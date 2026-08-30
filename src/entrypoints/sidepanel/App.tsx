/**
 * Side panel - the surface the user actually works in.
 * ---------------------------------------------------------------------------
 * Spec section 22. The panel's job is to make the system's uncertainty legible:
 *
 *     Application detected
 *     ATS: Greenhouse
 *
 *     18 fields detected
 *     13 ready to fill
 *      3 need review
 *      2 unknown
 *
 *     [Fill safe fields]
 *
 * THE DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE
 * The product's value is that the user can STOP checking obvious fields. That
 * only works if the panel is honest and quiet: it must show what it did, what
 * it declined to do, and nothing else. Spec section 22 explicitly warns against
 * overwhelming the user with debugging metadata - which is why confidence
 * numbers, mapping reasons and fingerprints live in the options-page playground
 * and not here.
 *
 * THE PANEL NEVER ASSERTS AN OUTCOME IT WAS NOT TOLD
 * This screen previously moved to "Filled" the moment a fill was DISPATCHED,
 * without reading the reply. That is the one bug that destroys the product's
 * whole premise: a user who is told thirteen fields were filled, and finds two
 * of them empty on submit, has to check all thirteen forever afterwards. Every
 * row's state now comes from the per-field verification the fill engine
 * actually performed, and a field that failed says so and says why.
 *
 * NOTHING FILLS WITHOUT A CLICK
 * Scanning happens on request. Filling happens on a separate, explicit click.
 * There is no auto-fill-on-load path, and spec section 21.4 forbids submitting
 * the form under any circumstances.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, StateBadge, StatusLine, type FieldState } from '@/components/ui';
import type { ResolvedFieldAction } from '@shared/messages';
import {
  describeFillFailure,
  type ContentErrorResponse,
  type ContentFillResponse,
  type ContentScanResponse,
  type FieldFillReport,
  type ResumePayload,
} from '@shared/page-protocol';
import { createLogger } from '@shared/logging';
import {
  EDUCATION_FIELDS,
  EMPLOYMENT_FIELDS,
  PROJECT_FIELDS,
  labelForPath,
  SCALAR_PROFILE_PATHS,
} from '@profile/paths';
import { StoredProfileRepository } from '@profile/repository';
import type { MappingScope } from '@learning/types';
import { ChromeLocalStore } from '@storage/key-value-store';
import { ResumeDocumentStore } from '@storage/documents';

/** Matches the key written by the options page's Resume tab. */
const DEFAULT_RESUME_KEY = 'aa:resume:defaultId';
const settings = new ChromeLocalStore();
const resumes = new ResumeDocumentStore();
const profiles = new StoredProfileRepository(settings);

/**
 * Read the user's default resume and encode it for the page.
 *
 * `chrome.tabs.sendMessage` serialises through JSON rather than structured
 * clone, so a File or ArrayBuffer would arrive as an empty object. Base64 is
 * the transport that actually survives, at a third more bytes on a one-off,
 * user-initiated action.
 *
 * The side panel is an extension page, so it can read the extension's own
 * IndexedDB directly. The content script cannot: `indexedDB` there is the
 * PAGE's database, not ours - which is exactly the isolation we want.
 */
async function loadResumePayload(): Promise<ResumePayload | undefined> {
  const saved = await settings.get<string>(DEFAULT_RESUME_KEY);
  if (!saved.ok || saved.value === undefined) return undefined;

  const file = await resumes.toFile(saved.value);
  if (!file.ok) return undefined;

  const bytes = new Uint8Array(await file.value.arrayBuffer());

  // Chunked, because String.fromCharCode(...bytes) on a 1 MB array blows the
  // argument limit and throws a RangeError - a failure that only shows up on
  // larger resumes and looks like a mystery.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return { name: file.value.name, type: file.value.type, base64: btoa(binary) };
}

/**
 * SECURITY: only ordinary web pages may be scanned or filled.
 *
 * Deliberately an ALLOWLIST of schemes rather than a denylist of chrome:// and
 * friends. A denylist has to be right about every scheme a browser will ever
 * add; an allowlist is wrong only in the safe direction (an unusual page is
 * not scanned).
 */
function isScannableUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'https:' || scheme === 'http:';
  } catch {
    return false;
  }
}

/** Hostname of the active tab, for showing the user where their data goes. */
async function activeTabHostname(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isScannableUrl(tab?.url)) return undefined;
  try {
    return new URL(tab?.url ?? '').hostname;
  } catch {
    return undefined;
  }
}

const log = createLogger('sidepanel');

/**
 * What the panel knows right now.
 *
 * Note there is no `filled` state. "Filled" is not a state of the PANEL, it is
 * a property of individual fields, and it is carried by `outcomes` - keyed by
 * localId - so a run that filled eleven of thirteen fields can say exactly
 * that. A single boolean could only ever say "we tried".
 */
type PanelState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | {
      kind: 'scanned';
      actions: ResolvedFieldAction[];
      /** Controls the scan found, which is not the same as actions produced. */
      fieldsDetected: number;
      /** localId -> what actually happened. Absent until a fill has run. */
      outcomes: Record<string, FieldFillReport>;
      /**
       * localId -> the frame that owns the element.
       *
       * An application form is frequently an EMBEDDED one - a Greenhouse or
       * Lever iframe inside the employer's own careers page - and the element
       * map that can resolve a localId lives in the frame that scanned it. A
       * fill addressed to the top frame would find nothing there.
       */
      frameByLocalId: Record<string, number>;
    }
  | { kind: 'error'; message: string; code?: string };

export function App(): ReactNode {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });
  /** Set when the page revealed new questions after the last scan. */
  const [pageChanged, setPageChanged] = useState(false);
  /**
   * Hostname of the page the last scan ran against.
   *
   * SECURITY / UX: the panel outlives the tab it was opened over. Clicking
   * Fill pushes profile values - and possibly the applicant's resume - into
   * whatever page is active AT THAT MOMENT, which is not necessarily the page
   * that was scanned. Naming the target out loud is what lets the user notice.
   */
  const [targetHost, setTargetHost] = useState<string | undefined>(undefined);

  /**
   * Listen for the scanner's "this form changed" broadcast.
   *
   * Conditional questions are the norm on real applications ("Do you require
   * sponsorship?" reveals three more fields). Without this the panel silently
   * shows a stale list and the newly revealed questions are simply missed.
   * It offers a rescan; it never rescans or fills on its own.
   */
  useEffect(() => {
    const listener = (message: unknown): undefined => {
      if ((message as { type?: string } | null)?.type === 'PAGE_FIELDS_CHANGED') {
        setPageChanged(true);
      }
      // Explicitly NOT returning true: this listener never answers, and
      // claiming the channel would leave the sender waiting for a reply.
      return undefined;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  /**
   * Ensure the scanner is present in the active tab, then message it.
   *
   * THE INJECTION IS THE PERMISSION MODEL.
   *
   * The scanner is not a declared content script - see the header of
   * `entrypoints/scanner.ts`. It is injected here, on an explicit user action,
   * which is what lets the extension run under `activeTab` instead of asking
   * for host access to every website at install time. The user's click IS the
   * grant.
   *
   * `executeScript` is safe to call repeatedly: the scanner guards its own
   * re-injection, so a second Scan click re-runs the file and returns
   * immediately rather than installing a duplicate message listener.
   */
  const injectScanner = useCallback(async (): Promise<
    { tabId: number; frameIds: number[] } | undefined
  > => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return undefined;
    const tabId = tab.id;

    /**
     * SECURITY: refuse a target that is not an ordinary web page.
     *
     * `chrome.scripting.executeScript` would fail on these anyway, but failing
     * with a clear reason here is worth the four lines: the panel can say
     * "this page cannot be scanned" instead of surfacing an opaque injection
     * error, and it documents the intent - this extension carries a person's
     * identity documents into whatever page is in front of it, so the set of
     * pages it will talk to is stated rather than left to Chrome's defaults.
     *
     * `tab.url` is readable here because the user's action granted activeTab.
     * A missing url means Chrome withheld it, which is itself a refusal.
     */
    if (!isScannableUrl(tab.url)) {
      log.debugLazy(() => ['Refusing to inject into a non-web page']);
      return undefined;
    }

    try {
      /**
       * EVERY FRAME, not just the top one.
       *
       * The most common real application is an embedded one: an employer's
       * careers page with a Greenhouse or Lever form in an iframe. Scanning
       * only the top document finds the page furniture and none of the
       * questions, which reads to the user as "this extension does not work on
       * the site I actually need it for".
       *
       * `activeTab` covers the whole tab including its subframes, so this
       * needs no additional permission - the user's click is still the grant.
       * Frames Chrome refuses (about:blank, a cross-origin frame mid-navigation)
       * simply do not appear in the results.
       */
      const injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['scanner.js'],
      });
      const frameIds = injected.map((result) => result.frameId ?? 0);
      // Deduplicated and ordered with the top frame first, so the panel lists
      // the main document's fields before an embedded form's.
      return { tabId, frameIds: [...new Set(frameIds)].sort((a, b) => a - b) };
    } catch (error) {
      // Injection is refused on pages no extension may touch: chrome://, the
      // Web Store, the PDF viewer, and other extensions' pages. Normal, not a
      // bug, and the caller turns it into a readable message.
      log.debugLazy(() => ['Could not inject the scanner into this tab', error]);
      return undefined;
    }
  }, []);

  /**
   * Message one frame.
   *
   * Addressed by `frameId` rather than broadcast to the tab: a broadcast
   * delivers to every frame and only the FIRST reply is ever received, so an
   * embedded form's answer would be discarded at random.
   */
  const sendToFrame = useCallback(
    async <T,>(tabId: number, frameId: number, message: unknown): Promise<T | undefined> => {
      try {
        return (await chrome.tabs.sendMessage(tabId, message, { frameId })) as T;
      } catch (error) {
        // The frame navigated between injection and the message, or it never
        // ran our script. Recoverable, and never a reason to fail the others.
        log.debugLazy(() => ['A frame did not answer', frameId, error]);
        return undefined;
      }
    },
    [],
  );

  const handleScan = useCallback(async (): Promise<void> => {
    setBusy(true);
    setStatus({ kind: 'idle' });
    setState({ kind: 'scanning' });
    setTargetHost(await activeTabHostname());

    const injected = await injectScanner();
    if (injected === undefined) {
      setBusy(false);
      setState({
        kind: 'error',
        message:
          'This page cannot be scanned. Chrome blocks extensions on its own pages, the Web Store, and PDFs.',
      });
      return;
    }

    // Frames are scanned in parallel: they are independent documents, and a
    // slow embedded form should not hold up the rest of the page.
    const scans = await Promise.all(
      injected.frameIds.map(async (frameId) => ({
        frameId,
        response: await sendToFrame<ContentScanResponse | ContentErrorResponse>(
          injected.tabId,
          frameId,
          { type: 'CONTENT_SCAN' },
        ),
      })),
    );

    setBusy(false);
    setPageChanged(false);

    const actions: ResolvedFieldAction[] = [];
    const frameByLocalId: Record<string, number> = {};
    let fieldsDetected = 0;
    const errors: ContentErrorResponse[] = [];

    for (const scan of scans) {
      if (scan.response === undefined) continue;
      if (!scan.response.ok) {
        errors.push(scan.response);
        continue;
      }
      fieldsDetected += scan.response.fieldsDetected;
      for (const action of scan.response.actions) {
        actions.push(action);
        frameByLocalId[action.localId] = scan.frameId;
      }
    }

    /**
     * A failure is only reported when NOTHING worked.
     *
     * An ad iframe that answered with an error must not hide a form that
     * scanned perfectly well in the frame next to it. But when every frame
     * failed, the reason matters - especially PROFILE_NOT_FOUND, which the
     * user can act on - so it is preferred over the generic ones.
     */
    if (actions.length === 0 && errors.length > 0) {
      const preferred = errors.find((error) => error.code === 'PROFILE_NOT_FOUND') ?? errors[0];
      if (preferred !== undefined) {
        setState({ kind: 'error', message: preferred.message, code: preferred.code });
        return;
      }
    }

    if (scans.every((scan) => scan.response === undefined)) {
      setState({
        kind: 'error',
        message: 'This page did not respond. Reload it and scan again.',
      });
      return;
    }

    setState({ kind: 'scanned', actions, fieldsDetected, outcomes: {}, frameByLocalId });
  }, [injectScanner, sendToFrame]);

  /**
   * Teach the system what a field means.
   *
   * The panel sends only a `localId` and the user's choice. The scanner owns
   * the descriptor and forwards it to the worker, which does the fingerprinting
   * - so there is exactly one implementation of what makes two questions "the
   * same question".
   */
  async function handleCorrect(
    localId: string,
    profilePath: string | null,
    scope: MappingScope,
  ): Promise<void> {
    const target = await injectScanner();
    // The descriptor for this field lives in the frame that scanned it, and
    // nowhere else - so the correction has to be addressed there.
    const frameId = state.kind === 'scanned' ? (state.frameByLocalId[localId] ?? 0) : 0;

    const response =
      target === undefined
        ? undefined
        : await sendToFrame<{ ok: boolean }>(target.tabId, frameId, {
            type: 'CONTENT_CORRECT',
            localId,
            profilePath,
            scope,
          });

    if (response?.ok !== true) {
      setStatus({ kind: 'error', message: 'That correction could not be saved.' });
      return;
    }

    setStatus({
      kind: 'ok',
      message:
        profilePath === null
          ? 'Noted - this field will be left alone from now on.'
          : `Learned: this question means ${labelForPath(profilePath).toLowerCase()}.`,
    });

    // Rescan so the panel reflects the new mapping immediately. Seeing the
    // field move from "needs review" to "ready" is the feedback that tells the
    // user the correction actually took.
    await handleScan();
  }

  /**
   * Run a fill for a specific set of actions and record what happened.
   *
   * Takes the actions explicitly rather than reading them from state because
   * this same path serves three different user intents - "fill everything
   * safe", "fill all the suggestions", "fill just this one" - and they differ
   * only in which actions they pass.
   */
  async function handleFill(requested: ResolvedFieldAction[]): Promise<void> {
    if (requested.length === 0) return;
    setBusy(true);
    setStatus({ kind: 'idle' });

    /**
     * SECURITY: fill only the site that was scanned.
     *
     * The side panel outlives the tab it was opened over. A user can scan an
     * application, switch tabs, and click Fill - at which point the profile
     * values, and the resume, would go to whatever page is now active. That is
     * not a hypothetical: switching tabs to check something mid-application is
     * the normal way people use this.
     *
     * Comparing hostnames is enough. Under activeTab the extension can only
     * reach a tab the user has activated it on anyway, so this is not about
     * stopping an attacker - it is about not sending a person's home address
     * somewhere they did not mean to.
     */
    const currentHost = await activeTabHostname();
    if (targetHost !== undefined && currentHost !== targetHost) {
      setBusy(false);
      setStatus({
        kind: 'error',
        message: `You are now on ${currentHost ?? 'another page'}, not ${targetHost}. Rescan before filling.`,
      });
      return;
    }

    // Only loaded when the page actually has a resume field. Otherwise we would
    // push the applicant's document into a webpage's context for no reason.
    const needsResume = requested.some((action) => action.action === 'attach_resume');
    const resume = needsResume ? await loadResumePayload() : undefined;

    if (needsResume && resume === undefined) {
      setStatus({
        kind: 'error',
        message: 'This form wants a resume, but none is saved. Add one under Edit your profile.',
      });
    }

    const target = await injectScanner();
    if (target === undefined) {
      setBusy(false);
      setStatus({ kind: 'error', message: 'This page can no longer be reached. Rescan.' });
      return;
    }

    /**
     * Grouped by the frame that owns each field.
     *
     * Only the frame that scanned a field can resolve its localId to an
     * element, so a fill spanning an employer's page and its embedded
     * application form is genuinely two operations. They run in parallel and
     * their outcomes are concatenated - the panel does not care which frame a
     * field came from, only what happened to it.
     */
    const byFrame = new Map<number, ResolvedFieldAction[]>();
    for (const action of requested) {
      const frameId =
        state.kind === 'scanned' ? (state.frameByLocalId[action.localId] ?? 0) : 0;
      const existing = byFrame.get(frameId);
      if (existing === undefined) byFrame.set(frameId, [action]);
      else existing.push(action);
    }

    const replies = await Promise.all(
      [...byFrame.entries()].map(([frameId, actions]) =>
        sendToFrame<ContentFillResponse | ContentErrorResponse>(target.tabId, frameId, {
          type: 'CONTENT_FILL',
          actions,
          ...(resume !== undefined ? { resume } : {}),
        }),
      ),
    );

    setBusy(false);

    const outcomes: FieldFillReport[] = [];
    let failure: ContentErrorResponse | undefined;
    for (const reply of replies) {
      if (reply === undefined) continue;
      if (reply.ok) outcomes.push(...reply.outcomes);
      else failure = reply;
    }

    if (outcomes.length === 0) {
      setStatus({
        kind: 'error',
        message: failure?.message ?? 'The page stopped responding. Rescan and try again.',
      });
      return;
    }

    // Merge rather than replace: accepting one suggestion after a bulk fill
    // must not erase the record of what that bulk fill did.
    setState((current) => {
      if (current.kind !== 'scanned') return current;
      const merged = { ...current.outcomes };
      for (const outcome of outcomes) merged[outcome.localId] = outcome;
      return { ...current, outcomes: merged };
    });

    const verified = outcomes.filter((outcome) => outcome.verified).length;
    const failed = outcomes.length - verified;

    // The summary states the failures out loud. A count that silently omits
    // them is the same lie as the old "Filled" badge, just smaller.
    setStatus({
      kind: failed === 0 ? 'ok' : 'error',
      message:
        failed === 0
          ? `${verified} field${verified === 1 ? '' : 's'} filled and verified.`
          : `${verified} filled, ${failed} could not be filled - see below.`,
    });
  }

  return (
    <div className="min-h-screen bg-white p-4 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <h1 className="text-base font-semibold">Job Application Agent</h1>
        {/* The destination, stated plainly. This panel can hand a resume and a
            home address to whatever page is in front of it, so the user should
            never have to guess which site that is. */}
        {targetHost !== undefined && (
          <p className="truncate text-xs text-zinc-500" title={targetHost}>
            Working on <span className="font-medium">{targetHost}</span>
          </p>
        )}
        <button
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="text-xs text-blue-600 hover:underline"
        >
          Edit your profile
        </button>
      </header>

      {state.kind === 'idle' && (
        <div className="space-y-3">
          <p className="text-zinc-600 dark:text-zinc-400">
            Open a job application, then scan it. Nothing is filled until you ask.
          </p>
          <Button onClick={() => void handleScan()} disabled={busy}>
            Scan this page
          </Button>
        </div>
      )}

      {state.kind === 'scanning' && <p className="text-zinc-500">Reading the form...</p>}

      {state.kind === 'error' && (
        <ScanError message={state.message} code={state.code} busy={busy} onRetry={handleScan} />
      )}

      <StatusLine status={status} />

      {pageChanged && state.kind === 'scanned' && (
        <div className="my-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/40">
          <p className="mb-1">This form changed - it may be showing questions we have not read.</p>
          <Button variant="secondary" onClick={() => void handleScan()} disabled={busy}>
            Rescan
          </Button>
        </div>
      )}

      {state.kind === 'scanned' && (
        <ScanReport
          actions={state.actions}
          fieldsDetected={state.fieldsDetected}
          outcomes={state.outcomes}
          busy={busy}
          onFill={(requested) => void handleFill(requested)}
          onRescan={() => void handleScan()}
          onCorrect={(localId, path, scope) => void handleCorrect(localId, path, scope)}
        />
      )}
    </div>
  );
}

/**
 * A scan that could not produce a field list, explained.
 *
 * A missing profile is the one failure with an obvious next step, so it gets a
 * button rather than a sentence. Telling a first-time user "no application form
 * detected" - which is what this code path used to do - is both wrong and
 * unactionable.
 */
function ScanError({
  message,
  code,
  busy,
  onRetry,
}: {
  message: string;
  /** `| undefined` explicitly, because `exactOptionalPropertyTypes` treats an
   *  optional property and one that may hold undefined as different types. */
  code: string | undefined;
  busy: boolean;
  onRetry: () => Promise<void>;
}): ReactNode {
  if (code === 'PROFILE_NOT_FOUND') {
    return (
      <div className="space-y-3 rounded border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
        <p className="font-medium">Set up your profile first</p>
        <p className="text-zinc-600 dark:text-zinc-400">
          The extension has nothing to fill this form with yet. Add your details - or import a
          resume - and it will take about two minutes, once.
        </p>
        <Button onClick={() => void chrome.runtime.openOptionsPage()}>Open my profile</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StatusLine status={{ kind: 'error', message }} />
      <Button variant="secondary" onClick={() => void onRetry()} disabled={busy}>
        Try again
      </Button>
    </div>
  );
}

/**
 * The summary and audit list.
 *
 * Grouped by what the user needs to DO, not by page order: fields that need a
 * decision come first, and the ones that will just work are collapsed into a
 * count. Sorting by page order would bury the three fields that matter among
 * the thirteen that do not.
 */
function ScanReport({
  actions,
  fieldsDetected,
  outcomes,
  busy,
  onFill,
  onRescan,
  onCorrect,
}: {
  actions: ResolvedFieldAction[];
  fieldsDetected: number;
  outcomes: Record<string, FieldFillReport>;
  busy: boolean;
  onFill: (actions: ResolvedFieldAction[]) => void;
  onRescan: () => void;
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  const ready = actions.filter(
    (action) => action.action === 'fill' || action.action === 'attach_resume',
  );
  const review = actions.filter((action) => action.action === 'suggest');
  const skipped = actions.filter((action) => action.action === 'skip');

  /** Fields we have already attempted, so a second click does not redo them. */
  const attempted = (candidates: ResolvedFieldAction[]): ResolvedFieldAction[] =>
    candidates.filter((action) => outcomes[action.localId] !== undefined);

  const remainingReady = ready.filter((action) => outcomes[action.localId] === undefined);

  if (actions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-zinc-600 dark:text-zinc-400">
          {fieldsDetected === 0
            ? 'No application form detected on this page.'
            : `${fieldsDetected} fields found, but none of them matched anything in your profile.`}
        </p>
        <Button variant="secondary" onClick={onRescan} disabled={busy}>
          Scan again
        </Button>
      </div>
    );
  }

  const verifiedCount = Object.values(outcomes).filter((outcome) => outcome.verified).length;
  const failedCount = Object.values(outcomes).length - verifiedCount;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <Stat label="Fields detected" value={fieldsDetected} />
        <Stat label="Ready to fill" value={ready.length} />
        <Stat label="Need review" value={review.length} />
        <Stat label="Not recognised" value={skipped.length} />
        {/* Only shown once a fill has run, and always shows BOTH numbers. */}
        {Object.keys(outcomes).length > 0 && (
          <>
            <Stat label="Filled and verified" value={verifiedCount} />
            <Stat label="Could not be filled" value={failedCount} />
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onFill(remainingReady)} disabled={busy || remainingReady.length === 0}>
          {remainingReady.length === 0 && attempted(ready).length > 0
            ? 'Safe fields done'
            : `Fill ${remainingReady.length} safe field${remainingReady.length === 1 ? '' : 's'}`}
        </Button>
        <Button variant="secondary" onClick={onRescan} disabled={busy}>
          Rescan
        </Button>
      </div>

      {/* The form is never submitted for the user. Saying so plainly is part of
          the product: it is why they can let it fill without watching. */}
      <p className="text-xs text-zinc-500">
        This extension never submits an application. Review everything before you do.
      </p>

      {review.length > 0 && (
        <ActionGroup
          title="Needs your review"
          actions={review}
          outcomes={outcomes}
          onFill={onFill}
          onCorrect={onCorrect}
          busy={busy}
          /* A suggestion is a value we are not confident enough to write on our
             own authority. The user supplying that authority - by reading it
             and clicking - is exactly what this button is for, and without it
             the review list is a dead end that can only be acted on by
             retyping. */
          bulkAction={{
            label: `Fill all ${review.length} suggestion${review.length === 1 ? '' : 's'}`,
            actions: review.filter((action) => outcomes[action.localId] === undefined),
          }}
        />
      )}
      {ready.length > 0 && (
        <ActionGroup
          title="Ready"
          actions={ready}
          outcomes={outcomes}
          onFill={onFill}
          onCorrect={onCorrect}
          busy={busy}
        />
      )}
      {skipped.length > 0 && (
        <ActionGroup
          title="Left alone"
          actions={skipped}
          outcomes={outcomes}
          onFill={onFill}
          onCorrect={onCorrect}
          busy={busy}
          collapsed
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </>
  );
}

function ActionGroup({
  title,
  actions,
  outcomes,
  busy,
  collapsed = false,
  bulkAction,
  onFill,
  onCorrect,
}: {
  title: string;
  actions: ResolvedFieldAction[];
  outcomes: Record<string, FieldFillReport>;
  busy: boolean;
  collapsed?: boolean;
  bulkAction?: { label: string; actions: ResolvedFieldAction[] };
  onFill: (actions: ResolvedFieldAction[]) => void;
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  const [open, setOpen] = useState(!collapsed);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mb-1 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-zinc-500"
        aria-expanded={open}
      >
        <span>
          {title} ({actions.length})
        </span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <>
          {bulkAction !== undefined && bulkAction.actions.length > 0 && (
            <div className="mb-2">
              <Button
                variant="secondary"
                onClick={() =>
                  // Wrapped rather than passed by reference: `map` supplies the
                  // index as a second argument, which would arrive as the
                  // edited value and write "0", "1", "2" into the form.
                  onFill(bulkAction.actions.map((candidate) => asAcceptedFill(candidate)))
                }
                disabled={busy}
              >
                {bulkAction.label}
              </Button>
            </div>
          )}
          <ul className="space-y-1">
            {actions.map((action) => (
              <ActionRow
                key={action.localId}
                action={action}
                outcome={outcomes[action.localId]}
                busy={busy}
                onFill={onFill}
                onCorrect={onCorrect}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Turn a suggestion into a fill the user has authorised.
 *
 * THE POLICY IS NOT BEING RE-IMPLEMENTED HERE. The confidence policy decided
 * "do not write this without a human looking at it", and that decision is
 * honoured: nothing converts a suggestion until a person reads the value and
 * clicks. What this function encodes is the user's consent, which is precisely
 * the input the policy was waiting for.
 *
 * An edited value drops `optionValue`: that field names an option the RESOLVER
 * matched, and it would no longer correspond to what the user typed.
 */
function asAcceptedFill(action: ResolvedFieldAction, editedValue?: string): ResolvedFieldAction {
  if (editedValue === undefined) return { ...action, action: 'fill' };
  const { optionValue: _dropped, ...rest } = action;
  return { ...rest, action: 'fill', value: editedValue };
}

/**
 * One field in the audit list.
 *
 * Three things happen in this row, and they are deliberately all present at
 * once:
 *
 *   - it states what WILL happen, or what DID happen, without embellishment;
 *   - a suggestion can be accepted (and edited) here, so the review list is
 *     somewhere the user can finish work rather than a list of things to
 *     retype elsewhere;
 *   - any field can be corrected, including one we were confident about. A
 *     confident field can still be wrong, and a user who finds they cannot say
 *     so is a user who stops trusting the extension.
 */
function ActionRow({
  action,
  outcome,
  busy,
  onFill,
  onCorrect,
}: {
  action: ResolvedFieldAction;
  outcome: FieldFillReport | undefined;
  busy: boolean;
  onFill: (actions: ResolvedFieldAction[]) => void;
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(
    typeof action.value === 'string' ? action.value : String(action.value ?? ''),
  );

  const state = rowState(action, outcome);

  /**
   * A suggestion can be accepted; a value already written cannot be re-offered.
   * Option-backed controls (a select, a radio group) are accepted as-is: the
   * value the user would edit is an option key, not text, and letting them type
   * over it would produce a value no option matches.
   */
  const canAccept = action.action === 'suggest' && outcome === undefined;
  const canEditValue = canAccept && action.optionValue === undefined && action.value !== undefined;

  return (
    <li className="text-xs">
      <div className="flex items-start gap-2">
        <StateBadge state={state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{action.explanation ?? 'Field'}</span>
          {action.value !== undefined && (
            <span className="block truncate font-mono text-zinc-500">{String(action.value)}</span>
          )}
          {/* The failure REASON, in the row that failed. A user who is told
              only "2 could not be filled" has to guess which two. */}
          {outcome !== undefined && !outcome.verified && (
            <span className="block text-amber-700 dark:text-amber-500">
              {describeFillFailure(outcome.failureReason)}
            </span>
          )}
        </span>

        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {canAccept && (
            <button
              type="button"
              onClick={() => onFill([asAcceptedFill(action)])}
              disabled={busy}
              className="text-blue-600 hover:underline disabled:opacity-50"
            >
              Fill this
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((current) => !current)}
            className="text-blue-600 hover:underline"
            aria-expanded={editing}
          >
            {editing ? 'Cancel' : 'Change'}
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-2 space-y-2 rounded border border-zinc-200 p-2 dark:border-zinc-700">
          {canEditValue && (
            <label className="block">
              <span className="mb-1 block text-zinc-500">Use this value</span>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                />
                <Button
                  onClick={() => {
                    setEditing(false);
                    onFill([asAcceptedFill(action, draft)]);
                  }}
                  disabled={busy}
                >
                  Fill
                </Button>
              </div>
            </label>
          )}

          <CorrectionPicker
            currentPath={action.profilePath}
            onSubmit={(path, scope) => {
              setEditing(false);
              onCorrect(action.localId, path, scope);
            }}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The badge for one row.
 *
 * Once a fill has been attempted the OUTCOME is the truth and the intent is
 * irrelevant - a field we were certain about, which the page then rejected, is
 * `needs_review`, not `verified`. Before any attempt, the badge reflects what
 * the policy decided.
 */
function rowState(action: ResolvedFieldAction, outcome: FieldFillReport | undefined): FieldState {
  if (outcome !== undefined) return outcome.verified ? 'verified' : 'needs_review';
  // Not yet attempted. `high_confidence` is the honest badge for a field we
  // intend to fill: confident, and not yet proven. Only a read-back earns
  // `verified`.
  if (action.action === 'fill' || action.action === 'attach_resume') return 'high_confidence';
  if (action.action === 'suggest') return 'needs_review';
  return 'missing';
}

/** One choice in the correction dropdown, grouped for readability. */
interface PathChoice {
  group: string;
  value: string;
  label: string;
}

/**
 * Everything a field can be corrected TO, including the repeated entries.
 *
 * The scalar list alone is not enough now that education and employment map:
 * a user who sees "School" mapped to the wrong degree needs to be able to say
 * "this is my second school", and a dropdown of scalar paths cannot express
 * that. The entries come from the profile itself, so the list names the
 * user's actual schools and jobs rather than an abstract index.
 *
 * Reading the profile directly is allowed here: the side panel is an extension
 * page, not a content script (see hooks/use-profile.ts).
 */
function useCorrectablePaths(): PathChoice[] {
  const [choices, setChoices] = useState<PathChoice[]>(() =>
    SCALAR_PROFILE_PATHS.map((path) => ({
      group: 'Your details',
      value: path,
      label: labelForPath(path),
    })),
  );

  useEffect(() => {
    void (async () => {
      const loaded = await profiles.load();
      if (!loaded.ok || loaded.value === undefined) return;
      const profile = loaded.value;

      const collections: Array<[string, readonly string[], Array<{ name: string | null }>]> = [
        [
          'education',
          EDUCATION_FIELDS,
          profile.education.map((entry) => ({ name: entry.institution.value })),
        ],
        [
          'employment',
          EMPLOYMENT_FIELDS,
          profile.employment.map((entry) => ({ name: entry.company.value })),
        ],
        ['projects', PROJECT_FIELDS, profile.projects.map((entry) => ({ name: entry.name.value }))],
      ];

      const entryChoices: PathChoice[] = [];
      for (const [collection, fields, entries] of collections) {
        entries.forEach((entry, index) => {
          // Named by what the user called it, falling back to a number. "MIT"
          // is findable in a dropdown; "Education 2" is a puzzle.
          const group = entry.name ?? `${collection} ${index + 1}`;
          for (const field of fields) {
            const value = `${collection}[${index}].${field}`;
            entryChoices.push({ group, value, label: labelForPath(value).split(' - ')[1] ?? field });
          }
        });
      }

      if (entryChoices.length > 0) {
        setChoices((current) => [...current, ...entryChoices]);
      }
    })();
  }, []);

  return choices;
}

/**
 * Pick what a field means, and how widely to remember it.
 *
 * THE SCOPE CHOICE IS THE USER'S, NOT OURS.
 *
 * We could infer a scope - "this looks company-specific, store it per company"
 * - but the user knows something we do not: whether "Preferred hub" is this
 * employer's private jargon or a phrase they expect to meet again. Guessing
 * wrong is quietly costly in both directions: too narrow and the correction
 * never helps again, too broad and one company's odd wording starts overriding
 * sensible defaults everywhere.
 *
 * The default is `global`, because the common case is a phrasing our alias
 * table simply has not seen yet, and that generalises.
 */
function CorrectionPicker({
  currentPath,
  onSubmit,
}: {
  currentPath: string | null;
  onSubmit: (profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  const [path, setPath] = useState<string>(currentPath ?? '');
  const [scope, setScope] = useState<MappingScope>('global');
  const choices = useCorrectablePaths();

  // Grouped in the order the choices were built: the user's own details first,
  // then one group per school, job and project.
  const groups = choices.reduce<Map<string, PathChoice[]>>((accumulator, choice) => {
    const existing = accumulator.get(choice.group);
    if (existing === undefined) accumulator.set(choice.group, [choice]);
    else existing.push(choice);
    return accumulator;
  }, new Map());

  const SCOPE_LABELS: Array<{ value: MappingScope; label: string; hint: string }> = [
    { value: 'global', label: 'Everywhere', hint: 'Any site that asks this' },
    { value: 'ats', label: 'This platform', hint: 'Greenhouse, Lever, etc.' },
    { value: 'company', label: 'This company', hint: 'Only on this site' },
    { value: 'exact_field', label: 'Just this field', hint: 'This exact question' },
  ];

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1 block text-zinc-500">This question is asking for</span>
        <select
          value={path}
          onChange={(event) => setPath(event.target.value)}
          className="w-full rounded border border-zinc-300 bg-white px-1 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
        >
          {/* "Nothing" is a real, useful answer: it teaches the extension to
              stop offering this field, which is itself a correction worth
              remembering. */}
          <option value="">Nothing - leave this field alone</option>
          {[...groups.entries()].map(([group, entries]) => (
            <optgroup key={group} label={group}>
              {entries.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-zinc-500">Remember this</span>
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as MappingScope)}
          className="w-full rounded border border-zinc-300 bg-white px-1 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
        >
          {SCOPE_LABELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} - {option.hint}
            </option>
          ))}
        </select>
      </label>

      <Button onClick={() => onSubmit(path.length === 0 ? null : path, scope)}>Save</Button>
    </div>
  );
}

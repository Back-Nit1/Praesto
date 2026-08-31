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
import { BrandMark, Button, StateBadge, StatusLine, type FieldState } from '@/components/ui';
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
  classifyPage,
  hasAccess,
  isPermissionError,
  requestAccess,
  type PageAccess,
} from './page-access';
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

/**
 * WHICH PAGE a scan belongs to.
 *
 * The hostname alone was not enough, and the gap was not theoretical: every
 * application on a careers site shares one hostname, so scanning
 * `boards.greenhouse.io/acme/jobs/1`, navigating to `.../jobs/2` and clicking
 * Fill passed the hostname check and then filled the SECOND application from
 * the FIRST one's field list - by localId, against elements that no longer
 * mean what they meant. The tab id matters for the same reason in the other
 * direction: the panel outlives the tab it was opened over, and the user can
 * switch tabs mid-application.
 *
 * The URL is compared without its fragment. `#section` is a scroll position,
 * not a different page, and treating it as one would invalidate a scan every
 * time the form scrolled itself.
 */
interface ScanTarget {
  tabId: number;
  /** Full URL, fragment stripped. */
  url: string;
  /** Hostname, for the one thing the user actually needs to read. */
  host: string;
}

function targetFromTab(tab: chrome.tabs.Tab | undefined): ScanTarget | undefined {
  if (tab?.id === undefined || !isScannableUrl(tab.url)) return undefined;
  try {
    const parsed = new URL(tab.url ?? '');
    parsed.hash = '';
    return { tabId: tab.id, url: parsed.href, host: parsed.hostname };
  } catch {
    return undefined;
  }
}

/** The page the user is looking at right now. */
async function activeTarget(): Promise<ScanTarget | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return targetFromTab(tab);
}

/** Same tab, same address - the two conditions for a scan still being valid. */
function sameTarget(a: ScanTarget | undefined, b: ScanTarget | undefined): boolean {
  return a !== undefined && b !== undefined && a.tabId === b.tabId && a.url === b.url;
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
/**
 * The outcome of trying to get the scanner into the page.
 *
 * A discriminated result, not `undefined`. The previous version returned
 * `undefined` for every failure, so the caller could only guess at a cause -
 * and it guessed "Chrome blocks this page", which was wrong for the most common
 * failure and left the user with nothing to do about it.
 */
type InjectionResult =
  | { ok: true; tabId: number; frameIds: number[] }
  | { ok: false; reason: 'restricted'; detail: string }
  | { ok: false; reason: 'local_file' }
  | { ok: false; reason: 'needs_permission'; origin: string }
  | { ok: false; reason: 'no_tab' }
  | { ok: false; reason: 'failed'; detail: string };

type InjectionFailure = Extract<InjectionResult, { ok: false }>;

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
  | { kind: 'error'; message: string; code?: string | undefined; origin?: string | undefined };

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
  const [target, setTarget] = useState<ScanTarget | undefined>(undefined);
  const targetHost = target?.host;

  /**
   * Listen for the scanner's "this form changed" broadcast.
   *
   * Conditional questions are the norm on real applications ("Do you require
   * sponsorship?" reveals three more fields). Without this the panel silently
   * shows a stale list and the newly revealed questions are simply missed.
   * It offers a rescan; it never rescans or fills on its own.
   */
  useEffect(() => {
    const listener = (message: unknown, sender: chrome.runtime.MessageSender): undefined => {
      if ((message as { type?: string } | null)?.type !== 'PAGE_FIELDS_CHANGED') return undefined;

      // FROM THE TAB WE SCANNED, or not at all. The broadcast reaches every
      // extension context, and the scanner is injected into every tab the user
      // has ever scanned - so without this check, a background tab quietly
      // re-rendering would tell the user that the form in FRONT of them had
      // changed. `sender.tab` is filled in by the browser, not by the sender.
      if (target === undefined || sender.tab?.id !== target.tabId) return undefined;

      setPageChanged(true);
      // Explicitly NOT returning true: this listener never answers, and
      // claiming the channel would leave the sender waiting for a reply.
      return undefined;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [target]);

  /**
   * Drop a scan when the page it describes is gone.
   *
   * A field list is a set of `localId`s that only mean anything to the
   * document that produced them. Once that tab navigates - or closes - the
   * list describes nothing, and leaving it on screen invites the user to click
   * Fill on a page it was never about. The fill path refuses that anyway; this
   * is so the panel stops SHOWING a stale list in the first place.
   *
   * A same-document navigation (an in-page step of a multi-step application)
   * still changes the URL, so it clears the scan too - correctly: the fields on
   * step 2 are not the fields we scanned on step 1.
   */
  useEffect(() => {
    if (target === undefined) return undefined;

    const invalidate = (): void => {
      setTarget(undefined);
      setPageChanged(false);
      setState({ kind: 'idle' });
      setStatus({ kind: 'idle' });
    };

    const onUpdated = (
      tabId: number,
      change: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (tabId !== target.tabId) return;
      // Only a URL change matters. A tab reports status, favicon and title
      // changes constantly, and none of them invalidate a field list.
      if (change.url === undefined) return;
      if (sameTarget(target, targetFromTab(tab))) return;
      invalidate();
    };

    const onRemoved = (tabId: number): void => {
      if (tabId === target.tabId) invalidate();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [target]);

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
  const injectScanner = useCallback(async (): Promise<InjectionResult> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return { ok: false, reason: 'no_tab' };
    const tabId = tab.id;

    // Classify BEFORE attempting anything. A chrome:// page is not a failure to
    // diagnose after the fact - it is a page we can say something accurate
    // about without touching it.
    const access: PageAccess = classifyPage(tab.url);
    if (access.kind === 'restricted') {
      return { ok: false, reason: 'restricted', detail: access.reason };
    }
    if (access.kind === 'local_file') return { ok: false, reason: 'local_file' };
    if (access.kind === 'unknown') {
      return { ok: false, reason: 'failed', detail: 'This tab has no address yet' };
    }

    try {
      /**
       * Injected into every frame.
       *
       * `allFrames: true` under `activeTab` covers embedded application forms -
       * a Greenhouse or Lever iframe on a company careers page - and needs no
       * additional permission. Frames Chrome refuses (about:blank, a
       * cross-origin frame mid-navigation) simply do not appear in the results.
       */
      const injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['scanner.js'],
      });
      const frameIds = injected.map((result) => result.frameId ?? 0);
      // Deduplicated and ordered with the top frame first, so the panel lists
      // the main document's fields before an embedded form's.
      return { ok: true, tabId, frameIds: [...new Set(frameIds)].sort((a, b) => a - b) };
    } catch (error) {
      log.debugLazy(() => ['Could not inject the scanner into this tab', error]);

      /**
       * The common case, and the one the old message got wrong.
       *
       * `activeTab` is granted when the user invokes the extension and revoked
       * when the tab navigates - so the ordinary flow of opening the panel and
       * then browsing to a job posting arrives here with no grant. It is not a
       * blocked page; it is a page we have not been allowed onto YET, and the
       * user can allow it in one click.
       *
       * The permission check is authoritative; the error-string match is a
       * fallback for the case where Chrome refuses for a permission reason we
       * did not anticipate.
       */
      const granted = await hasAccess(access.origin);
      if (!granted || isPermissionError(error)) {
        return { ok: false, reason: 'needs_permission', origin: access.origin };
      }

      return {
        ok: false,
        reason: 'failed',
        detail: error instanceof Error ? error.message : 'The page could not be reached',
      };
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
    setTarget(await activeTarget());

    const injected = await injectScanner();
    if (!injected.ok) {
      setBusy(false);
      setState({ kind: 'error', ...describeInjectionFailure(injected) });
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

    const response = !target.ok
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
    const current = await activeTarget();
    if (target !== undefined && !sameTarget(target, current)) {
      setBusy(false);
      setStatus({
        kind: 'error',
        message:
          current?.host === target.host
            ? `This is a different application on ${target.host}. Rescan before filling.`
            : `You are now on ${current?.host ?? 'another page'}, not ${target.host}. Rescan before filling.`,
      });
      return;
    }

    // Only loaded when the page actually has a resume field. Otherwise we would
    // push the applicant's document into a webpage's context for no reason.
    const needsResume = requested.some((action) => action.action === 'attach_resume');
    const resume = needsResume ? await loadResumePayload() : undefined;

    /**
     * No resume saved: drop the attach actions rather than sending them.
     *
     * Sending them anyway made the run report a failed field ("The page refused
     * the value") for a situation that is not the page's fault and that the
     * user can fix in one place - and the summary line then overwrote the
     * message saying so. Dropping them keeps the explanation on screen and
     * keeps the failure count honest about the fields we actually attempted.
     */
    let toFill = requested;
    if (needsResume && resume === undefined) {
      setStatus({
        kind: 'error',
        message: 'This form wants a resume, but none is saved. Add one under Edit your profile.',
      });
      toFill = requested.filter((action) => action.action !== 'attach_resume');
      if (toFill.length === 0) {
        setBusy(false);
        return;
      }
    }

    const injection = await injectScanner();
    if (!injection.ok) {
      setBusy(false);
      // Reuse the same diagnosis as the scan path. A permission that lapsed
      // between scanning and filling deserves the same one-click fix, not a
      // vaguer message because it happened at a different moment.
      setStatus({ kind: 'error', message: describeInjectionFailure(injection).message });
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
    for (const action of toFill) {
      const frameId =
        state.kind === 'scanned' ? (state.frameByLocalId[action.localId] ?? 0) : 0;
      const existing = byFrame.get(frameId);
      if (existing === undefined) byFrame.set(frameId, [action]);
      else existing.push(action);
    }

    const replies = await Promise.all(
      [...byFrame.entries()].map(([frameId, actions]) =>
        sendToFrame<ContentFillResponse | ContentErrorResponse>(injection.tabId, frameId, {
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
    //
    // The missing-resume note is appended rather than replaced: it is the one
    // thing on this screen the user can act on immediately, and a "12 fields
    // filled" line that scrolls it away hides the reason their resume is not
    // attached.
    const resumeNote =
      needsResume && resume === undefined ? ' No resume was attached - none is saved.' : '';

    setStatus({
      kind: failed === 0 && resumeNote === '' ? 'ok' : 'error',
      message:
        (failed === 0
          ? `${verified} field${verified === 1 ? '' : 's'} filled and verified.`
          : `${verified} filled, ${failed} could not be filled - see below.`) + resumeNote,
    });
  }

  return (
    <div className="panel-shell text-sm">
      <header className="panel-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark small />
          <div className="min-w-0">
            <h1 className="panel-product-name">Application Agent</h1>
        {/* The destination, stated plainly. This panel can hand a resume and a
            home address to whatever page is in front of it, so the user should
            never have to guess which site that is. */}
            {targetHost !== undefined ? (
              <p className="panel-host truncate" title={targetHost}>
                <span className="truncate">{targetHost}</span>
              </p>
            ) : (
              <p className="mt-0.5 text-[10px] text-[--app-muted]">Private application copilot</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="panel-icon-button"
          aria-label="Edit your profile"
          title="Edit your profile"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="3" /><path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" />
          </svg>
        </button>
      </header>

      {state.kind === 'idle' && (
        <div className="panel-hero">
          <div className="panel-hero-icon">
            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3" /><circle cx="12" cy="12" r="3.5" /><path d="m14.7 14.7 2.6 2.6" />
            </svg>
          </div>
          <div className="relative z-10">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[--app-accent]">
              Ready when you are
            </div>
            <h2 className="text-xl font-semibold tracking-[-0.035em] text-[--app-text]">
              Turn this form into a review list.
            </h2>
            <p className="mb-5 mt-2 text-xs leading-relaxed text-[--app-muted]">
              We’ll read the visible questions, prepare only confident answers, and leave everything else for you.
            </p>
            <Button className="w-full" onClick={() => void handleScan()} disabled={busy}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
              Scan this page
            </Button>
            <div className="mt-3 flex items-center justify-center gap-1.5 text-[10px] text-[--app-muted]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-teal)]" />
              Nothing is filled without your click
            </div>
          </div>
        </div>
      )}

      {state.kind === 'scanning' && (
        <div className="panel-card px-5 py-7 text-center">
          <div className="scan-orbit" aria-hidden="true" />
          <p className="font-semibold text-[--app-text]">Reading the form…</p>
          <p className="mt-1 text-[11px] text-[--app-muted]">Finding questions and matching verified answers</p>
        </div>
      )}

      {state.kind === 'error' && (
        <ScanError
          message={state.message}
          code={state.code}
          origin={state.origin}
          busy={busy}
          onRetry={handleScan}
        />
      )}

      <StatusLine status={status} />

      {pageChanged && state.kind === 'scanned' && (
        <div className="my-3 rounded-xl border border-amber-500/20 bg-amber-500/8 p-3 text-xs text-[--app-warning]">
          <p className="mb-2 font-medium">This form changed. There may be new questions.</p>
          <Button variant="secondary" className="w-full" onClick={() => void handleScan()} disabled={busy}>
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
/**
 * Turn an injection failure into something true and, where possible, fixable.
 *
 * Each branch says what actually happened. Only the `restricted` branch blames
 * Chrome, because only that branch is Chrome's doing - the previous single
 * message blamed Chrome for all of them, including the one the user could have
 * resolved in one click.
 */
function describeInjectionFailure(failure: InjectionFailure): {
  message: string;
  code?: string;
  origin?: string;
} {
  switch (failure.reason) {
    case 'restricted':
      // Genuinely Chrome. No permission changes this, so no button is offered.
      return { message: `${failure.detail}. Open a job application in a normal tab and try again.` };

    case 'local_file':
      return {
        message:
          'This is a local file. Chrome hides file:// pages from extensions unless you turn on "Allow access to file URLs" for this extension on chrome://extensions.',
      };

    case 'needs_permission':
      // The common case, and the actionable one.
      return {
        message: `The extension needs your permission to read ${new URL(failure.origin).hostname}.`,
        code: 'NEEDS_HOST_PERMISSION',
        origin: failure.origin,
      };

    case 'no_tab':
      return { message: 'No active tab. Click the page you want to fill, then scan again.' };

    case 'failed':
      // The honest fallback: we do not know, and we say the browser's own words
      // rather than inventing a cause.
      return { message: `This page could not be reached: ${failure.detail}` };
  }
}

function ScanError({
  message,
  code,
  origin,
  busy,
  onRetry,
}: {
  message: string;
  /** `| undefined` explicitly, because `exactOptionalPropertyTypes` treats an
   *  optional property and one that may hold undefined as different types. */
  code: string | undefined;
  origin: string | undefined;
  busy: boolean;
  onRetry: () => Promise<void>;
}): ReactNode {
  /**
   * The site we lack access to, offered as a one-click grant.
   *
   * `chrome.permissions.request` must be called straight from a user gesture -
   * Chrome refuses otherwise, and refuses by resolving `false`, which is
   * indistinguishable from the user declining. So it is invoked directly in
   * this click handler, never from an effect or a retry.
   */
  if (code === 'NEEDS_HOST_PERMISSION' && origin !== undefined) {
    const host = (() => {
      try {
        return new URL(origin).hostname;
      } catch {
        return origin;
      }
    })();

    return (
      <div className="panel-card overflow-hidden p-4">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-[--app-warning]">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v4M5.6 5.6l2.8 2.8M3 12h4M18.4 5.6l-2.8 2.8" /><path d="M8 16a4 4 0 1 1 8 0v2H8z" /></svg>
          </span>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[--app-warning]">Permission needed</p>
            <p className="mt-1 font-semibold tracking-[-0.015em] text-[--app-text]">Allow access to {host}?</p>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-[--app-muted]">
          The extension asks for no site access when you install it, so it has none here yet.
          Allowing {host} lets it read this form. It does not grant access to any other site, and
          you can undo it from Chrome&apos;s extension settings at any time.
        </p>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
          <Button
            onClick={() => {
              void (async () => {
                const granted = await requestAccess(origin);
                if (granted) await onRetry();
              })();
            }}
            disabled={busy}
          >
            Allow on {host}
          </Button>
          <Button variant="secondary" onClick={() => void onRetry()} disabled={busy}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (code === 'PROFILE_NOT_FOUND') {
    return (
      <div className="panel-card overflow-hidden p-4">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-xl border border-indigo-500/20 bg-indigo-500/10 text-[--app-accent]">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3" /><path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" /></svg>
          </span>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[--app-accent]">One-time setup</p>
            <p className="mt-1 font-semibold tracking-[-0.015em] text-[--app-text]">Build your application profile</p>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-[--app-muted]">
          The extension has nothing to fill this form with yet. Add your details - or import a
          resume - and it will take about two minutes, once.
        </p>
        <Button className="mt-4 w-full" onClick={() => void chrome.runtime.openOptionsPage()}>Open my profile</Button>
      </div>
    );
  }

  return (
    <div className="panel-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-xl border border-red-500/20 bg-red-500/10 text-[--app-danger]">!</span>
        <div className="min-w-0">
          <p className="font-semibold text-[--app-text]">We couldn’t read this page</p>
          <p className="mt-1 text-xs leading-relaxed text-[--app-muted]">{message}</p>
        </div>
      </div>
      <Button className="mt-4 w-full" variant="secondary" onClick={() => void onRetry()} disabled={busy}>
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
      <div className="panel-card p-5 text-center">
        <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] text-[--app-muted]">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3" /><path d="M9 12h6" /></svg>
        </span>
        <p className="text-xs leading-relaxed text-[--app-muted]">
          {fieldsDetected === 0
            ? 'No application form detected on this page.'
            : `${fieldsDetected} fields found, but none of them matched anything in your profile.`}
        </p>
        <Button className="mt-4 w-full" variant="secondary" onClick={onRescan} disabled={busy}>
          Scan again
        </Button>
      </div>
    );
  }

  const verifiedCount = Object.values(outcomes).filter((outcome) => outcome.verified).length;
  const failedCount = Object.values(outcomes).length - verifiedCount;

  return (
    <div className="space-y-3.5">
      <div className="flex items-end justify-between gap-3 px-0.5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[--app-accent]">Application map</p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.035em] text-[--app-text]">Your review queue</h2>
        </div>
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2 py-1 text-[10px] font-semibold text-[--app-success]">Scan complete</span>
      </div>

      <dl className="metric-grid">
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

      <div className="panel-card p-3">
        <Button className="w-full" onClick={() => onFill(remainingReady)} disabled={busy || remainingReady.length === 0}>
          {remainingReady.length === 0 && attempted(ready).length > 0
            ? 'Safe fields done'
            : `Fill ${remainingReady.length} safe field${remainingReady.length === 1 ? '' : 's'}`}
        </Button>
        <Button className="mt-2 w-full" variant="ghost" onClick={onRescan} disabled={busy}>
          Rescan
        </Button>
      </div>

      {/* The form is never submitted for the user. Saying so plainly is part of
          the product: it is why they can let it fill without watching. */}
      <p className="flex items-start gap-2 px-1 text-[10px] leading-relaxed text-[--app-muted]">
        <svg className="mt-px flex-none text-[--app-teal]" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>
        <span>This extension never submits an application. Review everything before you do.</span>
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
            label:
              review.length === 1
                ? 'Fill this suggestion'
                : `Fill all ${review.length} suggestions`,
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
    <div className="metric-card">
      <dt className="metric-label">{label}</dt>
      <dd className="metric-value">{value}</dd>
    </div>
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
    <section className="action-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between px-3 py-3 text-left text-[10px] font-bold uppercase tracking-[0.12em] text-[--app-muted] transition hover:bg-[var(--app-panel)]"
        aria-expanded={open}
      >
        <span>
          {title} ({actions.length})
        </span>
        <span className="grid h-5 w-5 place-items-center rounded-md bg-[var(--app-panel)] text-sm font-medium text-[--app-accent]" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <>
          {bulkAction !== undefined && bulkAction.actions.length > 0 && (
            <div className="border-t border-[var(--app-border)] px-3 py-2.5">
              <Button
                variant="secondary"
                className="w-full"
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
          <ul className="border-t border-[var(--app-border)]">
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
    <li className="border-b border-[var(--app-border)] px-3 py-3 text-xs last:border-b-0">
      <div className="flex items-start gap-2.5">
        <StateBadge state={state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[--app-text]">{action.explanation ?? 'Field'}</span>
          {action.value !== undefined && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-[--app-muted]">{String(action.value)}</span>
          )}
          {/* The failure REASON, in the row that failed. A user who is told
              only "2 could not be filled" has to guess which two. */}
          {outcome !== undefined && !outcome.verified && (
            <span className="mt-1 block text-[10px] leading-snug text-[--app-warning]">
              {describeFillFailure(outcome.failureReason)}
            </span>
          )}
        </span>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {canAccept && (
            <button
              type="button"
              onClick={() => onFill([asAcceptedFill(action)])}
              disabled={busy}
              className="rounded-md bg-indigo-500/10 px-2 py-1 text-[10px] font-semibold text-[--app-accent] transition hover:bg-indigo-500/15 disabled:opacity-50"
            >
              Fill this
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((current) => !current)}
            className="px-1 py-0.5 text-[10px] font-semibold text-[--app-muted] transition hover:text-[--app-text]"
            aria-expanded={editing}
          >
            {editing ? 'Cancel' : 'Change'}
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          {canEditValue && (
            <label className="block">
              <span className="mb-1.5 block font-medium text-[--app-muted]">Use this value</span>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-2 py-1.5 text-xs outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-indigo-500/10"
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

/** The group holding the profile's non-repeating fields. */
const SCALAR_GROUP = 'Your details';

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
      group: SCALAR_GROUP,
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
        /**
         * REPLACED, not appended.
         *
         * Under React's StrictMode - which the panel mounts with - an effect
         * runs twice on mount in development. Appending therefore produced two
         * copies of every education and employment option, with duplicate
         * React keys, in a dropdown whose whole job is to be unambiguous.
         * Rebuilding from the scalar list is idempotent however many times it
         * runs.
         */
        setChoices((current) => [
          ...current.filter((choice) => choice.group === SCALAR_GROUP),
          ...entryChoices,
        ]);
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
        <span className="mb-1.5 block font-medium text-[--app-muted]">This question is asking for</span>
        <select
          value={path}
          onChange={(event) => setPath(event.target.value)}
          className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-2 py-2 text-xs outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-indigo-500/10"
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
        <span className="mb-1.5 block font-medium text-[--app-muted]">Remember this</span>
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as MappingScope)}
          className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-2 py-2 text-xs outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-indigo-500/10"
        >
          {SCOPE_LABELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} - {option.hint}
            </option>
          ))}
        </select>
      </label>

      <Button className="w-full" onClick={() => onSubmit(path.length === 0 ? null : path, scope)}>Save correction</Button>
    </div>
  );
}

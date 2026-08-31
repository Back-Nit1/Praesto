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
import { PanelSnapshotStore } from './session-snapshot';
import {
  activeTarget,
  sameTarget,
  targetFromTab,
  type ScanTarget,
} from './scan-target';
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
/**
 * The panel's own memory, so closing it does not destroy the record of what
 * was filled and what failed. See session-snapshot.ts.
 */
const snapshots = new PanelSnapshotStore();
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
  /**
   * We cannot see the tab's address, which means we have no access to it yet -
   * Chrome hides `tab.url` without host permission or the `tabs` permission.
   * Distinct from `failed`: nothing went wrong, a grant simply lapsed.
   */
  | { ok: false; reason: 'no_access_yet' }
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
      /**
       * Set only when these rows came back from storage rather than from a
       * scan just performed. The panel says so out loud: a restored list
       * describes the page as it was, and the page may have moved on.
       */
      restoredAt?: number;
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
  /**
   * Cross-origin iframes on the scanned page that we have no permission for.
   *
   * Held separately from the scan result because it is not a property of the
   * form - it is a property of what we were allowed to look at.
   */
  const [blockedOrigins, setBlockedOrigins] = useState<string[]>([]);
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
   * Restore the last scan for this tab, once, on open.
   *
   * THE BEHAVIOUR THIS EXISTS FOR: a user fills eighteen questions, closes the
   * panel to read the job description, and reopens it. Before this, the panel
   * came back empty and the two fields that failed were unfindable without
   * re-reading the whole form - which is the exact work the product exists to
   * remove.
   *
   * Restores rows only, never actions: nothing is filled, rescanned or
   * re-decided here. The user sees what happened and chooses what to do next,
   * which is the same rule the rest of this panel follows.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const current = await activeTarget();
      if (current === undefined || cancelled) return;

      const restored = await snapshots.load(current);
      if (cancelled || !restored.ok || restored.value === undefined) return;

      const snapshot = restored.value;
      setTarget(current);
      setState({
        kind: 'scanned',
        actions: snapshot.actions,
        fieldsDetected: snapshot.fieldsDetected,
        outcomes: snapshot.outcomes,
        frameByLocalId: snapshot.frameByLocalId,
        restoredAt: snapshot.savedAt,
      });
    })();

    // The panel can be closed mid-read. Without this the async work lands on
    // an unmounted component and React logs a warning the user cannot act on.
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Persist the scan whenever it changes.
   *
   * Driven by state rather than called at each transition, so a path that
   * updates `outcomes` and forgets to save cannot exist. `restoredAt` is
   * carried through unchanged: re-saving a restored scan must not make it look
   * freshly scanned, or the note explaining that it is old would disappear on
   * the first fill after a restore.
   */
  useEffect(() => {
    if (target === undefined || state.kind !== 'scanned') return;

    void snapshots.save({
      target,
      savedAt: state.restoredAt ?? Date.now(),
      actions: state.actions,
      fieldsDetected: state.fieldsDetected,
      outcomes: state.outcomes,
      frameByLocalId: state.frameByLocalId,
    });
  }, [state, target]);

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
      // The stored copy goes with it. A snapshot the panel would refuse to
      // restore anyway is dead weight in session storage, and leaving it there
      // means the next scan of this tab briefly has two records of itself.
      void snapshots.clear(target.tabId);
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
      /**
       * WE CANNOT SEE THE TAB'S ADDRESS - which is itself the diagnosis.
       *
       * Chrome hides `tab.url` from an extension that holds neither the `tabs`
       * permission nor host access to that tab. `activeTab` grants host access,
       * and Chrome REVOKES it the moment the tab navigates. So the ordinary
       * flow - open the panel, browse to a job posting, click Scan - lands
       * here, with no URL, and therefore no origin to request permission for.
       *
       * This used to report "This tab has no address yet", which sounds like a
       * page still loading and leaves the user waiting for something that will
       * never happen. It is not a loading state: it is a revoked grant, and
       * clicking the toolbar icon restores it in one action - that click IS an
       * invocation, which is exactly what `activeTab` is granted by.
       */
      return { ok: false, reason: 'no_access_yet' };
    }

    try {
      /**
       * Injected into every frame.
       *
       * `allFrames: true` CHOOSES frames; it does not grant access to them.
       * `activeTab` covers the tab's own origin, so a same-origin iframe is
       * reached and a CROSS-ORIGIN one - which is how nearly every employer
       * embeds Greenhouse, Lever or Workday - is not. Chrome does not report
       * that as an error: the injection succeeds and simply returns fewer
       * frames.
       *
       * So the empty result is handled downstream instead: the top frame
       * reports the origins of the iframes it can see, and the panel offers a
       * one-click grant for the site the form actually comes from. See
       * `EmbeddedFormPrompt`.
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

    /**
     * Which embedded sites we could not read.
     *
     * Checked AFTER the scan rather than before, because the answer only
     * matters once we know what the accessible frames produced - a page whose
     * own form scanned fine still needs this if its iframe holds the rest of
     * the questions.
     */
    const embedded = new Set<string>();
    for (const scan of scans) {
      if (scan.response?.ok !== true) continue;
      for (const origin of scan.response.embeddedOrigins ?? []) embedded.add(origin);
    }

    if (embedded.size === 0) {
      setBlockedOrigins([]);
      return;
    }

    const granted = await Promise.all([...embedded].map((origin) => hasAccess(origin)));
    setBlockedOrigins([...embedded].filter((_origin, index) => granted[index] !== true));
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
            {/* The destination, stated plainly, in the data face. This panel
                can hand a resume and a home address to whatever page is in
                front of it, so the site you are about to hand them to is your
                data, not our prose - you should be able to read it character
                by character without deciding to. */}
            {targetHost !== undefined ? (
              <p className="data mt-0.5 truncate text-[10.5px] text-[var(--ink-2)]" title={targetHost}>
                {targetHost}
              </p>
            ) : (
              <p className="mt-0.5 text-[10.5px] text-[var(--ink-2)]">Nothing leaves this browser</p>
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
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="3" /><path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" />
          </svg>
        </button>
      </header>

      {state.kind === 'idle' && (
        <div className="panel-card p-4">
          <h2 className="text-[15px] font-semibold tracking-[-0.025em]">Read this application</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-2)]">
            Every question on the page is matched against your profile. Answers we can stand behind
            get prepared; anything we are unsure of is listed for you and left blank.
          </p>
          <Button className="mt-4 w-full" onClick={() => void handleScan()} disabled={busy}>
            Scan this page
          </Button>
          {/* Two promises, made where they are relevant rather than in a badge
              at the top of the panel. They are the reason it is safe to let
              this run on a real application. */}
          <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--ink-3)]">
            Nothing is filled until you click. Nothing is ever submitted.
          </p>
        </div>
      )}

      {state.kind === 'scanning' && (
        <div className="panel-card px-5 py-6 text-center" role="status" aria-live="polite">
          <div className="scan-lines" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <p className="text-[13px] font-medium">Reading the form</p>
          <p className="mt-1 text-[11px] text-[var(--ink-2)]">
            Matching each question against your profile
          </p>
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
        <div
          className="my-3 rounded-lg border p-3 text-xs"
          style={{
            color: 'var(--s-review)',
            background: 'var(--s-review-wash)',
            borderColor: 'var(--s-review-line)',
          }}
        >
          <p className="mb-2 font-medium">This form changed. There may be new questions.</p>
          <Button variant="secondary" className="w-full" onClick={() => void handleScan()} disabled={busy}>
            Rescan
          </Button>
        </div>
      )}

      {state.kind === 'scanned' && blockedOrigins.length > 0 && (
        <EmbeddedFormPrompt
          origins={blockedOrigins}
          busy={busy}
          onGranted={() => void handleScan()}
        />
      )}

      {state.kind === 'scanned' && (
        <ScanReport
          actions={state.actions}
          fieldsDetected={state.fieldsDetected}
          {...(state.restoredAt !== undefined ? { restoredAt: state.restoredAt } : {})}
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

    case 'no_access_yet':
      // Not a broken page and not a permanent block - a grant that lapsed on
      // navigation. The recovery is one click, and it is a click Chrome will
      // only accept on the toolbar icon, so the panel has to ask for it rather
      // than offer a button that cannot work.
      return {
        message:
          'Chrome withdrew this extension\'s access when you navigated here. Click the extension icon in your toolbar to give it access to this tab, then scan again.',
        code: 'NEEDS_INVOCATION',
      };

    case 'failed':
      // The honest fallback: we do not know, and we say the browser's own words
      // rather than inventing a cause.
      return { message: `This page could not be reached: ${failure.detail}` };
  }
}

/**
 * "The form is on a site we have not been allowed to read."
 *
 * THE FAILURE THIS REPLACES. An employer's careers page with a Greenhouse
 * iframe scanned as a page with three fields and no application - because
 * `allFrames: true` only selects frames, and `activeTab` never covered the
 * embedded origin. The user saw "no application form detected" on a page
 * plainly showing an application form.
 *
 * The grant is per origin and permanent until revoked, which is the right
 * shape here: someone applying through Greenhouse will meet it again on the
 * next employer's site, and being asked once is reasonable where being asked
 * every time would train them to click through.
 */
function EmbeddedFormPrompt({
  origins,
  busy,
  onGranted,
}: {
  origins: string[];
  busy: boolean;
  onGranted: () => void;
}): ReactNode {
  return (
    <div className="my-2 rounded border border-[var(--rule)] bg-[var(--paper-2)] p-3 text-xs border-[var(--rule)] bg-[var(--paper-2)]">
      <p className="mb-2">
        Part of this page is loaded from another site. Chrome needs your permission before the
        extension can read the form inside it.
      </p>
      <div className="flex flex-col gap-1">
        {origins.map((origin) => (
          <Button
            key={origin}
            variant="secondary"
            disabled={busy}
            onClick={() => {
              // Called straight from the click. Chrome refuses a permission
              // prompt that is not inside a user gesture, and refuses it
              // silently by resolving false - indistinguishable from the user
              // saying no. So this must not be moved into an effect or a retry.
              void requestAccess(origin).then((granted) => {
                if (granted) onGranted();
              });
            }}
          >
            Allow {hostOf(origin)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Hostname for display. Falls back to the raw origin if it will not parse. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
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
          <span className="grid h-8 w-8 flex-none place-items-center rounded-lg border border-[var(--s-review-line)] bg-[var(--s-review-wash)] text-[var(--s-review)]">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v4M5.6 5.6l2.8 2.8M3 12h4M18.4 5.6l-2.8 2.8" /><path d="M8 16a4 4 0 1 1 8 0v2H8z" /></svg>
          </span>
          <p className="text-[14px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
            Allow access to <span className="data">{host}</span>?
          </p>
        </div>
        <p className="text-xs leading-relaxed text-[var(--ink-2)]">
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
          <span className="grid h-8 w-8 flex-none place-items-center rounded-lg border border-[var(--rule)] bg-[var(--paper-2)] text-[var(--ink)]">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3" /><path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" /></svg>
          </span>
          <p className="text-[14px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
            Build your application profile
          </p>
        </div>
        <p className="text-xs leading-relaxed text-[var(--ink-2)]">
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
        <span className="grid h-8 w-8 flex-none place-items-center rounded-lg border border-[var(--danger-line)] bg-[var(--danger-wash)] text-[var(--danger)]">!</span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
            This page could not be read
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--ink-2)]">{message}</p>
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
/**
 * A wall-clock time the user can match against their own memory.
 *
 * Locale-formatted rather than an ISO string or a "3 hours ago": the panel is
 * telling them which of their own actions this record came from, and "10:42"
 * is how a person holds that.
 */
function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function ScanReport({
  actions,
  fieldsDetected,
  outcomes,
  busy,
  restoredAt,
  onFill,
  onRescan,
  onCorrect,
}: {
  actions: ResolvedFieldAction[];
  fieldsDetected: number;
  outcomes: Record<string, FieldFillReport>;
  busy: boolean;
  /** Epoch ms, present only when these rows came back from storage. */
  restoredAt?: number;
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
    /*
      An empty result is a direction, not a shrug. The two cases are genuinely
      different - we found no form at all, or we found one and understood none
      of it - and only the second one is a reason to add something to your
      profile, so only the second one offers that.
    */
    const foundNothing = fieldsDetected === 0;
    return (
      <div className="panel-card p-4">
        <p className="text-[14px] font-semibold tracking-[-0.02em]">
          {foundNothing ? 'No application form detected' : 'Nothing here matched your profile'}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-2)]">
          {foundNothing
            ? 'This page has no fields we recognise as an application. If the form is behind a button or a later step, open it and scan again.'
            : `${fieldsDetected} fields found, and none of them matched anything you have saved. Add the missing details to your profile, then scan again.`}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onRescan} disabled={busy}>
            Scan again
          </Button>
          <Button onClick={() => void chrome.runtime.openOptionsPage()}>Open my profile</Button>
        </div>
      </div>
    );
  }

  const verifiedCount = Object.values(outcomes).filter((outcome) => outcome.verified).length;
  const failedCount = Object.values(outcomes).length - verifiedCount;

  /**
   * THE CERTAINTY LEDGER.
   *
   * One bar, segmented in proportion to what the scan actually found, and a
   * key beneath it. It replaced a grid of four to six equal metric cards - a
   * layout that gave "fields detected", a number nobody acts on, exactly the
   * same weight as "needs your review", which is a to-do list, and that grew
   * by two cards after a fill and pushed everything below it down the panel.
   *
   * A proportional bar cannot flatter the result. If four fields out of
   * nineteen were understood, the grey runs three quarters of the width and
   * you see that before reading a word. An extension whose entire promise is
   * that it will admit what it does not know should draw its ignorance at
   * full size.
   *
   * Only non-empty buckets are drawn, so the bar never shows a state this
   * page does not actually have.
   */
  const buckets = [
    { key: 'verified', label: 'Filled and verified', count: verifiedCount, colour: 'var(--s-verified)' },
    { key: 'failed', label: 'Could not be filled', count: failedCount, colour: 'var(--danger)' },
    { key: 'ready', label: 'Ready to fill', count: remainingReady.length, colour: 'var(--s-confident)' },
    { key: 'review', label: 'Needs your review', count: review.length, colour: 'var(--s-review)' },
    { key: 'unknown', label: 'Left blank', count: skipped.length, colour: 'var(--s-unknown)' },
  ].filter((bucket) => bucket.count > 0);

  return (
    <div className="space-y-3">
      <section className="panel-card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em]">What we found</h2>
          <span className="data text-[11px] text-[var(--ink-2)]">
            {fieldsDetected} fields detected
          </span>
        </div>

        {/* A restored list describes the page AS IT WAS. Saying so is the same
            honesty the rest of this panel is built on: the user is looking at a
            record, not a live reading, and the form may have moved on since. */}
        {restoredAt !== undefined && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--ink-3)]">
            {`Restored from your scan at ${formatClockTime(restoredAt)}. Rescan if the form has changed since.`}
          </p>
        )}

        {/* The bar is aria-hidden because the key below it is the same
            information as text, and a screen reader should hear it once. */}
        <div className="ledger mt-3" aria-hidden="true">
          {buckets.map((bucket) => (
            <span
              key={bucket.key}
              className="ledger-seg"
              style={{ flex: bucket.count, background: bucket.colour }}
            />
          ))}
        </div>

        <dl className="ledger-key">
          {buckets.map((bucket) => (
            <div key={bucket.key} className="ledger-key-item">
              <span className="ledger-key-dot" style={{ background: bucket.colour }} aria-hidden="true" />
              <dd className="ledger-count">{bucket.count}</dd>
              <dt>{bucket.label}</dt>
            </div>
          ))}
        </dl>

        {/* Once every safe field has been attempted there is nothing left for
            a primary button to do, so it stops being one. A greyed-out slab
            across the widest part of the panel is the loudest element on the
            screen advertising the one thing you cannot press. */}
        {remainingReady.length === 0 && attempted(ready).length > 0 ? (
          <Button className="mt-4 w-full" variant="secondary" onClick={onRescan} disabled={busy}>
            Rescan
          </Button>
        ) : (
          <>
            <Button
              className="mt-4 w-full"
              onClick={() => onFill(remainingReady)}
              disabled={busy || remainingReady.length === 0}
            >
              {`Fill ${remainingReady.length} safe field${remainingReady.length === 1 ? '' : 's'}`}
            </Button>
            <Button className="mt-2 w-full" variant="ghost" onClick={onRescan} disabled={busy}>
              Rescan
            </Button>
          </>
        )}

        {/* The form is never submitted for the user. Saying so where the fill
            button is, rather than in a badge at the top, is part of the
            product: it is why they can let it fill without watching. */}
        <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--ink-3)]">
          This extension never submits an application. Read it through before you do.
        </p>
      </section>

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
          title="Ready to fill"
          actions={ready}
          outcomes={outcomes}
          onFill={onFill}
          onCorrect={onCorrect}
          busy={busy}
          /* CLOSED BY DEFAULT, AND THAT IS THE PRODUCT.
             The promise is that you can stop reading the fields it is sure
             about. Opening this list by default would contradict that on every
             scan, and it would push the three fields that DO need you off the
             bottom of a 400 px panel. */
          collapsed
          /* Unless something went wrong. A failure is only actionable if you
             can see which field it was, so a failed fill opens the group that
             contains it whether or not the user had it closed. */
          forceOpen={failedCount > 0}
        />
      )}
      {skipped.length > 0 && (
        <ActionGroup
          title="Left blank"
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

function ActionGroup({
  title,
  actions,
  outcomes,
  busy,
  collapsed = false,
  forceOpen,
  bulkAction,
  onFill,
  onCorrect,
}: {
  title: string;
  actions: ResolvedFieldAction[];
  outcomes: Record<string, FieldFillReport>;
  busy: boolean;
  collapsed?: boolean;
  /** Open the group regardless of `collapsed`, until the user says otherwise. */
  forceOpen?: boolean;
  bulkAction?: { label: string; actions: ResolvedFieldAction[] };
  onFill: (actions: ResolvedFieldAction[]) => void;
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  /**
   * `undefined` until the user touches the disclosure, and only then does
   * their choice win. Holding the open state as a plain boolean seeded from a
   * prop meant a group could never re-open itself: a fill that failed inside a
   * collapsed "Ready to fill" left the user with a red count in the ledger and
   * no way to find out which field it belonged to without guessing.
   */
  const [choice, setChoice] = useState<boolean | undefined>(undefined);
  const open = choice ?? (!collapsed || forceOpen === true);

  return (
    <section className="panel-card overflow-hidden">
      <button
        type="button"
        onClick={() => setChoice(!open)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--paper-2)]"
        aria-expanded={open}
      >
        <span
          className="grid h-4 w-4 flex-none place-items-center text-[var(--ink-3)]"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 12 12"
            width="9"
            height="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms ease' }}
          >
            <path d="m4 2 4 4-4 4" />
          </svg>
        </span>
        <span className="text-[12px] font-semibold tracking-[-0.005em]">{title}</span>
        <span className="data ml-auto text-[11px] text-[var(--ink-2)]">{actions.length}</span>
      </button>

      {open && (
        <>
          {bulkAction !== undefined && bulkAction.actions.length > 0 && (
            <div className="border-t border-[var(--rule)] px-3 py-2.5">
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
          <ul className="border-t border-[var(--rule)]">
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
  const failed = outcome !== undefined && !outcome.verified;

  /**
   * A suggestion can be accepted; a value already written cannot be re-offered.
   * Option-backed controls (a select, a radio group) are accepted as-is: the
   * value the user would edit is an option key, not text, and letting them type
   * over it would produce a value no option matches.
   */
  const canAccept = action.action === 'suggest' && outcome === undefined;
  const canEditValue = canAccept && action.optionValue === undefined && action.value !== undefined;

  const value = action.value === undefined ? undefined : String(action.value);

  return (
    <li className={`field-row field-row--${state}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/*
            THE ANSWER IS THE HEADLINE, NOT THE QUESTION.

            This row used to set the question in bold 12 px and the value in
            10 px muted monospace underneath it. That is backwards. The user
            already knows what an application asks for; what they are here to
            check is the string that is about to be typed into it on their
            behalf. So the value is the largest and darkest thing in the row
            and the field name is its caption.
          */}
          <span className="field-label">{rowTitle(action)}</span>
          {value !== undefined ? (
            <span className="field-value" title={value}>
              {value}
            </span>
          ) : action.action === 'attach_resume' ? (
            <span className="field-value">Your saved resume</span>
          ) : (
            <span className="field-value" style={{ color: 'var(--ink-3)' }}>
              Nothing will be entered
            </span>
          )}
        </div>
        {/* "Change" rides the top line with the badge rather than taking a
            line of its own. It is present on every one of what can be twenty
            rows, and a dedicated row for it added a third of the panel's
            height to say nothing. */}
        <button
          type="button"
          onClick={() => setEditing((current) => !current)}
          className="-my-0.5 flex-none rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--ink-2)] transition-colors hover:text-[var(--ink)]"
          aria-expanded={editing}
        >
          {editing ? 'Cancel' : 'Change'}
        </button>
        <StateBadge state={state} />
      </div>

      <p
        className="field-provenance"
        /* A failure is not a footnote. When the page rejected the value, the
           line that says so is the one thing in the row the user has to read,
           so it is the only text in the list that gets the failure colour. */
        style={failed ? { color: 'var(--danger)' } : undefined}
      >
        {describeProvenance(action, outcome)}
      </p>

      {/* A suggestion is the only row with a decision to make, so it is the
          only row that spends a line on a button. */}
      {canAccept && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => onFill([asAcceptedFill(action)])}
            disabled={busy}
            className="rounded-md border border-[var(--rule)] bg-[var(--paper-2)] px-2.5 py-1 text-[10.5px] font-semibold text-[var(--ink)] transition-colors hover:border-[var(--rule-2)] disabled:opacity-40"
          >
            Fill this
          </button>
        </div>
      )}

      {editing && (
        <div className="mt-2.5 space-y-3 rounded-lg border border-[var(--rule)] bg-[var(--paper-2)] p-3">
          {canEditValue && (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium text-[var(--ink-2)]">
                Use this value
              </span>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className="data min-w-0 flex-1 rounded-md border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--ink)]"
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
 * What this row is about, in the user's vocabulary.
 *
 * Prefers the canonical profile field over `explanation`, which for a mapped
 * field reads "Email address (autocomplete)" - the parenthetical being the
 * matching signal that fired. That is mapping metadata, and spec section 22 is
 * explicit that it belongs in the options-page playground, not here. The
 * explanation is still used verbatim where there is no profile path, because
 * those strings ("Resume upload", "A file is already attached") are written
 * for a person.
 */
function rowTitle(action: ResolvedFieldAction): string {
  if (action.profilePath !== null) return labelForPath(action.profilePath);
  return action.explanation ?? 'Field';
}

/**
 * One line saying where this answer came from, or why there isn't one.
 *
 * Once a fill has run the OUTCOME is the only honest answer: a value we were
 * certain about, which the page then rejected, did not come from anywhere -
 * it is not on the page at all.
 */
function describeProvenance(
  action: ResolvedFieldAction,
  outcome: FieldFillReport | undefined,
): string {
  if (outcome !== undefined) {
    return outcome.verified
      ? 'Filled, and read back from the page to confirm'
      : describeFillFailure(outcome.failureReason);
  }

  // A skipped field's explanation already says WHY it was left alone ("Your
  // profile has no phone number"), which is more use than naming the
  // knowledge state that produced it.
  if (action.action === 'skip') return action.explanation ?? 'Left blank';

  if (action.action === 'attach_resume') return 'Your saved resume will be attached';

  switch (action.knowledgeState) {
    case 'known':
      return 'You entered this yourself';
    case 'derived':
      return 'Worked out from what you entered';
    case 'previously_seen':
      return 'You have answered this question before';
    case 'probable':
      return 'Our best reading of the question - check it before filling';
    case 'unknown':
      return 'Not recognised';
  }
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
        <span className="mb-1.5 block font-medium text-[var(--ink-2)]">This question is asking for</span>
        <select
          value={path}
          onChange={(event) => setPath(event.target.value)}
          className="w-full rounded-lg border border-[var(--rule)] bg-[var(--paper-2)] px-2 py-2 text-xs outline-none focus:border-[var(--ink)]"
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
        <span className="mb-1.5 block font-medium text-[var(--ink-2)]">Remember this</span>
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as MappingScope)}
          className="w-full rounded-lg border border-[var(--rule)] bg-[var(--paper-2)] px-2 py-2 text-xs outline-none focus:border-[var(--ink)]"
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

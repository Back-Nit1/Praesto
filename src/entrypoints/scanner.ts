/**
 * Page scanner - injected into a job application on request.
 * ---------------------------------------------------------------------------
 * Runs inside the job application page. Spec section 10.1 defines what it may
 * and may not do, and the "may not" list is the important half:
 *
 *   MAY:  inspect the DOM, build descriptors, execute fills, verify results.
 *   MAY NOT: load the applicant profile, hold API secrets, call a model,
 *            persist canonical data, or submit the form.
 *
 * WHY THOSE RESTRICTIONS ARE REAL
 * This code shares a JavaScript context's origin with a page we do not control.
 * Chrome isolates content-script variables from page scripts, but the page can
 * still influence what we observe, and a bug here is a bug running on an
 * untrusted site. Keeping the profile out of this context means the worst case
 * is bounded: an attacker learns the answers to the questions their own form
 * displayed, which they were about to be told anyway.
 *
 * ELEMENT IDENTITY
 * Descriptors carry a `localId`, and this module keeps the only map from those
 * ids to live elements. That map never leaves the page context, so the service
 * worker cannot address a DOM node even in principle - it can only say "fill
 * the field you called f_123".
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createLogger } from '@shared/logging';
import { getRuntimeBudget } from '@shared/runtime-budget';
import {
  MESSAGE_PROTOCOL_VERSION,
  type ExtensionResponse,
  type ResolveApplicationFieldsRequest,
  type ResolvedFieldAction,
} from '@shared/messages';
import type {
  ContentFillResponse,
  ContentScanResponse,
  ContentErrorResponse,
  FieldFillReport,
  ResumePayload,
} from '@shared/page-protocol';
import { detectATS } from '@ats/detector';
import { scanPage } from '@form-engine/detector/scanner';
import { computeFingerprints } from '@form-engine/fingerprints/fingerprint';
import { executeFills } from '@fill-engine/executor';
import { clearPendingResume, setPendingResume } from '@fill-engine/adapters/file-upload';
import type { FieldDescriptor } from '@form-engine/descriptor/types';

const log = createLogger('content');

/**
 * Marker on the page's window object, so a second injection is a no-op.
 *
 * `chrome.scripting.executeScript` runs the file again every time it is called,
 * and the user can click Scan repeatedly. Without this guard each click would
 * add another `onMessage` listener, and by the third scan every request would
 * be answered three times - with three separate element maps, only one of which
 * matches the descriptors the panel is holding.
 */
const INJECTION_MARKER = '__applicantAgentScannerReady';

export default defineUnlistedScript(() => {
  /**
   * INJECTED ON DEMAND, NOT DECLARED IN THE MANIFEST.
   *
   * This file is built as a standalone script and is absent from the manifest's
   * `content_scripts`. The side panel injects it with
   * `chrome.scripting.executeScript` when the user asks to scan a page.
   *
   * This is the difference between two very different install prompts. A
   * declared `<all_urls>` content script - or a runtime-registered one, which
   * needs the same grant - makes Chrome demand host access at install time and
   * warn that the extension can "read and change all your data on all
   * websites". Injecting on demand runs under `activeTab`: access to one tab,
   * only after the user clicks the extension, and only until they navigate
   * away. For an extension whose pitch is that it is trustworthy with your
   * personal data, that install prompt is part of the product.
   *
   * The cost is that this script is not present until the user asks for it, so
   * it cannot observe the page beforehand. That is the behaviour we want
   * anyway: scanning is user-initiated, and nothing here should run on the
   * pages someone visits that are not job applications.
   */
  const alreadyInjected = (window as unknown as Record<string, unknown>)[INJECTION_MARKER] === true;
  if (alreadyInjected) return;
  (window as unknown as Record<string, unknown>)[INJECTION_MARKER] = true;

  {
    /**
     * localId -> live element.
     *
     * A WeakMap would be wrong here: we need the id as the KEY (WeakMap keys
     * must be objects), and we need to look elements up by id. A plain Map with
     * explicit clearing on rescan is the correct structure, and clearing it is
     * what prevents an unbounded leak on a long-lived single-page application.
     */
    const elementsById = new Map<string, HTMLElement>();

    /** Descriptors from the most recent scan, kept for correction reporting. */
    let lastDescriptors: FieldDescriptor[] = [];

    /**
     * Whether this frame has already told the panel it changed since the last
     * scan. Reset by a scan, because after one the panel's list is current
     * again and the next change is news.
     */
    let changeAlreadyReported = false;

    const budget = getRuntimeBudget();

    /**
     * Cheap gate before doing any real work.
     *
     * A page with no form controls, or with only a search box, is not an
     * application. Checking that first means the extension is effectively free
     * on the ~99% of pages the user visits that are not job applications - which
     * matters on a machine already running low on memory.
     */
    function shouldEngage(): boolean {
      const controls = document.querySelectorAll('input, textarea, select');
      // Three is low enough to catch a minimal application form and high enough
      // to exclude a search box plus a newsletter signup.
      return controls.length >= 3;
    }

    /**
     * The outcome of a scan, INCLUDING the ways it can usefully fail.
     *
     * `error` and `fieldsDetected` exist because collapsing them was a real
     * bug: every worker failure used to be returned as an empty action list,
     * and the panel reads an empty action list as "no application form here".
     * A first-time user with no profile was therefore told the page had no
     * form, which is both wrong and unactionable. A missing profile and a
     * missing form need different sentences, so they need different data.
     */
    interface ScanOutcome {
      actions: ResolvedFieldAction[];
      fieldsDetected: number;
      error?: { code: string; message: string };
    }

    /** Scan, ask the worker what to do, and report back. Never fills. */
    async function scanAndResolve(root?: ParentNode): Promise<ScanOutcome> {
      const ats = detectATS(
        { url: location.href, hostname: location.hostname, title: document.title },
        document,
      );

      const scanOptions = root === undefined ? { ats } : { ats, root };
      const { result: scan, elements } = await scanPage(document, scanOptions);

      // Refresh the id map. Cleared first so elements removed by a re-render
      // are released rather than pinned in memory by our own map - on a
      // long-lived single-page application this is the difference between a
      // bounded map and an unbounded leak.
      elementsById.clear();
      for (const [localId, element] of elements) elementsById.set(localId, element);

      lastDescriptors = scan.fields;
      // The panel now has a current list, so the next reveal is worth
      // reporting again.
      changeAlreadyReported = false;

      if (scan.fields.length === 0) return { actions: [], fieldsDetected: 0 };

      const request: ResolveApplicationFieldsRequest = {
        type: 'RESOLVE_APPLICATION_FIELDS',
        version: MESSAGE_PROTOCOL_VERSION,
        page: scan.page,
        fields: scan.fields,
      };

      const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;

      if (response === undefined || !response.ok) {
        // The worker was asleep, the extension was reloaded, or the profile is
        // missing. None justify disturbing the page - but they must not be
        // flattened into "we found nothing" either. The CODE travels back to
        // the panel, which is the only surface that can act on it (by offering
        // onboarding, a retry, or an explanation).
        const error =
          response === undefined
            ? { code: 'WORKER_UNAVAILABLE', message: 'The extension did not answer' }
            : { code: response.code, message: response.message };
        log.warn('Field resolution unavailable', error.code);
        return { actions: [], fieldsDetected: scan.fields.length, error };
      }
      if (response.type !== 'RESOLVE_APPLICATION_FIELDS_RESULT') {
        return {
          actions: [],
          fieldsDetected: scan.fields.length,
          error: { code: 'UNEXPECTED_RESPONSE', message: 'The extension answered unexpectedly' },
        };
      }

      log.info(
        `${scan.fields.length} fields in ${scan.scanDurationMs}ms: ` +
          `${response.summary.readyToFill} ready, ${response.summary.needsReview} to review`,
      );

      return { actions: response.actions, fieldsDetected: scan.fields.length };
    }

    /**
     * Fill the fields the worker marked safe, then report what actually landed.
     *
     * Triggered only by an explicit user action in the side panel. Nothing on
     * this page can cause a fill.
     */
    async function fillSafeFields(
      actions: readonly ResolvedFieldAction[],
      resume?: ResumePayload,
    ): Promise<FieldFillReport[]> {
      /**
       * The resume arrives base64-encoded.
       *
       * `chrome.tabs.sendMessage` serialises through JSON, not structured
       * clone, so an ArrayBuffer or a File would arrive as `{}`. Base64 costs
       * about a third in size on a one-off, user-initiated action, which is a
       * fair price for a transport that actually works.
       */
      if (resume !== undefined) {
        const file = decodeResume(resume);
        // A resume that fails validation is not an error worth aborting the
        // whole fill for - the text fields still get filled, and the file
        // input reports `rejected`, which the panel already explains.
        if (file !== null) setPendingResume(file);
        else log.warn('Ignored a resume payload that failed validation');
      }

      try {
        // The outcomes are RETURNED, not merely logged. The panel is the
        // surface that tells the user "13 filled"; if it does not receive the
        // per-field truth it can only assert success, which is exactly the
        // trust failure the verify step exists to prevent.
        return await runFills(actions);
      } finally {
        // Cleared on every path, including failure. The page context holds the
        // applicant's resume only for the duration of the operation.
        clearPendingResume();
      }
    }

    /**
     * Largest resume this context will decode, in base64 characters.
     *
     * The document store already refuses anything over 10 MB, so this is not
     * the primary control - it is the check on the side of the boundary that
     * cannot see the store. Base64 inflates by 4/3, so 14 MB of characters
     * covers a 10 MB file with room to spare, and anything larger is rejected
     * BEFORE `atob` allocates a string of that size in the host page's heap.
     */
    const MAX_RESUME_BASE64_CHARS = 14 * 1024 * 1024;

    /** The only file type the store accepts, restated at the boundary. */
    const ALLOWED_RESUME_TYPES = new Set(['application/pdf']);

    /**
     * Decode a resume payload into a File, or null if it is not one.
     *
     * SECURITY: this runs in the page's context, on a payload that arrived
     * over a message channel. Validating rather than trusting costs three
     * comparisons and removes: an unbounded `atob` allocation (a hostile
     * payload could make the host page allocate hundreds of megabytes), a
     * file type the form was never meant to receive, and a filename carrying
     * path separators or control characters into a page's upload widget.
     */
    function decodeResume(resume: ResumePayload): File | null {
      if (typeof resume.base64 !== 'string' || resume.base64.length === 0) return null;
      if (resume.base64.length > MAX_RESUME_BASE64_CHARS) return null;
      if (!ALLOWED_RESUME_TYPES.has(resume.type)) return null;

      const name = safeFileName(resume.name);
      if (name === null) return null;

      try {
        const binary = atob(resume.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        // Magic bytes. A file whose type says PDF but whose content is not one
        // is either a bug on our side or something we should not be attaching
        // to an employer's form. `%PDF-` is the first five bytes of every PDF.
        if (
          bytes.length < 5 ||
          bytes[0] !== 0x25 || // %
          bytes[1] !== 0x50 || // P
          bytes[2] !== 0x44 || // D
          bytes[3] !== 0x46 || // F
          bytes[4] !== 0x2d // -
        ) {
          return null;
        }

        return new File([bytes], name, { type: resume.type });
      } catch {
        // atob throws on malformed base64. Losing the attachment is the right
        // outcome; throwing into the host page is not.
        return null;
      }
    }

    /**
     * Reduce a filename to something safe to hand a webpage.
     *
     * Strips directory separators and control characters, caps the length, and
     * requires a .pdf extension. Returns null when nothing usable is left.
     */
    function safeFileName(raw: string): string | null {
      if (typeof raw !== 'string') return null;
      const cleaned = raw
        // eslint-disable-next-line no-control-regex -- stripping control chars is the point
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]/g, '_')
        .trim()
        .slice(0, 128);

      if (cleaned.length === 0) return null;
      return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
    }

    async function runFills(actions: readonly ResolvedFieldAction[]): Promise<FieldFillReport[]> {
      const outcomes = await executeFills(actions, {
        resolveElement: (localId) => elementsById.get(localId) ?? null,
      });

      await chrome.runtime
        .sendMessage({
          type: 'REPORT_FILL_RESULTS',
          version: MESSAGE_PROTOCOL_VERSION,
          page: { url: location.href, hostname: location.hostname, ats: 'unknown' as const },
          results: outcomes.map((outcome) => ({
            localId: outcome.localId,
            // Computed from the descriptor this outcome belongs to, so the
            // feedback lands on the same rule that produced the fill. An empty
            // set means the descriptor is gone, and the worker will find no
            // rule to credit - which is correct, not a silent miss.
            fingerprints: fingerprintsFor(outcome.localId),
            profilePath: outcome.profilePath,
            attempted: outcome.attempted,
            verified: outcome.verified,
            ...(outcome.adapter !== undefined ? { adapter: outcome.adapter } : {}),
            ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
          })),
        })
        .catch((error: unknown) => {
          // Losing the audit report is not worth surfacing to the user. The
          // fill already happened and they can see it.
          log.debugLazy(() => ['Could not report fill results', error]);
        });

      // What the PANEL is told. The profile path is deliberately absent: the
      // panel already knows it from the action it sent, and a fill report is
      // not a place to restate where a value came from.
      return outcomes.map((outcome) => ({
        localId: outcome.localId,
        attempted: outcome.attempted,
        verified: outcome.verified,
        ...(outcome.adapter !== undefined ? { adapter: outcome.adapter } : {}),
        ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      }));
    }

    /**
     * The four scoped fingerprints for a field from the last scan.
     *
     * Recomputed here rather than cached on the descriptor because only the
     * global scope travels with a descriptor - carrying all four across the
     * message boundary for every field would quadruple the hash payload of a
     * scan for a feature that only fires on fill and correction.
     */
    function fingerprintsFor(localId: string): {
      global: string;
      ats: string;
      company: string;
      exact: string;
    } {
      const descriptor = lastDescriptors.find((candidate) => candidate.localId === localId);
      if (descriptor === undefined) return { global: '', ats: '', company: '', exact: '' };
      return computeFingerprints(descriptor);
    }

    /**
     * Forward a user correction to the service worker.
     *
     * The scanner does this rather than the side panel because the DESCRIPTOR
     * lives here. The panel knows a field by its `localId` and nothing more; the
     * worker needs the full descriptor to fingerprint it. Routing through the
     * page keeps descriptors in exactly one place and keeps fingerprinting in
     * exactly one implementation.
     */
    async function recordCorrection(
      localId: string,
      profilePath: string | null,
      scope: 'global' | 'ats' | 'company' | 'exact_field',
    ): Promise<boolean> {
      const field = lastDescriptors.find((candidate) => candidate.localId === localId);
      if (field === undefined) return false;

      const response = (await chrome.runtime.sendMessage({
        type: 'RECORD_CORRECTION',
        version: MESSAGE_PROTOCOL_VERSION,
        field,
        profilePath,
        scope,
      })) as { ok?: boolean } | undefined;

      return response?.ok === true;
    }

    /**
     * Watch for conditionally-revealed questions (spec section 16).
     *
     * Debounced, because a framework re-render fires dozens of mutations in a
     * few milliseconds and rescanning on each would turn the observer into a
     * busy loop. The debounce window comes from the runtime budget, so a
     * low-end machine waits longer and does less work.
     *
     * Filtered before scheduling: mutations that add no element nodes (text
     * changes, attribute flips, a spinner) cannot have introduced a new form
     * control, so they must not cost a rescan.
     */
    function watchForNewFields(onChange: () => void): MutationObserver {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const observer = new MutationObserver((mutations) => {
        const addedElements = mutations.some((mutation) =>
          [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE),
        );
        if (!addedElements) return;

        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(onChange, budget.mutationDebounceMs);
      });

      observer.observe(document.body, { childList: true, subtree: true });
      return observer;
    }

    /**
     * SECURITY: validate a message from the panel instead of casting it.
     *
     * The three `CONTENT_*` requests used to be read with duck-typed casts
     * (`message as { type?: string; actions?: ... }`), which is a compile-time
     * fiction: at runtime `request.actions` could be anything, and it is
     * handed straight to the fill executor, which resolves DOM elements and
     * writes values into them. This narrows the payload once, here, and every
     * branch below works on a shape that has actually been checked.
     *
     * Deliberately hand-rolled rather than Zod: the content script is the
     * bundle that gets injected into every scanned page, and pulling a schema
     * library into it would add ~12 KB to a script whose whole design goal is
     * to be cheap to inject. The shapes are small enough that a few `typeof`
     * checks are clearer than a schema anyway.
     *
     * Cost is O(actions), one pass, with the array itself capped.
     */
    function validateContentRequest(
      message: unknown,
    ):
      | { type: 'CONTENT_SCAN' }
      | { type: 'CONTENT_FILL'; actions: ResolvedFieldAction[]; resume?: ResumePayload }
      | {
          type: 'CONTENT_CORRECT';
          localId: string;
          profilePath: string | null;
          scope: MappingScope;
        }
      | null {
      if (typeof message !== 'object' || message === null) return null;
      const raw = message as Record<string, unknown>;

      if (raw['type'] === 'CONTENT_SCAN') return { type: 'CONTENT_SCAN' };

      if (raw['type'] === 'CONTENT_CORRECT') {
        const localId = raw['localId'];
        if (typeof localId !== 'string' || localId.length === 0 || localId.length > 128) {
          return null;
        }
        const path = raw['profilePath'];
        const profilePath = typeof path === 'string' && path.length <= 128 ? path : null;

        const scope = raw['scope'];
        return {
          type: 'CONTENT_CORRECT',
          localId,
          profilePath,
          scope: isMappingScope(scope) ? scope : 'global',
        };
      }

      if (raw['type'] === 'CONTENT_FILL') {
        const actions = raw['actions'];
        if (!Array.isArray(actions)) return null;
        // Matches the scan cap: more actions than the page could have produced
        // is not a legitimate request.
        if (actions.length > MAX_ACTIONS_PER_FILL) return null;

        const valid = actions.filter(isFillAction);
        const resume = validateResumePayload(raw['resume']);

        return resume === undefined
          ? { type: 'CONTENT_FILL', actions: valid }
          : { type: 'CONTENT_FILL', actions: valid, resume };
      }

      return null;
    }

    /** Upper bound on actions in one fill, matching the scanner's field cap. */
    const MAX_ACTIONS_PER_FILL = 500;

    const MAPPING_SCOPES = ['global', 'ats', 'company', 'exact_field'] as const;
    type MappingScope = (typeof MAPPING_SCOPES)[number];

    function isMappingScope(value: unknown): value is MappingScope {
      return typeof value === 'string' && (MAPPING_SCOPES as readonly string[]).includes(value);
    }

    /**
     * The minimum an action must be for the executor to act on it safely.
     *
     * Only `fill` and `attach_resume` are actionable, and the executor already
     * refuses the rest - but an entry that is not even an object would throw
     * inside the loop, and one bad entry must not cost the other nineteen.
     */
    function isFillAction(value: unknown): value is ResolvedFieldAction {
      if (typeof value !== 'object' || value === null) return false;
      const action = value as Record<string, unknown>;

      if (typeof action['localId'] !== 'string' || action['localId'].length > 128) return false;
      if (typeof action['action'] !== 'string') return false;

      const kind = action['action'];
      if (kind !== 'fill' && kind !== 'suggest' && kind !== 'skip' && kind !== 'attach_resume') {
        return false;
      }

      const filled = action['value'];
      if (filled !== undefined && typeof filled !== 'string' && typeof filled !== 'boolean') {
        return false;
      }

      const option = action['optionValue'];
      if (option !== undefined && typeof option !== 'string') return false;

      return true;
    }

    /** Shape-check a resume payload before anything tries to decode it. */
    function validateResumePayload(value: unknown): ResumePayload | undefined {
      if (typeof value !== 'object' || value === null) return undefined;
      const payload = value as Record<string, unknown>;

      if (
        typeof payload['name'] !== 'string' ||
        typeof payload['type'] !== 'string' ||
        typeof payload['base64'] !== 'string'
      ) {
        return undefined;
      }

      return {
        name: payload['name'],
        type: payload['type'],
        base64: payload['base64'],
      };
    }

    // --- message handling from the side panel ------------------------------
    //
    // The side panel cannot reach the page directly, so it addresses this
    // script through the worker. Everything here is request/response; the page
    // never initiates a fill.
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      /**
       * SECURITY: sender check.
       *
       * This listener lives inside a page we do not control. Chrome does not
       * deliver a web page's `postMessage` here, and a different extension
       * cannot address our content script - but this is the boundary that
       * hands the applicant's resume to a DOM, so it is checked rather than
       * assumed. `sender.id` is set by the browser, not by the sender.
       */
      if (sender.id !== chrome.runtime.id) return false;

      const request = validateContentRequest(message);
      if (request === null) return false;

      if (request.type === 'CONTENT_SCAN') {
        scanAndResolve()
          .then((outcome) => {
            // A worker-side failure is reported AS a failure, with its code
            // intact. Returning `{ ok: true, actions: [] }` here would tell the
            // panel the page has no form - the wrong diagnosis for a missing
            // profile, an evicted worker, or a failed migration.
            if (outcome.error !== undefined) {
              const failure: ContentErrorResponse = {
                ok: false,
                code: outcome.error.code,
                message: outcome.error.message,
              };
              sendResponse(failure);
              return;
            }
            const success: ContentScanResponse = {
              ok: true,
              actions: outcome.actions,
              fieldsDetected: outcome.fieldsDetected,
            };
            sendResponse(success);
          })
          .catch((error: unknown) => {
            log.error('Scan failed', error);
            const failure: ContentErrorResponse = {
              ok: false,
              code: 'SCAN_FAILED',
              message: 'Could not scan this page',
            };
            sendResponse(failure);
          });
        return true;
      }

      if (request.type === 'CONTENT_CORRECT') {
        recordCorrection(request.localId, request.profilePath, request.scope)
          .then((ok) => sendResponse({ ok }))
          .catch((error: unknown) => {
            log.error('Could not record correction', error);
            sendResponse({ ok: false });
          });
        return true;
      }

      if (request.type === 'CONTENT_FILL') {
        fillSafeFields(request.actions, request.resume)
          .then((outcomes) => {
            // The per-field truth crosses back. `{ ok: true }` used to be the
            // whole reply, which is how the panel came to say "Filled" for a
            // field a React input had silently rejected.
            const success: ContentFillResponse = { ok: true, outcomes };
            sendResponse(success);
          })
          .catch((error: unknown) => {
            log.error('Fill failed', error);
            const failure: ContentErrorResponse = {
              ok: false,
              code: 'FILL_FAILED',
              message: 'Could not fill this page',
            };
            sendResponse(failure);
          });
        return true;
      }

      return false;
    });

    // --- startup -----------------------------------------------------------
    // The user has already asked for this page to be handled by injecting us,
    // so the only remaining question is whether there is anything here to work
    // with. `shouldEngage` is still worth checking: the panel's message is
    // clearer if we can say "no form here" rather than silently returning zero
    // fields from a full scan.
    if (!shouldEngage()) {
      log.debug('No application-shaped form on this page');
    } else {
      log.info('Application-shaped page detected; ready to scan on request');

      /**
       * Watch for dynamically revealed fields - in this frame only, and only
       * when this frame holds something form-shaped.
       *
       * BOTH CONDITIONS MATTER, because the scanner is injected into EVERY
       * frame of the tab (that is what makes an embedded application form
       * work). An advertising iframe re-renders constantly; observing it would
       * wake the service worker on a timer forever, on the low-power machines
       * this extension is built for, to report a change in a frame with no
       * form in it.
       *
       * This NEVER fills. A form that reveals a question in response to an
       * answer must not have that question answered without the user seeing
       * it. It tells the side panel the page changed; the user's click remains
       * the only thing that acts.
       */
      watchForNewFields(() => {
        // At most one nudge per scan. The panel's response is a single banner
        // offering a rescan - it does not get more useful the tenth time, and
        // a framework re-render can fire this every debounce window for as
        // long as the page is open.
        if (changeAlreadyReported) return;
        changeAlreadyReported = true;

        log.debugLazy(() => ['New nodes appeared; a rescan would be useful']);

        // Broadcast rather than addressed: a content script cannot message an
        // extension page directly. Every listening extension context receives
        // this, which is how it reaches the side panel. The worker recognises
        // the type and answers OK; it takes no action on it.
        void chrome.runtime
          .sendMessage({
            type: 'PAGE_FIELDS_CHANGED',
            version: MESSAGE_PROTOCOL_VERSION,
            page: {
              url: location.href,
              hostname: location.hostname,
              ats: detectATS(
                { url: location.href, hostname: location.hostname, title: document.title },
                document,
              ),
            },
          })
          .catch(() => {
            // Nothing was listening - the panel is closed, or the worker is
            // asleep and the page is idle. Not a problem worth a log line.
          });
      });
    }
  }
});

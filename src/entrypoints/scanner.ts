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
        setPendingResume(base64ToFile(resume.base64, resume.name, resume.type));
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

    /** Decode a base64 payload back into a File the adapter can attach. */
    function base64ToFile(base64: string, name: string, type: string): File {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name, { type });
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

    // --- message handling from the side panel ------------------------------
    //
    // The side panel cannot reach the page directly, so it addresses this
    // script through the worker. Everything here is request/response; the page
    // never initiates a fill.
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const request = message as { type?: string; actions?: ResolvedFieldAction[] } | null;

      if (request?.type === 'CONTENT_SCAN') {
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

      if (request?.type === 'CONTENT_CORRECT') {
        const correction = message as {
          localId?: string;
          profilePath?: string | null;
          scope?: 'global' | 'ats' | 'company' | 'exact_field';
        };
        if (typeof correction.localId !== 'string') return false;

        recordCorrection(
          correction.localId,
          correction.profilePath ?? null,
          correction.scope ?? 'global',
        )
          .then((ok) => sendResponse({ ok }))
          .catch((error: unknown) => {
            log.error('Could not record correction', error);
            sendResponse({ ok: false });
          });
        return true;
      }

      if (request?.type === 'CONTENT_FILL' && Array.isArray(request.actions)) {
        const payload = message as { resume?: ResumePayload };

        fillSafeFields(request.actions, payload.resume)
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
    }

    // Watch for dynamically revealed fields.
    //
    // This NEVER fills. A form that reveals a question in response to an answer
    // must not have that question answered without the user seeing it. What it
    // does is tell the side panel that the page has changed, so the panel can
    // offer a rescan - the user's click remains the only thing that acts.
    watchForNewFields(() => {
      log.debugLazy(() => ['New nodes appeared; a rescan would be useful']);

      // Broadcast rather than addressed: a content script cannot message an
      // extension page directly. Every listening extension context receives
      // this, which is how it reaches the side panel. The worker recognises the
      // type and answers OK; it takes no action on it.
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
});

/**
 * Content script.
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
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createLogger } from '@shared/logging';
import { getRuntimeBudget } from '@shared/runtime-budget';
import {
  MESSAGE_PROTOCOL_VERSION,
  type ExtensionResponse,
  type ResolveApplicationFieldsRequest,
  type ResolvedFieldAction,
} from '@shared/messages';
import { detectATS } from '@ats/detector';
import { scanPage } from '@form-engine/detector/scanner';
import { executeFills } from '@fill-engine/executor';
import type { FieldDescriptor } from '@form-engine/descriptor/types';

const log = createLogger('content');

export default defineContentScript({
  // Runs everywhere, but does nothing until asked. See `shouldEngage` below:
  // the script costs a few hundred microseconds on a page with no form, and
  // registering narrowly by URL would miss every company careers site that
  // embeds an ATS under its own domain.
  matches: ['<all_urls>'],

  // `document_idle` waits for the page to finish its initial work. Scanning at
  // document_start would find an empty DOM on any framework-rendered form.
  runAt: 'document_idle',

  main() {
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

    /** Scan, ask the worker what to do, and report back. Never fills. */
    async function scanAndResolve(root?: ParentNode): Promise<ResolvedFieldAction[]> {
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

      if (scan.fields.length === 0) return [];

      const request: ResolveApplicationFieldsRequest = {
        type: 'RESOLVE_APPLICATION_FIELDS',
        version: MESSAGE_PROTOCOL_VERSION,
        page: scan.page,
        fields: scan.fields,
      };

      const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;

      if (response === undefined || !response.ok) {
        // The worker was asleep, the extension was reloaded, or the profile is
        // missing. All are recoverable and none justify disturbing the page.
        log.warn('Field resolution unavailable', response?.ok === false ? response.code : 'no response');
        return [];
      }
      if (response.type !== 'RESOLVE_APPLICATION_FIELDS_RESULT') return [];

      log.info(
        `${scan.fields.length} fields in ${scan.scanDurationMs}ms: ` +
          `${response.summary.readyToFill} ready, ${response.summary.needsReview} to review`,
      );

      return response.actions;
    }

    /**
     * Fill the fields the worker marked safe, then report what actually landed.
     *
     * Triggered only by an explicit user action in the side panel. Nothing on
     * this page can cause a fill.
     */
    async function fillSafeFields(actions: readonly ResolvedFieldAction[]): Promise<void> {
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
            semanticFingerprint:
              lastDescriptors.find((d) => d.localId === outcome.localId)?.semanticFingerprint ?? '',
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
          .then((actions) => sendResponse({ ok: true, actions }))
          .catch((error: unknown) => {
            log.error('Scan failed', error);
            sendResponse({ ok: false, code: 'SCAN_FAILED', message: 'Could not scan this page' });
          });
        return true;
      }

      if (request?.type === 'CONTENT_FILL' && Array.isArray(request.actions)) {
        fillSafeFields(request.actions)
          .then(() => sendResponse({ ok: true }))
          .catch((error: unknown) => {
            log.error('Fill failed', error);
            sendResponse({ ok: false, code: 'FILL_FAILED', message: 'Could not fill this page' });
          });
        return true;
      }

      return false;
    });

    // --- startup -----------------------------------------------------------
    if (!shouldEngage()) {
      log.debug('No application-shaped form on this page; staying idle');
      return;
    }

    log.info('Application-shaped page detected; ready to scan on request');

    // Watch for dynamically revealed fields, but do NOT auto-scan on load.
    // Scanning is user-initiated: an unrequested scan on every page with three
    // inputs would be both surprising and wasteful.
    watchForNewFields(() => {
      log.debugLazy(() => ['New nodes appeared; a rescan would be useful']);
    });
  },
});

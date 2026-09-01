/**
 * Service worker (MV3 background).
 * ---------------------------------------------------------------------------
 * The coordinator, and the ONLY context that touches the applicant profile.
 *
 * Responsibilities (spec section 10.2):
 *   - validate every inbound message,
 *   - load only the profile data the request actually needs,
 *   - map descriptors to canonical paths,
 *   - resolve values,
 *   - reply with minimal fill instructions,
 *   - persist corrections and audit records.
 *
 * MV3 SERVICE WORKERS ARE EPHEMERAL - THE CENTRAL CONSTRAINT
 * Chrome terminates this worker after ~30 seconds of inactivity and restarts it
 * on the next event. Any module-level variable is therefore a CACHE, never
 * state. Everything that must survive lives in storage.
 *
 * Concretely, that rules out the shape most extension tutorials use:
 *
 *     let currentProfile;                       // WRONG - gone after eviction
 *     chrome.runtime.onMessage.addListener(...) // reads a now-undefined value
 *
 * Every handler below reloads what it needs. That is a few milliseconds from
 * chrome.storage, and it is the difference between an extension that works and
 * one that fails intermittently after the user pauses to read a job posting.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { toAppError } from '@shared/errors';
import { createLogger, setLogLevel } from '@shared/logging';
// SECURITY: message-boundary rate limiting - see shared/rate-limit.ts.
import { TokenBucket } from '@shared/rate-limit';
import {
  errorResponse,
  MESSAGE_PROTOCOL_VERSION,
  parseRequest,
  type ExtensionResponse,
  type ReportFillResultsRequest,
  type ResolveApplicationFieldsRequest,
  type ResolvedFieldAction,
} from '@shared/messages';
import { ChromeLocalStore } from '@storage/key-value-store';
import { runMigrations } from '@storage/migrations';
import { TOOLBAR_SCAN_SIGNAL, ToolbarScanStore } from '@storage/toolbar-scan';
import { StoredProfileRepository } from '@profile/repository';
import { isProfilePath, labelForPath, parseCollectionPath } from '@profile/paths';
import { currentEmploymentIndex, mostRecentEducationIndex } from '@profile/selectors';
import { LearnedMappingStore, type LearnedMappingIndex } from '@learning/mapping-memory';
import { AuditRepository } from '@audit/repository';
import { buildAuditRecords, buildUnmatchedRecords, type FillResultInput } from '@audit/join';
import { PendingRunStore, pendingKey, type PendingFieldAudit } from '@audit/pending';
import { canonicalUrl } from '@audit/types';
import { newId } from '@shared/ids';
import { computeFingerprints, selectQuestionText } from '@form-engine/fingerprints/fingerprint';
import { mapField, type CollectionEntryIndexes } from '@form-engine/mapper/mapper';
import { isResumeField } from '@form-engine/mapper/resume-field';
import { resolveValue } from '@form-engine/resolver/resolver';
import { decideFill } from '@form-engine/confidence/policy';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import { BackendGateway } from '@backend/gateway';
import { createSemanticPort } from '@backend/semantic';
import {
  applySemanticFallback,
  summariseRun,
  SemanticConceptCache,
  type FieldOutcome,
  type SemanticFieldUpdate,
} from '@semantic/index';

const log = createLogger('background');

/**
 * WXT wraps the worker body in `defineBackground`. The callback runs
 * SYNCHRONOUSLY when the worker starts, which is the requirement MV3 imposes:
 * `chrome.runtime.onMessage` listeners must be registered in the first turn of
 * the event loop, or an event that woke the worker is delivered before we are
 * listening and is lost.
 */
export default defineBackground(() => {

  /**
   * When this worker instance started.
   *
   * Not persistent state - it is a diagnostic. Seeing it change between two PINGs
   * tells a developer the worker was evicted and restarted, which explains a
   * whole class of otherwise mysterious behaviour.
   */
  const WORKER_STARTED_AT = Date.now();

  /**
   * Cached-per-instance, rebuilt on every wake-up.
   *
   * Constructing these is nearly free (they hold no data, only a store reference),
   * so there is no reason to reach for a lazy singleton that would then need
   * invalidation logic.
   */
  const store = new ChromeLocalStore();
  const profileRepository = new StoredProfileRepository(store);
  const learnedMappings = new LearnedMappingStore(store);

  /**
   * Application history (spec section 24).
   *
   * Two stores because the data has two lifetimes. `pendingRuns` holds the
   * mapping metadata of a scan in session storage until the fill results that
   * complete it arrive - minutes, and never written to disk. `auditHistory`
   * holds the finished rows in IndexedDB - months, and pruned by policy.
   *
   * NEITHER MAY EVER FAIL A FILL. History is a convenience; a fill that worked
   * must never be reported as failed because a history write did. Every use
   * below logs and continues.
   */
  const pendingRuns = new PendingRunStore();
  const auditHistory = new AuditRepository();
  const toolbarScans = new ToolbarScanStore();

  /**
   * The semantic fallback (see `@semantic`), wired HERE and only here.
   *
   * This is the composition root: `@semantic` declares the port it needs and
   * `@backend` implements it, so neither package imports the other and no test
   * in either can reach a socket by accident.
   *
   * Constructed unconditionally and cheaply. The gateway makes no request until
   * asked, the cache reads no storage until queried, and a scan whose fields the
   * deterministic pipeline fully understood produces an empty refusal queue and
   * therefore touches neither.
   */
  const semanticCache = new SemanticConceptCache(store);
  /**
   * Held rather than inlined into the port, because `usage()` is how the panel
   * learns how many AI answers are left today. Brief §5: a rate limit must be
   * surfaced, not silently swallowed - a user whose fields quietly stop
   * improving has no way to tell that from the feature simply not helping.
   */
  const semanticGateway = new BackendGateway(store);
  const semanticPort = createSemanticPort(semanticGateway);

  /**
   * Storage readiness, tracked per worker instance.
   *
   * Migrations must run before any read. Because the worker can restart at any
   * time, this promise is created at module scope and awaited by every handler:
   * the first handler after a wake-up waits for migrations, and subsequent ones
   * get the already-resolved promise. That gives us "run exactly once per worker
   * instance" without a mutex or a flag that could be read mid-write.
   */
  const storageReady: Promise<boolean> = (async () => {
    const result = await runMigrations(store);
    if (!result.ok) {
      log.error('Storage migration failed; the extension will not fill anything', result.error.code);
      return false;
    }
    log.info(`Storage ready at version ${result.value}`);
    return true;
  })();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  chrome.runtime.onInstalled.addListener((details) => {
    log.info(`Installed: ${details.reason}`);
  });

  /**
   * Make the toolbar click mean "open here and scan here".
   *
   * Why not `openPanelOnActionClick: true`? Chrome consumes that click to toggle
   * the panel and does not dispatch `chrome.action.onClicked`. The click still
   * grants `activeTab`, but the panel has no event telling it that access was
   * restored, so the user lands in a two-step loop: click the icon, then click
   * Scan. Handling the action ourselves preserves the same narrow permission
   * model and lets the panel consume the click as the scan request too.
   *
   * `sidePanel.open()` must be CALLED synchronously from the action listener.
   * The storage write starts beside it rather than being awaited first; awaiting
   * would lose the browser's user-gesture token on some Chrome versions.
   */
  const openSidePanel = chrome.sidePanel?.open?.bind(chrome.sidePanel);
  if (chrome.sidePanel?.setPanelBehavior !== undefined) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: openSidePanel === undefined })
      .catch((error: unknown) => {
        log.warn('Could not set side panel behaviour', toAppError(error).message);
      });
  }

  if (openSidePanel !== undefined) {
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id === undefined) return;
      const tabId = tab.id;

      const opening = openSidePanel({ tabId }).catch((error: unknown) => {
        log.warn('Could not open the side panel', toAppError(error).message);
      });
      const queued = toolbarScans.request(tabId);

      void Promise.all([opening, queued]).then(([, saved]) => {
        if (!saved.ok) {
          log.warn('Could not queue the toolbar scan', saved.error.code);
          return;
        }

        // Fast path for a panel that was already open. A newly-created panel may
        // not have mounted its listener yet; the session record above is the
        // reliable fallback it consumes during mount.
        void chrome.runtime
          .sendMessage({ type: TOOLBAR_SCAN_SIGNAL, tabId })
          .catch(() => undefined);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  /**
   * SECURITY: inbound message budget, per sender.
   *
   * A content script runs inside a page we do not control. If a page ever gets
   * to drive it, the cheapest attack is not stealing data - it is a flood of
   * RESOLVE_APPLICATION_FIELDS, each one loading the profile and running the
   * mapping pipeline over up to 500 descriptors. That burns CPU and battery and
   * pins the service worker awake indefinitely.
   *
   * 40 messages of burst covers the largest legitimate exchange by a wide
   * margin (one scan is ONE message, not one per field). The sustained rate is
   * set from the noisiest legitimate sender: the scanner's MutationObserver
   * broadcast, debounced to at most one per `mutationDebounceMs` (200ms on a
   * fast machine, so 5/second). 10/second leaves that a factor of two of
   * headroom and is still far below what a flood would need. Keyed by tab
   * where there is one, so a hostile page cannot exhaust the budget of a
   * different tab or of the side panel; extension pages share one key.
   *
   * Cost is one Map lookup and an integer compare per message - see
   * shared/rate-limit.ts for why this is a bucket rather than a request log.
   */
  const messageBudget = new TokenBucket({
    capacity: 40,
    refillPerSecond: 10,
    // One entry per tab that has ever messaged us, bounded so a page cycling
    // through tabs cannot grow the map. LRU eviction only ever hands an idle
    // sender a fresh (full) bucket.
    maxKeys: 64,
  });

  /**
   * Single entry point for every inbound message.
   *
   * `return true` keeps the message channel open for an async reply - omitting it
   * is the most common MV3 bug, and it manifests as the sender's callback never
   * firing rather than as an error.
   */
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    /**
     * SECURITY: SENDER CHECK, BEFORE PARSING.
     *
     * `chrome.runtime.onMessage` in MV3 does not receive messages from web
     * pages (those would arrive on `onMessageExternal`, which we never
     * register). But this listener is one `externally_connectable` entry - or
     * one future contributor adding one - away from being reachable by any
     * site, and the cost of being certain is a string compare. A message
     * without our own extension id is dropped without being parsed, so a
     * malformed payload from an unknown sender never even reaches Zod.
     */
    if (sender.id !== chrome.runtime.id) {
      log.warn('Dropped a message from an unexpected sender');
      sendResponse(errorResponse('SENDER_REJECTED', 'Unrecognised sender'));
      return false;
    }

    // Per-tab budget. `sender.tab` is absent for extension pages (side panel,
    // options), which get their own shared bucket.
    const budgetKey = sender.tab?.id === undefined ? 'extension' : `tab:${sender.tab.id}`;
    const decision = messageBudget.take(budgetKey);
    if (!decision.allowed) {
      log.warn(`Rate limited ${budgetKey}; retry in ${decision.retryAfterMs}ms`);
      sendResponse(errorResponse('RATE_LIMITED', 'Too many requests - try again in a moment'));
      return false;
    }

    // The tab id is part of how a fill result finds its scan - see
    // audit/pending.ts on why a URL alone is not enough on a careers site.
    handleMessage(raw, sender.tab?.id)
      .then(sendResponse)
      .catch((error: unknown) => {
        // Nothing may escape this listener. An unhandled rejection here takes the
        // worker down and every subsequent message fails silently.
        const appError = toAppError(error);
        log.error('Unhandled error while handling message', appError.code, appError.message);
        sendResponse(errorResponse(appError.code, appError.message));
      });
    return true;
  });

  async function handleMessage(
    raw: unknown,
    senderTabId: number | undefined,
  ): Promise<ExtensionResponse> {
    // TRUST BOUNDARY. Everything past this line has a validated shape.
    const parsed = parseRequest(raw);
    if (!parsed.ok) {
      log.warn('Rejected malformed message', parsed.issue);
      return errorResponse('MESSAGE_INVALID', 'Message did not match the expected shape');
    }

    const request = parsed.request;

    switch (request.type) {
      case 'PING':
        return {
          ok: true,
          type: 'PONG',
          version: MESSAGE_PROTOCOL_VERSION,
          workerStartedAt: WORKER_STARTED_AT,
          storageReady: await storageReady,
        };

      case 'RESOLVE_APPLICATION_FIELDS':
        return resolveFields(request, senderTabId);

      case 'REPORT_FILL_RESULTS': {
        // A verified fill the user did not change is evidence the rule behind
        // it was right, so each one nudges that rule's confidence up.
        //
        // Note what is NOT done here: a FAILED fill is not counted against a
        // rule. The mapping may have been perfectly correct and the control
        // simply undrivable. Only an explicit user correction counts as a miss -
        // see RECORD_CORRECTION. Conflating "could not fill" with "filled the
        // wrong thing" would retire good rules for a reason that has nothing to
        // do with whether they were right.
        for (const result of request.results) {
          if (result.verified) void learnedMappings.recordSuccess(result.fingerprints);
        }
        log.debugLazy(() => [
          `Fill results: ${request.results.filter((r) => r.verified).length}/${request.results.length} verified`,
        ]);

        await recordHistory(request, senderTabId);
        return { ok: true, type: 'OK' };
      }

      case 'GET_PAGE_STATE':
        return { ok: true, type: 'OK' };

      case 'PAGE_FIELDS_CHANGED':
        // Acknowledged and otherwise ignored, deliberately. The broadcast is
        // addressed to the SIDE PANEL - a content script cannot message an
        // extension page directly, so it goes through runtime.sendMessage,
        // which reaches every listening context including this one.
        //
        // Recognising it here stops the worker rejecting it as malformed on
        // every re-render of a dynamic form. Acting on it would mean filling a
        // field because the PAGE changed rather than because the user asked,
        // and there is deliberately no such path.
        return { ok: true, type: 'OK' };

      case 'RECORD_CORRECTION': {
        // Reject an unrecognised path BEFORE storing it. A rule pointing at a
        // path that does not exist would resolve to nothing forever, and the
        // user would reasonably conclude their correction had been ignored.
        if (request.profilePath !== null && !isProfilePath(request.profilePath)) {
          return errorResponse('MESSAGE_INVALID', `Unknown profile field: ${request.profilePath}`);
        }

        const field = request.field as FieldDescriptor;
        const fingerprints = computeFingerprints(field);

        // If a rule produced the answer the user is now correcting, mark it as
        // having missed - which lowers its confidence and, after enough misses,
        // retires it outright. Done BEFORE the new rule is written, and only
        // when the target actually changed, so re-confirming a rule does not
        // penalise it.
        const previous = (await learnedMappings.index()).find(fingerprints);
        if (previous !== null && previous.profilePath !== (request.profilePath ?? '')) {
          await learnedMappings.recordMiss(fingerprints);
        }

        const question = selectQuestionText(field);
        const recorded = await learnedMappings.recordCorrection({
          fingerprints,
          scope: request.scope,
          profilePath: request.profilePath,
          hostname: field.hostname,
          ats: field.ats,
          ...(question.length > 0 ? { normalizedLabel: question } : {}),
          fieldType: field.kind,
        });

        if (!recorded.ok) return errorResponse(recorded.error.code, recorded.error.message);

        // Mark the history rows this field already produced. A correction says
        // the mapping was wrong, and it was wrong every time it was used - so
        // the history should not go on showing those fills as unremarkable
        // successes. Keyed by the `exact` fingerprint, the same one the row
        // was written with.
        // What the correction MEANT is derived per row from what the policy had
        // decided about it: correcting a field we filled is a wrong fill;
        // correcting one we refused is the learning loop working. The path is
        // passed because `null` - "this field means nothing" - is a third case
        // again. See `deriveCorrectionOutcome`.
        const marked = await auditHistory.recordOutcome(fingerprints.exact, request.profilePath);
        if (!marked.ok) log.warn('Could not mark history rows corrected', marked.error.code);

        log.info(`Correction stored: ${request.profilePath ?? 'none'} at scope ${request.scope}`);
        return { ok: true, type: 'OK' };
      }
    }
  }

  /**
   * The heart of the extension: descriptors in, fill instructions out.
   *
   * The pipeline, one stage per line, each stage a pure function:
   *
   *     descriptor -> mapField -> resolveValue -> decideFill -> action
   *
   * Only this function is impure, and only because it loads the profile. That is
   * why the intelligence is testable without a browser and this file is thin.
   */
  async function resolveFields(
    request: ResolveApplicationFieldsRequest,
    senderTabId: number | undefined,
  ): Promise<ExtensionResponse> {
    if (!(await storageReady)) {
      return errorResponse('MIGRATION_FAILED', 'Stored data could not be prepared');
    }

    const loaded = await profileRepository.load();
    if (!loaded.ok) {
      return errorResponse(loaded.error.code, loaded.error.message);
    }
    if (loaded.value === undefined) {
      return errorResponse('PROFILE_NOT_FOUND', 'Create your profile before filling applications');
    }

    const profile = loaded.value;

    // Loaded ONCE per batch, not per field. The mapper's lookup is synchronous
    // by design (see learning/types.ts), so this is the point where the async
    // storage read happens.
    const learned = await learnedMappings.index();

    /**
     * Which entry a bare "School" or "Employer" question means.
     *
     * Computed here rather than in the mapper because it is a question about
     * the PROFILE - most recent graduation, currently-held job - and keeping
     * the mapper free of profile access is what makes the whole mapping
     * cascade testable from plain objects.
     *
     * The selectors are explicitly heuristics (see their doc comments), so the
     * result is fed through the normal confidence policy like everything else:
     * an unqualified "School" on a form is a suggestion the user can accept,
     * not a silent assertion about which of their three degrees was meant.
     */
    const entryIndexes: CollectionEntryIndexes = {
      education: mostRecentEducationIndex(profile) ?? 0,
      employment: currentEmploymentIndex(profile) ?? 0,
      // Projects have no "most relevant" ordering we can defend, so the first
      // one wins - which is the order the user themselves put them in.
      projects: 0,
    };

    const actions: ResolvedFieldAction[] = [];
    /**
     * What we knew about each field, for the history row it will produce.
     *
     * Collected here and stashed below rather than sent to the page: the
     * cascade stage that produced a mapping is our reasoning, and the page has
     * no business knowing it (see the data-minimisation note in messages.ts).
     */
    const auditFields: PendingFieldAudit[] = [];
    let readyToFill = 0;
    let needsReview = 0;
    let unknown = 0;

    /**
     * What the deterministic pipeline concluded about each field, kept so the
     * semantic fallback can see the REFUSALS. Collected during the loop rather
     * than recomputed after it: a second run against the same profile could
     * disagree with the first, and then the page and the history would describe
     * different decisions.
     */
    const outcomes: FieldOutcome[] = [];

    for (const descriptor of request.fields) {
      // A failure on one field must never abort the batch. A single unusual
      // control should cost that control, not the other nineteen on the page.
      try {
        const resolved = resolveOneField(
          profile,
          descriptor as FieldDescriptor,
          learned,
          entryIndexes,
        );
        actions.push(withFormFacts(resolved.action, descriptor as FieldDescriptor));
        auditFields.push(resolved.audit);
        if (resolved.outcome !== undefined) outcomes.push(resolved.outcome);
      } catch (error) {
        log.warn('Field resolution failed', descriptor.localId, toAppError(error).message);
        actions.push({
          localId: descriptor.localId,
          action: 'skip',
          profilePath: null,
          mappingConfidence: 0,
          knowledgeState: 'unknown',
          explanation: 'Could not be processed',
        });
        // A field that threw still gets a history row, saying exactly that: it
        // was seen, and nothing was decided about it.
        auditFields.push({
          localId: descriptor.localId,
          fieldFingerprint: '',
          mappingConfidence: 0,
          mappingSource: 'none',
          decidedAction: 'skip',
        });
      }
    }

    /**
     * The semantic fallback, on the refusals only.
     *
     * Costs nothing - no storage read, no request - when the queue is empty,
     * which is every form the deterministic pipeline already understood. It
     * returns UPDATES rather than mutating: it has no way to express "leave
     * that field worse than you found it", so a failure of any kind is exactly
     * today's behaviour.
     */
    const semantic = await applySemanticFallback({
      profile,
      outcomes,
      port: semanticPort,
      cache: semanticCache,
    });
    applyUpdates(semantic.updates, actions, auditFields);

    /**
     * Reported only when the pass actually ran. The quota is read ONLY on a
     * failure: `usage()` is a storage read, and spending one on every scan to
     * tell the user something they did not ask about is the wrong trade.
     */
    const semanticSummary =
      semantic.modelCalls === 0 && semantic.error === undefined && semantic.updates.length === 0
        ? undefined
        : summariseRun(semantic, semantic.error !== undefined ? await readUsage() : undefined);

    await stashScan(request, senderTabId, auditFields);

    for (const action of actions) {
      if (action.action === 'fill' || action.action === 'attach_resume') readyToFill++;
      else if (action.action === 'suggest') needsReview++;
      else unknown++;
    }

    return {
      ok: true,
      type: 'RESOLVE_APPLICATION_FIELDS_RESULT',
      actions,
      summary: { detected: request.fields.length, readyToFill, needsReview, unknown },
      // Omitted entirely when the fallback did not run, so its absence means
      // "there was nothing it could have helped with" rather than "it failed
      // silently".
      ...(semanticSummary !== undefined ? { semantic: semanticSummary } : {}),
    };
  }

  /**
   * One field through the pipeline. Extracted so the loop above stays readable.
   *
   * Returns the action AND the audit metadata, because the two are produced by
   * the same reasoning and separating them would mean running the mapper twice
   * - and a second run against a changed profile or rule set could disagree
   * with the first, so history would describe a decision that was never made.
   */
  function resolveOneField(
    profile: Parameters<typeof resolveValue>[0],
    descriptor: FieldDescriptor,
    learned: LearnedMappingIndex,
    entryIndexes: CollectionEntryIndexes,
  ): { action: ResolvedFieldAction; audit: PendingFieldAudit; outcome?: FieldOutcome } {
    // The `exact` scope, which is what a correction is keyed by - so a history
    // row and the rule the user later writes about it agree on the field.
    const fingerprint = computeFingerprints(descriptor).exact;
    const detectedLabel = selectQuestionText(descriptor);

    /** The audit half, filled in from whatever the branch below knew. */
    const auditFor = (
      fields: Omit<PendingFieldAudit, 'localId' | 'fieldFingerprint' | 'detectedLabel'>,
    ): PendingFieldAudit => ({
      localId: descriptor.localId,
      fieldFingerprint: fingerprint,
      ...(detectedLabel.length > 0 ? { detectedLabel } : {}),
      ...fields,
    });
    // 0. A resume upload is not a profile value, so it is decided before the
    //    mapping cascade runs. It has no canonical path and a different
    //    adapter drives it - see form-engine/mapper/resume-field.ts for why
    //    the matcher is deliberately narrow.
    if (isResumeField(descriptor)) {
      const alreadyAttached = (descriptor.currentValue ?? '').trim().length > 0;
      const action = alreadyAttached ? ('skip' as const) : ('attach_resume' as const);
      return {
        action: {
          localId: descriptor.localId,
          action,
          profilePath: null,
          mappingConfidence: 0.95,
          knowledgeState: 'known',
          controlKind: descriptor.kind,
          explanation: alreadyAttached ? 'A file is already attached' : 'Resume upload',
        },
        // No mapping ran, so none is claimed. `decidedAction` carries the
        // meaning here: a resume is a document, not a profile value, and
        // recording a mapping source for it would be inventing one.
        audit: auditFor({ mappingConfidence: 0, mappingSource: 'none', decidedAction: action }),
      };
    }

    // 1. What is this field asking for? Past corrections are consulted here,
    //    and a user-confirmed one outranks every heuristic in the cascade.
    const mapping = mapField(descriptor, { learned, entryIndexes });

    if (mapping.profilePath === null) {
      return {
        action: {
          localId: descriptor.localId,
          action: 'skip',
          profilePath: null,
          mappingConfidence: 0,
          knowledgeState: 'unknown',
          explanation: 'Not recognised',
        },
        // The most valuable row in the history: a question the user had to
        // answer by hand, recorded with the text the form used, which is
        // exactly what a future alias or correction has to match.
        audit: auditFor({ mappingConfidence: 0, mappingSource: mapping.source, decidedAction: 'skip' }),
        // The queue decides whether this refusal is the recoverable kind. It
        // is not this function's business to know.
        outcome: { descriptor, mapping },
      };
    }

    // 2. What value should this specific control receive?
    const resolution = resolveValue(profile, mapping.profilePath, descriptor);

    const base = {
      localId: descriptor.localId,
      profilePath: mapping.profilePath,
      mappingConfidence: mapping.confidence,
      knowledgeState: mapping.knowledgeState,
      // Echoed back so the fill engine can choose an adapter by what the
      // control is. The page told us; it should not have to work it out again.
      controlKind: descriptor.kind,
    };

    /** The audit half for a field the cascade did understand. */
    const mappedAudit = (decidedAction: PendingFieldAudit['decidedAction']): PendingFieldAudit =>
      auditFor({
        // Spread conditionally rather than assigning `undefined`:
        // `exactOptionalPropertyTypes` treats an explicit undefined as a
        // different thing from an absent key, and so does structured clone.
        ...(mapping.profilePath !== null ? { mappedProfilePath: mapping.profilePath } : {}),
        mappingConfidence: mapping.confidence,
        mappingSource: mapping.source,
        decidedAction,
      });

    if (!resolution.ok) {
      return {
        action: {
          ...base,
          action: 'skip',
          explanation:
            resolution.reason === 'no_entry'
              ? missingEntryExplanation(mapping.profilePath)
              : resolution.reason === 'no_value'
                ? `Your profile has no ${labelForPath(mapping.profilePath).toLowerCase()}`
                : 'No value could be formatted for this control',
        },
        // Understood, and deliberately not filled. History distinguishes this
        // from 'not recognised': one is a gap in the profile, the other a gap
        // in the mapping, and they need different fixes.
        audit: mappedAudit('skip'),
        // Only `no_matching_option` will survive the queue; the rest mean the
        // profile is incomplete, which no model can fix.
        outcome: { descriptor, mapping, resolution },
      };
    }

    // 3. Are we confident enough to act? The policy owns this decision entirely -
    //    nothing here re-implements or second-guesses a threshold.
    const decision = decideFill({
      mappingConfidence: mapping.confidence,
      valueConfidence: resolution.resolved.confidence,
      valueVerifiedByUser: resolution.resolved.verifiedByUser,
      profilePath: mapping.profilePath,
      valueMissing: false,
      controlHasValue: (descriptor.currentValue ?? '').trim().length > 0,
    });

    if (decision === 'skip') {
      return {
        action: { ...base, action: 'skip', explanation: explainSkip(descriptor) },
        audit: mappedAudit('skip'),
      };
    }

    const optionValue = resolution.resolved.option?.value;
    const decided = decision === 'autofill' ? ('fill' as const) : ('suggest' as const);

    return {
      action: {
        ...base,
        action: decided,
        value: resolution.resolved.value,
        ...(optionValue !== undefined ? { optionValue } : {}),
        explanation: `${labelForPath(mapping.profilePath)} (${mapping.reasons[0]?.signal ?? 'mapped'})`,
      },
      // NOTE what does not travel into the audit: `resolution.resolved.value`.
      // The applicant's answer stops here, at the boundary between deciding and
      // remembering. See audit/types.ts.
      audit: mappedAudit(decided),
    };
  }

  /**
   * The gateway's daily counter, or nothing.
   *
   * A failure to read it is not worth reporting: we are already reporting a
   * failure, and "we could not tell you how much is left" would replace a
   * useful message with a confusing one.
   */
  async function readUsage(): Promise<
    { used: number; limit: number; resetsInMs: number } | undefined
  > {
    try {
      return await semanticGateway.usage();
    } catch (error) {
      log.debugLazy(() => ['Could not read model quota', toAppError(error).message]);
      return undefined;
    }
  }

  /**
   * Splice the semantic pass's updates into the actions and the history rows.
   *
   * Kept here rather than in `@semantic` because `ResolvedFieldAction` and
   * `PendingFieldAudit` are this layer's vocabulary - a wire type and a history
   * type. The semantic package returns what it decided; translating that into
   * what the page and the history each need is the entrypoint's job, and
   * keeping it that way is why `@semantic` has no idea a message format exists.
   *
   * The two are written TOGETHER, always. A history row that disagreed with the
   * action the page received would describe a decision that was never made.
   */
  function applyUpdates(
    updates: readonly SemanticFieldUpdate[],
    actions: ResolvedFieldAction[],
    auditFields: PendingFieldAudit[],
  ): void {
    if (updates.length === 0) return;
    const indexOf = new Map(actions.map((action, index) => [action.localId, index]));

    for (const update of updates) {
      const index = indexOf.get(update.localId);
      if (index === undefined) continue;

      const previous = actions[index];
      if (previous === undefined) continue;

      actions[index] = {
        localId: update.localId,
        action: update.action,
        profilePath: update.profilePath,
        mappingConfidence: update.mappingConfidence,
        knowledgeState: update.knowledgeState,
        ...(previous.controlKind !== undefined ? { controlKind: previous.controlKind } : {}),
        value: update.value,
        ...(update.optionValue !== undefined ? { optionValue: update.optionValue } : {}),
        explanation: update.explanation,
      };

      const row = auditFields[index];
      if (row !== undefined) {
        auditFields[index] = {
          ...row,
          mappedProfilePath: update.profilePath,
          mappingConfidence: update.mappingConfidence,
          // The `MappingSource` the spec declared for this and left unwired.
          mappingSource: 'semantic',
          decidedAction: update.action,
        };
      }
    }
  }

  /**
   * Remember what a scan decided, so the fill report can be joined to it.
   *
   * Awaited rather than fired and forgotten: the fill report can follow within
   * milliseconds on a fast machine, and a stash that lands second would be
   * read as absent - producing history rows with no labels, intermittently,
   * which is the hardest kind of bug to see in a product like this.
   *
   * A failure is logged and swallowed. Losing history is a small harm; failing
   * a scan because history could not be written is a large one.
   */
  async function stashScan(
    request: ResolveApplicationFieldsRequest,
    senderTabId: number | undefined,
    fields: PendingFieldAudit[],
  ): Promise<void> {
    const pageUrl = canonicalUrl(request.page.url);
    const stashed = await pendingRuns.stash(pendingKey(senderTabId, pageUrl), {
      runId: newId(),
      createdAt: Date.now(),
      pageUrl,
      hostname: request.page.hostname,
      ats: request.page.ats,
      fields,
    });

    if (!stashed.ok) log.warn('Could not stash the scan for history', stashed.error.code);
  }

  /**
   * Write the history rows for a fill.
   *
   * The join key is the tab plus the canonical URL, matching what `stashScan`
   * wrote. When there is no stash - it expired, or the browser was restarted
   * between the scan and the fill - the rows are still written, from the report
   * alone, and say plainly that the reasoning behind them is no longer known.
   *
   * One note on the orphan path: the ATS kind there comes from the report,
   * where the scanner currently sends a literal `unknown` rather than the
   * detected value. Rows joined to a stash carry the real kind, which is the
   * overwhelming majority; fixing the report's page context is a separate
   * change to the content script's message.
   */
  async function recordHistory(
    request: ReportFillResultsRequest,
    senderTabId: number | undefined,
  ): Promise<void> {
    const pageUrl = canonicalUrl(request.page.url);
    const now = new Date();

    const results: FillResultInput[] = request.results.map((result) => ({
      localId: result.localId,
      attempted: result.attempted,
      verified: result.verified,
      ...(result.userInitiated === true ? { userInitiated: true } : {}),
      ...(result.adapter !== undefined ? { adapter: result.adapter } : {}),
      ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
    }));

    const pending = await pendingRuns.get(pendingKey(senderTabId, pageUrl));
    const records =
      pending.ok && pending.value !== undefined
        ? buildAuditRecords(pending.value, results, now)
        : buildUnmatchedRecords(
            {
              runId: newId(),
              pageUrl,
              hostname: request.page.hostname,
              ats: request.page.ats,
            },
            results,
            now,
          );

    const written = await auditHistory.record(records);
    if (!written.ok) {
      // Deliberately not returned to the caller. The fill happened; reporting
      // it as failed because the history write failed would be a lie in the
      // one direction this product must never lie.
      log.warn('Could not write application history', written.error.code);
      return;
    }

    // Pruned where the growth happens, so the store is never more than one run
    // over its limit and no background alarm has to wake this worker.
    const pruned = await auditHistory.prune(now);
    if (!pruned.ok) log.warn('Could not prune application history', pruned.error.code);
    else if (pruned.value > 0) log.debugLazy(() => [`Pruned ${pruned.value} history rows`]);
  }

/**
   * Attach what the FORM said about a field to the action the panel receives.
   *
   * Kept out of `resolveOneField` because these are not decisions - they are the
   * employer's markup, copied through unchanged, and every branch of that
   * function would otherwise have to remember to carry them.
   *
   * `prefilled` is a boolean and never the value. The panel needs to know that a
   * required field is already answered; it does not need to know what the answer
   * is, and a value in this message would be page content travelling for no
   * reason - see the data-minimisation note in messages.ts.
   */
  function withFormFacts(
    action: ResolvedFieldAction,
    descriptor: FieldDescriptor,
  ): ResolvedFieldAction {
    return {
      ...action,
      ...(descriptor.required ? { required: true } : {}),
      ...((descriptor.currentValue ?? '').trim().length > 0 ? { prefilled: true } : {}),
    };
  }

  /**
   * "We understood the question, and you have not added anything it could
   * be answered from."
   *
   * Specifically: the COLLECTION has no such entry. `labelForPath` renders
   * these paths as "Education 1 - institution", which read back as "Your
   * profile has no education 1 - institution" - technically true and useless
   * as an instruction. What the user needs to know is that the section is
   * empty and where to fix it.
   */
  function missingEntryExplanation(path: string): string {
    const parsed = parseCollectionPath(path);
    if (parsed === null) return 'Your profile has nothing to put here';
    const noun =
      parsed.collection === 'education'
        ? 'schools'
        : parsed.collection === 'employment'
          ? 'jobs'
          : 'projects';
    return `Add your ${noun} in your profile to fill this`;
  }

  /** Human-readable reason a mapped field was still left alone. */
  function explainSkip(descriptor: FieldDescriptor): string {
    if ((descriptor.currentValue ?? '').trim().length > 0) return 'Already filled';
    return 'Not confident enough to fill';
  }

  /**
   * Log level from the user's settings, applied once per worker instance.
   *
   * Read lazily and never awaited by the handlers: logging verbosity is not worth
   * delaying a message for, and a slightly late level change costs nothing.
   */
  void (async () => {
    const settings = await store.get<{ logLevel?: string }>('aa:settings');
    const level = settings.ok ? settings.value?.logLevel : undefined;
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
      setLogLevel(level);
    }
  })();

});

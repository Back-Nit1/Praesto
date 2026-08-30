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
import {
  errorResponse,
  MESSAGE_PROTOCOL_VERSION,
  parseRequest,
  type ExtensionResponse,
  type ResolveApplicationFieldsRequest,
  type ResolvedFieldAction,
} from '@shared/messages';
import { ChromeLocalStore } from '@storage/key-value-store';
import { runMigrations } from '@storage/migrations';
import { StoredProfileRepository } from '@profile/repository';
import { isProfilePath, labelForPath } from '@profile/paths';
import { LearnedMappingStore, type LearnedMappingIndex } from '@learning/mapping-memory';
import { computeFingerprints, selectQuestionText } from '@form-engine/fingerprints/fingerprint';
import { mapField } from '@form-engine/mapper/mapper';
import { isResumeField } from '@form-engine/mapper/resume-field';
import { resolveValue } from '@form-engine/resolver/resolver';
import { decideFill } from '@form-engine/confidence/policy';
import type { FieldDescriptor } from '@form-engine/descriptor/types';

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

    // Clicking the toolbar icon opens the side panel. Configured here rather than
    // in the manifest because `setPanelBehavior` is the only way to get the
    // icon-click behaviour, and it must be re-applied after an update.
    if (chrome.sidePanel?.setPanelBehavior !== undefined) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
        // Not fatal: the user can still open the panel from the extensions menu.
        log.warn('Could not set side panel behaviour', toAppError(error).message);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  /**
   * Single entry point for every inbound message.
   *
   * `return true` keeps the message channel open for an async reply - omitting it
   * is the most common MV3 bug, and it manifests as the sender's callback never
   * firing rather than as an error.
   */
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    handleMessage(raw)
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

  async function handleMessage(raw: unknown): Promise<ExtensionResponse> {
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
        return resolveFields(request);

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
        return { ok: true, type: 'OK' };
      }

      case 'GET_PAGE_STATE':
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

    const actions: ResolvedFieldAction[] = [];
    let readyToFill = 0;
    let needsReview = 0;
    let unknown = 0;

    for (const descriptor of request.fields) {
      // A failure on one field must never abort the batch. A single unusual
      // control should cost that control, not the other nineteen on the page.
      try {
        actions.push(resolveOneField(profile, descriptor as FieldDescriptor, learned));
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
      }
    }

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
    };
  }

  /** One field through the pipeline. Extracted so the loop above stays readable. */
  function resolveOneField(
    profile: Parameters<typeof resolveValue>[0],
    descriptor: FieldDescriptor,
    learned: LearnedMappingIndex,
  ): ResolvedFieldAction {
    // 0. A resume upload is not a profile value, so it is decided before the
    //    mapping cascade runs. It has no canonical path and a different
    //    adapter drives it - see form-engine/mapper/resume-field.ts for why
    //    the matcher is deliberately narrow.
    if (isResumeField(descriptor)) {
      const alreadyAttached = (descriptor.currentValue ?? '').trim().length > 0;
      return {
        localId: descriptor.localId,
        action: alreadyAttached ? 'skip' : 'attach_resume',
        profilePath: null,
        mappingConfidence: 0.95,
        knowledgeState: 'known',
        explanation: alreadyAttached ? 'A file is already attached' : 'Resume upload',
      };
    }

    // 1. What is this field asking for? Past corrections are consulted here,
    //    and a user-confirmed one outranks every heuristic in the cascade.
    const mapping = mapField(descriptor, { learned });

    if (mapping.profilePath === null) {
      return {
        localId: descriptor.localId,
        action: 'skip',
        profilePath: null,
        mappingConfidence: 0,
        knowledgeState: 'unknown',
        explanation: 'Not recognised',
      };
    }

    // 2. What value should this specific control receive?
    const resolution = resolveValue(profile, mapping.profilePath, descriptor);

    const base = {
      localId: descriptor.localId,
      profilePath: mapping.profilePath,
      mappingConfidence: mapping.confidence,
      knowledgeState: mapping.knowledgeState,
    };

    if (!resolution.ok) {
      return {
        ...base,
        action: 'skip',
        explanation:
          resolution.reason === 'no_value'
            ? `Your profile has no ${labelForPath(mapping.profilePath).toLowerCase()}`
            : 'No value could be formatted for this control',
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
      return { ...base, action: 'skip', explanation: explainSkip(descriptor) };
    }

    const optionValue = resolution.resolved.option?.value;

    return {
      ...base,
      action: decision === 'autofill' ? 'fill' : 'suggest',
      value: resolution.resolved.value,
      ...(optionValue !== undefined ? { optionValue } : {}),
      explanation: `${labelForPath(mapping.profilePath)} (${mapping.reasons[0]?.signal ?? 'mapped'})`,
    };
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

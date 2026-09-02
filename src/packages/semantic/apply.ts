/**
 * The semantic pass, as one function.
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT FOUR CALLS AT THE CALL SITE.
 * It was four calls in `background.ts`, where nothing could test it, and the
 * fixture test had its own copy of the same four calls. Two implementations of
 * "what order do these run in" is one more than the number that can be right,
 * and the copy in the test would have gone on passing while the one that ships
 * drifted. The entrypoint calls this; the fixture test calls this; the ordering
 * is asserted once.
 *
 * THE ORDER, WHICH IS THE DESIGN. Each step is cheaper than the next:
 *
 *     queue      free. Empty on a form the pipeline understood, and then this
 *                returns without reading storage or opening a socket.
 *     stage 1    cache first, then ONE batched call for what is left.
 *     resolve    the EXISTING resolver, unchanged.
 *     stage 2    the deterministic scorer, then at most one call per field.
 *     decideFill the EXISTING policy, unchanged.
 *
 * IT RETURNS UPDATES; IT MUTATES NOTHING. The caller owns its own action list
 * and splices these in. That keeps this module ignorant of the message types
 * (which belong to `@shared/messages`), and it makes the central safety
 * property trivially checkable: this function has no way to express "leave that
 * field worse than you found it". A field it cannot improve simply produces no
 * update, and keeps the refusal it already had.
 *
 * WHICH IS ALSO WHY "with the network disabled, behaviour is byte-for-byte
 * today's" is true by construction rather than by testing every failure path.
 *
 * ON READING THE PROFILE. This module does read it - through `resolveValue`,
 * the same resolver the deterministic pipeline uses. The privacy property that
 * matters is not "no profile in this package"; it is that STAGE 1 SENDS NO
 * PROFILE DATA, which is enforced by the types in `port.ts` and asserted by
 * serialising what was actually sent. Stage 2 sends one already-resolved value
 * for one field, and only after the free scorer has failed.
 */
import { toAppError, type AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { labelForPath, type ProfilePath } from '@profile/paths';
import type { ApplicantProfile } from '@profile/schema';
import { resolveValue } from '@form-engine/resolver/resolver';
import {
  decideFill,
  DEFAULT_CONFIDENCE_POLICY,
  type ConfidencePolicyConfig,
} from '@form-engine/confidence/policy';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { KnowledgeState } from '@form-engine/mapper/types';
import { resolveConcepts } from './concept';
import { chooseOption } from './option-match';
import { collectRefusals, type FieldOutcome } from './queue';
import type { SemanticConceptCache } from './cache';
import type { SemanticPort } from './port';

const log = createLogger('semantic:apply');

/** Everything the whole fallback needs: the pipeline's verdicts, and a way to ask. */
export interface SemanticApplyInput {
  readonly profile: ApplicantProfile;
  /** What the deterministic pipeline concluded about every scanned field. */
  readonly outcomes: readonly FieldOutcome[];
  readonly port: SemanticPort;
  readonly cache: SemanticConceptCache;
  readonly config?: ConfidencePolicyConfig;
}

/** One field this pass can improve. Never a downgrade - see the header. */
export interface SemanticFieldUpdate {
  readonly localId: string;
  readonly action: 'fill' | 'suggest';
  readonly profilePath: ProfilePath;
  readonly mappingConfidence: number;
  readonly knowledgeState: KnowledgeState;
  readonly value: string | boolean;
  readonly optionValue?: string;
  /** A sentence for the review panel. */
  readonly explanation: string;
  /** Which stage produced it. For the audit row and the debug panel. */
  readonly origin: 'stage1' | 'stage2';
}

export interface SemanticApplyOutcome {
  readonly updates: readonly SemanticFieldUpdate[];
  /**
   * Model calls actually made. Zero on a fully cached page - the number
   * acceptance criterion #3 asks to be demonstrated rather than asserted.
   */
  readonly modelCalls: number;
  /**
   * The first failure, if any. SURFACED, NOT SWALLOWED (brief §5): a rate limit
   * carries `retryAfterMs`, and a panel that reported only "nothing changed"
   * would make "you are out of AI answers until tomorrow" indistinguishable
   * from "nothing matched" - the first of which the user can act on.
   */
  readonly error?: AppError;
}

export async function applySemanticFallback(
  input: SemanticApplyInput,
): Promise<SemanticApplyOutcome> {
  const config = input.config ?? DEFAULT_CONFIDENCE_POLICY;
  const refusals = collectRefusals(input.outcomes);

  // The cheap exit, and the common one. No storage read, no request, no cost.
  if (refusals.length === 0) return { updates: [], modelCalls: 0 };

  const updates: SemanticFieldUpdate[] = [];
  let modelCalls = 0;
  let error: AppError | undefined;

  try {
    const descriptors = new Map(refusals.map((field) => [field.fieldId, field.descriptor]));

    // --- stage 1: what are these questions asking? --------------------------
    const stage1 = await resolveConcepts({
      fields: refusals,
      port: input.port,
      cache: input.cache,
      config,
    });
    modelCalls += stage1.modelCalls;
    error ??= stage1.error;

    for (const concept of stage1.resolutions) {
      const descriptor = descriptors.get(concept.fieldId);
      if (descriptor === undefined) continue;

      const update = fromConcept(input.profile, descriptor, concept.profilePath, {
        confidence: concept.confidence,
        // 'previously_seen' is the state the spec already defines for "the user
        // has answered this exact question before".
        knowledgeState: concept.origin === 'cache' ? 'previously_seen' : 'probable',
        explanation: `${labelForPath(concept.profilePath)} (${
          concept.origin === 'cache' ? 'remembered from a past application' : 'our reading of this question'
        })`,
        origin: 'stage1',
      });
      if (update !== null) updates.push(update);
    }

    // --- stage 2: our answer against this control's options -----------------
    for (const field of refusals) {
      if (field.kind !== 'no_matching_option' || field.profilePath === null) continue;

      const chosen = await matchAgainstOptions(
        input.profile,
        field.descriptor,
        field.profilePath,
        input.port,
      );
      modelCalls += chosen.modelCalls;
      error ??= chosen.error;
      if (chosen.update !== null) updates.push(chosen.update);
    }
  } catch (caught) {
    // Unreachable by design - every module below returns a Result - so reaching
    // it is a bug worth a log line. Whatever was already decided is kept, and
    // every other field keeps the refusal it already had.
    error ??= toAppError(caught);
    log.warn('Semantic fallback failed; fields keep their refusals', error.message);
  }

  return { updates, modelCalls, ...(error !== undefined ? { error } : {}) };
}

/**
 * One concept, through the existing resolver and the existing policy.
 *
 * Returns null wherever today's behaviour is already the right answer:
 * understanding a question does not mean we have the answer, and a profile gap
 * is explained better by the skip that is already there.
 */
function fromConcept(
  profile: ApplicantProfile,
  descriptor: FieldDescriptor,
  profilePath: ProfilePath,
  meta: {
    confidence: number;
    knowledgeState: KnowledgeState;
    explanation: string;
    origin: 'stage1' | 'stage2';
  },
): SemanticFieldUpdate | null {
  const resolution = resolveValue(profile, profilePath, descriptor);
  if (!resolution.ok) return null;

  const decision = decideFill({
    mappingConfidence: meta.confidence,
    valueConfidence: resolution.resolved.confidence,
    valueVerifiedByUser: resolution.resolved.verifiedByUser,
    profilePath,
    valueMissing: false,
    controlHasValue: (descriptor.currentValue ?? '').trim().length > 0,
  });
  if (decision === 'skip') return null;

  const optionValue = resolution.resolved.option?.value;

  return {
    localId: descriptor.localId,
    // 'fill' is unreachable while `sourceScores.semantic` stays below
    // `autofillThreshold`, which is by construction - but this honours whatever
    // the policy says rather than assuming it, so the policy stays the one
    // place the decision lives.
    action: decision === 'autofill' ? 'fill' : 'suggest',
    profilePath,
    mappingConfidence: meta.confidence,
    knowledgeState: meta.knowledgeState,
    value: resolution.resolved.value,
    ...(optionValue !== undefined ? { optionValue } : {}),
    explanation: meta.explanation,
    origin: meta.origin,
  };
}

/** Stage 2 for one field whose concept was never in doubt. */
async function matchAgainstOptions(
  profile: ApplicantProfile,
  descriptor: FieldDescriptor,
  profilePath: ProfilePath,
  port: SemanticPort,
): Promise<{ update: SemanticFieldUpdate | null; modelCalls: number; error?: AppError }> {
  /**
   * The value as TEXT, obtained by resolving against the SAME control with its
   * options removed.
   *
   * Reuses the resolver's own scalar rendering rather than reaching into the
   * profile here: dates and phone numbers have control-dependent renderings
   * this module has no business knowing about, and a second implementation of
   * "how does this value read" is how the two would drift.
   */
  const { options: _options, ...withoutOptions } = descriptor;
  const asText = resolveValue(profile, profilePath, withoutOptions);
  if (!asText.ok || typeof asText.resolved.value !== 'string') {
    return { update: null, modelCalls: 0 };
  }

  const chosen = await chooseOption({
    fieldId: descriptor.localId,
    value: asText.resolved.value,
    options: descriptor.options ?? [],
    port,
  });

  const failure = chosen.error;
  if (chosen.option === null) {
    return {
      update: null,
      modelCalls: chosen.modelCalls,
      ...(failure !== undefined ? { error: failure } : {}),
    };
  }

  const decision = decideFill({
    // The MAPPING was never in doubt - the cascade named this path itself, and
    // only the option match failed. But the match is what this pass supplied,
    // so it is scored as a semantic result: an option we CHOSE rather than
    // matched must be read by the user.
    mappingConfidence: DEFAULT_CONFIDENCE_POLICY.sourceScores.semantic,
    valueConfidence: asText.resolved.confidence,
    valueVerifiedByUser: asText.resolved.verifiedByUser,
    profilePath,
    valueMissing: false,
    controlHasValue: (descriptor.currentValue ?? '').trim().length > 0,
  });
  if (decision === 'skip') return { update: null, modelCalls: chosen.modelCalls };

  return {
    modelCalls: chosen.modelCalls,
    update: {
      localId: descriptor.localId,
      action: decision === 'autofill' ? 'fill' : 'suggest',
      profilePath,
      mappingConfidence: DEFAULT_CONFIDENCE_POLICY.sourceScores.semantic,
      knowledgeState: 'probable',
      value: chosen.option.value,
      optionValue: chosen.option.value,
      explanation: `${labelForPath(profilePath)} (matched to "${chosen.option.label}")`,
      origin: 'stage2',
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting the run
// ---------------------------------------------------------------------------

/**
 * What the panel is told about a semantic run.
 *
 * Plain data, because it crosses the message boundary to the side panel. Note
 * what it does NOT contain: no field ids, no labels, no values. It answers
 * "did this cost anything, did it fail, and how much is left", and nothing about
 * what the applicant was asked or what they would have answered.
 */
/**
 * Why the fallback could not run, in the only three flavours a user needs.
 *
 * DELIBERATELY NARROWER THAN `AppErrorCode`. A misconfigured origin, an
 * unregistered install and a malformed reply are three different bugs for us
 * and exactly one situation for the applicant: the AI part is not working, the
 * rest still is. Collapsing them here means the raw code never crosses the
 * message boundary, so there is no path by which "BACKEND_REJECTED" reaches
 * somebody's screen mid-application.
 */
export type SemanticFailureKind = 'rate_limited' | 'offline' | 'unavailable';

export interface SemanticRunSummary {
  readonly modelCalls: number;
  readonly error?: {
    readonly kind: SemanticFailureKind;
    /** Present on `rate_limited`. The actionable part of that failure. */
    readonly retryAfterMs?: number;
  };
  /** Present when the caller could read the gateway's daily counter. */
  readonly quota?: {
    readonly used: number;
    readonly limit: number;
    readonly resetsInMs: number;
  };
}

/**
 * Reduce a run to what may be reported.
 *
 * WHAT IT DELIBERATELY DROPS.
 * The `AppError` itself, its message, and its `context` bag. That bag is typed
 * as unknown-valued and elsewhere in this codebase legitimately carries a field
 * label or a filled value - so spreading it would push the applicant's own
 * words across the message boundary and into a log line, which is precisely the
 * leak the descriptor seam exists to prevent. One key is read out of it by
 * name, and only for the one code where it means something.
 *
 * `rate_limited` is singled out because it is the one failure the user can act
 * on: "you are out of AI answers until tomorrow" is a different sentence from
 * "nothing matched", and without `retryAfterMs` they are the same event.
 */
export function summariseRun(
  outcome: SemanticApplyOutcome,
  usage?: { used: number; limit: number; resetsInMs: number },
): SemanticRunSummary {
  const error = outcome.error;
  const retryAfterMs = error?.context['retryAfterMs'];
  const kind = error === undefined ? undefined : classify(error.code);

  // Built as one expression rather than by assignment: `exactOptionalPropertyTypes`
  // treats an explicitly-undefined key as a different thing from an absent one,
  // and so does structured clone across the message boundary.
  return {
    modelCalls: outcome.modelCalls,
    ...(kind !== undefined
      ? {
          error: {
            kind,
            ...(kind === 'rate_limited' && typeof retryAfterMs === 'number'
              ? { retryAfterMs }
              : {}),
          },
        }
      : {}),
    ...(usage !== undefined ? { quota: usage } : {}),
  };
}

/**
 * Map an `AppErrorCode` onto the three situations a user can distinguish.
 *
 * The default is `unavailable` rather than a throw or a passthrough: a code
 * this function has not heard of is still, from where the applicant sits, "the
 * AI part is not working" - and inventing a fourth sentence for it would be
 * guessing at a cause we do not know.
 */
function classify(code: string): SemanticFailureKind {
  switch (code) {
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'BACKEND_UNREACHABLE':
      return 'offline';
    default:
      return 'unavailable';
  }
}

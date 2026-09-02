/**
 * Stage 1 - what is this question asking?
 * ---------------------------------------------------------------------------
 * Runs on the fields the mapping cascade did not recognise. Answers each one
 * with a canonical `ProfilePath`, or refuses.
 *
 * THE ORDER IS THE ECONOMICS
 *   1. The cache, per field. Free, private, and instant. A question the user has
 *      met before - on any site - never reaches the network again, which is what
 *      makes the second application cost nothing.
 *   2. ONE batched call for everything left. A form has twenty unmapped fields
 *      and the expensive part of a request is the round trip, so twenty
 *      questions travel together or the feature is unusable on a slow
 *      connection.
 *
 * WHAT LEAVES THIS MACHINE: `{ question, kind, options }` per field, all three
 * written by the page. No profile data of any kind - see `port.ts`, where that
 * is a property of the types, and `tests/semantic/stages.test.ts`, where it is
 * asserted by serialising what was actually sent.
 *
 * WHAT COMES BACK IS A SUGGESTION, NOT AN INSTRUCTION
 * Two narrowings stand between the reply and a filled field, and neither is
 * optional:
 *
 *   - the path must be one WE defined (`isProfilePath`). A model naming
 *     `contact.bloodType` is refused here. Without this the string would reach
 *     `resolveValue`, come back `unknown_path`, and the only evidence anything
 *     had happened would be a blank field.
 *   - the confidence is capped below `autofillThreshold`, so the result reaches
 *     the user as something to read rather than something already done. The cap
 *     is `sourceScores.semantic` in the confidence policy, not a number here.
 *
 * And downstream of both, `decideFill` runs unchanged - so a semantic mapping
 * onto a sensitive path meets the same gate an alias match would.
 *
 * A NULL IS CACHED LIKE ANY OTHER ANSWER
 * "No path fits this question" is the correct answer to a great many real
 * questions ("How did you hear about us?"), and it is the answer to the ones a
 * user meets most often. Not remembering it would mean paying for it on every
 * application, forever - so decision #2 of the brief ("at most one model call
 * per distinct question, ever") depends on caching the negatives too.
 */
import { createLogger } from '@shared/logging';
import type { AppError } from '@shared/errors';
import { isProfilePath, type ProfilePath } from '@profile/paths';
import { computeFingerprints, selectQuestionText } from '@form-engine/fingerprints/fingerprint';
import { stableHashParts } from '@shared/ids';
import {
  DEFAULT_CONFIDENCE_POLICY,
  type ConfidencePolicyConfig,
} from '@form-engine/confidence/policy';
import type { SemanticConceptCache } from './cache';
import type { ConceptQuestion, SemanticPort } from './port';
import type { ConceptResolution, RefusedField } from './types';

const log = createLogger('semantic:concept');

/** What stage 1 needs: the refusals, a way to ask, and a place to remember. */
export interface ConceptStageInput {
  /** Fields from the queue. Only `no_mapping` entries are considered. */
  readonly fields: readonly RefusedField[];
  readonly port: SemanticPort;
  readonly cache: SemanticConceptCache;
  readonly config?: ConfidencePolicyConfig;
}

/** What stage 1 concluded, what it cost, and how it failed if it did. */
export interface ConceptStageOutcome {
  /** Accepted concepts. Every one names a real `ProfilePath`. */
  readonly resolutions: readonly ConceptResolution[];
  /**
   * Model calls actually made. Zero on a fully cached page, which is the
   * number acceptance criterion #3 of the brief asks to be DEMONSTRATED rather
   * than asserted - so it is reported rather than inferred.
   */
  readonly modelCalls: number;
  /**
   * Why the remote stage failed, when it did.
   *
   * Surfaced rather than swallowed so the panel can tell the difference between
   * "nothing matched" and "you are out of AI answers until tomorrow" - a
   * distinction the user can act on. `RATE_LIMITED` carries `retryAfterMs` in
   * its context.
   */
  readonly error?: AppError;
}

/** Resolve unmapped questions to concepts. Never throws. */
export async function resolveConcepts(input: ConceptStageInput): Promise<ConceptStageOutcome> {
  const config = input.config ?? DEFAULT_CONFIDENCE_POLICY;
  const confidence = config.sourceScores.semantic;

  const unmapped = input.fields.filter((field) => field.kind === 'no_mapping');
  if (unmapped.length === 0) return { resolutions: [], modelCalls: 0 };

  const resolutions: ConceptResolution[] = [];
  /** Fields the cache could not answer, with their fingerprints kept. */
  const toAsk: Array<{ field: RefusedField; question: ConceptQuestion }> = [];

  for (const field of unmapped) {
    const fingerprints = computeFingerprints(field.descriptor);
    const question = toQuestion(field);
    // The cache is keyed by the fingerprint and BOUND to the payload. The two
    // are computed from the same material by different rules - the fingerprint
    // hashes twelve sorted options, the payload sends sixty unsorted - so a
    // page can share a key with somebody else's question while showing the
    // model something entirely different. See the cache header.
    const cached = await input.cache.lookup(fingerprints, conceptPayloadDigest(question));

    if (cached !== null) {
      // A cached null is an answer: this question has no path, and asking again
      // would cost a call to be told the same thing.
      if (cached.profilePath !== null) {
        resolutions.push({
          fieldId: field.fieldId,
          profilePath: cached.profilePath,
          origin: 'cache',
          confidence,
        });
      }
      continue;
    }

    toAsk.push({ field, question });
  }

  if (toAsk.length === 0) return { resolutions, modelCalls: 0 };

  const reply = await input.port.identifyConcepts(toAsk.map((entry) => entry.question));

  if (!reply.ok) {
    // Degrade to exactly today's behaviour: the fields stay refused. Nothing is
    // cached, because nothing was answered - a failed call must not poison a
    // question against a later retry.
    log.debugLazy(() => ['Stage 1 failed; leaving fields refused', reply.error.code]);
    return { resolutions, modelCalls: 1, error: reply.error };
  }

  const answers = new Map(reply.value.map((answer) => [answer.fieldId, answer.profilePath]));

  for (const { field, question } of toAsk) {
    const proposed = answers.get(field.fieldId);
    const path = validatePath(proposed);

    if (path !== null) {
      resolutions.push({ fieldId: field.fieldId, profilePath: path, origin: 'model', confidence });
    }

    // Recorded either way. A path we cannot use is remembered as "no path",
    // because re-asking would produce the same unusable answer at the same
    // price.
    const label = question.question;
    await input.cache.record(computeFingerprints(field.descriptor), path, {
      ...(label.length > 0 ? { normalizedLabel: label } : {}),
      // The question as it was actually asked, not as it was keyed.
      payloadDigest: conceptPayloadDigest(question),
    });
  }

  return { resolutions, modelCalls: 1 };
}

/**
 * A hash of exactly what stage 1 sends about one field.
 *
 * Every string this stage hands to the port, in order, and nothing else.
 *
 * The transport truncates further (sixty options, four hundred characters a
 * question) before anything crosses the wire, so this digest is STRICTER than
 * the bytes that are actually sent: two fields whose payloads truncate to the
 * same request may still hash differently. That direction costs a model call
 * and is the safe one - the direction this exists to prevent is two different
 * requests sharing one cached answer.
 *
 * `fieldId` is excluded on purpose: it is a per-scan local id that changes on
 * every scan and means nothing to the model, so including it would make every
 * lookup a miss and the cache pointless.
 *
 * Exported so a test can assert the property this exists for from outside:
 * two fields that share a fingerprint but show the model different text must
 * not share an answer.
 */
export function conceptPayloadDigest(question: ConceptQuestion): string {
  return stableHashParts(['sc1', question.question, question.kind, ...question.options]);
}

/**
 * Reduce a refused field to what stage 1 is allowed to see.
 *
 * Written as an explicit construction of the three permitted fields rather than
 * as a spread of the descriptor. A spread would send `pageUrl`, `hostname`,
 * `currentValue` and every future field anyone adds to `FieldDescriptor` - so
 * the safe version would depend on nobody ever adding a field, which is not a
 * property a codebase can have.
 */
function toQuestion(field: RefusedField): ConceptQuestion {
  return { fieldId: field.fieldId, ...describeQuestion(field.descriptor) };
}

/**
 * The three page-written things stage 1 may see, without the id.
 *
 * Split out so the digest can be computed from a descriptor alone - by a
 * caller seeding the cache, or by a test asserting that two descriptors which
 * share a fingerprint do NOT share a payload.
 */
function describeQuestion(descriptor: RefusedField['descriptor']): Omit<ConceptQuestion, 'fieldId'> {
  return {
    question: selectQuestionText(descriptor),
    kind: descriptor.kind,
    options: (descriptor.options ?? []).map((option) => option.label),
  };
}

/** The digest for a field, from the descriptor alone. */
export function conceptPayloadDigestFor(descriptor: RefusedField['descriptor']): string {
  return conceptPayloadDigest({ fieldId: '', ...describeQuestion(descriptor) });
}

/**
 * Narrow a reply to a path we actually have, or null.
 *
 * Checks the type as well as the membership: a reply is unvalidated data, and
 * `isProfilePath` on a non-string would throw inside the regex rather than
 * return false.
 */
function validatePath(proposed: string | null | undefined): ProfilePath | null {
  if (typeof proposed !== 'string' || proposed.length === 0) return null;
  return isProfilePath(proposed) ? proposed : null;
}

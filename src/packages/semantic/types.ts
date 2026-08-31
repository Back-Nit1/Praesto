/**
 * Semantic fallback - the shared vocabulary.
 * ---------------------------------------------------------------------------
 * The deterministic pipeline leaves a field blank whenever it cannot name the
 * question or cannot match the answer to an offered option. That is correct
 * behaviour and it remains the default. This package adds one stage that runs
 * ONLY on the fields that pipeline refused.
 *
 * WHY A SEPARATE PACKAGE RATHER THAN A SIXTH STAGE OF THE CASCADE
 * Three reasons, in order of how much they matter:
 *
 *  1. `mapField` is synchronous, pure and the best-tested module in the repo.
 *     Adding a stage that can await, spend money, or fail would make every one
 *     of its callers async and every one of its tests need a harness. Consuming
 *     its REFUSALS instead leaves it untouched.
 *
 *  2. It draws the offline/online line in the directory tree. Everything that
 *     works with the network unplugged lives outside this package; everything
 *     that might not lives inside it. "What happens to a question we did not
 *     recognise" is answerable by reading one directory.
 *
 *  3. Refusals are a tiny fraction of a page's fields. Making the expensive
 *     path consume that fraction, rather than filtering inside a hot loop, is
 *     what makes this subsystem cost exactly nothing on a form the extension
 *     already understands.
 *
 * WHAT DOES NOT CHANGE
 * The fill decision, the adapters, the audit trail and the review panel. A
 * concept resolved here is fed back through the SAME `decideFill` policy, so
 * the sensitive-field gate in `confidence/policy.ts` applies unchanged. This
 * package widens the input to a policy that already exists; it does not get a
 * policy of its own.
 */
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { FieldMappingResult, KnowledgeState } from '@form-engine/mapper/types';
import type { ResolutionResult } from '@form-engine/resolver/resolver';
import type { ProfilePath } from '@profile/paths';

/**
 * One field's fate in the deterministic pipeline.
 *
 * This is the queue's input, assembled by the service worker from the same
 * three calls it already makes. `resolution` is absent when the mapping refused
 * first - there was no path to resolve - which is why it is optional rather
 * than nullable: absence is a fact about the pipeline, not a missing value.
 */
export interface FieldOutcome {
  readonly descriptor: FieldDescriptor;
  readonly mapping: FieldMappingResult;
  readonly resolution?: ResolutionResult;
}

/**
 * Why a field is in the queue.
 *
 * These are the only two failures a second opinion can address, and they need
 * completely different treatment downstream:
 *
 *   no_mapping           We do not know what the question MEANS. What is
 *                        missing is a profile path.
 *   no_matching_option   We know the question and we know our answer; the
 *                        control's own vocabulary spells it differently. What
 *                        is missing is one entry from a list we already hold.
 *
 * Every other failure is excluded on purpose - see `queue.ts`.
 */
export type QueuedRefusalReason = 'no_mapping' | 'no_matching_option';

/**
 * A field worth a second attempt.
 *
 * Note what this carries and what it does not. It carries the DESCRIPTOR - the
 * page's own words, which is what the privacy seam was drawn around
 * (`descriptor/types.ts`) - and never a profile value. Stage one can therefore
 * be built from a `RefusedField` alone and be structurally incapable of leaking
 * applicant data, rather than merely careful not to.
 */
export interface RefusedField {
  /** The descriptor's `localId`. Ties the result back to a DOM element. */
  readonly fieldId: string;
  readonly reason: QueuedRefusalReason;
  /**
   * The whole descriptor, because every downstream stage needs a different part
   * of it: fingerprints for the cache, options for the matcher, kind for the
   * resolver. Passing the parts separately would mean four signatures that all
   * drift apart the first time one of them needs a fifth field.
   */
  readonly descriptor: FieldDescriptor;
  /**
   * The normalized question, as `selectQuestionText` chooses it.
   *
   * Non-empty by construction - the queue drops a field without one. Computed
   * here rather than downstream so exactly one module decides what "the
   * question" is, the same way `fingerprints/fingerprint.ts` does.
   */
  readonly question: string;
  /**
   * The path we already believe this field means.
   *
   * Non-null exactly when `reason` is `'no_matching_option'`; null for
   * `'no_mapping'`, where finding the path is the whole point.
   */
  readonly profilePath: ProfilePath | null;
}

/** Where an answer came from. */
export type SemanticOrigin =
  /** The persistent concept cache. Free, offline, and the common case. */
  | 'cache'
  /** A remote model. Costs a call, and happens at most once per question. */
  | 'model';

/**
 * What the semantic stage concluded about one refused field.
 *
 * `profilePath: null` is a RESULT, not an absence of one: "this question maps
 * to nothing in the profile" is a real answer, it is worth remembering, and it
 * is the single most valuable thing to cache - without it, every scan of the
 * same form pays again to be told the same nothing.
 */
export interface ConceptResolution {
  readonly fieldId: string;
  readonly profilePath: ProfilePath | null;
  /**
   * Mapping confidence, on the same 0..1 scale the cascade uses.
   *
   * Capped below `autofillThreshold` on first sight: a question no
   * deterministic signal recognised must surface as a suggestion the user can
   * see, never as a silent fill. Promotion happens through the existing
   * correction path, where the user confirms it themselves.
   */
  readonly confidence: number;
  readonly knowledgeState: KnowledgeState;
  readonly origin: SemanticOrigin;
}

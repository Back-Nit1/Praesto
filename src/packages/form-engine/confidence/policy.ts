/**
 * Confidence policy - the single place that decides whether to fill.
 * ---------------------------------------------------------------------------
 * Spec section 13 requires one centralized policy module rather than thresholds
 * scattered across the codebase, and spec's primary engineering rule states the
 * objective plainly:
 *
 *     "Optimize for incorrect fills approaching zero, not fields-filled
 *      approaching 100%. A field left blank is recoverable. A confidently
 *      filled wrong answer is not."
 *
 * Centralising has a concrete payoff: calibrating the product means editing ONE
 * table and re-running the fixture suite, instead of hunting for `0.95` across
 * forty files and hoping none were missed.
 *
 * TWO INDEPENDENT CONFIDENCES, DELIBERATELY NOT MERGED INTO ONE NUMBER
 *
 *   MAPPING confidence  - "how sure am I what this field is ASKING?"
 *   VALUE   confidence  - "how sure am I that my stored answer is CORRECT?"
 *
 * They fail in different ways and must both be satisfied. Being certain a field
 * asks for a phone number does not license filling it with a number scraped
 * from a resume that the user has never looked at. Averaging the two would let
 * a high mapping score paper over an unverified value, which is precisely the
 * failure mode this product exists to prevent.
 */
import { requiresVerifiedValue } from '@profile/paths';

/**
 * What the system is allowed to do with a field.
 *
 * Three bands, matching spec section 13, and named for the ACTION rather than
 * the number so call sites read as decisions rather than as arithmetic.
 */
export type FillDecision =
  /** Fill it. High confidence in both the mapping and the value. */
  | 'autofill'
  /** Show it as a suggestion the user accepts or edits. Do not fill. */
  | 'suggest'
  /** Leave the control completely untouched. */
  | 'skip';

/**
 * Tunable thresholds and scores.
 *
 * Everything a calibration pass would want to change lives in this object.
 * Passed into the policy functions rather than read from module scope so a test
 * can explore alternative calibrations without global mutation.
 */
export interface ConfidencePolicyConfig {
  /** At or above this mapping confidence, an unambiguous field may autofill. */
  readonly autofillThreshold: number;
  /** At or above this, offer a suggestion. Below it, stay silent. */
  readonly suggestThreshold: number;
  /**
   * Minimum confidence in the stored VALUE for it to be autofilled.
   *
   * Set below 1 so a strong resume extraction the user has reviewed in the
   * onboarding screen can be used - but see `requiresVerifiedValue`, which
   * overrides this to demand explicit verification for legal and demographic
   * answers regardless of score.
   */
  readonly minValueConfidenceForAutofill: number;

  /**
   * Base score contributed by each mapping source (spec section 13).
   *
   * The ordering encodes a claim about the world: an explicit machine-readable
   * declaration by the page author (`autocomplete`) beats our own recognition
   * of their prose, which beats our own fuzzy guess. Fuzzy matching tops out
   * below the autofill threshold BY CONSTRUCTION - a fuzzy match can never fill
   * a field on its own, no matter how good the string similarity looks.
   */
  readonly sourceScores: {
    readonly autocomplete: number;
    readonly atsRule: number;
    readonly exactAlias: number;
    readonly nameAttribute: number;
    /**
     * A match on the trailing words of a namespaced attribute, where there was
     * no delimiter to split on. Below `autofillThreshold` BY CONSTRUCTION:
     * dropping a prefix can invert meaning, and `emergency_contact_phone`
     * truncating to "phone" must never be able to fill a field on its own.
     */
    readonly attributeSuffix: number;
    readonly learnedMapping: number;
    readonly compactAlias: number;
    /**
     * A field inside a repeated block (education / employment / projects)
     * whose alias is claimed by exactly one collection - "school", "employer",
     * "job title". Scored like an exact name match: the alias itself is
     * unambiguous about which block it belongs to, so no section heading is
     * needed to trust it.
     *
     * When an alias IS claimed by several collections ("start date"), the
     * mapper pushes a candidate for each, they compete, and the ambiguity
     * machinery in `selectWinner` pushes the result below the autofill line.
     */
    readonly collectionAlias: number;
    /**
     * The same match, with the surrounding section heading agreeing about
     * which block it is. Above `exactAlias` deliberately: "Start date" under an
     * "Education" heading IS the education start date, and it must outrank the
     * scalar reading of the same words (the applicant's availability date).
     */
    readonly collectionAliasWithSection: number;
    readonly fuzzy: number;
    /**
     * A concept proposed by the remote semantic fallback, or replayed from its
     * cache. BELOW `autofillThreshold` BY CONSTRUCTION, and below `fuzzy` on
     * purpose.
     *
     * Two claims are packed into that ordering. The first: a novel question
     * must surface as a SUGGESTION the user reads, never as a silent fill -
     * a model naming a concept is a plausible reading of a question we have
     * never seen, which is exactly what the review step exists for. The
     * second: it is worth no more than our own local token-overlap guess,
     * because it is the same kind of thing - an inference about wording -
     * made somewhere we cannot inspect, from text a webpage controls.
     *
     * A semantic mapping is promoted the way every other mapping is promoted:
     * the user accepts it, the correction path records a `LearnedMapping`, and
     * the NEXT encounter matches at `learnedMapping` scoring with the user's
     * own authority behind it. There is deliberately no path by which this
     * number rises on its own.
     */
    readonly semantic: number;
  };

  /**
   * Bonus when several independent signals agree.
   *
   * Small on purpose. Agreement between a label and a name attribute is
   * genuine evidence, but it is weaker than it looks: both are written by the
   * same developer from the same template, so they are correlated rather than
   * independent. A large bonus would let two weak correlated signals cross the
   * autofill line together.
   */
  readonly multiSignalBonus: number;
  /** Cap on total bonus, so stacking agreements cannot manufacture certainty. */
  readonly maxMultiSignalBonus: number;

  /**
   * Penalty when the field's question contains a negation we did not model.
   *
   * Large enough to push any match below the autofill threshold: an inverted
   * answer to "do you NOT require sponsorship" is a false statement to an
   * employer, so the field goes to the user.
   */
  readonly negationPenalty: number;

  /** Penalty when a learned mapping has been corrected by the user before. */
  readonly correctionPenaltyPerEvent: number;
  /** Bonus per successful uncorrected use of a learned mapping. */
  readonly successBonusPerEvent: number;
  /** Cap on the learned-history bonus. */
  readonly maxLearnedBonus: number;
}

/**
 * Shipped calibration.
 *
 * Starting values from spec section 13, to be refined against the fixture suite
 * and real-application regressions. Every number is a hypothesis with a test,
 * not a constant.
 */
export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicyConfig = {
  autofillThreshold: 0.95,
  suggestThreshold: 0.75,
  minValueConfidenceForAutofill: 0.8,

  sourceScores: {
    autocomplete: 0.99, // page author declared the meaning in a standard vocabulary
    atsRule: 0.98, // a rule we wrote after seeing this exact ATS field
    exactAlias: 0.97, // normalized label matches a known alias exactly
    nameAttribute: 0.96, // name/id matches a known alias exactly
    attributeSuffix: 0.88, // only the tail of a namespaced name matched - a guess
    learnedMapping: 0.96, // the user personally taught us this one
    compactAlias: 0.9, // matches once separators are collapsed
    collectionAlias: 0.96, // "school" / "employer" - unambiguous about its block
    collectionAliasWithSection: 0.98, // ...and the section heading agrees
    fuzzy: 0.82, // token overlap only - BELOW autofillThreshold by design
    semantic: 0.8, // a remote reading of a novel question - suggestion only, never a fill
  },

  multiSignalBonus: 0.015,
  maxMultiSignalBonus: 0.04,

  negationPenalty: 0.35,

  correctionPenaltyPerEvent: 0.1,
  successBonusPerEvent: 0.01,
  maxLearnedBonus: 0.03,
};

/** Everything the policy needs to decide. Purely data - trivially testable. */
export interface FillDecisionInput {
  /** How sure we are what the field is asking for. 0..1. */
  readonly mappingConfidence: number;
  /** How sure we are the stored answer is right. 0..1. */
  readonly valueConfidence: number;
  /** Whether the user has explicitly verified the stored value. */
  readonly valueVerifiedByUser: boolean;
  /** Canonical path the field mapped to; null when unmapped. */
  readonly profilePath: string | null;
  /** True when we have no value to offer at all. */
  readonly valueMissing: boolean;
  /**
   * True when the control already holds a value.
   *
   * We never overwrite. The user may have typed it, or the ATS may have
   * pre-filled it from a parsed resume - either way it is not ours to replace,
   * and a "helpful" overwrite of a correct value is a wrong fill.
   */
  readonly controlHasValue: boolean;
}

/**
 * Decide what to do with one field.
 *
 * Reads top to bottom as a series of refusals, ending in the single case where
 * filling is permitted. That shape is intentional: the safe path is the
 * default, and every way to reach `autofill` is visible in one screen.
 */
export function decideFill(
  input: FillDecisionInput,
  config: ConfidencePolicyConfig = DEFAULT_CONFIDENCE_POLICY,
): FillDecision {
  // Nothing to say about a field we could not map.
  if (input.profilePath === null) return 'skip';

  // We understand the question but have no answer. Surfacing it as "unknown" is
  // the side panel's job; there is nothing to fill.
  if (input.valueMissing) return 'skip';

  // Never overwrite existing content, at any confidence.
  if (input.controlHasValue) return 'skip';

  // Below the suggestion floor we stay completely silent rather than showing
  // low-quality guesses. A noisy suggestion list trains the user to click
  // through without reading, which destroys the review step's value.
  if (input.mappingConfidence < config.suggestThreshold) return 'skip';

  // --- the sensitive-path gate ---------------------------------------------
  // Spec 21.3. For work authorization, sponsorship, and demographics, a
  // confident mapping is NOT sufficient. We may be certain the form asks "are
  // you authorized to work in the US?" and still have no right to answer from
  // anything but an explicit user statement.
  if (requiresVerifiedValue(input.profilePath) && !input.valueVerifiedByUser) {
    return input.mappingConfidence >= config.suggestThreshold ? 'suggest' : 'skip';
  }

  // Both confidences must clear their bars independently.
  const mappingIsCertain = input.mappingConfidence >= config.autofillThreshold;
  const valueIsTrusted =
    input.valueVerifiedByUser || input.valueConfidence >= config.minValueConfidenceForAutofill;

  if (mappingIsCertain && valueIsTrusted) return 'autofill';

  return 'suggest';
}

/**
 * Combine a base source score with the adjustments that apply to it.
 *
 * Clamped to just under 1.0: the system is never *certain*. Reserving 1.0 for
 * "impossible" keeps the door open for a future signal that genuinely deserves
 * it, and stops downstream code from treating any current match as absolute.
 */
export function combineConfidence(
  baseScore: number,
  adjustments: {
    /** Count of additional independent signals agreeing with the mapping. */
    agreeingSignals?: number;
    /** True when the label contains a negation we have not modelled. */
    hasUnmodelledNegation?: boolean;
    /** Times a learned mapping was used without correction. */
    successfulUses?: number;
    /** Times the user corrected a learned mapping. */
    correctedUses?: number;
  },
  config: ConfidencePolicyConfig = DEFAULT_CONFIDENCE_POLICY,
): number {
  let score = baseScore;

  const agreeing = adjustments.agreeingSignals ?? 0;
  if (agreeing > 0) {
    score += Math.min(agreeing * config.multiSignalBonus, config.maxMultiSignalBonus);
  }

  const successes = adjustments.successfulUses ?? 0;
  if (successes > 0) {
    score += Math.min(successes * config.successBonusPerEvent, config.maxLearnedBonus);
  }

  // Corrections are NOT capped. A rule the user has repeatedly fixed should be
  // able to fall all the way out of contention - spec section 19: "bad learned
  // rules do not permanently trap the system."
  const corrections = adjustments.correctedUses ?? 0;
  if (corrections > 0) {
    score -= corrections * config.correctionPenaltyPerEvent;
  }

  if (adjustments.hasUnmodelledNegation === true) {
    score -= config.negationPenalty;
  }

  return Math.max(0, Math.min(0.999, score));
}

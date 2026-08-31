/**
 * Deterministic option scoring.
 * ---------------------------------------------------------------------------
 * Given a value we already hold and the options a control actually offers,
 * decide which option - if any - the value means. No network, no model, no I/O:
 * a string and a list in, a decision out, synchronously.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE RESOLVER ALREADY MATCHES OPTIONS
 * `resolver.ts` matches on exact, exact-value, compact and prefix, and stops.
 * That is correct for a stage that must be able to AUTOFILL, and it is why the
 * resolver refuses "Computer Engineering" against a list offering "Engineering,
 * Computer": `normalizeCompact` gives "computerengineering" and
 * "engineeringcomputer", which are simply different strings.
 *
 * This module runs only on the fields the resolver already refused, so it can
 * afford looser comparisons - PROVIDED every looser tier is priced below the
 * autofill bar and every ambiguity escalates instead of guessing. A large share
 * of real "no_matching_option" failures die here, which is the point: a remote
 * call should be the last resort, not the first.
 *
 * THE CASCADE, AND THE ONE RULE THAT ORDERS IT
 *
 *     normalize -> exact -> containment -> token overlap
 *
 * Each tier is tried in turn and the first that yields EXACTLY ONE option wins.
 * A tier that yields several does not fall through to a looser tier - it
 * escalates. That direction matters: a looser comparison must never be able to
 * overrule a stricter one that already looked at the same pair and declined.
 *
 * WHY CONTAINMENT IS ASYMMETRIC - the most important decision in this file
 * Token containment on its own is unsafe, and the counterexample is the one
 * `engineering.md` names: "Virginia" is fully contained in "West Virginia" by
 * any token measure, and filling a Virginia resident's application with West
 * Virginia is exactly the confidently-wrong answer this product exists to
 * prevent. But "United States" inside "United States of America" is the same
 * shape and is obviously right.
 *
 * What separates them is direction. In English, a modifier that CHANGES the
 * entity is a prefix - West Virginia, South Korea, Computer Engineering - while
 * one that merely elaborates is a suffix - "...of America", "...(USA)". So the
 * containment tier accepts an option that EXTENDS our value at the end, and a
 * pure reordering of the same words, and nothing else. This is the same
 * reasoning behind the resolver's `startsWith` strategy, generalised to tokens
 * so word order stops mattering.
 *
 * It is deliberately one-directional the other way too: an option that is a
 * strict SUBSET of our value is refused, because matching it means dropping
 * words from our own answer, and the dropped word is usually the one that
 * distinguishes it ("Rutgers University Newark" -> "Rutgers University").
 *
 * TOKEN OVERLAP IS THE WEAKEST TIER AND IS TREATED AS SUCH
 * It only judges pairs where neither token set contains the other - every
 * containment relation was already decided above - it demands a high floor and
 * a margin over the runner-up, and it is scored below
 * `minValueConfidenceForAutofill` BY CONSTRUCTION, so a token-overlap match can
 * become a suggestion the user reads but never a silent fill. Expect it to fire
 * rarely. That is the honest outcome, not a bug: at a floor low enough to fire
 * often it would also match "Computer Science and Engineering" to "Computer
 * Science and Math".
 *
 * WHAT THE SCORE MEANS TO A CALLER
 * It is confidence in the MATCH, not in the stored value. A caller feeding
 * `decideFill` must combine it with the value's own confidence - `Math.min` of
 * the two - never replace it. Spec section 13 keeps mapping confidence and
 * value confidence separate on purpose, and this number belongs to the second.
 *
 * There is deliberately no separate "snap a returned string back to a real
 * option" helper. `matchOption` with `strategy === 'exact'` IS that check, and
 * a second implementation of it would be a second thing to get wrong.
 */
import {
  containmentScore,
  normalizeLabel,
  tokenSimilarity,
  tokenize,
} from '@form-engine/descriptor/normalize';
import type { FieldOption } from '@form-engine/descriptor/types';

/** How a match was reached. Ordered strongest to weakest. */
export type OptionMatchStrategy = 'exact' | 'containment' | 'token_overlap';

/** One option and what it scored, for the escalation payload and the panel. */
export interface ScoredOption {
  readonly option: FieldOption;
  readonly score: number;
  readonly strategy: OptionMatchStrategy;
}

/**
 * The outcome of scoring.
 *
 * `ambiguous` and `no_candidate` both mean "not filled", and they are kept
 * apart because they need different sentences and different follow-ups: one is
 * a question worth escalating with a shortlist attached, the other is a
 * question with nothing to attach. Collapsing them is how a UI ends up saying
 * "no match" for two situations a user would handle differently.
 */
export type OptionMatch =
  | {
      readonly kind: 'matched';
      readonly option: FieldOption;
      readonly strategy: OptionMatchStrategy;
      readonly score: number;
    }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ScoredOption[] }
  | { readonly kind: 'no_candidate' };

/**
 * Tunable scores, in one object, passed in rather than read from module scope -
 * the same shape as `ConfidencePolicyConfig` and for the same reason.
 *
 * NOT merged into `DEFAULT_CONFIDENCE_POLICY`. That object holds MAPPING
 * confidence - "how sure am I what this field is asking?" - and its own header
 * is emphatic that the two confidences must not be blended. These numbers
 * describe how sure we are that a value means a particular option, which is the
 * other axis entirely. They are cross-checked against the confidence policy in
 * the tests, which is where the relationship belongs.
 */
export interface OptionMatchPolicy {
  /** Normalized strings are identical. The only tier that may clear autofill. */
  readonly exactScore: number;
  /** Same words reordered, or the option elaborates on ours. */
  readonly containmentScore: number;
  /** Jaccard floor below which overlap is not evidence at all. */
  readonly minTokenOverlap: number;
  /**
   * Cap on an overlap match's score.
   *
   * BELOW `DEFAULT_CONFIDENCE_POLICY.minValueConfidenceForAutofill` by
   * construction, exactly as `sourceScores.fuzzy` sits below
   * `autofillThreshold`. A token-overlap match must be surfaceable and
   * unfillable.
   */
  readonly tokenOverlapCeiling: number;
  /** How far the winner must beat the runner-up before it counts as a winner. */
  readonly minWinningMargin: number;
}

export const DEFAULT_OPTION_MATCH_POLICY: OptionMatchPolicy = {
  exactScore: 0.99, // never 1.0 - the system is not certain of anything
  containmentScore: 0.9,
  minTokenOverlap: 0.7,
  tokenOverlapCeiling: 0.75,
  minWinningMargin: 0.1,
};

const NO_CANDIDATE: OptionMatch = { kind: 'no_candidate' };

/**
 * Score a value against the options a control offers.
 *
 * Pure and synchronous. The signature is the guarantee: there is no seam here
 * through which a network call could be added without changing it.
 */
export function matchOption(
  value: string,
  options: readonly FieldOption[],
  policy: OptionMatchPolicy = DEFAULT_OPTION_MATCH_POLICY,
): OptionMatch {
  const wanted = normalizeLabel(value);
  if (wanted.length === 0) return NO_CANDIDATE;

  // An option whose label normalizes away is a separator row ("---") or a
  // spacer, not an answer a human could choose.
  const candidates = options
    .map((option) => ({ option, label: normalizeLabel(option.label) }))
    .filter((entry) => entry.label.length > 0);
  if (candidates.length === 0) return NO_CANDIDATE;

  const wantedTokens = tokenize(wanted);

  // --- tier 1: exact -------------------------------------------------------
  // Both the visible label and the submitted value, because some selects carry
  // a code in the label and the meaning in the value.
  const exact = candidates.filter(
    (entry) => entry.label === wanted || normalizeLabel(entry.option.value) === wanted,
  );
  if (exact.length > 0) {
    return decide(
      exact.map((entry) => ({
        option: entry.option,
        score: policy.exactScore,
        strategy: 'exact' as const,
      })),
      policy,
    );
  }

  // --- tier 2: containment -------------------------------------------------
  // A reordering of the same words, or an option that extends ours at the end.
  // See the header for why "extends at the end" and not "contains".
  const contained = candidates.filter((entry) => {
    const optionTokens = orderedTokens(entry.label);
    return (
      isSameWords(wantedTokens, tokenize(entry.label)) ||
      extendsAtEnd(orderedTokens(wanted), optionTokens)
    );
  });
  if (contained.length > 0) {
    return decide(
      contained.map((entry) => ({
        option: entry.option,
        score: policy.containmentScore,
        strategy: 'containment' as const,
      })),
      policy,
    );
  }

  // --- tier 3: token overlap -----------------------------------------------
  // Only pairs where neither set contains the other. Every containment relation
  // was judged above and declined; a weaker measure must not overrule that.
  const overlapping: ScoredOption[] = [];
  for (const entry of candidates) {
    const optionTokens = tokenize(entry.label);
    if (containmentScore(wanted, entry.label) === 1) continue; // one contains the other
    if (optionTokens.size === 0) continue;

    const similarity = tokenSimilarity(wanted, entry.label);
    if (similarity < policy.minTokenOverlap) continue;

    overlapping.push({
      option: entry.option,
      score: Math.min(similarity, policy.tokenOverlapCeiling),
      strategy: 'token_overlap',
    });
  }

  return overlapping.length > 0 ? decide(overlapping, policy) : NO_CANDIDATE;
}

/**
 * Turn one tier's shortlist into a decision.
 *
 * A single candidate wins. Several win only if the best beats the next by the
 * required margin - which within a fixed-score tier never happens, so exact and
 * containment ties always escalate. That is deliberate: "the first one that
 * matched" is not a reason, and it is the rule the resolver already follows.
 */
function decide(scored: ScoredOption[], policy: OptionMatchPolicy): OptionMatch {
  if (scored.length === 0) return NO_CANDIDATE;

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best === undefined) return NO_CANDIDATE;

  const runnerUp = ranked[1];
  if (runnerUp !== undefined && best.score - runnerUp.score < policy.minWinningMargin) {
    return { kind: 'ambiguous', candidates: ranked };
  }

  return { kind: 'matched', option: best.option, strategy: best.strategy, score: best.score };
}

/** Tokens in the order they were written. `tokenize` returns a Set, which is not. */
function orderedTokens(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token.length > 0);
}

/**
 * The same words, possibly reordered or repunctuated.
 *
 * "Computer Engineering" and "Engineering, Computer" say the same thing, and
 * form authors are not consistent about word order - the same reasoning that
 * made `tokenSimilarity` symmetric.
 */
function isSameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const token of a) {
    if (!b.has(token)) return false;
  }
  return true;
}

/**
 * True when `option` is `wanted` followed by additional words.
 *
 * A TOKEN-level prefix, not a character one, so "United States" matches
 * "United States of America" while "Virginia" does not match "West Virginia".
 * Character-level `startsWith` would also reject "Unite" -> "United", but it
 * would accept "New" -> "Newark", which token boundaries rule out.
 */
function extendsAtEnd(wanted: readonly string[], option: readonly string[]): boolean {
  if (option.length <= wanted.length) return false;
  return wanted.every((token, i) => option[i] === token);
}

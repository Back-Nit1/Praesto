/**
 * Deterministic option scoring - the tier that costs nothing.
 * ---------------------------------------------------------------------------
 * Runs on a field where the resolver already said `no_matching_option`, and
 * tries harder before anything is sent anywhere. Every case settled here is a
 * model call not made, a payload not sent, and a millisecond instead of a
 * second.
 *
 * THAT FRAMING IS ALSO THE DANGER. By construction this code is LOOSER than the
 * matching that just refused, and loose option matching is how an applicant who
 * lives in Virginia applies from West Virginia. So the ladder below is ordered
 * strongest-first, stops at the first tier that produces EXACTLY ONE match, and
 * every tier that could add or drop a meaning-bearing word is guarded.
 *
 * THE LADDER
 *
 *   exact         normalized label is the value
 *   exact_value   normalized submitted value is the value (label carries a code)
 *   compact       equal once separators collapse: "e mail" == "email"
 *   token_set     the same words in a different order:
 *                 "Computer Engineering" == "Engineering, Computer"
 *   containment   every word of the value appears in the option, GUARDED
 *
 * WHY THERE IS NO GENERAL SIMILARITY TIER
 * A Jaccard/edit-distance tier with a threshold is the obvious next rung, and it
 * is deliberately absent. The failure it produces is not "no match" but "the
 * wrong match, confidently" - "Virginia" against "West Virginia" scores 0.5,
 * "Newark" against "New York" scores well on character distance, and any
 * threshold that admits the good cases admits those too. The product's stated
 * objective is incorrect fills approaching zero, not fields filled approaching
 * 100%, so the ambiguous middle is handed to stage 2 and ultimately to the
 * user. `token_set` above IS token overlap, at the only threshold that cannot
 * change a meaning: total.
 *
 * THE CONTAINMENT GUARDS, WHICH ARE THE WHOLE SAFETY ARGUMENT
 *  1. The value must have at least TWO tokens. A single-token value carries all
 *     of its meaning in that token, so an option that adds a word names a
 *     different thing: Virginia/West Virginia, York/New York, Newark/New
 *     Brunswick. With two or more tokens the value has already pinned itself.
 *  2. The option may not be more than twice the value's length in tokens.
 *     "Rutgers University" inside "Rutgers University - New Brunswick" is a
 *     longer name for a place; inside "Rutgers University Newark School of
 *     Engineering Graduate Certificate Program" it is a coincidence.
 *  3. Exactly one option may match, as at every other tier.
 *
 * NO NETWORK, NO STORAGE, NO CLOCK. Pure function, plain objects in and out.
 */
import { normalizeCompact, normalizeLabel, tokenize } from '@form-engine/descriptor/normalize';
import type { FieldOption } from '@form-engine/descriptor/types';

/** Which tier settled a match. Recorded so a weak match is auditable. */
export type MatchStrategy = 'exact' | 'exact_value' | 'compact' | 'token_set' | 'containment';

export type OptionMatch =
  /** Exactly one option matched. Safe to use with no network call. */
  | { readonly kind: 'matched'; readonly option: FieldOption; readonly strategy: MatchStrategy }
  /**
   * Several options matched equally well. Which one the form means is a real
   * question, so it escalates rather than being decided by array order.
   */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly FieldOption[] }
  /** Nothing matched at any tier. */
  | { readonly kind: 'no_candidate' };

/** Minimum tokens in a value before containment is allowed. See guard 1. */
const MIN_TOKENS_FOR_CONTAINMENT = 2;

/** How much longer than the value an option may be. See guard 2. */
const MAX_CONTAINMENT_LENGTH_RATIO = 2;

/**
 * Find the option this value means, or refuse.
 *
 * Never returns an option that was not in `options` - it returns the array's own
 * object by reference, so a caller cannot be handed a fabricated choice.
 */
export function matchOption(value: string, options: readonly FieldOption[]): OptionMatch {
  const wanted = normalizeLabel(value);
  if (wanted.length === 0 || options.length === 0) return { kind: 'no_candidate' };

  const wantedCompact = normalizeCompact(value);
  const wantedTokens = tokenize(wanted);

  const tiers: Array<{
    strategy: MatchStrategy;
    matches: (option: FieldOption) => boolean;
  }> = [
    {
      strategy: 'exact',
      matches: (option) => normalizeLabel(option.label) === wanted,
    },
    {
      strategy: 'exact_value',
      matches: (option) => normalizeLabel(option.value) === wanted,
    },
    {
      strategy: 'compact',
      matches: (option) => {
        const compact = normalizeCompact(option.label);
        return compact.length > 0 && compact === wantedCompact;
      },
    },
    {
      strategy: 'token_set',
      // The same words, any order. Cannot change a meaning, because no word is
      // added and none is dropped.
      matches: (option) => sameTokenSet(wantedTokens, tokenize(normalizeLabel(option.label))),
    },
    {
      strategy: 'containment',
      matches: (option) => {
        if (wantedTokens.size < MIN_TOKENS_FOR_CONTAINMENT) return false;

        const optionTokens = tokenize(normalizeLabel(option.label));
        if (optionTokens.size > wantedTokens.size * MAX_CONTAINMENT_LENGTH_RATIO) return false;

        for (const token of wantedTokens) {
          if (!optionTokens.has(token)) return false;
        }
        return true;
      },
    },
  ];

  for (const tier of tiers) {
    const matches = options.filter((option) => tier.matches(option));
    const only = matches[0];

    if (matches.length === 1 && only !== undefined) {
      return { kind: 'matched', option: only, strategy: tier.strategy };
    }
    // STOP at the first tier that found anything. A looser tier cannot
    // disambiguate what a stricter one found ambiguous - it can only find MORE
    // matches - so continuing would trade a known ambiguity for a worse one.
    if (matches.length > 1) {
      return { kind: 'ambiguous', candidates: matches };
    }
  }

  return { kind: 'no_candidate' };
}

/** True when two token sets contain exactly the same tokens. */
function sameTokenSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const token of a) {
    if (!b.has(token)) return false;
  }
  return true;
}

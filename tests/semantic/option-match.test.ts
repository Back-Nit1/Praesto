/**
 * Deterministic option-scoring tests.
 *
 * This module is the reason a remote call is the LAST resort rather than the
 * first: a large share of "we know the answer, the dropdown spells it
 * differently" failures are ordinary string problems that need no model at all.
 *
 * Two kinds of test here, and the second kind matters more:
 *
 *   - the obvious cases resolve, with no escalation;
 *   - the near-misses DO NOT resolve. "Virginia" must not become "West
 *     Virginia", and a real tie must escalate rather than pick a side.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTION_MATCH_POLICY as POLICY,
  matchOption,
} from '@semantic/option-match';
import { DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import type { FieldOption } from '@form-engine/descriptor/types';

/** Build an option list from labels, with values the matcher must not need. */
const options = (...labels: string[]): FieldOption[] =>
  labels.map((label, i) => ({ value: `opt-${i}`, label }));

/** The matched label, or a marker naming why nothing matched. */
const matchedLabel = (value: string, list: FieldOption[]): string => {
  const result = matchOption(value, list);
  return result.kind === 'matched' ? result.option.label : `<${result.kind}>`;
};

describe('matchOption - exact', () => {
  it('matches an option spelled exactly as the value is', () => {
    const result = matchOption('Computer Engineering', options('Biology', 'Computer Engineering'));
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.option.label).toBe('Computer Engineering');
    expect(result.strategy).toBe('exact');
  });

  it('ignores case, punctuation and decoration, which are not meaning', () => {
    expect(matchedLabel('computer engineering', options('Computer Engineering'))).toBe(
      'Computer Engineering',
    );
    expect(matchedLabel("Bachelor's Degree", options('Bachelors Degree'))).toBe('Bachelors Degree');
  });

  it('leaves separator-collapsing to the resolver tier that already ran', () => {
    // "E-Mail" against "Email" is `normalizeCompact`'s case, and the resolver's
    // `compact` strategy handles it BEFORE a field can reach this module. A
    // second implementation here would be a second thing to get wrong, and it
    // would price a lossy comparison differently from the place that already
    // prices it. So this module does not re-attempt it.
    expect(matchedLabel('E-Mail', options('Email'))).toBe('<no_candidate>');
  });

  it('matches on the submitted value when the meaning lives there', () => {
    // Some selects carry a code in the label and the meaning in the value.
    const list: FieldOption[] = [{ value: 'New Jersey', label: 'NJ' }];
    const result = matchOption('New Jersey', list);
    expect(result.kind).toBe('matched');
  });

  it('escalates rather than choosing between two identically labelled options', () => {
    // "The first one that matched" is not a reason.
    const result = matchOption('Engineering', options('Engineering', 'Engineering'));
    expect(result.kind).toBe('ambiguous');
  });
});

describe('matchOption - containment', () => {
  it('matches a reordered, repunctuated spelling of the same words', () => {
    // The case the brief names. The existing resolver's `compact` strategy
    // cannot see this one: "engineeringcomputer" is not "computerengineering".
    const result = matchOption(
      'Computer Engineering',
      options('Biology', 'Engineering, Computer', 'Physics'),
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.option.label).toBe('Engineering, Computer');
    expect(result.strategy).toBe('containment');
  });

  it('matches an option that elaborates on our value', () => {
    expect(matchedLabel('United States', options('United States of America'))).toBe(
      'United States of America',
    );
  });

  it('does NOT select West Virginia when the applicant lives in Virginia', () => {
    // The canonical near-miss. "Virginia" is fully contained in "West Virginia"
    // by any token measure, which is exactly why token containment alone is not
    // safe: an English modifier that CHANGES the entity is a prefix ("West
    // Virginia", "South Korea"), while one that merely elaborates is a suffix
    // ("...of America"). Only the second direction is accepted.
    expect(matchedLabel('Virginia', options('West Virginia'))).toBe('<no_candidate>');
  });

  it('does not quietly drop words from our own value to reach an option', () => {
    // "Rutgers University Newark" is not "Rutgers University" - the campus is
    // the part that distinguishes them, and it is the part being discarded.
    const result = matchOption('Rutgers University Newark', options('Rutgers University'));
    expect(result.kind).not.toBe('matched');
  });

  it('escalates a genuine tie instead of picking a side', () => {
    // Both options extend our value and neither is more right than the other.
    // This is precisely the case a second opinion is FOR, and picking the first
    // would make the escalation path dead code that nobody notices is dead.
    const result = matchOption(
      'Computer Science',
      options('Computer Science BS', 'Computer Science BA'),
    );
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toHaveLength(2);
  });
});

describe('matchOption - token overlap', () => {
  /** A near-identical spelling: one token differs, five agree. */
  const DEGREE = 'Bachelor of Science in Computer Engineering';

  it('accepts a clear winner that beats the runner-up by a margin', () => {
    const result = matchOption(
      DEGREE,
      options('Bachelors of Science in Computer Engineering', 'Master of Arts'),
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.strategy).toBe('token_overlap');
  });

  it('refuses a half-match, however tempting the shared words are', () => {
    // Three tokens of four agree and the fourth is the entire subject. This is
    // the shape of a confidently wrong answer on a job application.
    expect(
      matchedLabel('Computer Science and Engineering', options('Computer Science and Math')),
    ).toBe('<no_candidate>');
  });

  it('does not re-judge a relationship the containment tier already refused', () => {
    // "Virginia" is fully inside "West Virginia", so a loose overlap measure
    // would happily match them. The containment tier looked at exactly that
    // pair and said no; a later, weaker comparison must not be able to overrule
    // an earlier, stronger one. So overlap only judges pairs where neither set
    // contains the other.
    expect(matchedLabel('Virginia', options('West Virginia'))).toBe('<no_candidate>');
    expect(matchedLabel('Rutgers University Newark', options('Rutgers University'))).toBe(
      '<no_candidate>',
    );
  });

  it('reports nothing when no option is even close', () => {
    expect(matchedLabel('Computer Engineering', options('Yes', 'No'))).toBe('<no_candidate>');
  });

  it('never lets a token-overlap match reach the value-autofill bar', () => {
    // Structural, like `sourceScores.fuzzy` in the confidence policy. A weak
    // match may become a suggestion the user reads. It may never become a fill.
    expect(POLICY.tokenOverlapCeiling).toBeLessThan(
      DEFAULT_CONFIDENCE_POLICY.minValueConfidenceForAutofill,
    );

    const result = matchOption(
      DEGREE,
      options('Bachelors of Science in Computer Engineering', 'Master of Arts'),
    );
    if (result.kind !== 'matched') throw new Error('expected a match to score');
    expect(result.score).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.minValueConfidenceForAutofill);
  });
});

describe('matchOption - degenerate input', () => {
  it('reports nothing for an empty option list', () => {
    expect(matchOption('Anything', [])).toEqual({ kind: 'no_candidate' });
  });

  it('reports nothing for an empty value', () => {
    expect(matchOption('   ', options('Yes', 'No'))).toEqual({ kind: 'no_candidate' });
  });

  it('skips an option whose label normalizes away to nothing', () => {
    // Separator rows ("---") are common in long dropdowns and are not answers.
    const result = matchOption('Yes', options('---', 'Yes'));
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.option.label).toBe('Yes');
  });

  it('is a pure function of its inputs', () => {
    const list = options('Computer Engineering', 'Biology');
    const first = matchOption('Computer Engineering', list);
    const second = matchOption('Computer Engineering', list);
    expect(first).toEqual(second);
    // And it did not rewrite the caller's list.
    expect(list.map((o) => o.label)).toEqual(['Computer Engineering', 'Biology']);
  });

  it('makes no network call, because it has nothing to call with', () => {
    // Not a joke test: the value of this module is that a large share of real
    // failures die here, before anything is sent anywhere. `matchOption` takes
    // a string and a list and returns synchronously - there is no seam through
    // which a call could be added without changing this signature.
    const result = matchOption('Computer Engineering', options('Engineering, Computer'));
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('matchOption - strategy ordering', () => {
  it('prefers an exact match over an option that merely extends the value', () => {
    // The rule that keeps the resolver's behaviour intact: "United States" in a
    // list holding both spellings is the exact one, every time.
    const result = matchOption(
      'United States',
      options('United States of America', 'United States'),
    );
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.option.label).toBe('United States');
    expect(result.strategy).toBe('exact');
  });

  it('scores the tiers in descending order of how much they claim', () => {
    expect(POLICY.exactScore).toBeGreaterThan(POLICY.containmentScore);
    expect(POLICY.containmentScore).toBeGreaterThan(POLICY.tokenOverlapCeiling);
  });
});

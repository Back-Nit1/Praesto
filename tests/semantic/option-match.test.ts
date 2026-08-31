/**
 * Deterministic option scorer tests.
 *
 * This module is the one that decides how much of the semantic fallback is free.
 * Every case it settles is a model call not made, a payload not sent, and a
 * millisecond instead of a second - so the positive tests matter more here than
 * anywhere else in this package.
 *
 * The negative tests still matter more. The scorer runs AFTER the resolver's own
 * option matching has already refused, which means by construction it is doing
 * something looser than the code that just said no. Looser matching is how
 * "Virginia" becomes "West Virginia" on a form, so the guards have their own
 * tests and their own names.
 */
import { describe, expect, it } from 'vitest';
import { matchOption } from '@semantic/option-match';
import type { FieldOption } from '@form-engine/descriptor/types';

const opts = (...labels: string[]): FieldOption[] =>
  labels.map((label, index) => ({ value: `v${index}`, label }));

/** The matched label, or a marker for the two non-match outcomes. */
function matchedLabel(value: string, options: FieldOption[]): string {
  const result = matchOption(value, options);
  return result.kind === 'matched' ? result.option.label : `<${result.kind}>`;
}

describe('matchOption - the cases it settles without a model', () => {
  it('matches an option exactly', () => {
    expect(matchedLabel('Bachelor of Science', opts('Bachelor of Science', 'Master of Science'))).toBe(
      'Bachelor of Science',
    );
  });

  it('matches across a case difference', () => {
    expect(matchedLabel('bachelor of science', opts('Bachelor of Science', 'Master of Arts'))).toBe(
      'Bachelor of Science',
    );
  });

  it('matches across punctuation and whitespace', () => {
    expect(matchedLabel('E-Mail  Address', opts('Email address', 'Phone'))).toBe('Email address');
  });

  it('matches a reordered label: "Computer Engineering" against "Engineering, Computer"', () => {
    // The case the brief names. An ATS that lists majors alphabetised by
    // department renders exactly this, and no amount of exact or prefix
    // matching reaches it.
    expect(
      matchedLabel('Computer Engineering', opts('Engineering, Computer', 'Engineering, Civil')),
    ).toBe('Engineering, Computer');
  });

  it('matches an option that adds only a qualifier', () => {
    expect(
      matchedLabel('Rutgers University', opts('Rutgers University - New Brunswick', 'Princeton University')),
    ).toBe('Rutgers University - New Brunswick');
  });

  it('matches on the submitted value when the label carries a code', () => {
    expect(
      matchOption('United States', [
        { value: 'United States', label: 'US' },
        { value: 'Canada', label: 'CA' },
      ]).kind,
    ).toBe('matched');
  });

  it('reports which strategy settled it, so a weak match is auditable', () => {
    const result = matchOption('Computer Engineering', opts('Engineering, Computer'));
    expect(result.kind === 'matched' && result.strategy).toBe('token_set');
  });
});

describe('matchOption - the cases it refuses to settle', () => {
  it('does NOT select West Virginia for an applicant in Virginia', () => {
    // The named regression of this whole codebase. A single-token value carries
    // its entire meaning in that one token, so an option that adds another word
    // is a DIFFERENT place, not a longer name for the same one.
    expect(matchedLabel('Virginia', opts('West Virginia', 'Vermont', 'Washington'))).toBe(
      '<no_candidate>',
    );
  });

  it('does not turn a single token into a longer place name', () => {
    expect(matchedLabel('York', opts('New York', 'Yorkshire'))).toBe('<no_candidate>');
  });

  it('escalates a genuine tie rather than taking the first', () => {
    // Two options whose words are the same words in a different order. Neither
    // is a better answer than the other from where this module stands, and
    // "the first one that matched" is not a reason.
    const result = matchOption('Computer Engineering', opts('Engineering, Computer', 'Engineering Computer'));
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(2);
  });

  it('escalates duplicate option labels rather than guessing which one is meant', () => {
    const result = matchOption('Computer Science', opts('Computer Science', 'Computer  Science'));
    expect(result.kind).toBe('ambiguous');
  });

  it('escalates when two campuses of the same school both contain the value', () => {
    const result = matchOption(
      'Rutgers University',
      opts('Rutgers University - New Brunswick', 'Rutgers University - Newark'),
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('finds no candidate in an unrelated option list', () => {
    expect(matchedLabel('Computer Engineering', opts('Yes', 'No', 'Prefer not to say'))).toBe(
      '<no_candidate>',
    );
  });

  it('finds no candidate in an empty option list', () => {
    expect(matchedLabel('Computer Engineering', [])).toBe('<no_candidate>');
  });

  it('refuses an empty value rather than matching an empty option label', () => {
    expect(matchedLabel('   ', opts('', 'Something'))).toBe('<no_candidate>');
  });

  it('does not match on a partial word overlap that changes the meaning', () => {
    // "Engineering" alone does not identify which engineering programme.
    expect(matchedLabel('Engineering', opts('Computer Engineering', 'Civil Engineering'))).toBe(
      '<no_candidate>',
    );
  });

  it('never returns an option that was not in the list it was given', () => {
    const options = opts('Engineering, Computer', 'Engineering, Civil');
    const result = matchOption('Computer Engineering', options);
    expect(result.kind === 'matched' && options.includes(result.option)).toBe(true);
  });
});

/**
 * How much of the work this module does for free.
 *
 * The brief asks for this to be MEASURED before stage 2 is built, on the
 * grounds that a large share of real refusals die here. The corpus is
 * hand-written from the option shapes real ATS forms use, so the number is a
 * description of our beliefs about real forms rather than of real forms - which
 * is the honest way to read it until the fixtures in phase 7 exist.
 */
describe('matchOption - deterministic coverage of the option-matching corpus', () => {
  const corpus: Array<{ value: string; options: string[]; expect: string | null }> = [
    { value: 'Bachelor of Science', options: ['Bachelor of Science', "Master's Degree"], expect: 'Bachelor of Science' },
    { value: 'bachelors degree', options: ["Bachelor's Degree", "Master's Degree"], expect: "Bachelor's Degree" },
    { value: 'Computer Engineering', options: ['Engineering, Computer', 'Engineering, Civil'], expect: 'Engineering, Computer' },
    { value: 'Computer Science', options: ['Computer Science (BS)', 'Data Science (BS)'], expect: 'Computer Science (BS)' },
    { value: 'New Jersey', options: ['New Jersey', 'New York'], expect: 'New Jersey' },
    { value: 'United States', options: ['United States of America', 'United Kingdom'], expect: 'United States of America' },
    { value: 'Rutgers University', options: ['Rutgers University', 'Rowan University'], expect: 'Rutgers University' },
    { value: '3-5 years', options: ['3-5 years', '5-7 years'], expect: '3-5 years' },
    { value: 'San Francisco, CA', options: ['San Francisco, CA', 'New York, NY'], expect: 'San Francisco, CA' },
    { value: 'Remote', options: ['Remote', 'Hybrid', 'On-site'], expect: 'Remote' },
    // Deliberately unmatchable: these are what stage 2 exists for.
    { value: '4', options: ['Less than 1 year', '1-3 years', '3-5 years'], expect: null },
    { value: 'Rutgers', options: ['Rutgers University - New Brunswick', 'Rutgers University - Newark'], expect: null },
    { value: 'Virginia', options: ['West Virginia', 'Vermont'], expect: null },
  ];

  it('settles the cases it should and refuses the cases it should', () => {
    const settled = corpus.filter(
      (row) => matchedLabel(row.value, opts(...row.options)) === (row.expect ?? '<no_candidate>'),
    );
    expect(settled).toHaveLength(corpus.length);
  });

  it('settles at least two thirds of the corpus with no model call', () => {
    const free = corpus.filter((row) => matchOption(row.value, opts(...row.options)).kind === 'matched');
    // 10 of 13 by construction. Asserted as a ratio so the test says what it
    // is protecting: if a future change makes the scorer meaningfully more
    // timid, the cost lands on the user's quota and this fails first.
    expect(free.length / corpus.length).toBeGreaterThanOrEqual(2 / 3);
  });
});

/**
 * Normalization tests.
 *
 * The negation cases are the reason this file exists. Everything else here is
 * ordinary string handling; the negation rule is the one that keeps a wrong
 * answer off a legal question.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeNameVariants,
  containmentScore,
  containsNegation,
  normalizeAttributeName,
  normalizeCompact,
  normalizeLabel,
  stripFiller,
  tokenSimilarity,
} from '@form-engine/descriptor/normalize';

describe('normalizeLabel', () => {
  it('collapses the ways a form decorates the same label', () => {
    const variants = [
      'First Name',
      'First Name *',
      'FIRST NAME',
      '  First   Name  ',
      'First Name:',
      'First Name (required)',
    ];
    for (const variant of variants) {
      expect(normalizeLabel(variant), variant).toBe('first name');
    }
  });

  it('splits on hyphens rather than joining across them', () => {
    // "e-mail" must become two words. Deleting the hyphen instead would also
    // turn "state-province" into "stateprovince", inventing a single word.
    expect(normalizeLabel('E-Mail Address')).toBe('e mail address');
    expect(normalizeLabel('State-Province')).toBe('state province');
  });

  it('normalizes non-breaking spaces, which are invisible in a diff', () => {
    expect(normalizeLabel('First Name')).toBe('first name');
  });

  it('strips accents so headings compare equal', () => {
    expect(normalizeLabel('Résumé')).toBe('resume');
  });

  it('normalizes a possessive to one token, whichever apostrophe was used', () => {
    // Both spellings must land on the same string, and the apostrophe must not
    // leave a stray one-letter token behind to dilute similarity scoring.
    expect(normalizeLabel('Bachelor’s Degree')).toBe('bachelors degree');
    expect(normalizeLabel("Bachelor's Degree")).toBe('bachelors degree');
  });

  it('returns empty for absent input rather than the string "undefined"', () => {
    expect(normalizeLabel(undefined)).toBe('');
    expect(normalizeLabel(null)).toBe('');
  });
});

describe('normalizeCompact', () => {
  it('joins across separators for the fallback match', () => {
    expect(normalizeCompact('E-Mail Address')).toBe('emailaddress');
    expect(normalizeCompact('e mail address')).toBe('emailaddress');
  });
});

describe('normalizeAttributeName', () => {
  it('splits camelCase and PascalCase', () => {
    expect(normalizeAttributeName('firstName')).toBe('first name');
    expect(normalizeAttributeName('candidateLastName')).toBe('candidate last name');
  });

  it('handles acronym boundaries', () => {
    expect(normalizeAttributeName('URLField')).toBe('url field');
  });

  it('splits snake_case, kebab-case and dotted names', () => {
    expect(normalizeAttributeName('legal_first_name')).toBe('legal first name');
    expect(normalizeAttributeName('cand-fname')).toBe('cand fname');
    expect(normalizeAttributeName('profile.email')).toBe('profile email');
  });
});

describe('attributeNameVariants', () => {
  it('extracts the author-delimited segment from a Rails-style name', () => {
    const variants = attributeNameVariants('job_application[email]');
    expect(variants[0]).toEqual({ text: 'job application email', kind: 'full' });
    expect(variants).toContainEqual({ text: 'email', kind: 'segment' });
  });

  it('takes the innermost bracket from a nested name', () => {
    const variants = attributeNameVariants('application[answers][2][value]');
    expect(variants).toContainEqual({ text: 'value', kind: 'segment' });
  });

  it('marks a truncation as a suffix, not a segment', () => {
    // This distinction is what stops `emergency_contact_phone_number` from
    // matching "phone number" at full attribute confidence.
    const variants = attributeNameVariants('emergency_contact_phone_number');
    const phoneNumber = variants.find((v) => v.text === 'phone number');
    expect(phoneNumber?.kind).toBe('suffix');
  });

  it('produces exactly one reading for a name with no namespace', () => {
    expect(attributeNameVariants('email')).toEqual([{ text: 'email', kind: 'full' }]);
  });
});

describe('containsNegation', () => {
  it('detects the words that invert a question', () => {
    expect(containsNegation(normalizeLabel('Do you NOT require sponsorship?'))).toBe(true);
    expect(containsNegation(normalizeLabel('I am unable to relocate'))).toBe(true);
    expect(containsNegation(normalizeLabel("Don't send me updates"))).toBe(true);
    expect(containsNegation(normalizeLabel('Neither of these apply'))).toBe(true);
  });

  it('does not flag an ordinary question', () => {
    expect(containsNegation(normalizeLabel('Do you require sponsorship?'))).toBe(false);
    expect(containsNegation(normalizeLabel('First name'))).toBe(false);
  });
});

describe('stripFiller', () => {
  it('drops boilerplate', () => {
    expect(stripFiller('please enter your email address')).toBe('enter email address');
  });

  it('keeps every word that could change a meaning', () => {
    // If any of these were treated as filler, two opposite questions would
    // normalize to the same string.
    for (const word of ['not', 'no', 'other', 'current', 'previous', 'former', 'any']) {
      expect(stripFiller(`sponsorship ${word} required`), word).toContain(word);
    }
  });
});

describe('similarity scoring', () => {
  it('scores identical token sets as 1', () => {
    expect(tokenSimilarity('phone number', 'number phone')).toBe(1);
  });

  it('reports containment and overlap as different facts', () => {
    // "linkedin" inside "linkedin profile url": fully contained, but only a
    // third of the combined vocabulary. Both numbers are true.
    expect(containmentScore('linkedin', 'linkedin profile url')).toBe(1);
    expect(tokenSimilarity('linkedin', 'linkedin profile url')).toBeCloseTo(1 / 3, 5);
  });

  it('scores unrelated strings at zero', () => {
    expect(tokenSimilarity('first name', 'salary expectations')).toBe(0);
  });
});

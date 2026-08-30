/**
 * Phone normalizer tests.
 *
 * The theme matches the date tests: we assert what we produce AND what we
 * refuse to produce. A phone number rendered in a format we cannot actually
 * derive is a wrong answer on a job application.
 */
import { describe, expect, it } from 'vitest';
import { formatPhone, parsePhone } from '@profile/normalizers/phone';

describe('parsePhone', () => {
  it('parses every common way a US number is written', () => {
    const written = [
      '(609) 555-1234',
      '609-555-1234',
      '609.555.1234',
      '6095551234',
      '+1 609 555 1234',
      '1-609-555-1234',
    ];
    for (const input of written) {
      const parsed = parsePhone(input);
      expect(parsed, input).not.toBeNull();
      expect(parsed?.digits, input).toBe('6095551234');
      expect(parsed?.international, input).toBe('+16095551234');
      expect(parsed?.national, input).toBe('(609) 555-1234');
      expect(parsed?.countryCode, input).toBe('1');
    }
  });

  it('preserves the raw string exactly as given', () => {
    expect(parsePhone('  (609) 555-1234 ')?.raw).toBe('(609) 555-1234');
  });

  it('drops an extension instead of concatenating it into the number', () => {
    // "6095551234203" would be a silently invalid 13-digit number.
    expect(parsePhone('609-555-1234 ext 203')?.digits).toBe('6095551234');
    expect(parsePhone('609-555-1234 x203')?.digits).toBe('6095551234');
  });

  it('keeps a non-NANP international number in E.164 without guessing its country code', () => {
    const parsed = parsePhone('+44 20 7946 0958');
    expect(parsed?.international).toBe('+442079460958');
    expect(parsed?.digits).toBe('442079460958');
    // We cannot split "44" off reliably without a prefix table, so we say so by
    // leaving the field unset rather than splitting at a guessed position.
    expect(parsed?.countryCode).toBeUndefined();
    expect(parsed?.national).toBeUndefined();
  });

  it('stores digits for a plausible number of unknown plan', () => {
    const parsed = parsePhone('020 7946 0958');
    expect(parsed?.digits).toBe('02079460958');
    expect(parsed?.national).toBeUndefined();
  });

  it('rejects strings that cannot be a phone number', () => {
    for (const input of ['', '   ', 'n/a', '12345', '1234567890123456789']) {
      expect(parsePhone(input), input).toBeNull();
    }
  });
});

describe('formatPhone', () => {
  const us = parsePhone('(609) 555-1234');
  const intl = parsePhone('+44 20 7946 0958');

  it('renders every US format a form might demand', () => {
    expect(formatPhone(us, 'E164')).toBe('+16095551234');
    expect(formatPhone(us, 'NATIONAL')).toBe('(609) 555-1234');
    expect(formatPhone(us, 'DIGITS')).toBe('6095551234');
    expect(formatPhone(us, 'DASHED')).toBe('609-555-1234');
    expect(formatPhone(us, 'COUNTRY_CODE')).toBe('1');
    expect(formatPhone(us, 'AREA_CODE')).toBe('609');
  });

  it('refuses NANP-only formats for a non-NANP number', () => {
    // The first three digits of a UK number are not an area code. Emitting them
    // as one would be confidently wrong.
    expect(formatPhone(intl, 'AREA_CODE')).toBeNull();
    expect(formatPhone(intl, 'DASHED')).toBeNull();
    expect(formatPhone(intl, 'NATIONAL')).toBeNull();
    // What we genuinely know still renders.
    expect(formatPhone(intl, 'E164')).toBe('+442079460958');
  });

  it('returns null for a missing number rather than an empty string', () => {
    // An empty string typed into a required field passes HTML validation and
    // submits a blank answer; null leaves the control untouched for the user.
    expect(formatPhone(null, 'E164')).toBeNull();
  });
});

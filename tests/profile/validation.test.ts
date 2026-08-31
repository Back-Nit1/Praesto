/**
 * Syntactic validation.
 *
 * The rule these encode: a validator that refuses a REAL value is worse than
 * one that accepts a typo, because the user cannot argue with us. So the
 * accept-list is deliberately wide and the reject-list is narrow - typos,
 * half-typed values, and things that are structurally not the shape at all.
 */
import { describe, expect, it } from 'vitest';
import {
  isBlank,
  isEmailShaped,
  isPostalCodeShaped,
  isUrlShaped,
  matchesFormat,
  trimValue,
} from '@profile/validation';

describe('isBlank', () => {
  it('treats every kind of whitespace a form can contain as empty', () => {
    // The non-breaking space is the one that matters: ATS markup is full of
    // them, they are invisible in a diff, and `=== ''` misses every one.
    for (const value of ['', '   ', '\t\n', ' ', '   ']) {
      expect(isBlank(value)).toBe(true);
    }
  });

  it('does not treat a real value as empty', () => {
    for (const value of ['a', ' a ', '0', '-']) expect(isBlank(value)).toBe(false);
  });
});

describe('trimValue', () => {
  it('returns the same reference when there is nothing to trim', () => {
    // Not a micro-optimisation for its own sake: this runs per keystroke per
    // field, and the common case is a string with no stray whitespace at all.
    const value = 'Nityanth';
    expect(trimValue(value)).toBe(value);
  });

  it('trims both ends, including non-breaking space', () => {
    expect(trimValue('  nitu@example.com \n')).toBe('nitu@example.com');
  });
});

describe('isEmailShaped', () => {
  it('accepts the addresses people actually have', () => {
    const valid = [
      'nitu@example.com',
      'first.last@sub.example.co.uk',
      'user+jobs@example.io',
      'a@b.co',
      "o'brien@example.com",
      'user_name-1@example-host.com',
    ];
    for (const value of valid) expect(isEmailShaped(value), value).toBe(true);
  });

  it('rejects the mistakes people actually make', () => {
    const invalid = [
      '',
      'nitu',
      'nitu@',
      '@example.com',
      'nitu@@example.com',
      'nitu@example',
      'nitu@.com',
      'nitu@example..com',
      'nitu@example.c',
      'nitu example@x.com',
    ];
    for (const value of invalid) expect(isEmailShaped(value), value).toBe(false);
  });

  it('ignores surrounding whitespace rather than failing on it', () => {
    expect(isEmailShaped('  nitu@example.com  ')).toBe(true);
  });
});

describe('isUrlShaped', () => {
  it('accepts what people type into a LinkedIn box', () => {
    const valid = [
      'https://www.linkedin.com/in/someone',
      'http://example.com',
      'linkedin.com/in/someone',
      'www.example.co.uk',
      'example.com/path?a=b#c',
      'example.com:8443/apply',
    ];
    for (const value of valid) expect(isUrlShaped(value), value).toBe(true);
  });

  it('rejects half-typed addresses and pasted sentences', () => {
    // A dotless host ("linkedin", "localhost") is rejected on purpose: in a
    // PROFILE link field it is always a half-typed address, never a real one.
    const invalid = [
      '',
      'linkedin',
      'localhost:5173',
      'https://',
      'example .com',
      'see my profile at example.com',
    ];
    for (const value of invalid) expect(isUrlShaped(value), value).toBe(false);
  });

  it('refuses a scheme that is not http(s)', () => {
    // The one input on this screen that could become dangerous downstream: a
    // profile "link" is rendered into a page and may be clicked.
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'mailto:nitu@example.com']) {
      expect(isUrlShaped(value), value).toBe(false);
    }
  });
});

describe('isPostalCodeShaped', () => {
  it('accepts codes from more than one country', () => {
    // Encoding the US 5-digit format would silently mark a real Canadian or
    // British address as unreadable.
    for (const value of ['08901', '08901-1234', 'K1A 0B1', 'SW1A 1AA', '75008']) {
      expect(isPostalCodeShaped(value), value).toBe(true);
    }
  });

  it('rejects a sentence or a stray symbol', () => {
    for (const value of ['', 'ab', 'New Brunswick, NJ', '08901!', '1234567890123']) {
      expect(isPostalCodeShaped(value), value).toBe(false);
    }
  });
});

describe('matchesFormat', () => {
  it('never calls blank valid, whatever the format', () => {
    // Blank is handled by the caller as "no value"; treating it as valid here
    // is what let an empty string be stored as user-verified.
    for (const format of ['text', 'email', 'url', 'postal_code'] as const) {
      expect(matchesFormat('   ', format)).toBe(false);
    }
  });

  it('accepts any non-blank text for an unformatted field', () => {
    expect(matchesFormat('Rutgers University', 'text')).toBe(true);
  });
});

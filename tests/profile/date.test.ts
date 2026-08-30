/**
 * Date normalizer tests.
 *
 * These read as a specification of the product rule, not of the implementation:
 * for every input we assert BOTH what is parsed AND what is deliberately left
 * unknown. The "returns null" cases are the important ones - they are the
 * behaviour that keeps a wrong date out of a job application.
 */
import { describe, expect, it } from 'vitest';
import { formatDate, isEmptyDate, parseDate } from '@profile/normalizers/date';

describe('parseDate', () => {
  it('parses "May 2025" without inventing a day', () => {
    const d = parseDate('May 2025');
    expect(d).toMatchObject({ year: 2025, month: 5 });
    // The critical assertion: we do NOT fill in a day we were never told.
    expect(d?.day).toBeUndefined();
    expect(d?.iso).toBeUndefined();
  });

  it('parses abbreviated and 4-letter month names', () => {
    expect(parseDate('Sep 2024')).toMatchObject({ year: 2024, month: 9 });
    expect(parseDate('Sept 2024')).toMatchObject({ year: 2024, month: 9 });
    expect(parseDate('Dec. 2026')).toMatchObject({ year: 2026, month: 12 });
  });

  it('ignores leading words around a month name', () => {
    expect(parseDate('Expected December 2026')).toMatchObject({ year: 2026, month: 12 });
  });

  it('parses ISO year-month and full ISO dates', () => {
    expect(parseDate('2025-05')).toMatchObject({ year: 2025, month: 5 });
    expect(parseDate('2025-05-14')).toMatchObject({ year: 2025, month: 5, day: 14, iso: '2025-05-14' });
  });

  it('parses MM/YYYY', () => {
    expect(parseDate('05/2025')).toMatchObject({ year: 2025, month: 5 });
  });

  it('parses a bare year', () => {
    expect(parseDate('2025')).toMatchObject({ year: 2025 });
  });

  it('recognises open-ended end dates', () => {
    for (const token of ['Present', 'present', 'Current', 'Now', 'Ongoing']) {
      expect(parseDate(token)).toMatchObject({ isPresent: true });
    }
  });

  it('flags a genuinely ambiguous numeric date instead of silently choosing', () => {
    // 03/04/2025 is March 4 (US) or April 3 (international). Both are valid, so
    // we record our reading AND the fact that it was a coin flip.
    const d = parseDate('03/04/2025', 'US_MDY');
    expect(d).toMatchObject({ year: 2025, month: 3, day: 4, ambiguousDayMonth: true });
  });

  it('does not flag an unambiguous numeric date', () => {
    // 25 cannot be a month, so there is only one valid reading.
    const d = parseDate('25/03/2025', 'US_MDY');
    expect(d).toMatchObject({ year: 2025, month: 3, day: 25 });
    expect(d?.ambiguousDayMonth).toBeUndefined();
  });

  it('respects the international convention when asked', () => {
    const d = parseDate('03/04/2025', 'INTL_DMY');
    expect(d).toMatchObject({ month: 4, day: 3 });
  });

  it('drops an impossible day rather than clamping it', () => {
    const d = parseDate('2025-02-30');
    expect(d?.month).toBe(2);
    // Clamping to the 28th would be a fabricated date the source never stated.
    expect(d?.day).toBeUndefined();
  });

  it('rejects input carrying no calendar information', () => {
    for (const input of ['', '   ', 'Rutgers University', 'GPA 3.9', 'n/a']) {
      expect(parseDate(input)).toBeNull();
    }
  });

  it('rejects implausible years that are really other numbers', () => {
    expect(parseDate('1234-56')).toBeNull();
    expect(parseDate('0847')).toBeNull();
  });

  it('preserves the raw source text for the audit trail', () => {
    expect(parseDate('  May 2025 ')?.raw).toBe('May 2025');
  });
});

describe('formatDate', () => {
  const may2025 = parseDate('May 2025');
  const full = parseDate('2025-05-14');

  it('renders every format a form might ask for', () => {
    expect(formatDate(may2025, 'MONTH_NAME_YEAR')).toBe('May 2025');
    expect(formatDate(may2025, 'MONTH_ABBR_YEAR')).toBe('May 2025');
    expect(formatDate(may2025, 'MM_YYYY')).toBe('05/2025');
    expect(formatDate(may2025, 'YYYY_MM')).toBe('2025-05');
    expect(formatDate(may2025, 'MONTH_NAME')).toBe('May');
    expect(formatDate(may2025, 'MONTH_NUMBER')).toBe('5');
    expect(formatDate(may2025, 'MONTH_NUMBER_PADDED')).toBe('05');
    expect(formatDate(may2025, 'YEAR')).toBe('2025');
    expect(formatDate(full, 'MM_DD_YYYY')).toBe('05/14/2025');
    expect(formatDate(full, 'YYYY_MM_DD')).toBe('2025-05-14');
  });

  it('refuses formats that would require inventing a component', () => {
    // We know May 2025. We do NOT know the day. A form asking for MM/DD/YYYY
    // gets nothing rather than the 1st of the month.
    expect(formatDate(may2025, 'MM_DD_YYYY')).toBeNull();
    expect(formatDate(may2025, 'YYYY_MM_DD')).toBeNull();
  });

  it('renders nothing numeric for an open-ended date', () => {
    const present = parseDate('Present');
    expect(formatDate(present, 'YEAR')).toBeNull();
    expect(formatDate(present, 'MM_YYYY')).toBeNull();
  });

  it('returns null for missing input rather than a default date', () => {
    expect(formatDate(null, 'YEAR')).toBeNull();
    expect(formatDate(undefined, 'MM_YYYY')).toBeNull();
  });
});

describe('isEmptyDate', () => {
  it('distinguishes no-information from open-ended', () => {
    expect(isEmptyDate(null)).toBe(true);
    expect(isEmptyDate({ raw: 'garbage' })).toBe(true);
    expect(isEmptyDate(parseDate('Present'))).toBe(false);
    expect(isEmptyDate(parseDate('2025'))).toBe(false);
  });
});

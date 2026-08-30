/**
 * Date normalization.
 * ---------------------------------------------------------------------------
 * Spec section 7: "Applications request the same fact in many formats. Do not
 * repeatedly ask AI to convert them."
 *
 * A graduation date is ONE fact. Applications ask for it as:
 *
 *     May 2025 | 05/2025 | 2025-05 | 05/01/2025 | May | 2025 | Present
 *
 * plus a separate month dropdown and year dropdown on Workday-style forms. If
 * we stored only the string the resume happened to contain, every one of those
 * renderings would be a fresh guess. So we parse ONCE into a partial calendar
 * value and render deterministically from there.
 *
 * THE CENTRAL DESIGN DECISION: PARTIAL DATES ARE FIRST CLASS
 * A JavaScript `Date` cannot represent "May 2025, day unknown" - it would
 * invent the 1st. Inventing a day is exactly the class of confident-but-wrong
 * behaviour this product exists to avoid. So `NormalizedDate` keeps year, month
 * and day as independently-optional fields, and every renderer that needs a
 * component we do not have returns `null` instead of a plausible fabrication.
 *
 * AMBIGUITY IS REFUSED, NOT RESOLVED
 * "03/04/2025" is March 4th in the US and April 3rd almost everywhere else.
 * There is no signal on a resume that settles it. We therefore parse it under a
 * declared locale convention and record that the day was ambiguous, so the
 * profile editor can flag it for the user rather than silently pick one.
 */

/**
 * A calendar value where any component may be unknown.
 * Every field is optional on purpose - see the module comment.
 */
export interface NormalizedDate {
  /** Exactly what the source said, preserved verbatim for the audit trail. */
  raw?: string;
  year?: number;
  /** 1-12. One-based to match how humans and form dropdowns count months. */
  month?: number;
  /** 1-31. */
  day?: number;
  /** ISO 8601 - only present when the date is complete (Y-M-D all known). */
  iso?: string;
  /** True for "Present" / "Current" - an open-ended end date, not a date. */
  isPresent?: boolean;
  /**
   * True when the source could be read as either D/M/Y or M/D/Y and the two
   * readings disagree. The profile editor surfaces this as "needs review"
   * rather than trusting our convention.
   */
  ambiguousDayMonth?: boolean;
}

/** Which order a bare numeric date like 03/04/2025 should be read in. */
export type DateOrderConvention = 'US_MDY' | 'INTL_DMY';

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** Three-letter abbreviations, used for both parsing and rendering. */
const MONTH_ABBREVIATIONS = MONTH_NAMES.map((m) => m.slice(0, 3));

/** Tokens that mean "this is still going", not a date. */
const PRESENT_TOKENS = new Set([
  'present',
  'current',
  'currently',
  'now',
  'to date',
  'ongoing',
  'today',
]);

/**
 * Plausible-year window. A resume date outside this range is far more likely to
 * be a misparsed page number, street number, or GPA than a real year, so we
 * reject rather than store a nonsense year that could be filled into a form.
 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

const isValidYear = (n: number): boolean => Number.isInteger(n) && n >= MIN_YEAR && n <= MAX_YEAR;
const isValidMonth = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 12;
const isValidDay = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 31;

/**
 * Days per month, used to reject impossible dates like 2025-02-30.
 * Leap years are handled by the February branch.
 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Resolve a month word or abbreviation to 1-12, or undefined if unrecognised. */
function monthFromName(token: string): number | undefined {
  const normalized = token.toLowerCase().replace(/\.$/, '');
  const fullIndex = MONTH_NAMES.indexOf(normalized as (typeof MONTH_NAMES)[number]);
  if (fullIndex >= 0) return fullIndex + 1;
  // "sept" is a common real-world abbreviation that is 4 letters, so compare on
  // the first three rather than requiring an exact abbreviation match.
  const abbrevIndex = MONTH_ABBREVIATIONS.indexOf(normalized.slice(0, 3));
  return abbrevIndex >= 0 ? abbrevIndex + 1 : undefined;
}

/**
 * Attach `iso` when, and only when, all three components are known and the
 * combination is a real calendar date.
 */
function withIso(date: NormalizedDate): NormalizedDate {
  const { year, month, day } = date;
  if (year === undefined || month === undefined || day === undefined) return date;
  if (day > daysInMonth(year, month)) {
    // An impossible day means we misparsed. Drop the day rather than clamp it:
    // a wrong-but-plausible day is worse than a missing one.
    const { day: _dropped, ...rest } = date;
    return rest;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return { ...date, iso: `${year}-${pad(month)}-${pad(day)}` };
}

/**
 * Parse a human-written date fragment into a NormalizedDate.
 *
 * Returns `null` - not a fabricated date - when the input carries no usable
 * calendar information. Callers treat null as "we do not know", which flows
 * through to a blank form field rather than a guess.
 */
export function parseDate(
  input: string | null | undefined,
  convention: DateOrderConvention = 'US_MDY',
): NormalizedDate | null {
  if (input === null || input === undefined) return null;

  const raw = input.trim();
  if (raw.length === 0) return null;

  // Normalize the separators resumes use interchangeably: en/em dashes, commas,
  // and the word "of". Keep slashes and hyphens, which are structural.
  const cleaned = raw
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // unicode dash family -> ASCII hyphen
    .replace(/,/g, ' ')
    .replace(/\bof\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // --- "Present" and friends ------------------------------------------------
  if (PRESENT_TOKENS.has(cleaned)) {
    return { raw, isPresent: true };
  }

  // --- ISO-ish: 2025-05-14 or 2025-05 or 2025/05 ---------------------------
  const isoMatch = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(cleaned);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = isoMatch[3] === undefined ? undefined : Number(isoMatch[3]);
    if (isValidYear(year) && isValidMonth(month)) {
      const base: NormalizedDate = { raw, year, month };
      return withIso(day !== undefined && isValidDay(day) ? { ...base, day } : base);
    }
    return null;
  }

  // --- Month name forms: "May 2025", "May 14 2025", "14 May 2025" ----------
  // Scan every alphabetic token rather than only the first, so leading noise
  // ("graduated may 2025", "expected december 2026") still resolves. A token
  // that is not a month simply does not match, so this cannot invent a month.
  {
    const words = cleaned.match(/[a-z]{3,9}/g) ?? [];
    let month: number | undefined;
    for (const word of words) {
      month = monthFromName(word);
      if (month !== undefined) break;
    }
    if (month !== undefined) {
      // Collect every number in the string and classify by magnitude: a 4-digit
      // number is a year, a 1-2 digit number is a day. This handles both
      // "May 14 2025" and "14 May 2025" without separate patterns.
      const numbers = (cleaned.match(/\d+/g) ?? []).map(Number);
      const year = numbers.find((n) => n >= 1000 && isValidYear(n));
      const day = numbers.find((n) => n < 1000 && isValidDay(n));

      const result: NormalizedDate = { raw, month };
      if (year !== undefined) result.year = year;
      if (day !== undefined) result.day = day;
      return withIso(result);
    }
  }

  // --- Numeric slash forms: 05/2025, 05/14/2025, 14/05/2025 ----------------
  const slashParts = cleaned.split(/[/-]/).filter((p) => p.length > 0);
  if (slashParts.length >= 2 && slashParts.every((p) => /^\d+$/.test(p))) {
    const nums = slashParts.map(Number);

    // Two components: month/year (e.g. "05/2025"). A 4-digit second component
    // is unambiguously the year.
    if (nums.length === 2) {
      const [first, second] = nums as [number, number];
      if (isValidMonth(first) && isValidYear(second)) {
        return { raw, month: first, year: second };
      }
      return null;
    }

    // Three components: date order depends on convention, and may be ambiguous.
    if (nums.length === 3) {
      const [a, b, c] = nums as [number, number, number];
      if (!isValidYear(c)) return null;

      const usReading = { month: a, day: b };
      const intlReading = { month: b, day: a };
      const chosen = convention === 'US_MDY' ? usReading : intlReading;
      const other = convention === 'US_MDY' ? intlReading : usReading;

      if (!isValidMonth(chosen.month) || !isValidDay(chosen.day)) {
        // Our convention does not produce a valid date but the other one might
        // (e.g. "25/03/2025" under US_MDY). Fall back to the reading that works;
        // this is disambiguation by validity, not by guessing.
        if (isValidMonth(other.month) && isValidDay(other.day)) {
          return withIso({ raw, year: c, month: other.month, day: other.day });
        }
        return null;
      }

      // Both readings are valid and they disagree -> genuinely ambiguous. Record
      // the flag so the profile editor can ask the user instead of assuming.
      const bothValid = isValidMonth(other.month) && isValidDay(other.day);
      const readingsDiffer = other.month !== chosen.month;
      const result = withIso({ raw, year: c, month: chosen.month, day: chosen.day });
      return bothValid && readingsDiffer ? { ...result, ambiguousDayMonth: true } : result;
    }
  }

  // --- Bare year: "2025" ----------------------------------------------------
  if (/^\d{4}$/.test(cleaned)) {
    const year = Number(cleaned);
    return isValidYear(year) ? { raw, year } : null;
  }

  // Nothing matched. Returning null, not a partial guess, is the point.
  return null;
}

/**
 * The rendering shapes application forms actually ask for.
 * Adding a format here is how we support a new form without touching parsing.
 */
export type DateFormat =
  | 'MONTH_NAME_YEAR' // May 2025
  | 'MONTH_ABBR_YEAR' // May 2025 (abbreviated month names)
  | 'MM_YYYY' // 05/2025
  | 'YYYY_MM' // 2025-05
  | 'MM_DD_YYYY' // 05/14/2025
  | 'YYYY_MM_DD' // 2025-05-14
  | 'MONTH_NAME' // May
  | 'MONTH_NUMBER' // 5
  | 'MONTH_NUMBER_PADDED' // 05
  | 'YEAR'; // 2025

/** Capitalise a lowercase month name for display. */
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Render a NormalizedDate in a requested format.
 *
 * Returns `null` when the date lacks a component the format requires. Callers
 * must treat null as "leave the field alone" - never as "use today" or "use
 * January". This is the single most important contract in this module.
 */
export function formatDate(date: NormalizedDate | null | undefined, format: DateFormat): string | null {
  if (date === null || date === undefined) return null;

  // An open-ended date has no numeric components to render. The caller decides
  // what "Present" looks like in its own control (a checkbox, or the literal
  // word) - that is a resolver concern, not a formatting concern.
  if (date.isPresent === true) return null;

  const { year, month, day } = date;
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthName = month !== undefined ? MONTH_NAMES[month - 1] : undefined;

  switch (format) {
    case 'YEAR':
      return year !== undefined ? String(year) : null;

    case 'MONTH_NUMBER':
      return month !== undefined ? String(month) : null;

    case 'MONTH_NUMBER_PADDED':
      return month !== undefined ? pad(month) : null;

    case 'MONTH_NAME':
      return monthName !== undefined ? titleCase(monthName) : null;

    case 'MONTH_NAME_YEAR':
      return monthName !== undefined && year !== undefined ? `${titleCase(monthName)} ${year}` : null;

    case 'MONTH_ABBR_YEAR':
      return monthName !== undefined && year !== undefined
        ? `${titleCase(monthName.slice(0, 3))} ${year}`
        : null;

    case 'MM_YYYY':
      return month !== undefined && year !== undefined ? `${pad(month)}/${year}` : null;

    case 'YYYY_MM':
      return month !== undefined && year !== undefined ? `${year}-${pad(month)}` : null;

    case 'MM_DD_YYYY':
      return month !== undefined && day !== undefined && year !== undefined
        ? `${pad(month)}/${pad(day)}/${year}`
        : null;

    case 'YYYY_MM_DD':
      return date.iso ?? null;
  }
}

/** True when the value carries no calendar information at all. */
export function isEmptyDate(date: NormalizedDate | null | undefined): boolean {
  if (date === null || date === undefined) return true;
  return (
    date.year === undefined &&
    date.month === undefined &&
    date.day === undefined &&
    date.isPresent !== true
  );
}

/**
 * The value resolver.
 * ---------------------------------------------------------------------------
 * The mapper answered "what is this field asking for?". The resolver answers a
 * different question (spec section 14):
 *
 *     "Given this concept and THIS control, what exact representation should
 *      be supplied?"
 *
 * The same stored fact renders differently depending on the control it is going
 * into, and getting this wrong is a silent failure: the field looks filled, the
 * form rejects it on submit, and the user has to find which one.
 *
 *     contact.phone            + input[type=tel]        -> "(609) 555-1234"
 *     contact.phone            + a "digits only" field  -> "6095551234"
 *     education[0].gradDate    + a month <select>        -> "May"
 *     education[0].gradDate    + a year <select>         -> "2027"
 *     contact.country          + <select> of 250 options -> "United States"
 *
 * WHY THIS IS NOT INSIDE THE ATS ADAPTERS
 * Spec section 14 is explicit: "Create formatter/resolver functions rather than
 * embedding formatting inside ATS adapters." If Greenhouse and Lever each
 * carried their own date formatting, a bug in month rendering would need fixing
 * in as many places as we have adapters, and the fixes would drift. Formatting
 * belongs to the VALUE, not to the platform.
 *
 * THE RESOLVER MAY REFUSE
 * Every function here can return null, and null means "leave this control
 * alone". A resolver that always produces something would defeat the entire
 * confidence architecture upstream of it - the mapper's careful refusal to
 * guess is worthless if the resolver then invents a value anyway.
 */
import { formatDate, type DateFormat, type NormalizedDate } from '@profile/normalizers/date';
import { formatPhone, type NormalizedPhone, type PhoneFormat } from '@profile/normalizers/phone';
import { bestConfidence, isVerified, type ApplicantProfile } from '@profile/schema';
import { getValueAtPath } from '@profile/selectors';
import { normalizeLabel, normalizeCompact } from '../descriptor/normalize';
import type { FieldDescriptor, FieldOption } from '../descriptor/types';

/**
 * A value ready to be handed to a control adapter.
 *
 * `value` is deliberately a narrow union rather than `unknown`: every control
 * adapter must be able to exhaustively handle what it might receive, and an
 * `unknown` here would push that burden into every adapter as a runtime check.
 */
export interface ResolvedValue {
  /** What to put in the control. */
  value: string | boolean;
  /**
   * For option-based controls, the option we matched. Adapters select by
   * identity where possible rather than by re-searching on the string, which
   * avoids picking a different option that happens to share a label.
   */
  option?: FieldOption;
  /** 0..1 confidence in the VALUE (distinct from mapping confidence). */
  confidence: number;
  /** Whether the user personally verified the underlying profile value. */
  verifiedByUser: boolean;
  /** How the representation was produced, for the audit record. */
  formatting: string;
}

/** Why a resolution produced nothing. Distinct causes need distinct UI. */
export type ResolutionFailure =
  /** The path resolves to no stored value. Ask the user to fill their profile. */
  | 'no_value'
  /** We have the value but cannot render it for this control. */
  | 'no_representation'
  /** An option-based control offered nothing that matches our value. */
  | 'no_matching_option'
  /** The path is not one we know. A bug or stale learned mapping. */
  | 'unknown_path';

export type ResolutionResult =
  | { readonly ok: true; readonly resolved: ResolvedValue }
  | { readonly ok: false; readonly reason: ResolutionFailure };

const fail = (reason: ResolutionFailure): ResolutionResult => ({ ok: false, reason });

/**
 * Resolve one mapped field into a concrete value.
 *
 * Pure: profile + descriptor in, value or refusal out. No DOM, no storage.
 */
export function resolveValue(
  profile: ApplicantProfile,
  path: string,
  descriptor: FieldDescriptor,
): ResolutionResult {
  const lookup = getValueAtPath(profile, path);
  if (lookup.status === 'unknown_path') return fail('unknown_path');
  if (lookup.status === 'out_of_range') return fail('no_value');

  const stored = lookup.value;
  if (stored.value === null) return fail('no_value');

  const confidence = bestConfidence(stored);
  const verifiedByUser = isVerified(stored);

  /** Wrap a rendered representation with its provenance. */
  const success = (
    value: string | boolean,
    formatting: string,
    option?: FieldOption,
  ): ResolutionResult => ({
    ok: true,
    resolved: {
      value,
      confidence,
      verifiedByUser,
      formatting,
      ...(option !== undefined ? { option } : {}),
    },
  });

  // --- option-based controls come first ------------------------------------
  // A select/radio/combobox constrains the answer space, and that constraint is
  // more informative than the value's own type. "United States" as free text is
  // trivial; as one of 250 dropdown entries that might say "United States of
  // America" or "US", it is a matching problem, and matching must happen before
  // any type-specific formatting.
  const hasOptions = descriptor.options !== undefined && descriptor.options.length > 0;
  if (hasOptions) {
    return resolveAgainstOptions(stored.value, descriptor, success);
  }

  // --- typed scalar rendering ----------------------------------------------
  if (isNormalizedPhone(stored.value)) {
    const format = phoneFormatFor(descriptor);
    const rendered = formatPhone(stored.value, format);
    return rendered === null ? fail('no_representation') : success(rendered, `phone:${format}`);
  }

  if (isNormalizedDate(stored.value)) {
    const format = dateFormatFor(descriptor);
    const rendered = formatDate(stored.value, format);
    return rendered === null ? fail('no_representation') : success(rendered, `date:${format}`);
  }

  if (typeof stored.value === 'boolean') {
    // A checkbox takes the boolean directly. Anything else needs a rendering
    // decision we do not have enough information to make safely - writing
    // "true" into a text field is nearly always wrong.
    if (descriptor.kind === 'checkbox') return success(stored.value, 'boolean:checkbox');
    return fail('no_representation');
  }

  if (typeof stored.value === 'number') {
    return success(String(stored.value), 'number:plain');
  }

  if (Array.isArray(stored.value)) {
    // Skills, preferred locations. Comma-separated is the near-universal
    // convention for a free-text list field.
    const items = stored.value.filter((item): item is string => typeof item === 'string');
    if (items.length === 0) return fail('no_value');
    const joined = items.join(', ');
    // Respect a declared length limit rather than submitting truncated-looking
    // content. A half-list is worse than an empty field the user completes.
    if (descriptor.maxLength !== undefined && joined.length > descriptor.maxLength) {
      return fail('no_representation');
    }
    return success(joined, 'array:comma');
  }

  if (typeof stored.value === 'string') {
    if (descriptor.maxLength !== undefined && stored.value.length > descriptor.maxLength) {
      return fail('no_representation');
    }
    return success(stored.value, 'string:raw');
  }

  return fail('no_representation');
}

// ---------------------------------------------------------------------------
// Control-shape inference
// ---------------------------------------------------------------------------

/**
 * Pick a phone rendering from what the control tells us about itself.
 *
 * Ordered from strongest to weakest evidence, ending in the format that is
 * accepted most widely when we have no evidence at all.
 */
function phoneFormatFor(descriptor: FieldDescriptor): PhoneFormat {
  const hint = normalizeLabel(
    [descriptor.label, descriptor.placeholder, descriptor.name].filter(Boolean).join(' '),
  );

  // An explicit country-code field is a common Workday/Greenhouse split.
  if (/country code/.test(hint)) return 'COUNTRY_CODE';
  if (/area code/.test(hint)) return 'AREA_CODE';

  // A placeholder is a worked example of the expected format - the single most
  // reliable hint a form gives us about phone formatting.
  if (descriptor.placeholder !== undefined) {
    if (/\+\d/.test(descriptor.placeholder)) return 'E164';
    if (/\(\d{3}\)/.test(descriptor.placeholder)) return 'NATIONAL';
    if (/\d{3}-\d{3}-\d{4}/.test(descriptor.placeholder)) return 'DASHED';
  }

  // A numeric input cannot hold punctuation; digits are the only valid answer.
  if (descriptor.kind === 'number') return 'DIGITS';

  // A tight maxLength is the form telling us it wants bare digits.
  if (descriptor.maxLength !== undefined && descriptor.maxLength <= 10) return 'DIGITS';

  return 'NATIONAL';
}

/**
 * Pick a date rendering from the control.
 *
 * The month/year split is the case that matters: a great many application forms
 * ask for a graduation date as two separate dropdowns, and sending "May 2027"
 * to a month dropdown fills nothing while looking like it worked.
 */
function dateFormatFor(descriptor: FieldDescriptor): DateFormat {
  const hint = normalizeLabel(
    [descriptor.label, descriptor.name, descriptor.placeholder].filter(Boolean).join(' '),
  );

  // Explicitly one component or the other.
  const mentionsMonth = /\bmonth\b/.test(hint);
  const mentionsYear = /\byear\b/.test(hint);
  if (mentionsMonth && !mentionsYear) return 'MONTH_NAME';
  if (mentionsYear && !mentionsMonth) return 'YEAR';

  // A native date input requires ISO; anything else is silently rejected.
  if (descriptor.kind === 'date') return 'YYYY_MM_DD';

  // Placeholders spell the expected shape out.
  if (descriptor.placeholder !== undefined) {
    const placeholder = descriptor.placeholder.toUpperCase();
    if (placeholder.includes('MM/DD/YYYY')) return 'MM_DD_YYYY';
    if (placeholder.includes('YYYY-MM-DD')) return 'YYYY_MM_DD';
    if (placeholder.includes('MM/YYYY')) return 'MM_YYYY';
    if (placeholder.includes('YYYY-MM')) return 'YYYY_MM';
  }

  // Default to month-and-year. Most application date questions (graduation,
  // employment start/end) are month-precision, and it is the format we can most
  // often actually produce - a resume rarely states the day.
  return 'MONTH_NAME_YEAR';
}

// ---------------------------------------------------------------------------
// Option matching
// ---------------------------------------------------------------------------

/**
 * Yes/no vocabularies, for mapping a stored boolean onto a form's own wording.
 *
 * Note what is NOT here: "I decline to answer", "Prefer not to say". Those are
 * legitimate answers a user may choose, but they are not the same as `false`,
 * and quietly treating a stored `false` as a decline (or the reverse) would
 * misstate the applicant's position on a form. If the user wants to decline,
 * they store that as an explicit demographic answer.
 */
const AFFIRMATIVE = new Set(['yes', 'y', 'true', 'authorized', 'i am', 'yes i am', 'agree']);
const NEGATIVE = new Set(['no', 'n', 'false', 'not authorized', 'i am not', 'no i am not', 'disagree']);

/**
 * Match a stored value against a control's available options.
 *
 * Tries progressively looser comparisons and STOPS at the first that produces
 * exactly one match. Stopping at a unique match is the safety property: if a
 * looser comparison would match two options, we do not know which the form
 * means, so we refuse rather than take the first.
 */
function resolveAgainstOptions(
  storedValue: unknown,
  descriptor: FieldDescriptor,
  success: (value: string | boolean, formatting: string, option?: FieldOption) => ResolutionResult,
): ResolutionResult {
  const options = descriptor.options ?? [];

  // --- booleans against a yes/no control -----------------------------------
  if (typeof storedValue === 'boolean') {
    const wanted = storedValue ? AFFIRMATIVE : NEGATIVE;
    const matches = options.filter((option) => wanted.has(normalizeLabel(option.label)));
    const match = matches[0];
    if (matches.length === 1 && match !== undefined) {
      return success(match.value, 'boolean:option', match);
    }
    // Either nothing matched, or several did (a form offering both "Yes" and
    // "Yes, with conditions"). Both cases are for the user to settle.
    return fail('no_matching_option');
  }

  // Everything else is compared as text. Dates and phones are rendered first so
  // "May 2027" can be matched against a dropdown of month-year strings.
  const candidateTexts = renderTextCandidates(storedValue, descriptor);
  if (candidateTexts.length === 0) return fail('no_representation');

  // Comparison strategies, strongest first. Each returns matching options.
  const strategies: Array<{
    name: string;
    match: (candidate: string, option: FieldOption) => boolean;
  }> = [
    {
      name: 'exact',
      match: (candidate, option) => normalizeLabel(option.label) === normalizeLabel(candidate),
    },
    {
      name: 'exact_value',
      // Some selects carry the meaning in `value` and a code in the label.
      match: (candidate, option) => normalizeLabel(option.value) === normalizeLabel(candidate),
    },
    {
      name: 'compact',
      match: (candidate, option) => normalizeCompact(option.label) === normalizeCompact(candidate),
    },
    {
      name: 'prefix',
      // "United States" against "United States of America". Requires the option
      // to START with our value: a mid-string match ("Virginia" inside "West
      // Virginia") is exactly the kind of near-miss that produces a wrong answer.
      match: (candidate, option) => {
        const optionText = normalizeLabel(option.label);
        const candidateText = normalizeLabel(candidate);
        return candidateText.length >= 3 && optionText.startsWith(candidateText);
      },
    },
  ];

  for (const strategy of strategies) {
    for (const candidate of candidateTexts) {
      const matches = options.filter((option) => strategy.match(candidate, option));
      const match = matches[0];
      // EXACTLY one match, or we move on. Ambiguity is never resolved by
      // position - "the first one that matched" is not a reason.
      if (matches.length === 1 && match !== undefined) {
        return success(match.value, `option:${strategy.name}`, match);
      }
    }
  }

  return fail('no_matching_option');
}

/**
 * Every text form of a stored value that is worth comparing against options.
 *
 * A date produces several because we cannot tell from the control alone whether
 * a dropdown lists "May", "05", or "May 2027" - so we offer all of them and let
 * the unique-match rule decide.
 */
function renderTextCandidates(storedValue: unknown, descriptor: FieldDescriptor): string[] {
  if (isNormalizedDate(storedValue)) {
    const formats: DateFormat[] = [
      dateFormatFor(descriptor),
      'MONTH_NAME',
      'MONTH_NAME_YEAR',
      'MONTH_NUMBER',
      'MONTH_NUMBER_PADDED',
      'YEAR',
      'MM_YYYY',
    ];
    const rendered = formats
      .map((format) => formatDate(storedValue, format))
      .filter((text): text is string => text !== null);
    return [...new Set(rendered)];
  }

  if (isNormalizedPhone(storedValue)) {
    const rendered = (['NATIONAL', 'E164', 'DIGITS', 'COUNTRY_CODE'] as PhoneFormat[])
      .map((format) => formatPhone(storedValue, format))
      .filter((text): text is string => text !== null);
    return [...new Set(rendered)];
  }

  if (typeof storedValue === 'string') return [storedValue];
  if (typeof storedValue === 'number') return [String(storedValue)];

  if (Array.isArray(storedValue)) {
    // A multi-select over a list value: offer each item so the adapter can pick
    // the ones present. Joining them would match nothing.
    return storedValue.filter((item): item is string => typeof item === 'string');
  }

  return [];
}

// ---------------------------------------------------------------------------
// Structural type guards
// ---------------------------------------------------------------------------
//
// The profile stores these as plain objects (they cross the storage boundary as
// JSON), so `instanceof` is unavailable and a structural check is the only
// option. Each guard tests for a field unique to that shape.

function isNormalizedPhone(value: unknown): value is NormalizedPhone {
  return typeof value === 'object' && value !== null && 'raw' in value && !('year' in value);
}

function isNormalizedDate(value: unknown): value is NormalizedDate {
  if (typeof value !== 'object' || value === null) return false;
  return 'year' in value || 'month' in value || 'isPresent' in value || 'iso' in value;
}

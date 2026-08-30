/**
 * Phone normalization.
 * ---------------------------------------------------------------------------
 * One phone number, many required renderings:
 *
 *     +16095551234 | (609) 555-1234 | 609-555-1234 | 6095551234 | 609 | 5551234
 *
 * Some forms validate strictly ("must be 10 digits, no punctuation"), others
 * split the number across three inputs. Storing the raw string the user typed
 * and reformatting it on demand is the only way to satisfy all of them without
 * asking the user the same question repeatedly.
 *
 * WHY NOT libphonenumber-js
 * It is the correct answer for a server. For a browser extension it costs
 * ~145 KB of parsed JavaScript that must be loaded into the service worker on
 * every wake-up, on machines we explicitly want to support at 2-4 GB of RAM.
 * We instead implement full formatting for NANP (the +1 North American
 * Numbering Plan, which covers the overwhelming majority of US/Canada job
 * applications) and E.164 passthrough for everything else.
 *
 * The tradeoff is stated honestly rather than hidden: for a non-NANP number we
 * produce a correct international form and a correct digit string, but we do
 * NOT produce a locale-idiomatic national format. The resolver treats a missing
 * format as "cannot render" and leaves the field for the user - consistent with
 * the project's primary rule that a blank field beats a wrong one.
 *
 * Introducing libphonenumber later is a drop-in replacement for the two
 * `format*` helpers, because callers depend on NormalizedPhone, not on this
 * implementation.
 */

export interface NormalizedPhone {
  /** Exactly what the user or resume provided. Never rewritten. */
  raw: string;
  /** E.164, e.g. "+16095551234". Present only when the country code is known. */
  international?: string;
  /** Locale-idiomatic national form, e.g. "(609) 555-1234". NANP only today. */
  national?: string;
  /** Significant digits with no country code and no punctuation. */
  digits?: string;
  /** Digits of the country calling code, without the "+", e.g. "1", "44". */
  countryCode?: string;
}

/** North American Numbering Plan: 3-digit area code + 7-digit subscriber. */
const NANP_SIGNIFICANT_DIGITS = 10;

/**
 * E.164 caps the whole number, country code included, at 15 digits. Anything
 * longer is not a phone number - most likely we captured an ID or a fax label.
 */
const E164_MAX_DIGITS = 15;

/**
 * Shortest plausible international number. Below this we are almost certainly
 * looking at an extension, a partial capture, or a street number.
 */
const MIN_PLAUSIBLE_DIGITS = 7;

/** Strip every character that is not a digit. */
const digitsOnly = (s: string): string => s.replace(/\D/g, '');

/**
 * Parse a phone number written in any of the ways humans write them.
 *
 * Returns `null` when the input cannot be a phone number. As everywhere in this
 * codebase, null means "we do not know" and results in an untouched form field.
 *
 * @param input          the raw string from a resume or the profile editor
 * @param defaultCountryCode  applied only to a bare NANP-length number with no
 *                            "+" prefix. Defaults to "1" because the product's
 *                            first target is US applications; it is a parameter
 *                            rather than a constant so this is a configuration
 *                            decision, not a hard-coded assumption about who
 *                            the user is.
 */
export function parsePhone(
  input: string | null | undefined,
  defaultCountryCode = '1',
): NormalizedPhone | null {
  if (input === null || input === undefined) return null;

  const raw = input.trim();
  if (raw.length === 0) return null;

  // A leading "+" is the one piece of structure we can trust: it explicitly
  // marks an international number. Detect it before stripping punctuation.
  const hasPlusPrefix = raw.startsWith('+');

  // Applications frequently include an extension ("555-1234 ext 203",
  // "555-1234 x203"). The extension is not part of the number and must not be
  // concatenated into it, which would produce a silently invalid 13-digit
  // "phone number" that then fails every form's validation.
  //
  // The pattern anchors to the end of the string and requires the marker to be
  // preceded by whitespace or punctuation, so a bare "x" inside the number is
  // not mistaken for a marker. Note there is deliberately no \b after the
  // marker: "x203" has no word boundary between "x" and "2".
  const withoutExtension = raw.replace(/[\s,;(-]*(?:ext|extension|x)\.?\s*\d+\s*\)?\s*$/i, '');

  const allDigits = digitsOnly(withoutExtension);

  if (allDigits.length < MIN_PLAUSIBLE_DIGITS || allDigits.length > E164_MAX_DIGITS) {
    return null;
  }

  // --- Case 1: explicit international, e.g. "+44 20 7946 0958" -------------
  if (hasPlusPrefix) {
    // NANP is the only plan whose country code we can split off reliably
    // without a country-code prefix table. For every other country we keep the
    // full digit string and leave `countryCode` unset rather than guessing
    // where the code ends - a wrong split would corrupt the number.
    if (allDigits.startsWith('1') && allDigits.length === NANP_SIGNIFICANT_DIGITS + 1) {
      return buildNanp(raw, allDigits.slice(1), '1');
    }
    return {
      raw,
      international: `+${allDigits}`,
      digits: allDigits,
    };
  }

  // --- Case 2: bare NANP, e.g. "(609) 555-1234" or "6095551234" -----------
  if (allDigits.length === NANP_SIGNIFICANT_DIGITS && defaultCountryCode === '1') {
    return buildNanp(raw, allDigits, '1');
  }

  // --- Case 3: NANP with a leading long-distance 1, e.g. "1-609-555-1234" --
  if (
    allDigits.length === NANP_SIGNIFICANT_DIGITS + 1 &&
    allDigits.startsWith('1') &&
    defaultCountryCode === '1'
  ) {
    return buildNanp(raw, allDigits.slice(1), '1');
  }

  // --- Case 4: plausible number, unknown plan ------------------------------
  // We know the digits are in a sane range but we cannot claim a country code
  // or a national format. Store what is true and nothing more.
  return { raw, digits: allDigits };
}

/** Assemble every representation of a known-good NANP number. */
function buildNanp(raw: string, significant: string, countryCode: string): NormalizedPhone {
  const area = significant.slice(0, 3);
  const exchange = significant.slice(3, 6);
  const line = significant.slice(6, 10);
  return {
    raw,
    countryCode,
    digits: significant,
    international: `+${countryCode}${significant}`,
    national: `(${area}) ${exchange}-${line}`,
  };
}

/** Renderings that job application forms ask for. */
export type PhoneFormat =
  | 'E164' // +16095551234
  | 'NATIONAL' // (609) 555-1234
  | 'DIGITS' // 6095551234
  | 'DASHED' // 609-555-1234
  | 'COUNTRY_CODE' // 1
  | 'AREA_CODE' // 609
  | 'RAW'; // whatever the user originally typed

/**
 * Render a phone number in a requested format.
 * Returns `null` when the requested representation cannot be produced from what
 * we actually know - never a partial or padded approximation.
 */
export function formatPhone(
  phone: NormalizedPhone | null | undefined,
  format: PhoneFormat,
): string | null {
  if (phone === null || phone === undefined) return null;

  switch (format) {
    case 'RAW':
      return phone.raw;

    case 'E164':
      return phone.international ?? null;

    case 'NATIONAL':
      return phone.national ?? null;

    case 'DIGITS':
      return phone.digits ?? null;

    case 'COUNTRY_CODE':
      return phone.countryCode ?? null;

    case 'AREA_CODE':
      // Only meaningful for NANP; for any other plan the first three digits are
      // not an area code, so refuse rather than return a misleading fragment.
      return phone.countryCode === '1' && phone.digits?.length === NANP_SIGNIFICANT_DIGITS
        ? phone.digits.slice(0, 3)
        : null;

    case 'DASHED':
      return phone.countryCode === '1' && phone.digits?.length === NANP_SIGNIFICANT_DIGITS
        ? `${phone.digits.slice(0, 3)}-${phone.digits.slice(3, 6)}-${phone.digits.slice(6)}`
        : null;
  }
}

/**
 * Syntactic validation for values the user types.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * `userValue()` stamps `verifiedByUser: true, confidence: 1` on whatever it is
 * handed. The profile editor called it on every keystroke, so an empty string
 * and "nitu@@example" were both stored as values the applicant had personally
 * vouched for - and `verifiedByUser` is the flag that unlocks autofilling a
 * legal question. A blank "verified" value is worse than a missing one: the
 * missing one is reported as missing, while the blank one is offered to the
 * resolver, refused for having no content, and shows in the audit list as a
 * field we were certain about and did nothing with.
 *
 * So: a value is verified only if it is actually a value, and only if it is
 * the SHAPE it claims to be.
 *
 * WHAT THIS IS NOT
 * It is not a judgement about whether an address exists, whether a domain
 * resolves, or whether a person's email is "sensible". Every function here
 * answers one narrow question - "could this string possibly be one of these?"
 * - and errs toward accepting. Refusing a real, unusual email would be a worse
 * failure than accepting a typo, because the user cannot argue with us.
 *
 * SPACE
 * Everything here scans by INDEX. No `split`, no `trim`, no regex, no
 * intermediate arrays or substrings - so validating a field costs O(1) memory
 * beyond the string the caller already had, and the editor can call it on
 * every keystroke of every field without allocating anything at all. The one
 * allocation in this module is the trimmed string a caller actually stores,
 * and `trimValue` skips even that when there is nothing to trim.
 */

/** Space, tab, newline, carriage return, and the non-breaking spaces ATS markup is full of. */
function isSpace(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // line feed
    code === 0x0d || // carriage return
    code === 0x0c || // form feed
    code === 0x0b || // vertical tab
    code === 0x00a0 || // no-break space
    code === 0x2007 || // figure space
    code === 0x202f || // narrow no-break space
    code === 0xfeff // zero-width no-break space
  );
}

/** First index that is not whitespace, or `value.length` when all of it is. */
function firstNonSpace(value: string): number {
  let index = 0;
  while (index < value.length && isSpace(value.charCodeAt(index))) index++;
  return index;
}

/** Index one past the last non-whitespace character. */
function lastNonSpace(value: string, from: number): number {
  let index = value.length;
  while (index > from && isSpace(value.charCodeAt(index - 1))) index--;
  return index;
}

/**
 * Is this string empty once whitespace is discounted?
 *
 * Deliberately not `value.trim().length === 0`: `trim` allocates a whole new
 * string to answer a question about one character. On a per-keystroke path
 * across a form's worth of fields that is pure garbage-collector pressure.
 */
export function isBlank(value: string): boolean {
  return firstNonSpace(value) === value.length;
}

/**
 * The trimmed form of a string, without allocating when nothing was trimmed.
 *
 * The common case - a value the user typed with no stray whitespace - returns
 * the original reference.
 */
export function trimValue(value: string): string {
  const start = firstNonSpace(value);
  const end = lastNonSpace(value, start);
  if (start === 0 && end === value.length) return value;
  return value.slice(start, end);
}

/**
 * Could this be an email address?
 *
 * The rules checked are the ones that catch real typing mistakes:
 * exactly one `@`, something either side of it, a dot in the domain with
 * labels around it, and no whitespace anywhere. Everything else - quoted local
 * parts, unicode domains, plus-addressing, a domain that does not exist - is
 * accepted, because a validator that rejects a real address is a validator the
 * user cannot get past.
 *
 * Index-scanned rather than regex-matched. The classic email regex is both
 * enormous and a backtracking hazard on a long paste; this is one pass and no
 * allocation.
 */
export function isEmailShaped(value: string): boolean {
  const start = firstNonSpace(value);
  const end = lastNonSpace(value, start);
  if (end - start < 5) return false; // a@b.c is the shortest possible

  let at = -1;
  for (let index = start; index < end; index++) {
    const code = value.charCodeAt(index);
    if (isSpace(code)) return false;
    if (code === 0x40) {
      // A second '@' means this is not an address we understand.
      if (at !== -1) return false;
      at = index;
    }
  }

  if (at === -1) return false;
  if (at === start) return false; // nothing before the @
  if (at === end - 1) return false; // nothing after it

  // The domain needs a dot with at least one character before it and a
  // top-level label of two or more after the LAST dot.
  let lastDot = -1;
  for (let index = at + 1; index < end; index++) {
    if (value.charCodeAt(index) === 0x2e) {
      // A dot immediately after the @ or immediately after another dot is a
      // malformed domain, not an unusual one.
      if (index === at + 1 || index === lastDot + 1) return false;
      lastDot = index;
    }
  }
  if (lastDot === -1) return false;
  return end - lastDot - 1 >= 2;
}

/**
 * Could this be a web address?
 *
 * Accepts what people actually type into a "LinkedIn" box:
 *
 *     https://www.linkedin.com/in/someone
 *     linkedin.com/in/someone
 *     www.example.co.uk
 *
 * Rejects whitespace, a scheme that is not http(s), and anything with no dot
 * in its host - which is what a half-typed address looks like.
 *
 * `new URL()` is not used: it allocates a parsed object per keystroke, and it
 * REJECTS the bare-domain form that most people type, which would mean marking
 * a perfectly good LinkedIn URL as unreadable.
 */
export function isUrlShaped(value: string): boolean {
  const start = firstNonSpace(value);
  const end = lastNonSpace(value, start);
  if (end - start < 4) return false; // "a.io" is the shortest plausible

  let hostStart = start;

  // Skip a scheme if there is one, and refuse any scheme but http(s): a
  // `javascript:` or `data:` "link" in a profile is never a real answer, and
  // it is the one input here that could become dangerous downstream.
  const schemeEnd = value.indexOf('://', start);
  if (schemeEnd !== -1 && schemeEnd < end) {
    const scheme = value.slice(start, schemeEnd).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return false;
    hostStart = schemeEnd + 3;
  } else {
    // No `://`, but a scheme-like prefix ("mailto:", "javascript:") is still
    // disqualifying. A bare host never contains a colon before its first slash
    // except as a port, which is digits.
    for (let index = start; index < end; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x2f) break; // '/'
      if (code === 0x3a) {
        // A port is digits; anything else here is a scheme we do not accept.
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0x30 && next <= 0x39)) return false;
        break;
      }
    }
  }

  // The host runs to the first '/', '?' or '#'.
  let hostEnd = end;
  for (let index = hostStart; index < end; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x2f || code === 0x3f || code === 0x23) {
      hostEnd = index;
      break;
    }
  }

  if (hostEnd - hostStart < 3) return false; // "a.b" at minimum

  let lastDot = -1;
  for (let index = hostStart; index < hostEnd; index++) {
    const code = value.charCodeAt(index);
    if (isSpace(code)) return false;
    if (code === 0x2e) {
      if (index === hostStart || index === lastDot + 1) return false;
      lastDot = index;
    }
  }
  if (lastDot === -1 || lastDot === hostEnd - 1) return false;

  // Whitespace anywhere in the rest of the address is a pasted sentence, not a
  // link. (A real URL encodes its spaces as %20.)
  for (let index = hostEnd; index < end; index++) {
    if (isSpace(value.charCodeAt(index))) return false;
  }

  return true;
}

/**
 * Could this be a postal code?
 *
 * Deliberately format-agnostic: postal codes are 5 digits in the US, 6 with a
 * space in Canada, up to 8 with a space in the UK, and 4 in much of Europe.
 * Encoding one country's format here would mean silently marking a real
 * address as unreadable for everyone else. What is checked is that it is
 * short, and made of the characters postal codes are made of.
 */
export function isPostalCodeShaped(value: string): boolean {
  const start = firstNonSpace(value);
  const end = lastNonSpace(value, start);

  let significant = 0;
  for (let index = start; index < end; index++) {
    const code = value.charCodeAt(index);
    if (isSpace(code) || code === 0x2d) continue; // interior space or hyphen
    const isDigit = code >= 0x30 && code <= 0x39;
    const isUpper = code >= 0x41 && code <= 0x5a;
    const isLower = code >= 0x61 && code <= 0x7a;
    if (!isDigit && !isUpper && !isLower) return false;
    significant++;
  }

  return significant >= 3 && significant <= 10;
}

/** The formats the profile editor can check. */
export type ValueFormat = 'text' | 'email' | 'url' | 'postal_code';

/**
 * Does this text satisfy the format its field expects?
 *
 * Blank is NOT valid here - callers treat blank as "no value" before they get
 * this far, which keeps "the user cleared the field" and "the user typed
 * something wrong" as two different outcomes with two different displays.
 */
export function matchesFormat(value: string, format: ValueFormat): boolean {
  if (isBlank(value)) return false;
  switch (format) {
    case 'email':
      return isEmailShaped(value);
    case 'url':
      return isUrlShaped(value);
    case 'postal_code':
      return isPostalCodeShaped(value);
    case 'text':
      return true;
  }
}

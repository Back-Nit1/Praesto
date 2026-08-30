/**
 * Text normalization for semantic matching.
 * ---------------------------------------------------------------------------
 * Every label on every job application arrives dirty:
 *
 *     "First Name *"      "  E-Mail Address"     "LinkedIn URL:"
 *     "First Name"   "FIRST NAME (Required)"  "Are you 18 years or older?"
 *
 * All six of those are the same question as far as mapping is concerned. This
 * module is what makes them comparable.
 *
 * THE ONE RULE THAT MATTERS: NEGATION IS SEMANTIC
 * Spec section 12.2 requires that normalization "preserve meaningful negation
 * words". This is not a nicety. Consider:
 *
 *     "Do you require sponsorship?"
 *     "Do you NOT require sponsorship?"
 *
 * A normalizer that strips stop-words to improve fuzzy matching would collapse
 * those into the same string and then answer one of them with the other's
 * answer - producing a confidently inverted answer to a legal question on a job
 * application. So this module strips punctuation and casing, and nothing else.
 * We never drop a word that could flip a meaning.
 */

/**
 * Normalize a label, placeholder, or option text for comparison.
 *
 * Deliberately conservative. Everything removed here is provably meaningless
 * (casing, decoration, whitespace); everything with any semantic content
 * survives.
 */
export function normalizeLabel(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';

  return (
    input
      // Unicode normalization first, so "e" + combining accent and the
      // precomposed "é" compare equal.
      .normalize('NFKD')
      // Strip combining marks left behind by NFKD. Résumé -> resume, which is
      // what a section-heading comparison needs.
      .replace(/[\u0300-\u036F]/g, '')
      .toLowerCase()
      // Non-breaking spaces are pervasive in ATS markup and are invisible in a
      // diff, making them a classic source of "why doesn't this match" bugs.
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      // The required-field asterisk, and its common typographic variants.
      .replace(/[*\u2217\u066D]/g, ' ')
      // Parenthetical decoration that never carries the question's meaning.
      .replace(/\((?:required|optional|opcional)\)/gi, ' ')
      // Typographic quotes and dashes to their ASCII equivalents, so
      // "Bachelor's" and "Bachelor's" are one string.
      .replace(/[\u2018\u2019\u201B]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2010-\u2015]/g, '-')
      // Remaining punctuation becomes a space rather than being deleted, so
      // "e-mail" -> "e mail" rather than "email". Which of those is right is
      // handled explicitly below, where we can be deliberate about it.
      .replace(/[:;,.?!"'`|\\/_\[\]{}()<>+#@]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Aggressive form used ONLY as a secondary matching key.
 *
 * Removes every non-alphanumeric character, so "e mail" and "email" and
 * "E-Mail" all become "email". This is what lets us match an ATS that writes
 * `name="e_mail_address"` against the alias "email address".
 *
 * Used as a FALLBACK with a lower confidence score than an exact normalized
 * match, never as the primary key - collapsing separators loses real
 * distinctions ("no. of years" vs "noofyears" is fine, but the general
 * transformation is lossy and we price it accordingly.)
 */
export function normalizeCompact(input: string | null | undefined): string {
  return normalizeLabel(input).replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize an HTML `name` or `id` attribute.
 *
 * These use programmer conventions rather than prose: `legal_first_name`,
 * `firstName`, `job_application[first_name]`, `cand-fname`. Splitting on case
 * boundaries and separators turns them into word sequences that can be compared
 * against the same alias registry the human-readable labels use, instead of
 * needing a parallel registry of attribute spellings.
 */
export function normalizeAttributeName(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';

  return (
    input
      // camelCase / PascalCase -> space separated. Handles "firstName" and the
      // acronym-adjacent "URLField" via the second pattern.
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      // Rails/PHP style array brackets: "job_application[first_name]".
      .replace(/[[\]]/g, ' ')
      .replace(/[-_.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Words that carry no meaning in a form label and are safe to drop when
 * comparing.
 *
 * NOTE what is absent: no "not", no "no", no "any", no "other", no "current",
 * no "previous", no "former". Every one of those can flip or retarget a
 * question. This list contains only words that are pure boilerplate in the
 * context of an application form.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'please',
  'kindly',
  'field',
  'the',
  'a',
  'an',
  'your',
  'my',
  'this',
]);

/**
 * Drop pure boilerplate. Used only for fuzzy comparison, and only as a lower-
 * confidence signal than exact matching.
 */
export function stripFiller(normalized: string): string {
  return normalized
    .split(' ')
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word))
    .join(' ');
}

/**
 * Token set for overlap scoring.
 * Returns a Set so callers can compute intersections without O(n*m) scans.
 */
export function tokenize(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter((t) => t.length > 0));
}

/**
 * Jaccard similarity over token sets: |intersection| / |union|, in 0..1.
 *
 * Chosen over edit distance because form labels differ by whole words
 * ("LinkedIn" vs "LinkedIn profile URL"), not by characters. Edit distance on
 * those two strings reports them as very different; token overlap reports 0.33,
 * which is a far more honest description of the relationship.
 *
 * Symmetric and order-independent, so "profile linkedin" scores the same as
 * "linkedin profile" - which is correct, because form authors are not
 * consistent about word order.
 */
export function tokenSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Fraction of the SHORTER string's tokens that appear in the longer one.
 *
 * Complements Jaccard for the containment case: "linkedin" inside
 * "linkedin profile url" scores 1.0 here but only 0.33 by Jaccard. Both numbers
 * are true and describe different things, so the mapper is given both and the
 * confidence policy decides what each is worth.
 */
export function containmentScore(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let contained = 0;
  for (const token of smaller) {
    if (larger.has(token)) contained++;
  }
  return contained / smaller.size;
}

/**
 * Detect a negation that inverts a yes/no question.
 *
 * Consulted by the mapper before it maps a boolean question to a boolean
 * profile value. When a negation is present the mapper must either invert the
 * answer deliberately or - the current, safer behaviour - decline to answer and
 * hand the question to the user.
 *
 * "Will you NOW or in the FUTURE require sponsorship" is a real Greenhouse
 * question where getting the polarity wrong is a materially false statement to
 * an employer.
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  'not',
  'no',
  'never',
  'without',
  'unable',
  'cannot',
  'decline',
  'neither',
  'nor',
]);

export function containsNegation(normalized: string): boolean {
  for (const token of tokenize(normalized)) {
    if (NEGATION_TOKENS.has(token)) return true;
  }
  // "don't" / "won't" survive normalization as "don t" / "won t"; catch the
  // contracted forms explicitly rather than relying on the token list.
  return /\b(?:do|does|did|will|would|can|could|should|is|are|was|were|has|have)n?\s?t\b/.test(
    normalized,
  );
}

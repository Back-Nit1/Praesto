/**
 * Recognising the resume upload field.
 * ---------------------------------------------------------------------------
 * A file input is not a profile value, so it does not belong in the canonical
 * path vocabulary - there is no `profile.resume`, and inventing one would put a
 * document into a schema that models facts about a person.
 *
 * But it is still a semantic question the engine has to answer, and it answers
 * it the same way it answers every other one: from the field's own words, with
 * an explicit refusal when it does not know.
 *
 * WHY THIS IS NARROW ON PURPOSE
 * An application form frequently has SEVERAL file inputs - resume, cover
 * letter, transcript, portfolio, writing sample. Attaching a resume to the
 * cover-letter field is not a small mistake: the employer receives an
 * application whose cover letter is a resume, and the applicant has no way to
 * know it happened. So this matcher requires positive evidence that a field is
 * the resume field, and treats every other file input as unknown.
 */
import { normalizeLabel, normalizeAttributeName } from '../descriptor/normalize';
import type { FieldDescriptor } from '../descriptor/types';

/** Words that identify a resume upload. */
const RESUME_TERMS = ['resume', 'resumé', 'cv', 'curriculum vitae', 'curriculum'];

/**
 * Words that identify a DIFFERENT document, and therefore disqualify the field
 * even if it also mentions "resume".
 *
 * The disqualifiers win, and the ordering is deliberate: a label reading
 * "Cover letter (or resume)" is a cover-letter field. When both signals are
 * present we have positive evidence of ambiguity, and the safe reading of an
 * ambiguous document field is "not the resume".
 */
const OTHER_DOCUMENT_TERMS = [
  'cover letter',
  'coverletter',
  'transcript',
  'portfolio',
  'writing sample',
  'certificate',
  'certification',
  'photo',
  'headshot',
  'passport',
  'visa',
  'reference letter',
  'recommendation',
  'w9',
  'id',
];

/**
 * Is this file input the resume field?
 *
 * Returns false for anything it cannot positively identify. That default costs
 * the user one manual upload; the opposite default costs them a misfiled
 * application they never learn about.
 */
export function isResumeField(descriptor: FieldDescriptor): boolean {
  if (descriptor.kind !== 'file') return false;

  // Every signal the field offers about itself, in one string. A file input
  // often has no `<label>`, so the name attribute and surrounding text carry
  // the meaning more often here than for a text field.
  const haystack = [
    normalizeLabel(descriptor.label),
    normalizeLabel(descriptor.accessibleName),
    normalizeAttributeName(descriptor.name),
    normalizeAttributeName(descriptor.id),
    normalizeLabel(descriptor.placeholder),
    normalizeLabel(descriptor.nearbyText),
    normalizeLabel(descriptor.sectionHeading),
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  if (haystack.length === 0) return false;

  // Disqualifiers first - see the comment on OTHER_DOCUMENT_TERMS.
  if (OTHER_DOCUMENT_TERMS.some((term) => containsPhrase(haystack, term))) return false;

  return RESUME_TERMS.some((term) => containsPhrase(haystack, term));
}

/**
 * Whole-word phrase match.
 *
 * A plain `includes` is wrong here, and wrong in a way that is easy to miss:
 * the two-letter terms match inside ordinary words. "id" appears inside
 * "candidate", so `candidate[cv]` - an obvious resume field - was disqualified
 * as an ID upload. "cv" would likewise match inside "cvs".
 *
 * The haystack is already normalized to lowercase words separated by single
 * spaces, so padding both sides and searching for a space-delimited phrase is
 * sufficient and needs no regex escaping.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

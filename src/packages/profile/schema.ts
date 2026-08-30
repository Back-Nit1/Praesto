/**
 * The Canonical Applicant Profile.
 * ---------------------------------------------------------------------------
 * This is the single source of truth about the applicant, and the most
 * important data model in the product (spec section 6).
 *
 * THE RESUME IS NOT THE SOURCE OF TRUTH.
 * A resume is an onboarding input used to *bootstrap* this structure. Once the
 * user verifies a value here, this structure wins - permanently. Nothing
 * re-parses a resume to answer "what is your phone number?" (spec section 2).
 *
 * WHY EVERY VALUE IS WRAPPED IN ProfileValue<T> RATHER THAN BEING A PRIMITIVE
 * The product's entire promise is that it knows the difference between:
 *
 *     "I KNOW this."         (the user typed it and confirmed it)
 *     "I READ this."         (extracted from a resume, unconfirmed)
 *     "I GUESSED this."      (derived from something else)
 *     "I DON'T KNOW this."   (absent)
 *
 * A bare `string` cannot express that difference, so a codebase built on bare
 * strings *cannot* implement the promise, no matter how careful the surrounding
 * logic is. Wrapping every value in its provenance makes the distinction
 * structural: it is impossible to read a value without being handed the
 * question of how much to trust it.
 *
 * VALIDATION AT TRUST BOUNDARIES
 * These Zod schemas are not decoration. Data enters this shape from three
 * untrusted directions - `chrome.storage` (which a previous, buggy version of
 * this extension may have written), an imported JSON file, and a resume parser.
 * Each is validated on the way in. See `repository.ts`.
 */
import { z } from 'zod';

/**
 * Schema version for the persisted profile.
 *
 * Bump this whenever the stored shape changes in a way that old data does not
 * satisfy, and add a matching step in `storage/migrations.ts`. Never reuse a
 * version number: a user's browser may hold data written by any past release.
 */
export const PROFILE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a value came from.
 *
 * `derived` deserves special note: it marks a value we computed from other
 * values (a full name assembled from first + last). Derived values are safe for
 * factual composition but must NEVER be used for legal or demographic answers -
 * see `SENSITIVE_PATHS` in `paths.ts`, which enforces that structurally.
 */
export const sourceTypeSchema = z.enum(['resume', 'user', 'previous_application', 'derived']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

/**
 * One reason to believe a value.
 *
 * A value can carry several: "the resume said this on page 1" AND "the user
 * confirmed it". Keeping them as a list rather than collapsing to a single
 * source preserves the audit trail the review UI needs to explain itself.
 */
export const evidenceSchema = z.object({
  source: sourceTypeSchema,

  /** IndexedDB id of the resume document this came from, when applicable. */
  documentId: z.string().optional(),
  /** 1-based page number within that document. */
  page: z.number().int().positive().optional(),
  /** Resume section the value was found in ("education", "header", ...). */
  section: z.string().optional(),
  /**
   * The exact source text this value was extracted from.
   *
   * This is what makes evidence *checkable* rather than merely asserted: spec
   * section 8.5 requires that a semantic parser's claimed evidence actually
   * appear in the source document, and a value whose evidence cannot be found
   * loses confidence or is rejected outright.
   */
  originalText: z.string().optional(),

  /** 0..1. How much this piece of evidence supports the value. */
  confidence: z.number().min(0).max(1),

  /**
   * Set only by an explicit user action in the profile editor. Never set by a
   * parser, a heuristic, or a migration. This flag is the difference between
   * "probably right" and "the applicant has personally vouched for this", and
   * it gates autofill of anything legally consequential.
   */
  verifiedByUser: z.boolean(),

  /** ISO timestamp, for ordering and for expiring stale extractions. */
  recordedAt: z.string().datetime().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * A value plus everything we know about how much to trust it.
 *
 * Generic over the Zod schema of the underlying value so that
 * `profileValue(z.string())` yields a fully-typed `ProfileValue<string>` with
 * no casts. `null` is always permitted: "we do not have this" is a first-class,
 * expected state, not an error condition.
 */
export function profileValue<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    value: inner.nullable(),
    /**
     * The unnormalized source text, kept alongside the parsed value.
     * Lets the profile editor show "we read 'May 2025' and stored 2025-05" so
     * the user can spot a misparse without opening a debugger.
     */
    raw: z.string().optional(),
    evidence: z.array(evidenceSchema),
  });
}

/**
 * Runtime-agnostic TypeScript shape of a wrapped value.
 *
 * `raw?: string | undefined` rather than `raw?: string` is deliberate. Under
 * `exactOptionalPropertyTypes` those are DIFFERENT types: the first allows the
 * property to be present and explicitly undefined, the second does not. Zod's
 * `.optional()` produces the first, so writing the second here would make this
 * hand-written interface incompatible with the schema it is supposed to mirror,
 * and every value produced by parsing would fail to satisfy it.
 */
export interface ProfileValue<T> {
  value: T | null;
  raw?: string | undefined;
  evidence: Evidence[];
}

// ---------------------------------------------------------------------------
// Normalized scalar shapes (see ./normalizers)
// ---------------------------------------------------------------------------

/** Mirrors `NormalizedDate` in ./normalizers/date.ts. */
export const normalizedDateSchema = z.object({
  raw: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
  day: z.number().int().min(1).max(31).optional(),
  iso: z.string().optional(),
  isPresent: z.boolean().optional(),
  ambiguousDayMonth: z.boolean().optional(),
});

/** Mirrors `NormalizedPhone` in ./normalizers/phone.ts. */
export const normalizedPhoneSchema = z.object({
  raw: z.string(),
  international: z.string().optional(),
  national: z.string().optional(),
  digits: z.string().optional(),
  countryCode: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Repeated entities
// ---------------------------------------------------------------------------

/**
 * Every list entry carries a stable `id`.
 *
 * Array position is NOT identity: the user reorders jobs, the resume parser
 * finds them in a different order on re-import, and React needs a stable key.
 * A learned mapping that pointed at "employment[0]" would silently retarget a
 * different job the moment the list is sorted - so ids exist precisely to make
 * that class of bug impossible.
 */
export const employmentSchema = z.object({
  id: z.string(),
  company: profileValue(z.string()),
  title: profileValue(z.string()),
  location: profileValue(z.string()),
  startDate: profileValue(normalizedDateSchema),
  endDate: profileValue(normalizedDateSchema),
  currentlyEmployed: profileValue(z.boolean()),
  description: profileValue(z.string()),
  bullets: profileValue(z.array(z.string())),
});
export type Employment = z.infer<typeof employmentSchema>;

export const educationSchema = z.object({
  id: z.string(),
  institution: profileValue(z.string()),
  degree: profileValue(z.string()),
  fieldOfStudy: profileValue(z.string()),
  startDate: profileValue(normalizedDateSchema),
  graduationDate: profileValue(normalizedDateSchema),
  /**
   * GPA is a string, not a number, on purpose. Forms ask for "3.8", "3.80",
   * "3.8/4.0" and "First Class Honours". Parsing to a float would destroy the
   * scale and the honours wording, and re-rendering "3.80" from 3.8 is a lossy
   * guess about what the institution actually issued.
   */
  gpa: profileValue(z.string()),
});
export type Education = z.infer<typeof educationSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: profileValue(z.string()),
  description: profileValue(z.string()),
  technologies: profileValue(z.array(z.string())),
  url: profileValue(z.string()),
});
export type Project = z.infer<typeof projectSchema>;

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

export const applicantProfileSchema = z.object({
  schemaVersion: z.number().int().positive(),

  /** Stable id so multiple profiles (or resume variants) can coexist later. */
  id: z.string(),
  /** User-facing label, e.g. "Software engineering". */
  label: z.string().default('Default profile'),

  createdAt: z.string(),
  updatedAt: z.string(),

  identity: z.object({
    /**
     * Legal vs preferred name is not pedantry: background checks and I-9 forms
     * ask for the legal name, while "what should we call you" asks for the
     * preferred one. Filling one into the other is a real, harmful error.
     */
    legalFirstName: profileValue(z.string()),
    preferredFirstName: profileValue(z.string()),
    middleName: profileValue(z.string()),
    lastName: profileValue(z.string()),
    /** Usually derived; kept explicit so the user can override an odd case. */
    fullName: profileValue(z.string()),
  }),

  contact: z.object({
    email: profileValue(z.string().email()),
    phone: profileValue(normalizedPhoneSchema),
    addressLine1: profileValue(z.string()),
    addressLine2: profileValue(z.string()),
    city: profileValue(z.string()),
    state: profileValue(z.string()),
    postalCode: profileValue(z.string()),
    country: profileValue(z.string()),
  }),

  links: z.object({
    linkedin: profileValue(z.string()),
    github: profileValue(z.string()),
    portfolio: profileValue(z.string()),
    /** Anything else the user wants available: Twitter, Scholar, Dribbble. */
    other: z.array(profileValue(z.string())),
  }),

  education: z.array(educationSchema),
  employment: z.array(employmentSchema),
  projects: z.array(projectSchema),
  skills: profileValue(z.array(z.string())),

  /**
   * Answers that are NEVER inferred (spec sections 3.1 and 21.3).
   *
   * Work authorization and sponsorship are legal declarations. Getting one
   * wrong on an application is not a cosmetic error - it can invalidate the
   * application or misrepresent the applicant to an employer. Nothing in this
   * codebase may populate these from a school, a name, a location, a language,
   * or a prior employer. Only an explicit user action writes here.
   */
  applicationPreferences: z.object({
    authorizedToWorkUS: profileValue(z.boolean()),
    requiresSponsorshipNow: profileValue(z.boolean()),
    requiresSponsorshipFuture: profileValue(z.boolean()),
    willingToRelocate: profileValue(z.boolean()),
    desiredSalary: profileValue(z.number()),
    availableStartDate: profileValue(normalizedDateSchema),
    preferredLocations: profileValue(z.array(z.string())),
  }),

  /**
   * Voluntary EEO answers.
   *
   * Stored as free strings rather than enums because every ATS words its
   * options differently and forcing them into our vocabulary would require
   * translating the user's answer - i.e. guessing about protected
   * characteristics. Left empty by default; "Decline to self-identify" is a
   * legitimate stored answer and is treated like any other user-supplied value.
   */
  demographics: z.object({
    gender: profileValue(z.string()),
    raceEthnicity: profileValue(z.array(z.string())),
    veteranStatus: profileValue(z.string()),
    disabilityStatus: profileValue(z.string()),
  }),
});

export type ApplicantProfile = z.infer<typeof applicantProfileSchema>;

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** An unknown value: no data, no evidence. The correct default everywhere. */
export function emptyValue<T>(): ProfileValue<T> {
  return { value: null, evidence: [] };
}

/**
 * A value the user typed and thereby vouched for.
 *
 * confidence 1 + verifiedByUser true is the ONLY combination that unlocks
 * autofill of sensitive/legal fields. It is produced here, and by the profile
 * editor's explicit verify action - never by a parser.
 */
export function userValue<T>(value: T, raw?: string): ProfileValue<T> {
  const result: ProfileValue<T> = {
    value,
    evidence: [
      {
        source: 'user',
        confidence: 1,
        verifiedByUser: true,
        recordedAt: new Date().toISOString(),
      },
    ],
  };
  if (raw !== undefined) result.raw = raw;
  return result;
}

/**
 * A value read out of a resume: present, but unconfirmed.
 * Deliberately `verifiedByUser: false` - the user has not seen it yet.
 */
export function resumeValue<T>(
  value: T,
  options: { confidence: number; documentId?: string; page?: number; section?: string; originalText?: string; raw?: string },
): ProfileValue<T> {
  const evidence: Evidence = {
    source: 'resume',
    confidence: options.confidence,
    verifiedByUser: false,
    recordedAt: new Date().toISOString(),
  };
  if (options.documentId !== undefined) evidence.documentId = options.documentId;
  if (options.page !== undefined) evidence.page = options.page;
  if (options.section !== undefined) evidence.section = options.section;
  if (options.originalText !== undefined) evidence.originalText = options.originalText;

  const result: ProfileValue<T> = { value, evidence: [evidence] };
  if (options.raw !== undefined) result.raw = options.raw;
  return result;
}

/**
 * An empty profile with every branch present.
 *
 * Fully-populated-with-empties rather than partial: downstream code can then
 * read `profile.contact.email.value` without optional chaining at every step,
 * and a missing branch can never be mistaken for a missing value.
 */
export function createEmptyProfile(id: string, now = new Date().toISOString()): ApplicantProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id,
    label: 'Default profile',
    createdAt: now,
    updatedAt: now,
    identity: {
      legalFirstName: emptyValue<string>(),
      preferredFirstName: emptyValue<string>(),
      middleName: emptyValue<string>(),
      lastName: emptyValue<string>(),
      fullName: emptyValue<string>(),
    },
    contact: {
      email: emptyValue<string>(),
      phone: emptyValue<z.infer<typeof normalizedPhoneSchema>>(),
      addressLine1: emptyValue<string>(),
      addressLine2: emptyValue<string>(),
      city: emptyValue<string>(),
      state: emptyValue<string>(),
      postalCode: emptyValue<string>(),
      country: emptyValue<string>(),
    },
    links: {
      linkedin: emptyValue<string>(),
      github: emptyValue<string>(),
      portfolio: emptyValue<string>(),
      other: [],
    },
    education: [],
    employment: [],
    projects: [],
    skills: emptyValue<string[]>(),
    applicationPreferences: {
      authorizedToWorkUS: emptyValue<boolean>(),
      requiresSponsorshipNow: emptyValue<boolean>(),
      requiresSponsorshipFuture: emptyValue<boolean>(),
      willingToRelocate: emptyValue<boolean>(),
      desiredSalary: emptyValue<number>(),
      availableStartDate: emptyValue<z.infer<typeof normalizedDateSchema>>(),
      preferredLocations: emptyValue<string[]>(),
    },
    demographics: {
      gender: emptyValue<string>(),
      raceEthnicity: emptyValue<string[]>(),
      veteranStatus: emptyValue<string>(),
      disabilityStatus: emptyValue<string>(),
    },
  };
}

// ---------------------------------------------------------------------------
// Trust queries
// ---------------------------------------------------------------------------

/**
 * The display state of a value in the profile editor (spec section 9).
 * Also the input to the confidence policy: an `unverified` value can be
 * suggested but must not be silently autofilled into a legal question.
 */
export type ValueState = 'verified' | 'high_confidence' | 'needs_review' | 'missing';

/** Highest confidence across all evidence for a value. */
export function bestConfidence(value: ProfileValue<unknown> | undefined): number {
  if (value === undefined || value.value === null) return 0;
  return value.evidence.reduce((max, e) => Math.max(max, e.confidence), 0);
}

/** True when the user has personally confirmed this value. */
export function isVerified(value: ProfileValue<unknown> | undefined): boolean {
  if (value === undefined || value.value === null) return false;
  return value.evidence.some((e) => e.verifiedByUser);
}

/**
 * Classify a value for display and for policy.
 *
 * Note the ordering: verification beats confidence. A user-confirmed value is
 * verified even if some stale low-confidence resume evidence is still attached,
 * because the user's word is the highest authority in this system.
 */
export function valueState(value: ProfileValue<unknown> | undefined): ValueState {
  if (value === undefined || value.value === null) return 'missing';
  if (isVerified(value)) return 'verified';
  return bestConfidence(value) >= 0.85 ? 'high_confidence' : 'needs_review';
}

/**
 * Mark a value as user-verified while KEEPING its original evidence.
 *
 * We append rather than replace so the trail stays intact: "the resume said X
 * on page 1, and the user later confirmed it". Spec section 9 allows either
 * retaining the source or switching to "user"; retaining is strictly more
 * informative and costs nothing.
 */
export function verifyValue<T>(value: ProfileValue<T>): ProfileValue<T> {
  if (value.value === null) return value; // Nothing to verify. Never invent one.
  return {
    ...value,
    evidence: [
      ...value.evidence,
      {
        source: 'user',
        confidence: 1,
        verifiedByUser: true,
        recordedAt: new Date().toISOString(),
      },
    ],
  };
}

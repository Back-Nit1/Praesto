/**
 * Canonical profile paths.
 * ---------------------------------------------------------------------------
 * A "profile path" is the vocabulary the whole system agrees on:
 *
 *     "identity.legalFirstName"        "contact.phone"
 *     "education[0].graduationDate"    "applicationPreferences.willingToRelocate"
 *
 * The semantic mapper's job is to turn an arbitrary webpage field into one of
 * these strings. The value resolver's job is to turn one of these strings into
 * a value formatted for a specific control. Neither knows anything about the
 * other - the path IS the interface between them. That is what keeps
 * ATS-specific DOM knowledge out of the mapper and formatting logic out of the
 * ATS adapters (spec sections 12, 14 and 28).
 *
 * WHY A REGISTRY AND NOT JUST `string`
 * A typo in a path string ("identity.firstName" instead of
 * "identity.legalFirstName") would not be a crash - it would be a field that
 * silently never fills, or worse, a learned mapping permanently pointing at
 * nothing. The registry below turns that into a compile-time error for literals
 * and a runtime rejection for data loaded from storage.
 */

/**
 * Every non-repeating path in the profile.
 *
 * Kept as a flat `as const` array so it serves three purposes at once: the
 * source of the `ScalarProfilePath` union type, a runtime validation set, and
 * the enumeration the profile editor renders from.
 */
export const SCALAR_PROFILE_PATHS = [
  // --- identity ------------------------------------------------------------
  'identity.legalFirstName',
  'identity.preferredFirstName',
  'identity.middleName',
  'identity.lastName',
  'identity.fullName',

  // --- contact -------------------------------------------------------------
  'contact.email',
  'contact.phone',
  'contact.addressLine1',
  'contact.addressLine2',
  'contact.city',
  'contact.state',
  'contact.postalCode',
  'contact.country',

  // --- links ---------------------------------------------------------------
  'links.linkedin',
  'links.github',
  'links.portfolio',

  // --- skills --------------------------------------------------------------
  'skills',

  // --- application preferences (legal / logistical) ------------------------
  'applicationPreferences.authorizedToWorkUS',
  'applicationPreferences.requiresSponsorshipNow',
  'applicationPreferences.requiresSponsorshipFuture',
  'applicationPreferences.willingToRelocate',
  'applicationPreferences.desiredSalary',
  'applicationPreferences.availableStartDate',
  'applicationPreferences.preferredLocations',

  // --- voluntary demographics ---------------------------------------------
  'demographics.gender',
  'demographics.raceEthnicity',
  'demographics.veteranStatus',
  'demographics.disabilityStatus',
] as const;

export type ScalarProfilePath = (typeof SCALAR_PROFILE_PATHS)[number];

/** Fields available on each repeated entity. */
export const EDUCATION_FIELDS = [
  'institution',
  'degree',
  'fieldOfStudy',
  'startDate',
  'graduationDate',
  'gpa',
] as const;

export const EMPLOYMENT_FIELDS = [
  'company',
  'title',
  'location',
  'startDate',
  'endDate',
  'currentlyEmployed',
  'description',
  'bullets',
] as const;

export const PROJECT_FIELDS = ['name', 'description', 'technologies', 'url'] as const;

export type EducationField = (typeof EDUCATION_FIELDS)[number];
export type EmploymentField = (typeof EMPLOYMENT_FIELDS)[number];
export type ProjectField = (typeof PROJECT_FIELDS)[number];

/**
 * Indexed paths into the repeated collections.
 *
 * Template literal types give us `education[0].gpa` checked at compile time
 * without enumerating an infinite set.
 */
export type CollectionProfilePath =
  | `education[${number}].${EducationField}`
  | `employment[${number}].${EmploymentField}`
  | `projects[${number}].${ProjectField}`;

export type ProfilePath = ScalarProfilePath | CollectionProfilePath;

/** Fast membership set for the scalar paths. Built once at module load. */
const SCALAR_PATH_SET: ReadonlySet<string> = new Set(SCALAR_PROFILE_PATHS);

/** Structure of a collection path, once parsed. */
export interface ParsedCollectionPath {
  collection: 'education' | 'employment' | 'projects';
  index: number;
  field: string;
}

/**
 * Parse `education[2].gpa` into its parts, or return null if it is not a
 * well-formed collection path.
 *
 * The field name is checked against the allowed list for that collection, so a
 * path like `education[0].salary` is rejected rather than resolving to
 * undefined at read time and being mistaken for "the user has no salary".
 */
export function parseCollectionPath(path: string): ParsedCollectionPath | null {
  const match = /^(education|employment|projects)\[(\d+)\]\.([A-Za-z]+)$/.exec(path);
  if (match === null) return null;

  const collection = match[1] as ParsedCollectionPath['collection'];
  const index = Number(match[2]);
  const field = match[3] as string;

  const allowed: readonly string[] =
    collection === 'education'
      ? EDUCATION_FIELDS
      : collection === 'employment'
        ? EMPLOYMENT_FIELDS
        : PROJECT_FIELDS;

  if (!allowed.includes(field)) return null;
  return { collection, index, field };
}

/**
 * Runtime guard for arbitrary strings arriving from storage, a message payload,
 * or a learned mapping written by an older version of the extension.
 */
export function isProfilePath(path: string): path is ProfilePath {
  return SCALAR_PATH_SET.has(path) || parseCollectionPath(path) !== null;
}

// ---------------------------------------------------------------------------
// Sensitivity classification
// ---------------------------------------------------------------------------

/**
 * Paths that must NEVER be filled from an inferred or derived value.
 *
 * Spec section 21.3: work authorization, sponsorship, citizenship, gender,
 * race, disability and veteran status may only come from an explicit user
 * answer. Not from a name, a university, a country in an address, a language on
 * the resume, or a previous employer.
 *
 * This is expressed as data rather than as a comment so that the confidence
 * policy can *enforce* it: `requiresVerifiedValue()` below is consulted before
 * any autofill, which makes the rule impossible to forget when adding a new
 * mapping rule.
 */
export const SENSITIVE_PATHS: ReadonlySet<string> = new Set<ProfilePath>([
  'applicationPreferences.authorizedToWorkUS',
  'applicationPreferences.requiresSponsorshipNow',
  'applicationPreferences.requiresSponsorshipFuture',
  'demographics.gender',
  'demographics.raceEthnicity',
  'demographics.veteranStatus',
  'demographics.disabilityStatus',
]);

/**
 * True when a path may only be autofilled from a user-verified value.
 *
 * Consulted by the confidence policy. A high mapping confidence is NOT enough
 * for these paths: we may be certain the form is asking "are you authorized to
 * work in the US?" and still have no right to answer it from a guess.
 */
export function requiresVerifiedValue(path: string): boolean {
  return SENSITIVE_PATHS.has(path);
}

/**
 * Human-readable labels for the review UI and the audit log.
 *
 * Lives here, next to the path registry, so adding a path and forgetting its
 * label is a visible omission in one file rather than a missing string
 * discovered by a user.
 */
export const PATH_LABELS: Readonly<Record<ScalarProfilePath, string>> = {
  'identity.legalFirstName': 'Legal first name',
  'identity.preferredFirstName': 'Preferred first name',
  'identity.middleName': 'Middle name',
  'identity.lastName': 'Last name',
  'identity.fullName': 'Full name',
  'contact.email': 'Email',
  'contact.phone': 'Phone',
  'contact.addressLine1': 'Address line 1',
  'contact.addressLine2': 'Address line 2',
  'contact.city': 'City',
  'contact.state': 'State / province',
  'contact.postalCode': 'Postal code',
  'contact.country': 'Country',
  'links.linkedin': 'LinkedIn',
  'links.github': 'GitHub',
  'links.portfolio': 'Portfolio / website',
  skills: 'Skills',
  'applicationPreferences.authorizedToWorkUS': 'Authorized to work in the US',
  'applicationPreferences.requiresSponsorshipNow': 'Requires sponsorship now',
  'applicationPreferences.requiresSponsorshipFuture': 'Requires sponsorship in future',
  'applicationPreferences.willingToRelocate': 'Willing to relocate',
  'applicationPreferences.desiredSalary': 'Desired salary',
  'applicationPreferences.availableStartDate': 'Available start date',
  'applicationPreferences.preferredLocations': 'Preferred locations',
  'demographics.gender': 'Gender',
  'demographics.raceEthnicity': 'Race / ethnicity',
  'demographics.veteranStatus': 'Veteran status',
  'demographics.disabilityStatus': 'Disability status',
};

/** Best-effort display label for any path, including indexed collection paths. */
export function labelForPath(path: string): string {
  if (SCALAR_PATH_SET.has(path)) return PATH_LABELS[path as ScalarProfilePath];

  const parsed = parseCollectionPath(path);
  if (parsed !== null) {
    // "education[0].graduationDate" -> "Education 1 - graduation date"
    const humanField = parsed.field
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .trim();
    const humanCollection = parsed.collection.charAt(0).toUpperCase() + parsed.collection.slice(1);
    return `${humanCollection} ${parsed.index + 1} - ${humanField}`;
  }
  return path;
}

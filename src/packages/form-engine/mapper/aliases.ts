/**
 * The alias registry - how the system recognises questions without an LLM.
 * ---------------------------------------------------------------------------
 * Spec section 28 forbids sending every field to a language model, and spec 4
 * requires that basic factual autofill work with no network at all. This file
 * is what makes that possible: a curated map from the words real application
 * forms use to the canonical profile paths they mean.
 *
 * WHY A HAND-WRITTEN LIST BEATS A MODEL HERE
 * The space of ways to ask "what is your first name?" is large but not
 * unbounded, and it is stable across years. A list is deterministic (the same
 * label always maps the same way, so a bug is reproducible), free (no latency,
 * no cost, no network), private (nothing leaves the machine), and auditable
 * (you can read exactly why a field mapped). A model buys generalisation to
 * genuinely novel phrasings - which is real value, but it belongs at the END of
 * the cascade, as a fallback for the fields this list does not cover.
 *
 * HOW TO EXTEND
 * When a real application fails to map, add its exact wording here and add a
 * fixture (spec section 25.3). Prefer adding an alias over loosening the fuzzy
 * matcher: an alias is a precise, permanent fix, whereas loosening the fuzzy
 * threshold trades a fixed field for an unknown number of new mismatches.
 *
 * WHAT MUST NOT GO IN THIS FILE
 * No aliases that would let a demographic or work-authorization question be
 * answered from an inferred value. Those paths are in SENSITIVE_PATHS and the
 * confidence policy refuses to autofill them without explicit user
 * verification - aliases here only help us RECOGNISE the question so we can
 * ask the user, never license us to answer it ourselves.
 */
import type { ProfilePath } from '@profile/paths';

/**
 * HTML `autocomplete` tokens to canonical paths.
 *
 * The highest-confidence signal in the cascade, because it is a declaration of
 * intent in a standard vocabulary rather than prose we had to interpret. The
 * tokens are from the WHATWG HTML autofill specification.
 *
 * Caveat that shapes how it is used: many sites emit `autocomplete="off"` or
 * copy a token from a template, so this is trusted only when the token is one
 * we recognise. An unrecognised token contributes nothing rather than being
 * treated as a signal we simply failed to parse.
 */
export const AUTOCOMPLETE_MAP: Readonly<Record<string, ProfilePath>> = {
  'given-name': 'identity.legalFirstName',
  'additional-name': 'identity.middleName',
  'family-name': 'identity.lastName',
  name: 'identity.fullName',
  nickname: 'identity.preferredFirstName',

  email: 'contact.email',
  tel: 'contact.phone',
  'tel-national': 'contact.phone',
  'tel-country-code': 'contact.phone',

  'address-line1': 'contact.addressLine1',
  'address-line2': 'contact.addressLine2',
  'address-level2': 'contact.city', // WHATWG: city / locality
  'address-level1': 'contact.state', // WHATWG: state / province
  'postal-code': 'contact.postalCode',
  country: 'contact.country',
  'country-name': 'contact.country',

  url: 'links.portfolio',
};

/**
 * Canonical path to the phrasings that mean it.
 *
 * Entries are written in already-normalized form (lowercase, no punctuation,
 * single-spaced) so matching is a plain string comparison against
 * `normalizeLabel` output - no per-lookup normalization of this table, and no
 * risk of an entry that can never match because of a stray colon.
 *
 * ORDER WITHIN AN ARRAY DOES NOT MATTER. Exact matching is a set membership
 * test. Specificity between DIFFERENT paths is handled in the mapper, which
 * prefers the longest matching alias - so "legal first name" wins over
 * "first name" when both would match.
 */
export const ALIASES: Readonly<Partial<Record<ProfilePath, readonly string[]>>> = {
  // --- identity ------------------------------------------------------------
  'identity.legalFirstName': [
    'first name',
    'legal first name',
    'first legal name',
    'given name',
    'forename',
    'candidate first name',
    'applicant first name',
    'your first name',
    'fname',
    'firstname',
    'first',
  ],
  'identity.preferredFirstName': [
    'preferred name',
    'preferred first name',
    'nickname',
    'what should we call you',
    'goes by',
    'known as',
    'display name',
  ],
  'identity.middleName': ['middle name', 'middle initial', 'middle names', 'mname'],
  'identity.lastName': [
    'last name',
    'legal last name',
    'surname',
    'family name',
    'candidate last name',
    'applicant last name',
    'your last name',
    'lname',
    'lastname',
    'last',
  ],
  'identity.fullName': [
    'full name',
    'name',
    'your name',
    'full legal name',
    'legal name',
    'candidate name',
    'applicant name',
  ],

  // --- contact -------------------------------------------------------------
  'contact.email': [
    'email',
    'e mail', // "e-mail" normalizes to this
    'email address',
    'e mail address',
    'personal email',
    'contact email',
    'your email',
    'email id',
    'work email',
  ],
  'contact.phone': [
    'phone',
    'phone number',
    'telephone',
    'telephone number',
    'mobile',
    'mobile number',
    'mobile phone',
    'cell',
    'cell phone',
    'cell phone number',
    'contact number',
    'primary phone',
    'phone no',
  ],
  'contact.addressLine1': [
    'address',
    'street address',
    'address line 1',
    'address 1',
    'street',
    'mailing address',
    'home address',
    'current address',
  ],
  'contact.addressLine2': [
    'address line 2',
    'address 2',
    'apt',
    'apartment',
    'suite',
    'unit',
    'apt suite unit',
  ],
  'contact.city': ['city', 'town', 'city town', 'locality', 'current city', 'city of residence'],
  'contact.state': [
    'state',
    'province',
    'state province',
    'state region',
    'region',
    'county',
    'state or province',
  ],
  'contact.postalCode': ['zip', 'zip code', 'postal code', 'postcode', 'zip postal code'],
  'contact.country': ['country', 'country region', 'country of residence', 'nation'],

  // --- links ---------------------------------------------------------------
  'links.linkedin': [
    'linkedin',
    'linkedin url',
    'linkedin profile',
    'linkedin profile url',
    'linkedin link',
    'linked in',
    'linkedin com',
  ],
  'links.github': ['github', 'github url', 'github profile', 'github username', 'git hub'],
  'links.portfolio': [
    'portfolio',
    'website',
    'personal website',
    'portfolio url',
    'portfolio website',
    'personal site',
    'web site',
    'other website',
  ],

  // --- skills --------------------------------------------------------------
  skills: ['skills', 'technical skills', 'key skills', 'relevant skills', 'core competencies'],

  // --- application preferences (recognise-only for the sensitive ones) -----
  //
  // These aliases exist so the extension can SAY "this form is asking about
  // sponsorship" and surface it for review. The confidence policy still refuses
  // to answer them from anything but an explicitly verified user value.
  'applicationPreferences.authorizedToWorkUS': [
    'are you legally authorized to work in the united states',
    'are you authorized to work in the us',
    'authorized to work in the united states',
    'legally authorized to work',
    'work authorization',
    'are you legally eligible to work in the united states',
    'us work authorization',
  ],
  'applicationPreferences.requiresSponsorshipNow': [
    'do you now require sponsorship',
    'do you currently require sponsorship',
    'do you require visa sponsorship',
    'will you require sponsorship',
    'require sponsorship',
    'visa sponsorship required',
    'do you need sponsorship to work in the united states',
  ],
  'applicationPreferences.requiresSponsorshipFuture': [
    'will you in the future require sponsorship',
    'will you now or in the future require sponsorship',
    'future sponsorship',
    'will you require sponsorship in the future',
  ],
  'applicationPreferences.willingToRelocate': [
    'willing to relocate',
    'are you willing to relocate',
    'open to relocation',
    'relocation',
    'would you relocate',
  ],
  'applicationPreferences.desiredSalary': [
    'desired salary',
    'salary expectations',
    'expected salary',
    'salary expectation',
    'compensation expectations',
    'desired compensation',
    'expected compensation',
  ],
  'applicationPreferences.availableStartDate': [
    'start date',
    'available start date',
    'earliest start date',
    'when can you start',
    'availability',
    'date available',
    'earliest availability',
  ],
  'applicationPreferences.preferredLocations': [
    'preferred location',
    'preferred locations',
    'location preference',
    'preferred office',
    'preferred work location',
    'desired location',
  ],

  // --- voluntary demographics (recognise-only, never inferred) -------------
  'demographics.gender': ['gender', 'what is your gender', 'gender identity'],
  'demographics.raceEthnicity': [
    'race',
    'ethnicity',
    'race ethnicity',
    'racial identity',
    'race or ethnicity',
    'hispanic or latino',
  ],
  'demographics.veteranStatus': [
    'veteran status',
    'protected veteran',
    'are you a protected veteran',
    'veteran',
    'military service',
  ],
  'demographics.disabilityStatus': [
    'disability status',
    'disability',
    'do you have a disability',
    'voluntary self identification of disability',
  ],
};

/**
 * Aliases for fields inside a repeated education/employment/project block.
 *
 * Kept separate from the scalar table because these resolve against an ENTRY
 * (which school? which job?), not against a fixed path. The mapper turns a
 * match here into an indexed path - `education[0].institution` - using an entry
 * index the service worker supplies from the profile, so the mapper itself
 * stays a pure function that has never read a profile.
 *
 * WHY THE COLLISIONS IN THESE TABLES ARE THE INTERESTING PART
 * "start date", "end date", "location" and "description" appear in more than
 * one of these tables, and "start date" is also a scalar alias for the
 * applicant's availability. Those collisions are real ambiguity in the source
 * material, not a defect in the tables: on a page the only thing that resolves
 * them is the section the question sits under. See `collectionFromContext`.
 */
export const EDUCATION_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  institution: ['school', 'university', 'college', 'institution', 'school name', 'university name'],
  degree: ['degree', 'degree type', 'level of education', 'qualification', 'degree earned'],
  fieldOfStudy: ['major', 'field of study', 'discipline', 'concentration', 'area of study', 'course'],
  startDate: ['start date', 'from', 'attended from', 'education start date'],
  graduationDate: [
    'graduation date',
    'end date',
    'expected graduation',
    'expected graduation date',
    'graduation',
    'completion date',
    'to',
  ],
  gpa: ['gpa', 'grade point average', 'cgpa', 'grade', 'academic performance'],
};

export const EMPLOYMENT_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  company: ['company', 'employer', 'company name', 'organization', 'organisation', 'employer name'],
  title: ['title', 'job title', 'position', 'role', 'position title', 'your title'],
  location: ['location', 'job location', 'work location', 'city'],
  startDate: ['start date', 'from', 'employment start date', 'date started'],
  endDate: ['end date', 'to', 'employment end date', 'date ended'],
  currentlyEmployed: ['currently work here', 'i currently work here', 'current position', 'present'],
  description: ['description', 'job description', 'responsibilities', 'duties', 'summary'],
};

export const PROJECT_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  name: ['project name', 'project title', 'title of project'],
  description: ['project description', 'describe the project', 'about the project'],
  technologies: ['technologies', 'tech stack', 'tools used', 'technologies used'],
  url: ['project url', 'project link', 'repository', 'repo url', 'demo link'],
};

// ---------------------------------------------------------------------------
// Repeated-entity lookup
// ---------------------------------------------------------------------------

/** The three repeated collections in the profile. */
export type ProfileCollection = 'education' | 'employment' | 'projects';

/** One claim on an alias by a field inside a repeated collection. */
export interface CollectionAliasEntry {
  collection: ProfileCollection;
  /** A field name from EDUCATION_FIELDS / EMPLOYMENT_FIELDS / PROJECT_FIELDS. */
  field: string;
}

const COLLECTION_TABLES: ReadonlyArray<
  readonly [ProfileCollection, Readonly<Record<string, readonly string[]>>]
> = [
  ['education', EDUCATION_FIELD_ALIASES],
  ['employment', EMPLOYMENT_FIELD_ALIASES],
  ['projects', PROJECT_FIELD_ALIASES],
];

/**
 * Reverse index across all three repeated-entity tables.
 *
 * The value is an array for the same reason the scalar index's is: "start date"
 * is claimed by both education and employment, and recording BOTH claims is
 * what lets the mapper see the ambiguity and lower its confidence, rather than
 * silently taking whichever table was defined first.
 */
function buildCollectionAliasIndex(): ReadonlyMap<string, readonly CollectionAliasEntry[]> {
  const index = new Map<string, CollectionAliasEntry[]>();
  for (const [collection, table] of COLLECTION_TABLES) {
    for (const [field, aliases] of Object.entries(table)) {
      for (const alias of aliases) {
        const entry: CollectionAliasEntry = { collection, field };
        const existing = index.get(alias);
        if (existing === undefined) index.set(alias, [entry]);
        else existing.push(entry);
      }
    }
  }
  return index;
}

export const COLLECTION_ALIAS_INDEX: ReadonlyMap<string, readonly CollectionAliasEntry[]> =
  buildCollectionAliasIndex();

/** Same index keyed by the compact form, for `name="school_name"`. */
function buildCompactCollectionIndex(): ReadonlyMap<string, readonly CollectionAliasEntry[]> {
  const index = new Map<string, CollectionAliasEntry[]>();
  for (const [alias, entries] of COLLECTION_ALIAS_INDEX) {
    const compact = alias.replace(/[^a-z0-9]/g, '');
    const existing = index.get(compact);
    if (existing === undefined) index.set(compact, [...entries]);
    else {
      for (const entry of entries) {
        const duplicate = existing.some(
          (candidate) => candidate.collection === entry.collection && candidate.field === entry.field,
        );
        if (!duplicate) existing.push(entry);
      }
    }
  }
  return index;
}

export const COMPACT_COLLECTION_ALIAS_INDEX: ReadonlyMap<string, readonly CollectionAliasEntry[]> =
  buildCompactCollectionIndex();

/**
 * Which repeated block a piece of page context is talking about.
 *
 * This is the signal that disambiguates the collisions above, and it is the
 * reason `sectionHeading` is collected during the scan at all. "Start date"
 * under "Education" and "Start date" under "Work experience" are different
 * questions with identical labels; no amount of label analysis can separate
 * them, and the heading separates them immediately.
 *
 * Deliberately conservative:
 *   - the patterns are word-bounded, so "workday" is not "work";
 *   - a text that matches SEVERAL collections returns null rather than picking
 *     one, because a heading like "Education and work history" tells us the
 *     page groups them together and therefore tells us nothing about which one
 *     this field belongs to.
 */
const COLLECTION_CONTEXT_PATTERNS: ReadonlyArray<readonly [ProfileCollection, RegExp]> = [
  [
    'education',
    /\b(education|educational|school|schooling|university|college|academic|academics|alma mater|degree|coursework)\b/,
  ],
  [
    'employment',
    /\b(experience|employment|employer|work history|working history|professional background|previous position|current position|job history|positions held)\b/,
  ],
  ['projects', /\b(project|projects|portfolio piece|side project)\b/],
];

export function collectionFromContext(text: string | undefined): ProfileCollection | null {
  if (text === undefined || text.length === 0) return null;

  const matched = COLLECTION_CONTEXT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([collection]) => collection,
  );

  // Exactly one, or we know nothing useful.
  return matched.length === 1 ? (matched[0] ?? null) : null;
}

/**
 * Reverse index: normalized alias -> the paths that claim it.
 *
 * Built once at module load and consulted per field. A Map lookup is O(1),
 * whereas scanning the table is O(paths x aliases) - roughly 300 comparisons -
 * for EVERY field on a page with hundreds of fields. On a low-end machine that
 * difference is visible, and the index costs a few KB once.
 *
 * The value is an ARRAY, not a single path, because aliases genuinely collide:
 * "start date" means one thing under an Education heading and another under
 * Employment. Recording the collision lets the mapper detect the ambiguity and
 * lower its confidence, instead of silently taking whichever entry happened to
 * be defined first.
 */
function buildAliasIndex(): ReadonlyMap<string, readonly ProfilePath[]> {
  const index = new Map<string, ProfilePath[]>();
  for (const [path, aliases] of Object.entries(ALIASES)) {
    if (aliases === undefined) continue;
    for (const alias of aliases) {
      const existing = index.get(alias);
      if (existing === undefined) index.set(alias, [path as ProfilePath]);
      else existing.push(path as ProfilePath);
    }
  }
  return index;
}

export const ALIAS_INDEX: ReadonlyMap<string, readonly ProfilePath[]> = buildAliasIndex();

/**
 * Same index keyed by the compact form (all separators removed).
 *
 * Lets `name="e_mail_address"` reach the "email address" alias. Scored lower
 * than an exact match by the confidence policy, because collapsing separators
 * is a lossy transformation.
 */
function buildCompactIndex(): ReadonlyMap<string, readonly ProfilePath[]> {
  const index = new Map<string, ProfilePath[]>();
  for (const [alias, paths] of ALIAS_INDEX) {
    const compact = alias.replace(/[^a-z0-9]/g, '');
    const existing = index.get(compact);
    if (existing === undefined) index.set(compact, [...paths]);
    else {
      // Union rather than concat: two aliases can compact to the same key
      // ("e mail" and "email"), and duplicating a path would make the mapper
      // read a single claim as two agreeing ones.
      for (const path of paths) if (!existing.includes(path)) existing.push(path);
    }
  }
  return index;
}

export const COMPACT_ALIAS_INDEX: ReadonlyMap<string, readonly ProfilePath[]> = buildCompactIndex();

/** Every alias for a path, for the debug panel and the mapping playground. */
export function aliasesForPath(path: ProfilePath): readonly string[] {
  return ALIASES[path] ?? [];
}

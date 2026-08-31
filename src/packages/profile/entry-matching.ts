/**
 * Duplicate detection and field-wise merging for repeated profile entries.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Education, employment and project entries used to be appended wholesale on
 * every resume import. Uploading a lightly-edited resume - which is what people
 * actually do, several times a season - therefore produced a profile with the
 * same job in it three times, and no way to tell the copies apart.
 *
 * This module answers the two questions the import review screen needs:
 *
 *   findDuplicate - "is this parsed job already in the profile?"
 *   mergeEntry    - "given that it is, what should the entry look like now?"
 *
 * Both are pure functions over plain data. No storage, no React, no parser:
 * that is what makes the matching rules testable as rules rather than as UI.
 *
 * THE BIAS IS TOWARDS NOT MATCHING.
 * A false positive silently collapses two real jobs into one and loses a chunk
 * of someone's history. A false negative shows them one extra row to uncheck.
 * Those costs are not symmetric, so every rule below requires a strong key
 * (company, institution, project name) to agree before anything else is even
 * considered, and a blank key matches nothing at all.
 */
import { isEmptyDate, type NormalizedDate } from './normalizers/date';
import { isVerified, type Education, type Employment, type Project, type ProfileValue } from './schema';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export interface EntryByKind {
  education: Education;
  employment: Employment;
  projects: Project;
}

export type EntryKind = keyof EntryByKind;

/** Any repeated entry: a stable id plus a bag of wrapped values. */
type AnyEntry = { id: string } & Record<string, unknown>;

/**
 * A match, with the human-readable reason it was called one.
 *
 * The reason is not decoration. The review screen shows it next to the
 * "already in your profile" badge, so the user can tell a confident match
 * ("Same company and title") from a circumstantial one ("Same company, dates
 * overlap") and overrule the second without having to trust us.
 */
export interface DuplicateMatch {
  /** Index into the `existing` array that was passed in. */
  index: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Legal and structural suffixes that are noise for identity purposes.
 *
 * "Acme", "Acme Inc." and "ACME CORPORATION, INC." are one employer. Nobody
 * writes the suffix consistently across resume revisions, and a resume parser
 * reproduces whatever the line said, so stripping these is the difference
 * between recognising a re-import and not.
 */
const COMPANY_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'ag',
  'sa',
  'nv',
  'bv',
  'pvt',
  'private',
  'holdings',
  'group',
]);

/**
 * Reduce a name to the tokens that carry identity.
 *
 * Diacritics are folded, "&" becomes "and", punctuation goes, and trailing
 * legal suffixes are dropped. What is left is compared token-wise rather than
 * as a string, so a stray comma cannot break a match.
 */
function tokenize(raw: string, dropSuffixes: boolean): string[] {
  const folded = raw
    .normalize('NFKD')
    // Strip combining marks so "Nestlé" and "Nestle" are the same employer.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (folded === '') return [];

  const tokens = folded.split(' ').filter((token) => token !== 'the');
  if (!dropSuffixes) return tokens;

  // Only trailing suffixes: "Company X" keeps its first word, "X Company"
  // does not need it.
  let end = tokens.length;
  while (end > 1 && COMPANY_SUFFIXES.has(tokens[end - 1] as string)) end -= 1;
  return tokens.slice(0, end);
}

/**
 * Names join WITHOUT a separator, on purpose.
 *
 * "ShiftFlow", "shift-flow" and "Shift Flow" are one project, and word breaks
 * inside a proper noun are exactly the thing people are inconsistent about
 * between resume revisions. Titles keep their spaces (see `normalizeTitle`),
 * because there the token boundaries are what `titlesAgree` compares.
 */
const normalizeName = (raw: string): string => tokenize(raw, true).join('');
const normalizeTitle = (raw: string): string => tokenize(raw, false).join(' ');

/** The comparable form of a wrapped string, or '' when there is nothing to compare. */
function key(value: ProfileValue<string> | undefined, normalizer: (raw: string) => string): string {
  const raw = value?.value;
  return typeof raw === 'string' ? normalizer(raw) : '';
}

/**
 * Do two titles describe the same role?
 *
 * Equal after normalisation, or one's tokens are a subset of the other's:
 * "Software Engineer" and "Software Engineer II" are the same job seen from
 * two resume revisions. This is deliberately only ever consulted AFTER the
 * company already matched, where the looseness is safe.
 */
function titlesAgree(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerTokens = new Set(longer.split(' '));
  return shorter.split(' ').every((token) => longerTokens.has(token));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * A date as a comparable month index, or undefined when it says nothing.
 *
 * Month granularity is what resumes actually carry ("Jun 2021 - Aug 2023"), and
 * comparing at day granularity would just invent precision.
 */
function monthIndex(date: NormalizedDate | null | undefined, fallbackMonth: number): number | undefined {
  if (date === null || date === undefined) return undefined;
  if (date.isPresent === true) return Number.POSITIVE_INFINITY;
  if (date.year === undefined) return undefined;
  return date.year * 12 + (date.month ?? fallbackMonth);
}

interface Span {
  start: number;
  end: number;
}

function span(start: ProfileValue<NormalizedDate>, end: ProfileValue<NormalizedDate>): Span | null {
  const from = monthIndex(start.value, 1);
  if (from === undefined || from === Number.POSITIVE_INFINITY) return null;

  // A start with no end is an ongoing role far more often than it is a
  // one-month one, so it runs to the present rather than to its own start.
  const to = monthIndex(end.value, 12) ?? Number.POSITIVE_INFINITY;
  return { start: from, end: to };
}

/** Half-open in neither direction: a job ending the month another starts overlaps. */
function spansOverlap(a: Span | null, b: Span | null): boolean {
  if (a === null || b === null) return false;
  return a.start <= b.end && b.start <= a.end;
}

/** Same month, or same year when one of the two never recorded a month. */
function datesAgree(a: ProfileValue<NormalizedDate>, b: ProfileValue<NormalizedDate>): boolean {
  const first = a.value;
  const second = b.value;
  if (first === null || second === null) return false;
  if (first.year === undefined || second.year === undefined) return false;
  if (first.year !== second.year) return false;
  if (first.month === undefined || second.month === undefined) return true;
  return first.month === second.month;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Find the entry in `existing` that `candidate` is a repeat of.
 *
 * Returns the FIRST match. Two existing entries that both match a candidate
 * means the profile already has a duplicate in it, and picking either is as
 * good an answer as this function can give.
 */
export function findDuplicate<K extends EntryKind>(
  kind: K,
  candidate: EntryByKind[K],
  existing: readonly EntryByKind[K][],
): DuplicateMatch | null {
  // One cast, at the boundary: `kind` and the entry type co-vary by
  // construction, but TypeScript cannot see that through a generic parameter.
  const match = (
    kind === 'employment'
      ? matchEmployment
      : kind === 'education'
        ? matchEducation
        : matchProject
  ) as (candidate: EntryByKind[K], other: EntryByKind[K]) => string | null;

  for (const [index, other] of existing.entries()) {
    const reason = match(candidate, other);
    if (reason !== null) return { index, reason };
  }
  return null;
}

function matchEmployment(candidate: Employment, other: Employment): string | null {
  const company = key(candidate.company, normalizeName);
  if (company === '' || company !== key(other.company, normalizeName)) return null;

  if (titlesAgree(key(candidate.title, normalizeTitle), key(other.title, normalizeTitle))) {
    return 'Same company and title';
  }

  // A different title at the same company during the same stint is a promotion
  // or a re-worded line, not a second job.
  if (
    spansOverlap(
      span(candidate.startDate, candidate.endDate),
      span(other.startDate, other.endDate),
    )
  ) {
    return 'Same company, and the dates overlap';
  }

  return null;
}

function matchEducation(candidate: Education, other: Education): string | null {
  const institution = key(candidate.institution, normalizeName);
  if (institution === '' || institution !== key(other.institution, normalizeName)) return null;

  if (titlesAgree(key(candidate.degree, normalizeTitle), key(other.degree, normalizeTitle))) {
    return 'Same school and degree';
  }

  // A bachelors and a masters at one university share an institution but not a
  // graduation date, which is what keeps them apart here.
  if (datesAgree(candidate.graduationDate, other.graduationDate)) {
    return 'Same school and graduation date';
  }

  return null;
}

/**
 * Projects have no company and no reliable dates, so the name is the whole
 * test - and it has to be exact after normalisation. "Chat" and "Chat App" are
 * plausibly two different side projects, with nothing available to corroborate
 * a merge.
 */
function matchProject(candidate: Project, other: Project): string | null {
  const name = key(candidate.name, normalizeName);
  if (name === '' || name !== key(other.name, normalizeName)) return null;
  return 'Same project name';
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Is there nothing in this value worth keeping?
 *
 * Whitespace, an empty list and a date with no fields set are all "we do not
 * have this" wearing the costume of a value. Treating them as present would
 * block a re-import from ever filling them in.
 */
function isBlankValue(value: ProfileValue<unknown> | undefined): boolean {
  const inner = value?.value;
  if (inner === null || inner === undefined) return true;
  if (typeof inner === 'string') return inner.trim() === '';
  if (Array.isArray(inner)) return inner.length === 0;
  if (typeof inner === 'object') {
    const record = inner as Record<string, unknown>;
    // Covers NormalizedDate, and any future wrapped object, by the same rule.
    if ('isPresent' in record || 'year' in record || 'raw' in record || 'iso' in record) {
      return isEmptyDate(record as NormalizedDate);
    }
    return Object.values(record).every((field) => field === undefined || field === null);
  }
  return false;
}

/** A `{ value, evidence }` shaped field, as opposed to `id`. */
function isWrappedValue(field: unknown): field is ProfileValue<unknown> {
  return (
    typeof field === 'object' &&
    field !== null &&
    'value' in field &&
    'evidence' in field &&
    Array.isArray((field as { evidence: unknown }).evidence)
  );
}

/**
 * Fold a freshly parsed entry into one the profile already holds.
 *
 * THE RULE: the incoming value wins ONLY where the existing entry has nothing.
 * Never where the user verified a value, and never where the existing value is
 * merely older - a parser being more confident this time is not grounds to
 * overwrite a value the profile already committed to. That makes re-importing a
 * resume purely additive, which is the only way it is safe to offer as a
 * one-click action.
 *
 * The existing `id` is kept. Learned form mappings and any future references
 * point at ids, so replacing one would silently retarget them - the exact
 * failure the ids were introduced to prevent (see `employmentSchema`).
 */
export function mergeEntry<T extends { id: string }>(existing: T, incoming: T): T {
  const merged: AnyEntry = { ...(existing as AnyEntry) };

  for (const [field, incomingValue] of Object.entries(incoming as AnyEntry)) {
    if (field === 'id') continue;
    if (!isWrappedValue(incomingValue) || isBlankValue(incomingValue)) continue;

    const current = merged[field];
    const held = isWrappedValue(current) ? current : undefined;
    if (isVerified(held)) continue;
    if (!isBlankValue(held)) continue;

    // Wholesale, so the incoming evidence - which resume, which page, which
    // line - travels with the value it justifies.
    merged[field] = incomingValue;
  }

  return merged as T;
}

/**
 * How many fields `mergeEntry` would actually fill in.
 *
 * The review screen uses this to say "adds 3 details" rather than offering an
 * update that would change nothing.
 */
export function mergeGain<T extends { id: string }>(existing: T, incoming: T): number {
  let gained = 0;
  const merged = mergeEntry(existing, incoming) as AnyEntry;
  const before = existing as AnyEntry;

  for (const field of Object.keys(merged)) {
    if (field === 'id') continue;
    if (merged[field] !== before[field]) gained += 1;
  }
  return gained;
}

// ---------------------------------------------------------------------------
// Applying the user's decisions
// ---------------------------------------------------------------------------

/**
 * What the user chose to do with one parsed entry.
 *
 * `skip` is the default for a detected duplicate and `add` for everything
 * else, but both are only ever defaults - the review screen shows all three
 * and nothing is applied without a click.
 */
export type EntryDecision = 'skip' | 'add' | 'update';

export interface EntryDecisionInput<T> {
  /**
   * The entry to apply - which is the user's EDITED copy when they corrected
   * something on the review screen, not necessarily what the parser produced.
   */
  entry: T;
  decision: EntryDecision;
  /** Index in `existing` that `update` should merge into. From `findDuplicate`. */
  matchIndex?: number;
}

export interface ApplyResult<T> {
  entries: T[];
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Fold a screen's worth of decisions into a new list.
 *
 * Pure, and separated from the review UI on purpose: "what does accepting this
 * screen do to my profile" is a question about data, and answering it in a
 * component would make it answerable only by rendering one.
 *
 * An `update` whose match index no longer exists is APPENDED rather than
 * dropped. The profile could have changed between the parse and the click, and
 * of the two failure modes - a duplicate the user can delete, or a silently
 * discarded entry they asked to keep - only the first is recoverable.
 */
export function applyEntryDecisions<T extends { id: string }>(
  existing: readonly T[],
  decisions: readonly EntryDecisionInput<T>[],
): ApplyResult<T> {
  const entries = [...existing];
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const { entry, decision, matchIndex } of decisions) {
    if (decision === 'skip') {
      skipped += 1;
      continue;
    }

    const index = decision === 'update' ? matchIndex : undefined;
    const target = index === undefined ? undefined : entries[index];

    if (index === undefined || target === undefined) {
      entries.push(entry);
      added += 1;
      continue;
    }

    // Merge onto the ACCUMULATING list, so two parsed entries pointing at the
    // same existing one compose instead of the second undoing the first.
    entries[index] = mergeEntry(target, entry);
    updated += 1;
  }

  return { entries, added, updated, skipped };
}

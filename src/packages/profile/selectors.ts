/**
 * Profile selectors - reading and writing values by canonical path.
 * ---------------------------------------------------------------------------
 * The rest of the system speaks in paths ("contact.email"), not in object
 * navigation. This module is the only place that knows the profile's physical
 * shape, which means the schema can be reorganised without touching the mapper,
 * the resolver, the learning store, or the UI.
 *
 * WHY NOT A GENERIC `lodash.get`
 * A generic deep-get would happily return `undefined` for a misspelled path,
 * and `undefined` is indistinguishable from "the user has not filled this in".
 * That ambiguity is exactly the failure mode this product cannot afford. So
 * every read here goes through the path registry first: an unknown path is a
 * hard `null` *with a different meaning* from a known-but-empty path, and the
 * caller is given a discriminated result rather than being left to guess.
 */
import type { ApplicantProfile, ProfileValue } from './schema';
import { isProfilePath, parseCollectionPath } from './paths';

/**
 * The outcome of resolving a path.
 *
 * Three genuinely different states, kept distinct all the way to the UI:
 *   - `ok`            we found a value slot; it may still hold null
 *   - `unknown_path`  the path is not part of our vocabulary (a bug, or stale
 *                     data written by a different version)
 *   - `out_of_range`  the path is valid but the collection has no such entry
 *                     (e.g. `education[3]` when the user listed two schools)
 */
export type PathLookup =
  | { readonly status: 'ok'; readonly value: ProfileValue<unknown> }
  | { readonly status: 'unknown_path' }
  | { readonly status: 'out_of_range' };

/** Index signature view used to walk the profile without `any`. */
type Indexable = Record<string, unknown>;

/**
 * Read the ProfileValue at a canonical path.
 *
 * Never throws: a malformed path is a returned status, not an exception,
 * because paths reach us from persisted learned mappings that may predate a
 * schema change.
 */
export function getValueAtPath(profile: ApplicantProfile, path: string): PathLookup {
  if (!isProfilePath(path)) return { status: 'unknown_path' };

  const collectionPath = parseCollectionPath(path);

  if (collectionPath !== null) {
    const { collection, index, field } = collectionPath;
    const entries = profile[collection];
    const entry = entries[index];
    // A valid path into a collection the user simply has not filled out yet.
    // Distinct from a bad path - the UI can offer "add another school".
    if (entry === undefined) return { status: 'out_of_range' };

    const value = (entry as unknown as Indexable)[field];
    if (!isProfileValue(value)) return { status: 'unknown_path' };
    return { status: 'ok', value };
  }

  // Scalar path: at most two segments ("skills" or "contact.email"). Walking
  // rather than switching keeps this correct as the schema grows, and the path
  // registry has already guaranteed the segments exist.
  const segments = path.split('.');
  let cursor: unknown = profile;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return { status: 'unknown_path' };
    cursor = (cursor as Indexable)[segment];
  }

  if (!isProfileValue(cursor)) return { status: 'unknown_path' };
  return { status: 'ok', value: cursor };
}

/**
 * Structural check that an unknown is a ProfileValue.
 *
 * Needed because we walk the profile through an index signature, so the
 * compiler cannot prove the leaf type. Checking for the `evidence` array rather
 * than just `value` matters: `value` alone would also match a plain data object
 * and let a non-provenanced primitive slip through as if it were trusted.
 */
function isProfileValue(candidate: unknown): candidate is ProfileValue<unknown> {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'value' in candidate &&
    'evidence' in candidate &&
    Array.isArray((candidate as { evidence: unknown }).evidence)
  );
}

/** Convenience read: the underlying value, or null for any non-ok lookup. */
export function readValue<T>(profile: ApplicantProfile, path: string): T | null {
  const lookup = getValueAtPath(profile, path);
  return lookup.status === 'ok' ? ((lookup.value.value as T | null) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/**
 * Compose a full name from its parts.
 *
 * Returns null unless we have at least a first and last name: "Nityanth" alone
 * is not a full name, and half a name in a "Full name" field is a wrong answer,
 * not a partial one.
 *
 * Note this NEVER overwrites an explicit `identity.fullName` the user supplied.
 * Derivation is a fallback for a missing value, never a correction of a present
 * one - the user may have a name our composition rule cannot express.
 */
export function deriveFullName(profile: ApplicantProfile): string | null {
  const explicit = profile.identity.fullName.value;
  if (explicit !== null && explicit.trim().length > 0) return explicit;

  const first = profile.identity.legalFirstName.value?.trim();
  const middle = profile.identity.middleName.value?.trim();
  const last = profile.identity.lastName.value?.trim();

  if (first === undefined || first.length === 0) return null;
  if (last === undefined || last.length === 0) return null;

  return [first, middle, last].filter((p) => p !== undefined && p.length > 0).join(' ');
}

/**
 * The education entry a form most likely means when it asks for "your school"
 * without qualification.
 *
 * Heuristic, and labelled as such: most recent graduation date wins, falling
 * back to list order. Callers must treat the result as a *suggestion* and route
 * it through the normal confidence policy rather than filling it silently -
 * "most recent" is a reasonable default but it is still an assumption about
 * what the form meant.
 */
export function mostRecentEducationIndex(profile: ApplicantProfile): number | null {
  if (profile.education.length === 0) return null;

  let bestIndex = 0;
  let bestKey = -1;

  profile.education.forEach((entry, index) => {
    const date = entry.graduationDate.value;
    // Encode year+month as a single sortable integer. Missing components sort
    // low, so a fully-dated entry beats an undated one.
    const key = date === null ? -1 : (date.year ?? 0) * 12 + (date.month ?? 0);
    if (key > bestKey) {
      bestKey = key;
      bestIndex = index;
    }
  });

  return bestIndex;
}

/**
 * The employment entry a form means by "current/most recent employer".
 * Same heuristic caveat as `mostRecentEducationIndex`.
 */
export function currentEmploymentIndex(profile: ApplicantProfile): number | null {
  if (profile.employment.length === 0) return null;

  // An explicitly-current job is the strongest signal available and does not
  // depend on date parsing having succeeded.
  const currentIndex = profile.employment.findIndex((e) => e.currentlyEmployed.value === true);
  if (currentIndex >= 0) return currentIndex;

  let bestIndex = 0;
  let bestKey = -1;
  profile.employment.forEach((entry, index) => {
    const date = entry.endDate.value;
    // An open-ended end date means the job is ongoing: rank it above any dated
    // entry rather than treating a missing year as zero.
    const key =
      date === null ? -1 : date.isPresent === true ? Number.MAX_SAFE_INTEGER : (date.year ?? 0) * 12 + (date.month ?? 0);
    if (key > bestKey) {
      bestKey = key;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * ProfileRepository - durable access to the canonical applicant profile.
 * ---------------------------------------------------------------------------
 * The only component permitted to read or write the persisted profile. Every
 * other module goes through it, which buys us:
 *
 *   - VALIDATION ON READ. Data in `chrome.storage` may have been written by an
 *     older release, hand-edited by a curious user, or restored from a partial
 *     sync. It is untrusted input and is validated against the Zod schema on
 *     the way out of storage, exactly like input from a network boundary.
 *
 *   - THE VERIFICATION INVARIANT. Spec section 9: "Do not re-parse and
 *     overwrite a verified value later without explicit user action." That is
 *     the product's central trust guarantee, and it is enforced here, in the
 *     merge path, rather than being restated as a rule each caller must
 *     remember.
 *
 *   - A SUBSTITUTABLE BACKEND. The repository holds a `KeyValueStore`, so tests
 *     run against `InMemoryStore` with no browser and no mocks.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { err, ok, type Result } from '@shared/result';
import { newId } from '@shared/ids';
import type { KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import {
  applicantProfileSchema,
  createEmptyProfile,
  isVerified,
  type ApplicantProfile,
  type ProfileValue,
} from './schema';

const log = createLogger('profile:repository');

export interface ProfileRepository {
  /** The active profile, or undefined when the user has not created one yet. */
  load(): Promise<Result<ApplicantProfile | undefined, AppError>>;
  /** The active profile, creating an empty one on first run. */
  loadOrCreate(): Promise<Result<ApplicantProfile, AppError>>;
  save(profile: ApplicantProfile): Promise<Result<void, AppError>>;
  /** Read-modify-write with validation on both ends. */
  update(
    mutate: (profile: ApplicantProfile) => ApplicantProfile,
  ): Promise<Result<ApplicantProfile, AppError>>;
  /** Merge parsed candidates in without ever clobbering a verified value. */
  mergeCandidates(candidates: ProfileCandidates): Promise<Result<MergeReport, AppError>>;
  /** Serialise for backup/debugging (Phase 1 requirement). */
  exportJson(): Promise<Result<string, AppError>>;
  /** Restore from a backup. Validated before it is allowed to replace anything. */
  importJson(json: string): Promise<Result<ApplicantProfile, AppError>>;
  clear(): Promise<Result<void, AppError>>;
}

/**
 * Values a parser proposes, keyed by canonical path.
 *
 * Kept flat and path-keyed rather than shaped like a profile so the resume
 * parser never has to know the profile's physical structure, and so a partial
 * extraction is naturally expressible - the parser reports only what it found.
 */
export type ProfileCandidates = Readonly<Record<string, ProfileValue<unknown>>>;

/** What a merge actually did, so the onboarding UI can explain itself. */
export interface MergeReport {
  /** Paths where an empty slot was populated. */
  applied: string[];
  /** Paths skipped because the user had already verified them. */
  skippedVerified: string[];
  /** Paths skipped because the incoming path is not in our vocabulary. */
  skippedUnknownPath: string[];
  /**
   * Paths where an unverified value already existed and a different one was
   * proposed. NOT auto-applied: the user is asked to choose. Silently picking
   * one is exactly the "confidently wrong" behaviour the product forbids.
   */
  conflicts: Array<{ path: string; existingRaw?: string; incomingRaw?: string }>;
}

export class StoredProfileRepository implements ProfileRepository {
  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<Result<ApplicantProfile | undefined, AppError>> {
    const raw = await this.store.get<unknown>(STORAGE_KEYS.activeProfile);
    if (!raw.ok) return err(raw.error);
    if (raw.value === undefined) return ok(undefined);

    // Validate on the way out. Persisted data is untrusted input.
    const parsed = applicantProfileSchema.safeParse(raw.value);
    if (!parsed.success) {
      // We do NOT delete or "repair" the bad record. A user's verified profile
      // is expensive to recreate, and a repair heuristic could quietly discard
      // half of it. Surfacing the error lets the UI offer export-and-inspect.
      return err(
        new AppError('SCHEMA_VALIDATION_FAILED', 'Stored profile failed validation', {
          cause: parsed.error,
          // The Zod issue paths name fields, not values, so they are safe to log.
          context: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
        }),
      );
    }
    return ok(parsed.data);
  }

  async loadOrCreate(): Promise<Result<ApplicantProfile, AppError>> {
    const existing = await this.load();
    if (!existing.ok) return err(existing.error);
    if (existing.value !== undefined) return ok(existing.value);

    const created = createEmptyProfile(newId('profile'));
    const saved = await this.save(created);
    return saved.ok ? ok(created) : err(saved.error);
  }

  async save(profile: ApplicantProfile): Promise<Result<void, AppError>> {
    // Validate on the way IN as well. This catches a bug in our own code before
    // it becomes persisted corruption that every later read has to cope with.
    const parsed = applicantProfileSchema.safeParse(profile);
    if (!parsed.success) {
      return err(
        new AppError('SCHEMA_VALIDATION_FAILED', 'Refusing to save an invalid profile', {
          cause: parsed.error,
          context: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
        }),
      );
    }

    const stamped: ApplicantProfile = { ...parsed.data, updatedAt: new Date().toISOString() };
    const written = await this.store.setMany({
      [STORAGE_KEYS.activeProfile]: stamped,
      [STORAGE_KEYS.activeProfileId]: stamped.id,
    });
    return written.ok ? ok(undefined) : err(written.error);
  }

  async update(
    mutate: (profile: ApplicantProfile) => ApplicantProfile,
  ): Promise<Result<ApplicantProfile, AppError>> {
    const current = await this.loadOrCreate();
    if (!current.ok) return err(current.error);

    const next = mutate(current.value);
    const saved = await this.save(next);
    return saved.ok ? ok(next) : err(saved.error);
  }

  /**
   * Merge parser-proposed values into the profile.
   *
   * THE RULES, in priority order:
   *   1. A user-verified value is never overwritten. Full stop.
   *   2. An empty slot is filled.
   *   3. An unverified slot holding a DIFFERENT value produces a conflict for
   *      the user to resolve, not a silent replacement.
   *   4. An unknown path is reported and ignored - never coerced into a
   *      neighbouring field that looks similar.
   *
   * Rule 3 is the one that is tempting to skip. "The new parse is probably
   * better" is a guess, and a guess that overwrites is how a correct value
   * becomes a wrong one between two runs.
   */
  async mergeCandidates(candidates: ProfileCandidates): Promise<Result<MergeReport, AppError>> {
    const loaded = await this.loadOrCreate();
    if (!loaded.ok) return err(loaded.error);

    // Imported lazily to keep this module's dependency direction clean: the
    // repository knows about paths, but paths must not know about storage.
    const { getValueAtPath } = await import('./selectors');
    const { isProfilePath } = await import('./paths');

    const report: MergeReport = {
      applied: [],
      skippedVerified: [],
      skippedUnknownPath: [],
      conflicts: [],
    };

    // Mutate a structured clone so a mid-merge failure cannot leave the caller
    // holding a half-updated profile object.
    const next = structuredClone(loaded.value);

    for (const [path, incoming] of Object.entries(candidates)) {
      if (!isProfilePath(path)) {
        report.skippedUnknownPath.push(path);
        continue;
      }

      const lookup = getValueAtPath(next, path);
      if (lookup.status !== 'ok') {
        // A well-formed path into a collection entry that does not exist yet.
        // Creating entries is the caller's job (it knows how many schools the
        // resume listed); inventing one here would be guessing at structure.
        report.skippedUnknownPath.push(path);
        continue;
      }

      const existing = lookup.value;

      if (isVerified(existing)) {
        report.skippedVerified.push(path);
        continue;
      }

      if (existing.value === null) {
        writeValueInPlace(next, path, incoming);
        report.applied.push(path);
        continue;
      }

      // Both present, neither verified. Same value is a no-op; different values
      // need the user.
      const same = JSON.stringify(existing.value) === JSON.stringify(incoming.value);
      if (same) {
        // Merge the evidence so repeated extractions strengthen the record
        // without duplicating the value itself.
        writeValueInPlace(next, path, {
          ...existing,
          evidence: [...existing.evidence, ...incoming.evidence],
        });
        report.applied.push(path);
      } else {
        const conflict: MergeReport['conflicts'][number] = { path };
        if (existing.raw !== undefined) conflict.existingRaw = existing.raw;
        if (incoming.raw !== undefined) conflict.incomingRaw = incoming.raw;
        report.conflicts.push(conflict);
      }
    }

    const saved = await this.save(next);
    if (!saved.ok) return err(saved.error);

    log.info(
      `Merged resume candidates: ${report.applied.length} applied, ` +
        `${report.conflicts.length} conflicts, ${report.skippedVerified.length} protected`,
    );
    return ok(report);
  }

  async exportJson(): Promise<Result<string, AppError>> {
    const loaded = await this.load();
    if (!loaded.ok) return err(loaded.error);
    if (loaded.value === undefined) {
      return err(new AppError('PROFILE_NOT_FOUND', 'No profile to export'));
    }
    // Pretty-printed: the export exists to be read and hand-edited during
    // development, not to be transmitted efficiently.
    return ok(JSON.stringify(loaded.value, null, 2));
  }

  async importJson(json: string): Promise<Result<ApplicantProfile, AppError>> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(json);
    } catch (error) {
      return err(new AppError('SCHEMA_VALIDATION_FAILED', 'Import is not valid JSON', { cause: error }));
    }

    // Validate BEFORE touching stored data. An invalid import must leave the
    // existing profile completely untouched.
    const parsed = applicantProfileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return err(
        new AppError('SCHEMA_VALIDATION_FAILED', 'Import does not match the profile schema', {
          cause: parsed.error,
          context: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
        }),
      );
    }

    const saved = await this.save(parsed.data);
    return saved.ok ? ok(parsed.data) : err(saved.error);
  }

  async clear(): Promise<Result<void, AppError>> {
    const removed = await this.store.remove(STORAGE_KEYS.activeProfile);
    return removed.ok ? ok(undefined) : err(removed.error);
  }
}

/**
 * Write a ProfileValue at a canonical path, mutating in place.
 *
 * Private to this module and used only on a structured clone the caller owns.
 * It is the mirror of `getValueAtPath`, and lives here rather than in
 * selectors.ts because selectors are deliberately read-only: keeping mutation
 * out of them means a component can import selectors without gaining the
 * ability to corrupt the profile.
 */
function writeValueInPlace(
  profile: ApplicantProfile,
  path: string,
  value: ProfileValue<unknown>,
): void {
  const collectionMatch = /^(education|employment|projects)\[(\d+)\]\.([A-Za-z]+)$/.exec(path);

  if (collectionMatch !== null) {
    const collection = collectionMatch[1] as 'education' | 'employment' | 'projects';
    const index = Number(collectionMatch[2]);
    const field = collectionMatch[3] as string;
    const entry = profile[collection][index];
    if (entry === undefined) return; // Caller already reported this as unknown.
    (entry as unknown as Record<string, unknown>)[field] = value;
    return;
  }

  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf === undefined) return;

  let cursor: Record<string, unknown> = profile as unknown as Record<string, unknown>;
  for (const segment of segments) {
    const nested = cursor[segment];
    if (typeof nested !== 'object' || nested === null) return;
    cursor = nested as Record<string, unknown>;
  }
  cursor[leaf] = value;
}

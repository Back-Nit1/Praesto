/**
 * Storage migrations.
 * ---------------------------------------------------------------------------
 * A browser extension cannot control when users update. On any given day the
 * installed base holds data written by every version ever shipped, and an
 * update can arrive with the user mid-application. So migrations are not
 * optional infrastructure to add later - they are the reason the extension can
 * be changed at all after release.
 *
 * DESIGN
 *   - Migrations form an ordered chain. Each step moves storage from version
 *     N to N+1. Upgrading from 1 to 4 runs steps 1->2, 2->3, 3->4 in order.
 *   - A step takes and returns plain data. It must NOT import the current
 *     schema types: those describe today's shape, and next year they will
 *     describe a different one, silently changing what an old migration does.
 *     A migration is a historical record and must be frozen once shipped.
 *   - The chain is idempotent: running it on already-current storage is a
 *     no-op, so it can safely run on every service-worker startup.
 *   - Failure is reported, never swallowed. Corrupting a user's verified
 *     profile is worse than refusing to start with a clear error.
 *
 * WHY NOT "JUST DELETE OLD DATA"
 * The profile is data the user typed by hand and verified field by field. It is
 * the single thing in this product that is expensive to recreate.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { err, ok, type Result } from '@shared/result';
import type { KeyValueStore } from './key-value-store';
import { STORAGE_KEYS, STORAGE_VERSION } from './keys';

const log = createLogger('storage:migrations');

/**
 * One migration step.
 *
 * `read`/`write` are handed in rather than the store itself so a step can only
 * touch storage through a narrow surface, and so the runner can log or dry-run
 * every access a step performs.
 */
export interface MigrationStep {
  /** The version this step migrates FROM. Produces `from + 1`. */
  readonly from: number;
  /** Short description, surfaced in logs when a migration runs. */
  readonly description: string;
  run(context: MigrationContext): Promise<Result<void, AppError>>;
}

export interface MigrationContext {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  allKeys(): Promise<string[]>;
}

/**
 * The migration chain, in order.
 *
 * Version 1 is the initial layout, so there is nothing to migrate yet. This
 * array is deliberately present-and-empty rather than absent: the runner, its
 * tests, and the version bookkeeping are all exercised from day one, so the
 * first real migration is a data change rather than a new mechanism written
 * under pressure.
 *
 * WORKED EXAMPLE for the next contributor - a step to add when the profile
 * schema gains a field:
 *
 *   {
 *     from: 1,
 *     description: 'Add applicationPreferences.preferredLocations',
 *     async run({ read, write }) {
 *       const profile = await read<Record<string, any>>(STORAGE_KEYS.activeProfile);
 *       if (profile === undefined) return ok(undefined);   // nothing to do
 *       profile.applicationPreferences ??= {};
 *       profile.applicationPreferences.preferredLocations ??= { value: null, evidence: [] };
 *       profile.schemaVersion = 2;
 *       await write(STORAGE_KEYS.activeProfile, profile);
 *       return ok(undefined);
 *     },
 *   }
 *
 * Note it defaults to an EMPTY value, never a plausible one. A migration that
 * invents data is indistinguishable to the user from the extension lying.
 */
export const MIGRATIONS: readonly MigrationStep[] = [];

/** Overrides for the migration runner. Production passes nothing. */
export interface MigrationRunOptions {
  /** The chain to run. Defaults to the shipped `MIGRATIONS`. */
  steps?: readonly MigrationStep[];
  /** The version to migrate to. Defaults to `STORAGE_VERSION`. */
  targetVersion?: number;
}

/**
 * Bring storage up to `STORAGE_VERSION`.
 *
 * Safe to call on every startup. Returns the version storage ended at so the
 * caller can log or surface it.
 *
 * The chain and target version are injectable rather than read from module
 * scope. This is not test scaffolding for its own sake: the runner's ordering,
 * checkpointing and failure behaviour are the parts that must be correct before
 * a real migration is ever trusted with a user's verified profile, and they
 * cannot be exercised at all while the shipped chain is empty. ES module
 * bindings are also immutable, so a test could not substitute the chain by
 * patching the export even if it wanted to.
 */
export async function runMigrations(
  store: KeyValueStore,
  options: MigrationRunOptions = {},
): Promise<Result<number, AppError>> {
  const steps = options.steps ?? MIGRATIONS;
  const targetVersion = options.targetVersion ?? STORAGE_VERSION;

  const versionResult = await store.get<number>(STORAGE_KEYS.storageVersion);
  if (!versionResult.ok) return err(versionResult.error);

  // Absent version means one of two things: a brand new install (nothing to
  // migrate), or storage written before versioning existed. We treat both as
  // the current version on an EMPTY store, and as version 1 otherwise, so a
  // fresh install never pays for the migration chain.
  let current = versionResult.value;
  if (current === undefined) {
    const keysResult = await store.keys();
    if (!keysResult.ok) return err(keysResult.error);
    current = keysResult.value.length === 0 ? targetVersion : 1;
  }

  if (current === targetVersion) return ok(current);

  if (current > targetVersion) {
    // The user downgraded the extension, or Chrome restored an older profile.
    // We cannot know what a future version did to the data, and guessing risks
    // destroying a verified profile. Refuse loudly instead.
    return err(
      new AppError(
        'MIGRATION_FAILED',
        `Stored data is from a newer version (${current} > ${targetVersion}). Update the extension.`,
        { context: { storedVersion: current, expected: targetVersion } },
      ),
    );
  }

  const context: MigrationContext = {
    read: async <T,>(key: string) => {
      const result = await store.get<T>(key);
      if (!result.ok) throw result.error;
      return result.value;
    },
    write: async (key, value) => {
      const result = await store.set(key, value);
      if (!result.ok) throw result.error;
    },
    remove: async (key) => {
      const result = await store.remove(key);
      if (!result.ok) throw result.error;
    },
    allKeys: async () => {
      const result = await store.keys();
      if (!result.ok) throw result.error;
      return result.value;
    },
  };

  while (current < targetVersion) {
    const step = steps.find((m) => m.from === current);
    if (step === undefined) {
      // A gap in the chain is a build-time bug, but it surfaces at runtime on a
      // user's machine, so it must be a clear error rather than an infinite loop.
      return err(
        new AppError('MIGRATION_FAILED', `No migration registered from version ${current}`, {
          context: { from: current, target: targetVersion },
        }),
      );
    }

    log.info(`Migrating storage ${step.from} -> ${step.from + 1}: ${step.description}`);

    let stepResult: Result<void, AppError>;
    try {
      stepResult = await step.run(context);
    } catch (error) {
      stepResult = err(
        new AppError('MIGRATION_FAILED', `Migration from ${step.from} threw`, { cause: error }),
      );
    }
    if (!stepResult.ok) return err(stepResult.error);

    current = step.from + 1;

    // Persist progress after EACH step. If the browser closes mid-chain, the
    // next startup resumes from where it stopped rather than re-running steps
    // that already ran - re-running a non-idempotent step is how migrations
    // corrupt data.
    const persisted = await store.set(STORAGE_KEYS.storageVersion, current);
    if (!persisted.ok) return err(persisted.error);
  }

  return ok(current);
}

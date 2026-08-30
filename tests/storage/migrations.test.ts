/**
 * Migration runner tests.
 *
 * The chain is empty at version 1, so these tests exercise the RUNNER against
 * synthetic steps. That is deliberate: the machinery that will one day move a
 * user's verified profile between schema versions is proven correct before it
 * is ever trusted with real data.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@storage/key-value-store';
import { runMigrations, type MigrationStep } from '@storage/migrations';
import { STORAGE_KEYS, STORAGE_VERSION } from '@storage/keys';
import { ok, err } from '@shared/result';
import { AppError } from '@shared/errors';

describe('runMigrations', () => {
  it('treats an empty store as already current and runs nothing', async () => {
    const store = new InMemoryStore();
    const result = await runMigrations(store);
    expect(result.ok && result.value).toBe(STORAGE_VERSION);
  });

  it('is a no-op when storage is already at the current version', async () => {
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.storageVersion, STORAGE_VERSION);
    const result = await runMigrations(store);
    expect(result.ok && result.value).toBe(STORAGE_VERSION);
  });

  it('refuses to run against data written by a newer version', async () => {
    const store = new InMemoryStore();
    // Downgrade scenario. We cannot know what the future version did to the
    // data, so destroying it on a guess is not an option.
    await store.set(STORAGE_KEYS.storageVersion, STORAGE_VERSION + 5);
    const result = await runMigrations(store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MIGRATION_FAILED');
  });

  it('runs steps in order and records progress after each one', async () => {
    // Drive the runner through a synthetic 3-step chain, so the test proves
    // ordering and checkpointing rather than the contents of any particular
    // migration.
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.storageVersion, 1);
    await store.set('probe', 'start');

    const order: number[] = [];
    const steps: MigrationStep[] = [1, 2, 3].map((from) => ({
      from,
      description: `synthetic ${from}`,
      async run({ read, write }) {
        order.push(from);
        // Assert the checkpoint written by the PREVIOUS iteration is visible,
        // which is what makes a partial run resumable.
        const version = await read<number>(STORAGE_KEYS.storageVersion);
        expect(version).toBe(from);
        await write('probe', `after-${from}`);
        return ok(undefined);
      },
    }));

    const result = await runMigrations(store, { steps, targetVersion: 4 });

    expect(result.ok).toBe(true);
    expect(order).toEqual([1, 2, 3]);
    const probe = await store.get<string>('probe');
    expect(probe.ok && probe.value).toBe('after-3');
  });

  it('stops at the failing step and leaves the version at the last good one', async () => {
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.storageVersion, 1);

    const steps: MigrationStep[] = [
      { from: 1, description: 'ok', run: async () => ok(undefined) },
      {
        from: 2,
        description: 'boom',
        run: async () => err(new AppError('MIGRATION_FAILED', 'synthetic failure')),
      },
      { from: 3, description: 'never runs', run: async () => ok(undefined) },
    ];

    const result = await runMigrations(store, { steps, targetVersion: 4 });
    expect(result.ok).toBe(false);

    // Version 2 means step 1 committed and step 2 did not - so the next startup
    // retries exactly the step that failed, not the one that already succeeded.
    const version = await store.get<number>(STORAGE_KEYS.storageVersion);
    expect(version.ok && version.value).toBe(2);
  });

  it('converts a thrown exception inside a step into a reported failure', async () => {
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.storageVersion, 1);

    const steps: MigrationStep[] = [
      {
        from: 1,
        description: 'throws',
        run: async () => {
          throw new Error('unexpected');
        },
      },
    ];

    const result = await runMigrations(store, { steps, targetVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MIGRATION_FAILED');
  });
});

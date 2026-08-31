/**
 * The pending-run stash.
 *
 * Tested against `InMemoryStore` - the same fake every other repository uses -
 * so none of this needs a chrome global or a service worker.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PENDING_RUNS, PENDING_TTL_MS, PendingRunStore, pendingKey, type PendingRun } from '@audit/pending';
import { InMemoryStore } from '@storage/key-value-store';

function run(overrides: Partial<PendingRun> = {}): PendingRun {
  return {
    runId: 'run-1',
    createdAt: 1_000,
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fields: [
      {
        localId: 'f1',
        fieldFingerprint: 'fp',
        detectedLabel: 'email',
        mappedProfilePath: 'identity.email',
        mappingConfidence: 0.97,
        mappingSource: 'alias',
        decidedAction: 'fill',
      },
    ],
    ...overrides,
  };
}

/** A clock the test moves by hand. */
function clockAt(times: { now: number }): () => number {
  return () => times.now;
}

describe('pendingKey', () => {
  it('separates two postings on the same careers site', () => {
    expect(pendingKey(7, 'https://boards.greenhouse.io/acme/jobs/1')).not.toBe(
      pendingKey(7, 'https://boards.greenhouse.io/acme/jobs/2'),
    );
  });

  it('separates the same posting open in two tabs', () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/1';
    expect(pendingKey(7, url)).not.toBe(pendingKey(8, url));
  });
});

describe('PendingRunStore', () => {
  it('stashes a scan and reads it back', async () => {
    const times = { now: 1_000 };
    const store = new PendingRunStore(new InMemoryStore(), clockAt(times));
    await store.stash('k', run());

    const found = await store.get('k');

    expect(found.ok && found.value?.runId).toBe('run-1');
  });

  it('does not consume the stash on read, so a second fill report still has it', async () => {
    const times = { now: 1_000 };
    const store = new PendingRunStore(new InMemoryStore(), clockAt(times));
    await store.stash('k', run());

    await store.get('k');
    const second = await store.get('k');

    expect(second.ok && second.value?.runId).toBe('run-1');
  });

  it('replaces a previous scan of the same page rather than merging it', async () => {
    const times = { now: 1_000 };
    const store = new PendingRunStore(new InMemoryStore(), clockAt(times));
    await store.stash('k', run({ runId: 'first' }));
    await store.stash('k', run({ runId: 'second', createdAt: 2_000 }));

    const found = await store.get('k');

    expect(found.ok && found.value?.runId).toBe('second');
  });

  it('treats an expired stash as absent', async () => {
    const times = { now: 1_000 };
    const store = new PendingRunStore(new InMemoryStore(), clockAt(times));
    await store.stash('k', run({ createdAt: 1_000 }));

    times.now = 1_000 + PENDING_TTL_MS + 1;
    const found = await store.get('k');

    expect(found.ok && found.value).toBeUndefined();
  });

  it('evicts the oldest scans past the bound', async () => {
    const times = { now: 0 };
    const store = new PendingRunStore(new InMemoryStore(), clockAt(times));

    for (let index = 0; index < MAX_PENDING_RUNS + 3; index++) {
      times.now = index;
      await store.stash(`k${index}`, run({ runId: `run-${index}`, createdAt: index }));
    }

    // The three oldest are gone; the newest survives.
    const oldest = await store.get('k0');
    const newest = await store.get(`k${MAX_PENDING_RUNS + 2}`);
    expect(oldest.ok && oldest.value).toBeUndefined();
    expect(newest.ok && newest.value?.runId).toBe(`run-${MAX_PENDING_RUNS + 2}`);
  });

  it('drops a scan on request', async () => {
    const times = { now: 1_000 };
    const store = new PendingRunStore(new InMemoryStore(), clockAt(times));
    await store.stash('k', run());

    await store.drop('k');

    const found = await store.get('k');
    expect(found.ok && found.value).toBeUndefined();
  });

  it('reports nothing pending when the stored value is corrupt', async () => {
    const backing = new InMemoryStore();
    await backing.set('aa:session:pendingRuns', 'not an object');
    const store = new PendingRunStore(backing, clockAt({ now: 1_000 }));

    const found = await store.get('k');

    expect(found.ok && found.value).toBeUndefined();
  });
});

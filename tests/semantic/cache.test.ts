/**
 * Semantic concept cache tests.
 *
 * The cache is what makes the economics of this feature work: decision #2 of
 * the brief is that a distinct question costs AT MOST ONE model call, ever. The
 * tests below are mostly about the ways that promise could quietly break -
 * a question that fails to match itself on the next form, a negative answer
 * that is not remembered and so is re-asked forever, or a corrupted entry that
 * is trusted on the way back out of storage.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SemanticConceptCache } from '@semantic/cache';
import { computeFingerprints } from '@form-engine/fingerprints/fingerprint';
import { InMemoryStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import { err } from '@shared/result';
import { AppError } from '@shared/errors';
import type { KeyValueStore } from '@storage/key-value-store';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import { descriptor } from '../helpers/descriptors';

const school = (overrides: Partial<FieldDescriptor> = {}): FieldDescriptor =>
  descriptor({
    label: 'Where did you study?',
    kind: 'select',
    options: [
      { value: '1', label: 'Rutgers University' },
      { value: '2', label: 'Princeton University' },
    ],
    ...overrides,
  });

describe('SemanticConceptCache', () => {
  it('returns a recorded concept for the same question', async () => {
    const cache = new SemanticConceptCache(new InMemoryStore());
    const field = school();

    await cache.record(computeFingerprints(field), 'education[0].institution');
    const hit = await cache.lookup(computeFingerprints(field));

    expect(hit?.profilePath).toBe('education[0].institution');
  });

  it('misses for a question it has never seen', async () => {
    const cache = new SemanticConceptCache(new InMemoryStore());
    await cache.record(computeFingerprints(school()), 'education[0].institution');

    const other = school({ label: 'What is your expected salary?', options: [] });
    expect(await cache.lookup(computeFingerprints(other))).toBeNull();
  });

  it('hits on a different company, because a question means the same thing anywhere', async () => {
    // The whole value of the cache is that the SECOND application is free. A
    // concept keyed to the hostname it was learned on would re-ask on every new
    // employer, which is every application.
    const cache = new SemanticConceptCache(new InMemoryStore());
    await cache.record(computeFingerprints(school({ hostname: 'boards.greenhouse.io', ats: 'greenhouse' })), 'education[0].institution');

    const elsewhere = school({ hostname: 'jobs.lever.co', ats: 'lever' });
    expect((await cache.lookup(computeFingerprints(elsewhere)))?.profilePath).toBe(
      'education[0].institution',
    );
  });

  it('remembers that a question has NO answer, so it is asked exactly once', async () => {
    // Decision #2 is "at most one model call ever", and it fails silently
    // without this: an unanswerable question that is not remembered as
    // unanswerable costs a call on every single application.
    const cache = new SemanticConceptCache(new InMemoryStore());
    const field = school({ label: 'How did you hear about this role?' });

    await cache.record(computeFingerprints(field), null);
    const hit = await cache.lookup(computeFingerprints(field));

    expect(hit).not.toBeNull();
    expect(hit?.profilePath).toBeNull();
  });

  it('refuses an entry whose stored path is no longer a profile path', async () => {
    // A path can vanish between versions, and a learned entry naming one would
    // otherwise resolve to `unknown_path` on every future scan.
    const store = new InMemoryStore();
    const field = school();
    const { global } = computeFingerprints(field);
    await store.set(STORAGE_KEYS.semanticConcepts, [
      {
        scope: 'global',
        fingerprint: global,
        profilePath: 'contact.faxNumber',
        createdAt: new Date().toISOString(),
      },
    ]);

    expect(await new SemanticConceptCache(store).lookup(computeFingerprints(field))).toBeNull();
  });

  it('degrades to a miss when storage cannot be read, rather than failing the scan', async () => {
    const broken: KeyValueStore = {
      ...new InMemoryStore(),
      get: async () => err(new AppError('STORAGE_READ_FAILED', 'nope')),
    } as unknown as KeyValueStore;

    expect(await new SemanticConceptCache(broken).lookup(computeFingerprints(school()))).toBeNull();
  });

  it('never grows without bound, and evicts the oldest entry first', async () => {
    const store = new InMemoryStore();
    const cache = new SemanticConceptCache(store, { maxEntries: 3 });

    const fields = ['one', 'two', 'three', 'four'].map((word) => school({ label: `Question ${word}?` }));
    for (const field of fields) {
      await cache.record(computeFingerprints(field), 'education[0].institution');
    }

    expect(await cache.size()).toBe(3);
    // The first question recorded is the one dropped.
    expect(await cache.lookup(computeFingerprints(fields[0] as FieldDescriptor))).toBeNull();
    expect(await cache.lookup(computeFingerprints(fields[3] as FieldDescriptor))).not.toBeNull();
  });

  it('overwrites rather than duplicating when the same question is recorded twice', async () => {
    const cache = new SemanticConceptCache(new InMemoryStore());
    const field = school();

    await cache.record(computeFingerprints(field), 'education[0].institution');
    await cache.record(computeFingerprints(field), 'education[0].fieldOfStudy');

    expect(await cache.size()).toBe(1);
    expect((await cache.lookup(computeFingerprints(field)))?.profilePath).toBe(
      'education[0].fieldOfStudy',
    );
  });

  it('cannot reach the network, because it does not import anything that can', async () => {
    // Structural rather than behavioural. "A cache hit is free" is a claim about
    // what this module is CAPABLE of, and no test of its behaviour can prove a
    // negative about a dependency it might acquire next week. Reading the source
    // can.
    const source = await readFile(
      new URL('../../src/packages/semantic/cache.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/@backend|fetch\(/);
  });
});

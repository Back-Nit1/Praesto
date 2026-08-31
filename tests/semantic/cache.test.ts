/**
 * Semantic concept cache tests.
 *
 * The cache is what makes "each distinct question costs at most one model call
 * ever" true rather than aspirational, so the tests that matter are the ones
 * about what it remembers and how cheaply it answers:
 *
 *   - a whole page's lookups cost ONE storage read, not one per field;
 *   - "this question maps to nothing" is remembered, because that is the answer
 *     we would otherwise pay for again on every single scan;
 *   - a cache that cannot be read degrades to knowing nothing, never to an
 *     error, because losing a cache must not break a scan.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SemanticCacheIndex, SemanticConceptCache, toResolution } from '@semantic/cache';
import type { CachedConcept } from '@semantic/cache';
import { InMemoryStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import type { KeyValueStore } from '@storage/key-value-store';
import { AppError } from '@shared/errors';
import { err, type Result } from '@shared/result';
import type { FingerprintQuery } from '@learning/types';
import { computeFingerprints } from '@form-engine/fingerprints/fingerprint';
import { descriptor, resetDescriptorIds } from '../helpers/descriptors';

let store: InMemoryStore;
let cache: SemanticConceptCache;

beforeEach(() => {
  resetDescriptorIds();
  store = new InMemoryStore();
  cache = new SemanticConceptCache(store);
});

const query = (overrides: Partial<FingerprintQuery> = {}): FingerprintQuery => ({
  global: 'g1',
  ats: 'a1',
  company: 'c1',
  exact: 'e1',
  ...overrides,
});

const entry = (overrides: Partial<CachedConcept> = {}): CachedConcept => ({
  scope: 'global',
  semanticFingerprint: 'g1',
  profilePath: 'education[0].fieldOfStudy',
  confidence: 0.8,
  question: 'what is your major',
  kind: 'select',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

/**
 * A store that counts reads, so "one read per batch" is asserted rather than
 * assumed. Real code implementing the real interface - no module mocking.
 */
class CountingStore implements KeyValueStore {
  reads = 0;
  constructor(private readonly inner: KeyValueStore) {}
  async get<T>(key: string): Promise<Result<T | undefined, AppError>> {
    this.reads++;
    return this.inner.get<T>(key);
  }
  getMany(keys: readonly string[]): Promise<Result<Record<string, unknown>, AppError>> {
    this.reads++;
    return this.inner.getMany(keys);
  }
  set<T>(key: string, value: T): Promise<Result<void, AppError>> {
    return this.inner.set(key, value);
  }
  setMany(entries: Readonly<Record<string, unknown>>): Promise<Result<void, AppError>> {
    return this.inner.setMany(entries);
  }
  remove(key: string): Promise<Result<void, AppError>> {
    return this.inner.remove(key);
  }
  keys(): Promise<Result<string[], AppError>> {
    return this.inner.keys();
  }
  bytesInUse(): Promise<Result<number | undefined, AppError>> {
    return this.inner.bytesInUse();
  }
}

/** A store whose reads always fail, for the degradation path. */
class UnreadableStore extends InMemoryStore {
  override async get<T>(): Promise<Result<T | undefined, AppError>> {
    return err(new AppError('STORAGE_READ_FAILED', 'Simulated read failure'));
  }
}

describe('SemanticCacheIndex', () => {
  it('answers a question it has seen before', () => {
    const index = new SemanticCacheIndex([entry()]);
    expect(index.find(query())?.profilePath).toBe('education[0].fieldOfStudy');
  });

  it('answers nothing for a question it has not', () => {
    const index = new SemanticCacheIndex([entry()]);
    expect(index.find(query({ global: 'other' }))).toBeNull();
  });

  it('prefers a narrower scope over a broader one', () => {
    // Same precedence rule as the learned-mapping store, for the same reason:
    // "at THIS company this question means X" is more specific information
    // than "this question usually means X".
    const index = new SemanticCacheIndex([
      entry({ scope: 'global', semanticFingerprint: 'g1', profilePath: 'contact.city' }),
      entry({
        scope: 'company',
        semanticFingerprint: 'c1',
        profilePath: 'applicationPreferences.preferredLocations',
      }),
    ]);
    expect(index.find(query())?.profilePath).toBe('applicationPreferences.preferredLocations');
  });

  it('remembers that a question maps to NOTHING', () => {
    // The most valuable entry in the cache. Without it, a form's untranslatable
    // question is paid for on every single scan, forever, to be told the same
    // nothing each time.
    const index = new SemanticCacheIndex([entry({ profilePath: '' })]);
    const hit = index.find(query());
    expect(hit).not.toBeNull();
    expect(hit?.profilePath).toBe('');
  });

  it('ignores an entry naming a path the registry no longer has', () => {
    // Written by an older build, or by a path we have since removed. A stale
    // pointer must read as "not cached", not as a mapping to nothing - the two
    // are different claims and only one of them is ours to make.
    const index = new SemanticCacheIndex([entry({ profilePath: 'identity.middlename' })]);
    expect(index.find(query())).toBeNull();
  });

  it('ignores an entry whose confidence is outside 0..1', () => {
    const index = new SemanticCacheIndex([entry({ confidence: 1.5 })]);
    expect(index.find(query())).toBeNull();
  });
});

describe('SemanticConceptCache', () => {
  it('records a concept and finds it again', async () => {
    const written = await cache.record({
      fingerprints: query(),
      profilePath: 'education[0].fieldOfStudy',
      confidence: 0.8,
      question: 'what is your major',
      kind: 'select',
    });
    expect(written.ok).toBe(true);

    const index = await cache.index();
    expect(index.find(query())?.profilePath).toBe('education[0].fieldOfStudy');
  });

  it('defaults to the global scope, which is all a question-only answer can claim', async () => {
    // Stage one is shown the question, the control kind and the options - and
    // no company, no ATS, no URL. Filing its answer under a narrower scope
    // would be a precision claim it has no evidence for, and would force a
    // fresh paid call for the same question at the next company.
    await cache.record({
      fingerprints: query(),
      profilePath: 'contact.city',
      confidence: 0.8,
      question: 'city',
      kind: 'text',
    });
    const all = await cache.all();
    expect(all.ok && all.value[0]?.scope).toBe('global');
  });

  it('records "maps to nothing" as an answer, not as a failure to answer', async () => {
    await cache.record({
      fingerprints: query(),
      profilePath: null,
      confidence: 0.8,
      question: 'how did you hear about us',
      kind: 'select',
    });
    const index = await cache.index();
    expect(index.find(query())?.profilePath).toBe('');
  });

  it('upserts on (scope, fingerprint) rather than stacking rules that disagree', async () => {
    const input = {
      fingerprints: query(),
      confidence: 0.8,
      question: 'what is your major',
      kind: 'select' as const,
    };
    await cache.record({ ...input, profilePath: 'contact.city' });
    await cache.record({ ...input, profilePath: 'education[0].fieldOfStudy' });

    const all = await cache.all();
    expect(all.ok && all.value).toHaveLength(1);
    expect(all.ok && all.value[0]?.profilePath).toBe('education[0].fieldOfStudy');
  });

  it('refuses to record a path the registry does not know', async () => {
    // A model naming a path we do not have is a refusal, not a fill - and it is
    // certainly not something to remember as if it were an answer.
    const written = await cache.record({
      fingerprints: query(),
      profilePath: 'identity.nickname' as never,
      confidence: 0.8,
      question: 'nickname',
      kind: 'text',
    });
    expect(written.ok).toBe(false);
    const all = await cache.all();
    expect(all.ok && all.value).toEqual([]);
  });

  it('costs ONE storage read for a whole page of lookups', async () => {
    // The reason the index exists at all. A per-field async lookup would be one
    // storage round trip per field on every scan, which is exactly the latency
    // the learned-mapping store was shaped to avoid.
    const counting = new CountingStore(store);
    const batched = new SemanticConceptCache(counting);
    await batched.record({
      fingerprints: query(),
      profilePath: 'contact.city',
      confidence: 0.8,
      question: 'city',
      kind: 'text',
    });

    counting.reads = 0;
    const index = await batched.index();
    for (let i = 0; i < 20; i++) index.find(query());

    expect(counting.reads).toBe(1);
  });

  it('degrades to knowing nothing when the cache cannot be read', async () => {
    // Losing a cache is a small harm. Failing a scan because a cache could not
    // be read is a large one - the user is mid-application.
    const broken = new SemanticConceptCache(new UnreadableStore());
    const index = await broken.index();
    expect(index.size).toBe(0);
    expect(index.find(query())).toBeNull();
  });

  it('keys on the real fingerprint of a real descriptor', async () => {
    // Guards the seam: the cache must key on the SAME hash the rest of the
    // system computes, not on a shape that only agrees in a fixture.
    const field = descriptor({
      label: 'What is your major?',
      kind: 'select',
      options: [{ value: 'ce', label: 'Computer Engineering' }],
    });
    const fingerprints = computeFingerprints(field);

    await cache.record({
      fingerprints,
      profilePath: 'education[0].fieldOfStudy',
      confidence: 0.8,
      question: 'what is your major',
      kind: 'select',
    });

    // Same question, completely different markup - the case the whole design
    // exists for.
    const elsewhere = descriptor({
      accessibleName: 'What is your major?',
      kind: 'select',
      name: 'cards[abc123][field0]',
      hostname: 'jobs.other.example',
      options: [{ value: '1', label: 'Computer Engineering' }],
    });

    const index = await cache.index();
    expect(index.find(computeFingerprints(elsewhere))?.profilePath).toBe(
      'education[0].fieldOfStudy',
    );
  });
});

describe('SemanticConceptCache - housekeeping', () => {
  it('evicts the least recently used when full', async () => {
    // Nothing here carries the user's authority, so unlike the learned-mapping
    // store there is nothing to protect from eviction - only a cost to weigh,
    // and the cheapest entry to lose is the one nobody has needed lately.
    const many = Array.from({ length: SemanticConceptCache.MAX_ENTRIES + 1 }, (_, i) =>
      entry({
        semanticFingerprint: `f${i}`,
        // Entry 0 is the oldest use and must be the one that goes.
        lastUsedAt: new Date(2026, 0, 1, 0, i).toISOString(),
      }),
    );
    await store.set(STORAGE_KEYS.semanticConcepts, many);

    await cache.record({
      fingerprints: query({ global: 'fresh' }),
      profilePath: 'contact.city',
      confidence: 0.8,
      question: 'city',
      kind: 'text',
    });

    const all = await cache.all();
    expect(all.ok && all.value).toHaveLength(SemanticConceptCache.MAX_ENTRIES);
    const kept = all.ok ? all.value.map((c) => c.semanticFingerprint) : [];
    expect(kept).not.toContain('f0');
    expect(kept).toContain('fresh');
  });

  it('touch moves an entry to the front of the eviction queue', async () => {
    await cache.record({
      fingerprints: query(),
      profilePath: 'contact.city',
      confidence: 0.8,
      question: 'city',
      kind: 'text',
    });
    const before = await cache.all();
    const stamp = before.ok ? before.value[0]?.lastUsedAt : undefined;

    await cache.touch(query(), new Date('2027-06-01T00:00:00.000Z'));

    const after = await cache.all();
    expect(after.ok && after.value[0]?.lastUsedAt).toBe('2027-06-01T00:00:00.000Z');
    expect(after.ok && after.value[0]?.lastUsedAt).not.toBe(stamp);
  });

  it('clears everything, without touching the user\'s own corrections', async () => {
    await store.set(STORAGE_KEYS.learnedMappings, [{ id: 'lm-1' }]);
    await cache.record({
      fingerprints: query(),
      profilePath: 'contact.city',
      confidence: 0.8,
      question: 'city',
      kind: 'text',
    });

    await cache.clear();

    const all = await cache.all();
    expect(all.ok && all.value).toEqual([]);
    // Separate keys, so "forget what the model told us" and "forget what I
    // taught you" are genuinely separate buttons.
    const learned = await store.get<unknown[]>(STORAGE_KEYS.learnedMappings);
    expect(learned.ok && learned.value).toHaveLength(1);
  });

  it('removes one entry by its key', async () => {
    await cache.record({
      fingerprints: query(),
      profilePath: 'contact.city',
      confidence: 0.8,
      question: 'city',
      kind: 'text',
    });
    await cache.remove('global', 'g1');
    const all = await cache.all();
    expect(all.ok && all.value).toEqual([]);
  });
});

describe('toResolution', () => {
  it('reports a cache hit as previously_seen, from the cache', async () => {
    const resolution = toResolution('field-1', entry());
    expect(resolution.fieldId).toBe('field-1');
    expect(resolution.profilePath).toBe('education[0].fieldOfStudy');
    expect(resolution.knowledgeState).toBe('previously_seen');
    expect(resolution.origin).toBe('cache');
  });

  it('turns the empty stored path back into a null path', async () => {
    const resolution = toResolution('field-1', entry({ profilePath: '' }));
    expect(resolution.profilePath).toBeNull();
    // Still `previously_seen`: we have seen this question and we know the
    // answer is "nothing". That is knowledge, and `decideFill` will skip it.
    expect(resolution.knowledgeState).toBe('previously_seen');
  });
});

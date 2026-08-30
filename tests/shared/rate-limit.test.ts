/**
 * Rate limiter tests.
 *
 * The clock is injected, so none of these sleep - a limiter test that waits on
 * real time is slow and flaky, and the thing under test is arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { PersistentQuota, TokenBucket, type QuotaStore } from '@shared/rate-limit';

/** A controllable clock. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity and then refuses', () => {
    const time = clock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: time.now });

    expect(bucket.take('a').allowed).toBe(true);
    expect(bucket.take('a').allowed).toBe(true);
    expect(bucket.take('a').allowed).toBe(true);

    const refused = bucket.take('a');
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it('refills lazily from elapsed time, with no timer', () => {
    const time = clock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, now: time.now });

    bucket.take('a');
    bucket.take('a');
    expect(bucket.take('a').allowed).toBe(false);

    time.advance(500); // 0.5s at 2/s = exactly one token
    expect(bucket.take('a').allowed).toBe(true);
    expect(bucket.take('a').allowed).toBe(false);
  });

  it('never refills past capacity, however long it idles', () => {
    const time = clock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 100, now: time.now });

    bucket.take('a');
    time.advance(60_000);

    expect(bucket.take('a').allowed).toBe(true);
    expect(bucket.take('a').allowed).toBe(true);
    // Capacity is 2: an hour of idling must not buy an unbounded burst.
    expect(bucket.take('a').allowed).toBe(false);
  });

  it('reports a retryAfter that actually works', () => {
    const time = clock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 4, now: time.now });

    bucket.take('a');
    const refused = bucket.take('a');
    expect(refused.allowed).toBe(false);

    time.advance(refused.retryAfterMs);
    expect(bucket.take('a').allowed).toBe(true);
  });

  it('keeps keys independent, so one tab cannot starve another', () => {
    const time = clock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, now: time.now });

    expect(bucket.take('tab:1').allowed).toBe(true);
    expect(bucket.take('tab:1').allowed).toBe(false);
    expect(bucket.take('tab:2').allowed).toBe(true);
  });

  it('bounds memory by evicting the least-recently-used key', () => {
    const time = clock();
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSecond: 1,
      maxKeys: 2,
      now: time.now,
    });

    bucket.take('a');
    bucket.take('b');
    bucket.take('a'); // 'a' is now most recent, so 'b' is the eviction target
    bucket.take('c');

    expect(bucket.size).toBe(2);
    // 'a' was touched most recently, so it survived and is still exhausted.
    expect(bucket.take('a').allowed).toBe(false);
    // 'b' was evicted, so it comes back as a fresh bucket. That is the only
    // cost of eviction, and it is bounded: an evicted key was idle by
    // definition, so its bucket had already refilled.
    expect(bucket.take('b').allowed).toBe(true);
  });

  it('does not consume a token on a refusal', () => {
    const time = clock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, now: time.now });

    bucket.take('a');
    // Hammering must not push recovery further away.
    for (let i = 0; i < 50; i++) bucket.take('a');

    time.advance(1000);
    expect(bucket.take('a').allowed).toBe(true);
  });
});

/** Minimal in-memory QuotaStore. */
function fakeStore(): QuotaStore & { fail: boolean; failWrites: boolean } {
  const data = new Map<string, unknown>();
  return {
    fail: false,
    failWrites: false,
    async get<T>(key: string) {
      if (this.fail) return { ok: false as const };
      return { ok: true as const, value: data.get(key) as T | undefined };
    },
    async set<T>(key: string, value: T) {
      if (this.failWrites) return { ok: false };
      data.set(key, value);
      return { ok: true };
    },
  };
}

describe('PersistentQuota', () => {
  it('permits exactly `limit` calls per window', async () => {
    const time = clock();
    const quota = new PersistentQuota(fakeStore(), {
      storageKey: 'q',
      limit: 3,
      windowMs: 60_000,
      now: time.now,
    });

    expect((await quota.take()).allowed).toBe(true);
    expect((await quota.take()).allowed).toBe(true);
    expect((await quota.take()).allowed).toBe(true);
    expect((await quota.take()).allowed).toBe(false);
  });

  it('starts a fresh window once the old one expires', async () => {
    const time = clock();
    const quota = new PersistentQuota(fakeStore(), {
      storageKey: 'q',
      limit: 1,
      windowMs: 1000,
      now: time.now,
    });

    expect((await quota.take()).allowed).toBe(true);
    expect((await quota.take()).allowed).toBe(false);

    time.advance(1000);
    expect((await quota.take()).allowed).toBe(true);
  });

  it('survives a simulated service-worker eviction', async () => {
    const time = clock();
    const store = fakeStore();
    const options = { storageKey: 'q', limit: 2, windowMs: 60_000, now: time.now };

    // First worker instance spends the budget...
    const first = new PersistentQuota(store, options);
    expect((await first.take()).allowed).toBe(true);
    expect((await first.take()).allowed).toBe(true);

    // ...the worker is evicted and a brand new instance starts. The whole
    // point of this class: the counter is in storage, not in the instance.
    const second = new PersistentQuota(store, options);
    expect((await second.take()).allowed).toBe(false);
  });

  it('fails closed when storage cannot be read', async () => {
    const store = fakeStore();
    store.fail = true;
    const quota = new PersistentQuota(store, { storageKey: 'q', limit: 10, windowMs: 1000 });

    expect((await quota.take()).allowed).toBe(false);
  });

  it('refuses when the spend cannot be recorded', async () => {
    const store = fakeStore();
    store.failWrites = true;
    const quota = new PersistentQuota(store, { storageKey: 'q', limit: 10, windowMs: 1000 });

    // Permitting here would mean the counter never advances and the cap is
    // decorative.
    expect((await quota.take()).allowed).toBe(false);
  });

  it('ignores a corrupt stored window rather than granting unlimited quota', async () => {
    const time = clock();
    const store = fakeStore();
    await store.set('q', { windowStartedAtMs: 'nonsense', used: Number.NaN });

    const quota = new PersistentQuota(store, {
      storageKey: 'q',
      limit: 1,
      windowMs: 60_000,
      now: time.now,
    });

    expect((await quota.take()).allowed).toBe(true);
    expect((await quota.take()).allowed).toBe(false);
  });

  it('peek reports usage without consuming', async () => {
    const time = clock();
    const quota = new PersistentQuota(fakeStore(), {
      storageKey: 'q',
      limit: 5,
      windowMs: 60_000,
      now: time.now,
    });

    await quota.take();
    const before = await quota.peek();
    const after = await quota.peek();

    expect(before.used).toBe(1);
    expect(after.used).toBe(1);
    expect(after.limit).toBe(5);
  });
});

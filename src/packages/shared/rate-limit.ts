/**
 * Rate limiting.
 * ---------------------------------------------------------------------------
 * ADDED BY THE SECURITY PASS. Two limiters, because there are two genuinely
 * different problems and one implementation cannot solve both:
 *
 *  1. `TokenBucket` - IN-MEMORY, per JS context. Guards the message boundary.
 *     A content script runs inside a page we do not control; if that page ever
 *     manages to drive it, the cheapest attack is a flood of
 *     RESOLVE_APPLICATION_FIELDS messages, each of which makes the service
 *     worker load the profile and run the mapping pipeline over 500 fields.
 *     That is a battery/CPU denial of service and a way to keep the worker
 *     alive indefinitely. A bucket costs one integer compare per message.
 *
 *  2. `PersistentQuota` - STORAGE-BACKED. Guards anything that costs MONEY or
 *     leaves the machine - i.e. the planned chat interface's model calls.
 *     An in-memory limiter cannot do this job: MV3 evicts the service worker
 *     after ~30s idle, and every eviction would reset the counter. An attacker
 *     (or an accidental render loop) would simply wait 30 seconds between
 *     bursts and spend the whole API budget. The window therefore lives in
 *     chrome.storage, which survives eviction.
 *
 * COMPLEXITY
 * Both are O(1) per check, with no timers and no background work:
 *   - refill is computed lazily from elapsed time on the read, so an idle
 *     limiter costs literally nothing (no setInterval waking a sleeping
 *     service worker, which on a laptop is a measurable battery cost),
 *   - memory is O(number of distinct keys) and hard-capped, with O(1)
 *     eviction of the least-recently-used key.
 *
 * WHY NOT A SLIDING WINDOW LOG
 * A log of timestamps is O(requests) memory per key and O(n) per check to
 * expire. A token bucket gives the same burst-plus-sustained-rate shape in two
 * numbers. On a 2 GB Chromebook that difference is the whole point.
 */

/** Result of a limiter check. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the next request would be allowed. 0 when allowed. */
  retryAfterMs: number;
  /** Whole tokens left after this decision. Useful for a UI hint. */
  remaining: number;
}

export interface TokenBucketOptions {
  /** Maximum tokens, i.e. the largest instantaneous burst allowed. */
  capacity: number;
  /** Tokens added per second. Sustained rate. */
  refillPerSecond: number;
  /**
   * Maximum distinct keys tracked at once. Prevents an attacker-chosen key
   * (a hostname, a tab id) from growing the map without bound. When full, the
   * least-recently-used key is dropped - which at worst gives that key a fresh
   * bucket, and it was idle by definition.
   */
  maxKeys?: number;
  /** Injectable clock, so the tests do not sleep. */
  now?: () => number;
}

/** Per-key state. Two numbers - that is the entire memory cost. */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_MAX_KEYS = 256;

/**
 * Classic token bucket, lazily refilled.
 *
 * Not persisted, deliberately: it guards a hot path where a storage round trip
 * per message would cost more than the work it is protecting.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.refillPerMs = Math.max(options.refillPerSecond, 0) / 1000;
    this.maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Consume one token for `key`.
   *
   * O(1). A Map hit, one multiply, one compare.
   */
  take(key: string, cost = 1): RateLimitDecision {
    const now = this.now();
    const bucket = this.touch(key, now);

    // Lazy refill. Time that passed while nobody was asking is credited here,
    // which is what removes the need for a timer.
    const elapsed = now - bucket.lastRefillMs;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }

    // Refusing costs nothing and, importantly, does NOT consume a token - a
    // caller that keeps hammering cannot push its own recovery further away.
    const deficit = cost - bucket.tokens;
    const retryAfterMs =
      this.refillPerMs > 0 ? Math.ceil(deficit / this.refillPerMs) : Number.MAX_SAFE_INTEGER;

    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  /** Drop a key's state, e.g. when its tab closes. */
  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** Number of keys currently tracked. Exposed for tests and diagnostics. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Fetch (or create) a bucket and mark it most-recently-used.
   *
   * A JS `Map` iterates in insertion order, so delete-then-set moves a key to
   * the end and `keys().next()` is the least-recently-used one. That gives LRU
   * eviction in O(1) without a linked list.
   */
  private touch(key: string, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing !== undefined) {
      this.buckets.delete(key);
      this.buckets.set(key, existing);
      return existing;
    }

    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }

    const fresh: Bucket = { tokens: this.capacity, lastRefillMs: now };
    this.buckets.set(key, fresh);
    return fresh;
  }
}

// ---------------------------------------------------------------------------
// Persistent quota - for anything that costs money or leaves the machine
// ---------------------------------------------------------------------------

/**
 * The minimal storage surface a quota needs.
 *
 * Declared structurally rather than importing `KeyValueStore` so this module
 * stays dependency-free and testable with an object literal. `ChromeLocalStore`
 * satisfies it as-is.
 */
export interface QuotaStore {
  get<T>(key: string): Promise<{ ok: true; value: T | undefined } | { ok: false }>;
  set<T>(key: string, value: T): Promise<{ ok: boolean }>;
}

export interface PersistentQuotaOptions {
  /** Storage key holding this quota's window. */
  storageKey: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds, e.g. 24h for a daily API budget. */
  windowMs: number;
  now?: () => number;
}

/** The shape written to storage. Two numbers - cheap to read on every call. */
interface QuotaWindow {
  windowStartedAtMs: number;
  used: number;
}

/**
 * A fixed-window counter that survives service-worker eviction.
 *
 * FIXED WINDOW, NOT SLIDING, ON PURPOSE. A sliding window needs the timestamp
 * of every request in the window; for a daily budget that is thousands of
 * numbers read and rewritten on each call. A fixed window is two numbers, and
 * the worst case it permits (a double burst across a window edge) is
 * acceptable for a personal spending cap - which is what this defends.
 *
 * FAIL CLOSED. If storage cannot be read, the request is DENIED. The thing on
 * the other side of this check spends money and sends data off the machine; a
 * limiter that fails open is not a limiter.
 */
export class PersistentQuota {
  private readonly options: Required<Omit<PersistentQuotaOptions, 'now'>> & { now: () => number };

  constructor(
    private readonly store: QuotaStore,
    options: PersistentQuotaOptions,
  ) {
    this.options = {
      storageKey: options.storageKey,
      limit: Math.max(1, options.limit),
      windowMs: Math.max(1, options.windowMs),
      now: options.now ?? (() => Date.now()),
    };
  }

  /** Try to consume one unit of quota. */
  async take(cost = 1): Promise<RateLimitDecision> {
    const { storageKey, limit, windowMs, now } = this.options;

    const read = await this.store.get<QuotaWindow>(storageKey);
    if (!read.ok) {
      // Fail closed - see the class comment.
      return { allowed: false, retryAfterMs: windowMs, remaining: 0 };
    }

    const at = now();
    const current = read.value;

    // A missing, expired, or corrupt window all mean the same thing: start a
    // new one. Validating the shape here is what stops a hand-edited storage
    // value (or a future schema change) from producing NaN arithmetic that
    // silently grants unlimited quota.
    const usable =
      current !== undefined &&
      typeof current.windowStartedAtMs === 'number' &&
      typeof current.used === 'number' &&
      Number.isFinite(current.windowStartedAtMs) &&
      Number.isFinite(current.used) &&
      at - current.windowStartedAtMs < windowMs;

    const window: QuotaWindow = usable
      ? (current as QuotaWindow)
      : { windowStartedAtMs: at, used: 0 };

    if (window.used + cost > limit) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, window.windowStartedAtMs + windowMs - at),
        remaining: Math.max(0, limit - window.used),
      };
    }

    const updated: QuotaWindow = { ...window, used: window.used + cost };
    const written = await this.store.set(storageKey, updated);
    if (!written.ok) {
      // Could not record the spend, so we must not permit it - otherwise the
      // counter never advances and the cap does nothing.
      return { allowed: false, retryAfterMs: 0, remaining: Math.max(0, limit - window.used) };
    }

    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, limit - updated.used) };
  }

  /** Current usage without consuming. For showing "42 of 200 left today". */
  async peek(): Promise<{ used: number; limit: number; resetsInMs: number }> {
    const { storageKey, limit, windowMs, now } = this.options;
    const read = await this.store.get<QuotaWindow>(storageKey);
    const at = now();

    if (!read.ok || read.value === undefined || at - read.value.windowStartedAtMs >= windowMs) {
      return { used: 0, limit, resetsInMs: windowMs };
    }
    return {
      used: read.value.used,
      limit,
      resetsInMs: Math.max(0, read.value.windowStartedAtMs + windowMs - at),
    };
  }
}

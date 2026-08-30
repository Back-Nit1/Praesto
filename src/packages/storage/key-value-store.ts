/**
 * KeyValueStore - the abstraction over `chrome.storage.local`.
 * ---------------------------------------------------------------------------
 * Spec section 4: "Create repository interfaces around storage. Application
 * logic should not call raw browser storage everywhere."
 *
 * Three concrete reasons this interface exists rather than calling
 * `chrome.storage.local` directly:
 *
 *  1. TESTABILITY. `chrome` does not exist in a Node test process. With this
 *     interface, every repository can be unit tested against `InMemoryStore`
 *     with no mocking framework and no global patching - the fake is real code
 *     that obeys the same contract.
 *
 *  2. FAILURE HANDLING. `chrome.storage` reports errors through
 *     `chrome.runtime.lastError` rather than by rejecting, which is easy to
 *     forget and produces silent data loss. That check happens here, once.
 *
 *  3. SUBSTITUTION. Moving a collection to IndexedDB (because it outgrew the
 *     ~10 MB `storage.local` quota) becomes a constructor change at one call
 *     site rather than a refactor across the codebase.
 *
 * Values are stored as already-parsed JSON structures, not strings:
 * `chrome.storage` serialises internally, and pre-stringifying would double the
 * work and the memory on every read.
 */
import { AppError } from '@shared/errors';
import { attemptAsync, err, ok, type Result } from '@shared/result';

export interface KeyValueStore {
  /** Read one key. Resolves to `undefined` when absent - absence is not an error. */
  get<T>(key: string): Promise<Result<T | undefined, AppError>>;

  /** Read several keys in one round trip. Missing keys are simply absent. */
  getMany(keys: readonly string[]): Promise<Result<Record<string, unknown>, AppError>>;

  set<T>(key: string, value: T): Promise<Result<void, AppError>>;

  /** Write several keys atomically with respect to the underlying store. */
  setMany(entries: Readonly<Record<string, unknown>>): Promise<Result<void, AppError>>;

  remove(key: string): Promise<Result<void, AppError>>;

  /** Every key currently present. Used by migrations and the export feature. */
  keys(): Promise<Result<string[], AppError>>;

  /** Bytes in use, when the backend can report it. Used to warn before quota. */
  bytesInUse(): Promise<Result<number | undefined, AppError>>;
}

/**
 * `chrome.storage.local` backed implementation.
 *
 * WHY storage.local AND NOT storage.sync
 * `storage.sync` would replicate the profile to every Chrome instance the user
 * is signed into, and to Google's servers. This profile contains a home
 * address, a phone number and optional demographic answers. Keeping it local
 * is a deliberate privacy posture (spec section 21), not an oversight. Cloud
 * sync is listed as explicitly out of scope in spec 3.2.
 *
 * QUOTA
 * `storage.local` allows ~10 MB without the `unlimitedStorage` permission,
 * which we do not request because requesting it enlarges the install-time
 * permission warning. A profile is a few KB; resume binaries and audit history
 * live in IndexedDB precisely so this store never approaches the limit.
 */
export class ChromeLocalStore implements KeyValueStore {
  /**
   * @param area injectable so tests (and a future `session` area for
   *             short-lived data) do not require the global `chrome`.
   */
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.local) {}

  async get<T>(key: string): Promise<Result<T | undefined, AppError>> {
    const result = await attemptAsync(async () => {
      const record = await this.area.get(key);
      return record[key] as T | undefined;
    });
    return result.ok
      ? ok(result.value)
      : err(
          new AppError('STORAGE_READ_FAILED', `Failed to read "${key}" from chrome.storage`, {
            cause: result.error,
            context: { key },
          }),
        );
  }

  async getMany(keys: readonly string[]): Promise<Result<Record<string, unknown>, AppError>> {
    const result = await attemptAsync(() => this.area.get([...keys]));
    return result.ok
      ? ok(result.value)
      : err(
          new AppError('STORAGE_READ_FAILED', 'Failed to read keys from chrome.storage', {
            cause: result.error,
            context: { keyCount: keys.length },
          }),
        );
  }

  async set<T>(key: string, value: T): Promise<Result<void, AppError>> {
    return this.setMany({ [key]: value });
  }

  async setMany(entries: Readonly<Record<string, unknown>>): Promise<Result<void, AppError>> {
    const result = await attemptAsync(() => this.area.set(entries));
    if (result.ok) return ok(undefined);

    // Quota exhaustion is the one storage failure the user can actually act on
    // ("delete an old resume"), so it gets its own code for a distinct UI
    // message rather than being lumped into a generic write failure.
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    const isQuota = /quota/i.test(message);
    return err(
      new AppError(
        isQuota ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED',
        isQuota ? 'Browser storage is full' : 'Failed to write to chrome.storage',
        // Keys, not values: the values are applicant PII and must not reach a log.
        { cause: result.error, context: { keys: Object.keys(entries) } },
      ),
    );
  }

  async remove(key: string): Promise<Result<void, AppError>> {
    const result = await attemptAsync(() => this.area.remove(key));
    return result.ok
      ? ok(undefined)
      : err(
          new AppError('STORAGE_WRITE_FAILED', `Failed to remove "${key}"`, {
            cause: result.error,
            context: { key },
          }),
        );
  }

  async keys(): Promise<Result<string[], AppError>> {
    // `get(null)` returns the whole area. Only used by migrations and export,
    // never on a hot path, because it materialises everything at once.
    const result = await attemptAsync(() => this.area.get(null));
    return result.ok
      ? ok(Object.keys(result.value))
      : err(
          new AppError('STORAGE_READ_FAILED', 'Failed to enumerate storage keys', {
            cause: result.error,
          }),
        );
  }

  async bytesInUse(): Promise<Result<number | undefined, AppError>> {
    // Not implemented by every StorageArea (notably `session`), so a missing
    // method is reported as "unknown", not as a failure.
    if (typeof this.area.getBytesInUse !== 'function') return ok(undefined);
    const result = await attemptAsync(() => this.area.getBytesInUse(null));
    return result.ok
      ? ok(result.value)
      : err(new AppError('STORAGE_READ_FAILED', 'Failed to measure storage usage', { cause: result.error }));
  }
}

/**
 * In-memory implementation for unit tests and for graceful degradation in a
 * context where `chrome.storage` is unavailable.
 *
 * Deep-clones on the way in and out. That is not paranoia: `chrome.storage`
 * structurally clones, so a test using a store that hands back live references
 * would pass while the real implementation fails - the fake must be at least as
 * strict as the thing it stands in for.
 */
export class InMemoryStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  /** Set true to make every operation fail, for exercising error paths. */
  failNextWrites = false;

  private clone<T>(value: T): T {
    // structuredClone matches chrome.storage's own serialisation semantics
    // (functions and DOM nodes are rejected, dates survive).
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : (JSON.parse(JSON.stringify(value)) as T);
  }

  async get<T>(key: string): Promise<Result<T | undefined, AppError>> {
    const value = this.data.get(key);
    return ok(value === undefined ? undefined : this.clone(value as T));
  }

  async getMany(keys: readonly string[]): Promise<Result<Record<string, unknown>, AppError>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = this.clone(this.data.get(key));
    }
    return ok(out);
  }

  async set<T>(key: string, value: T): Promise<Result<void, AppError>> {
    return this.setMany({ [key]: value });
  }

  async setMany(entries: Readonly<Record<string, unknown>>): Promise<Result<void, AppError>> {
    if (this.failNextWrites) {
      return err(new AppError('STORAGE_WRITE_FAILED', 'Simulated write failure'));
    }
    for (const [key, value] of Object.entries(entries)) {
      this.data.set(key, this.clone(value));
    }
    return ok(undefined);
  }

  async remove(key: string): Promise<Result<void, AppError>> {
    this.data.delete(key);
    return ok(undefined);
  }

  async keys(): Promise<Result<string[], AppError>> {
    return ok([...this.data.keys()]);
  }

  async bytesInUse(): Promise<Result<number | undefined, AppError>> {
    // Approximation is fine - this is only used for a "storage is filling up"
    // warning, and the fake exists so that code path is testable at all.
    let total = 0;
    for (const [key, value] of this.data) total += key.length + JSON.stringify(value).length;
    return ok(total);
  }
}

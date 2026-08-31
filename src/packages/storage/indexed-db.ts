/**
 * IndexedDB - the store for data too large or too numerous for chrome.storage.
 * ---------------------------------------------------------------------------
 * WHAT LIVES HERE AND WHY
 *
 *   resumes  - the original PDF/DOCX bytes. A resume is 100 KB-2 MB. Putting
 *              even one in chrome.storage.local would consume a fifth of the
 *              ~10 MB quota; several would exhaust it and take the profile down
 *              with them.
 *   audits   - fill audit records (spec section 24). Append-only and unbounded
 *              over time, so it needs a store that can be range-queried and
 *              pruned rather than one that is read whole on every access.
 *
 * MEMORY DISCIPLINE
 * chrome.storage.local deserialises an entire key on read. IndexedDB lets us
 * read exactly one record by key, or walk a cursor. That difference is the
 * whole reason resume binaries are here: on a 4 GB machine, "load every resume
 * to find one" is the kind of thing that gets an extension uninstalled. Every
 * read below is either by key or bounded by a `limit`.
 *
 * SERVICE WORKER LIFETIME
 * An MV3 service worker can be evicted between any two lines. The connection is
 * therefore opened lazily per operation batch and never cached across the
 * event-loop turn boundary in a way that assumes the worker is still alive.
 */
import { AppError } from '@shared/errors';
import { attemptAsync, err, ok, type Result } from '@shared/result';

const DB_NAME = 'applicant-agent';

/**
 * Database version. Bumping this triggers `onupgradeneeded`, which is where
 * object stores are created. Kept separate from the storage-layout version in
 * keys.ts because IndexedDB has its own upgrade mechanism with its own rules.
 */
const DB_VERSION = 1;

/** Object store names, as a const object so store access is typo-proof. */
export const STORES = {
  /** Original resume documents: { id, name, mimeType, bytes, addedAt }. */
  resumes: 'resumes',
  /** FillAuditRecord rows, keyed by id, indexed by timestamp for pruning. */
  audits: 'audits',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

/**
 * The audit store's time index.
 *
 * Named here rather than as a string literal at each call site because a typo
 * in an index name is not a compile error - it is a `NotFoundError` thrown at
 * runtime, inside a transaction, on a user's machine.
 */
export const AUDIT_TIMESTAMP_INDEX = 'byTimestamp';

/**
 * Open (and if necessary upgrade) the database.
 *
 * Wrapping the event-based IDB API in a promise once, here, means no other
 * module has to reason about `onsuccess`/`onerror`/`onblocked`.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new AppError('STORAGE_UNAVAILABLE', 'IndexedDB is not available in this context'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Creating stores is additive and guarded, so this same block correctly
      // handles a fresh install and an upgrade from any earlier version.
      if (!db.objectStoreNames.contains(STORES.resumes)) {
        db.createObjectStore(STORES.resumes, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.audits)) {
        const audits = db.createObjectStore(STORES.audits, { keyPath: 'id' });
        // Indexed by timestamp so the retention job can delete a date range
        // with a cursor instead of loading every record to filter in memory.
        audits.createIndex(AUDIT_TIMESTAMP_INDEX, 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new AppError('STORAGE_UNAVAILABLE', 'Failed to open IndexedDB', { cause: request.error }));

    // Fires when another tab holds an older version open. We surface it rather
    // than hanging forever on a promise that will never settle.
    request.onblocked = () =>
      reject(
        new AppError('STORAGE_UNAVAILABLE', 'IndexedDB upgrade blocked by another extension context'),
      );
  });
}

/** Promisify a single IDBRequest. */
function fromRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run a function inside one transaction and close the connection afterwards.
 *
 * Connection-per-operation rather than a long-lived singleton: in a service
 * worker that may be evicted at any moment, a cached connection is a handle to
 * a context that might no longer exist. Opening is on the order of a
 * millisecond, and none of our IndexedDB use is on a per-keystroke hot path.
 */
async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<Result<T, AppError>> {
  const opened = await attemptAsync(openDatabase);
  if (!opened.ok) {
    return err(
      opened.error instanceof AppError
        ? opened.error
        : new AppError('STORAGE_UNAVAILABLE', 'Could not open IndexedDB', { cause: opened.error }),
    );
  }

  const db = opened.value;
  try {
    const transaction = db.transaction(storeName, mode);
    const result = await work(transaction.objectStore(storeName));

    // Wait for the transaction itself, not just the request. A request can
    // succeed inside a transaction that later aborts (quota, conflict), and
    // reporting success in that case would be a silent data-loss bug.
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    return ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new AppError(/quota/i.test(message) ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED', message, {
        cause: error,
        context: { store: storeName, mode },
      }),
    );
  } finally {
    // Always release the connection, including on the error path, or a failed
    // operation leaves a handle that blocks the next version upgrade.
    db.close();
  }
}

/**
 * A minimal typed document store.
 *
 * Deliberately small: put, get, delete, and a bounded list. Anything richer
 * (compound indexes, cursors over ranges) should be added when a feature
 * genuinely needs it, so the abstraction stays something a reader can hold in
 * their head.
 */
export class IndexedDbCollection<T extends { id: string }> {
  constructor(private readonly storeName: StoreName) {}

  async put(record: T): Promise<Result<void, AppError>> {
    return withStore(this.storeName, 'readwrite', async (store) => {
      await fromRequest(store.put(record));
    });
  }

  async get(id: string): Promise<Result<T | undefined, AppError>> {
    return withStore(this.storeName, 'readonly', async (store) => {
      const value = await fromRequest<T | undefined>(store.get(id));
      return value;
    });
  }

  async delete(id: string): Promise<Result<void, AppError>> {
    return withStore(this.storeName, 'readwrite', async (store) => {
      await fromRequest(store.delete(id));
    });
  }

  /**
   * List records, newest first, capped at `limit`.
   *
   * The cap is mandatory rather than optional: an unbounded `getAll()` on the
   * audit store would materialise every fill the extension has ever performed
   * into memory. On a low-RAM device that is exactly the allocation we are
   * trying not to make (see shared/runtime-budget.ts).
   */
  async list(limit: number): Promise<Result<T[], AppError>> {
    return withStore(this.storeName, 'readonly', async (store) => {
      const out: T[] = [];
      await new Promise<void>((resolve, reject) => {
        // 'prev' walks the key range in descending order, so we get the newest
        // records without sorting the whole collection.
        const request = store.openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null || out.length >= limit) {
            resolve();
            return;
          }
          out.push(cursor.value as T);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    });
  }


  /**
   * Write several records in ONE transaction.
   *
   * Not a loop over `put`: each `put` above opens its own connection and its
   * own transaction, so writing a 30-field audit run that way would open thirty
   * connections and could half-succeed - leaving a run in history with a third
   * of its fields missing and no way to tell that is what happened.
   */
  async putMany(records: readonly T[]): Promise<Result<void, AppError>> {
    if (records.length === 0) return ok(undefined);
    return withStore(this.storeName, 'readwrite', async (store) => {
      // Requests are queued on the transaction and awaited together; the
      // transaction's own completion (checked by `withStore`) is what decides
      // whether the batch actually landed.
      await Promise.all(records.map((record) => fromRequest(store.put(record))));
    });
  }

  /** Delete several records in one transaction. Same reasoning as `putMany`. */
  async deleteMany(ids: readonly string[]): Promise<Result<void, AppError>> {
    if (ids.length === 0) return ok(undefined);
    return withStore(this.storeName, 'readwrite', async (store) => {
      await Promise.all(ids.map((id) => fromRequest(store.delete(id))));
    });
  }

  /** Remove everything in the store. The "delete my history" primitive. */
  async clear(): Promise<Result<void, AppError>> {
    return withStore(this.storeName, 'readwrite', async (store) => {
      await fromRequest(store.clear());
    });
  }

  /**
   * List by an INDEX rather than by primary key, newest first, capped.
   *
   * `list` above walks the primary key, which for a keyPath like
   * `${runId}:${localId}` is an arbitrary order that merely looks sorted. A
   * history view walking that would show last month's application above this
   * morning's. Anything time-ordered must come through here.
   */
  async listByIndex(indexName: string, limit: number): Promise<Result<T[], AppError>> {
    return withStore(this.storeName, 'readonly', async (store) => {
      const out: T[] = [];
      await new Promise<void>((resolve, reject) => {
        const request = store.index(indexName).openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null || out.length >= limit) {
            resolve();
            return;
          }
          out.push(cursor.value as T);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    });
  }

  /**
   * Walk an index newest-first, keeping only a projection of each record.
   *
   * Retention needs to see EVERY row to decide what to drop, and the whole
   * point of this store is that we never materialise every row. The projection
   * is the compromise: the cursor visits each record, but only three short
   * strings per row are retained, so the peak allocation is kilobytes for a
   * history that is megabytes on disk.
   */
  async projectByIndex<R>(
    indexName: string,
    project: (record: T) => R,
  ): Promise<Result<R[], AppError>> {
    return withStore(this.storeName, 'readonly', async (store) => {
      const out: R[] = [];
      await new Promise<void>((resolve, reject) => {
        const request = store.index(indexName).openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) {
            resolve();
            return;
          }
          out.push(project(cursor.value as T));
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      return out;
    });
  }

  /** Number of records. Cheap - IndexedDB maintains this, it does not scan. */
  async count(): Promise<Result<number, AppError>> {
    return withStore(this.storeName, 'readonly', async (store) => fromRequest(store.count()));
  }
}

/**
 * The application-history repository.
 * ---------------------------------------------------------------------------
 * Spec section 4: "Create repository interfaces around storage. Application
 * logic should not call raw browser storage everywhere."
 *
 * The service worker writes history; the options page reads it. Neither knows
 * that IndexedDB exists, which is what lets both be tested in a Node process
 * against `InMemoryAuditCollection` - a real implementation of the same
 * contract, not a mock with rehearsed answers.
 *
 * EVERY WRITE IS AN UPSERT
 * Row ids are `${runId}:${localId}`, so the user filling the safe fields and
 * then accepting two suggestions produces three reports and one set of rows.
 * An append-only log keyed by a random id would show the same field three
 * times with three different outcomes, and the newest would not necessarily
 * sort last.
 *
 * FAILURE IS NON-FATAL, ALWAYS
 * History is a convenience. Every method returns a Result and no caller is
 * expected to abort on failure: a fill that worked must never be reported as
 * failed because the history write did. That policy is stated here because the
 * callers are the ones who have to honour it.
 */
import { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import { AUDIT_TIMESTAMP_INDEX, IndexedDbCollection, STORES } from '@storage/indexed-db';
import { groupIntoRuns, type ApplicationRun, type FillAuditRecord } from './types';
import { DEFAULT_RETENTION, planPrune, type RetentionEntry, type RetentionPolicy } from './retention';

/**
 * The storage surface history needs.
 *
 * Deliberately five methods. Anything richer would be an invitation to put
 * query logic in the database layer, where it cannot be tested without one.
 */
export interface AuditCollection {
  putMany(records: readonly FillAuditRecord[]): Promise<Result<void, AppError>>;
  deleteMany(ids: readonly string[]): Promise<Result<void, AppError>>;
  clear(): Promise<Result<void, AppError>>;
  /** Newest first, capped. */
  listByIndex(indexName: string, limit: number): Promise<Result<FillAuditRecord[], AppError>>;
  projectByIndex<R>(
    indexName: string,
    project: (record: FillAuditRecord) => R,
  ): Promise<Result<R[], AppError>>;
}

/**
 * How many rows a history VIEW reads.
 *
 * The cap is not a page size to be raised later: it is the memory ceiling for
 * the options page on the low-memory machines this extension targets. 200 runs
 * of ~30 fields is well under it, and the retention policy keeps the store
 * itself near that size anyway.
 */
export const HISTORY_READ_LIMIT = 4000;

export class AuditRepository {
  constructor(
    private readonly collection: AuditCollection = new IndexedDbCollection<FillAuditRecord>(
      STORES.audits,
    ),
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION,
  ) {}

  /** Write (or overwrite) the rows of one run. */
  async record(records: readonly FillAuditRecord[]): Promise<Result<void, AppError>> {
    return this.collection.putMany(records);
  }

  /**
   * Enforce the retention policy.
   *
   * Called after a write rather than on a `chrome.alarms` schedule: an alarm
   * wakes a service worker that had no other reason to run, and history only
   * ever grows at the moment it is written. Pruning where the growth happens
   * means the store is never more than one run over its limit.
   */
  async prune(now: Date = new Date()): Promise<Result<number, AppError>> {
    const entries = await this.collection.projectByIndex<RetentionEntry>(
      AUDIT_TIMESTAMP_INDEX,
      (record) => ({ id: record.id, runId: record.runId, timestamp: record.timestamp }),
    );
    if (!entries.ok) return entries;

    const doomed = planPrune(entries.value, this.policy, now);
    if (doomed.length === 0) return ok(0);

    const deleted = await this.collection.deleteMany(doomed);
    return deleted.ok ? ok(doomed.length) : deleted;
  }

  /** The history view: runs, newest first. */
  async recentRuns(limit = HISTORY_READ_LIMIT): Promise<Result<ApplicationRun[], AppError>> {
    const rows = await this.collection.listByIndex(AUDIT_TIMESTAMP_INDEX, limit);
    return rows.ok ? ok(groupIntoRuns(rows.value)) : rows;
  }

  /**
   * Mark every recent row for a field as user-corrected.
   *
   * By fingerprint rather than by row id because a correction arrives from the
   * side panel, which knows the field but not which history row it produced -
   * and the same question genuinely can appear in more than one recent run
   * (the user reloaded the form, or applied to two roles at the same company).
   * Marking all of them is right: the correction says that mapping was wrong,
   * and it was wrong every time it was used.
   *
   * Bounded to the rows a history view would show. A correction should not walk
   * the whole store.
   */
  async markCorrected(
    fieldFingerprint: string,
    limit = 500,
  ): Promise<Result<number, AppError>> {
    const rows = await this.collection.listByIndex(AUDIT_TIMESTAMP_INDEX, limit);
    if (!rows.ok) return rows;

    const updated = rows.value
      .filter((row) => row.fieldFingerprint === fieldFingerprint && !row.userCorrected)
      .map((row) => ({ ...row, userCorrected: true }));

    if (updated.length === 0) return ok(0);

    const written = await this.collection.putMany(updated);
    return written.ok ? ok(updated.length) : written;
  }

  /** "Delete my history." Unconditional and immediate. */
  async clear(): Promise<Result<void, AppError>> {
    return this.collection.clear();
  }
}

/**
 * In-memory collection, for tests and for any context without IndexedDB.
 *
 * Real code obeying the real contract: it upserts by id like a keyPath store,
 * it sorts by the projected index rather than by insertion, and it clones on
 * the way out. A double that handed back live references would let a test pass
 * against mutations that IndexedDB's structured clone would have discarded.
 */
export class InMemoryAuditCollection implements AuditCollection {
  private readonly rows = new Map<string, FillAuditRecord>();

  async putMany(records: readonly FillAuditRecord[]): Promise<Result<void, AppError>> {
    for (const record of records) this.rows.set(record.id, { ...record });
    return ok(undefined);
  }

  async deleteMany(ids: readonly string[]): Promise<Result<void, AppError>> {
    for (const id of ids) this.rows.delete(id);
    return ok(undefined);
  }

  async clear(): Promise<Result<void, AppError>> {
    this.rows.clear();
    return ok(undefined);
  }

  async listByIndex(_indexName: string, limit: number): Promise<Result<FillAuditRecord[], AppError>> {
    return ok(this.sorted().slice(0, limit));
  }

  async projectByIndex<R>(
    _indexName: string,
    project: (record: FillAuditRecord) => R,
  ): Promise<Result<R[], AppError>> {
    return ok(this.sorted().map(project));
  }

  /**
   * Newest first, ties broken by id.
   *
   * The tie-break matters and is not cosmetic: every row in a run shares one
   * timestamp, so without it the order within a run would depend on Map
   * insertion order and the retention tests would be asserting against an
   * accident rather than a contract.
   */
  private sorted(): FillAuditRecord[] {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  }
}

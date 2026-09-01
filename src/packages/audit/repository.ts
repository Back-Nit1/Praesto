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
import {
  deriveCorrectionOutcome,
  groupIntoRuns,
  type ApplicationRun,
  type FieldOutcome,
  type FillAuditRecord,
} from './types';
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

/**
 * How far back a correction, or a write preserving one, looks.
 *
 * The same window for both, deliberately: a verdict that `recordOutcome` was
 * willing to write is a verdict `record` has to be willing to preserve, and two
 * different numbers here would mean an old correction could be silently erased
 * by the next fill on the same page.
 */
export const CORRECTION_SCAN_LIMIT = 500;

export class AuditRepository {
  constructor(
    private readonly collection: AuditCollection = new IndexedDbCollection<FillAuditRecord>(
      STORES.audits,
    ),
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION,
  ) {}

  /**
   * Write (or overwrite) the rows of one run, keeping any verdict they carry.
   *
   * Every write here is an UPSERT by `${runId}:${localId}`, which is what stops
   * three fill reports producing three histories of the same field. But a fill
   * report is built from the SCAN, so it re-writes every scanned row - including
   * ones the user has since corrected, and including ones a later report has
   * nothing new to say about. Written blind, "the user filled two more fields"
   * would erase the correction they made in between.
   *
   * So an incoming `unreviewed` never overwrites a verdict already on disk.
   * `unreviewed` is the absence of evidence; it cannot displace evidence.
   * Anything else - the user accepted this suggestion - is newer and wins.
   */
  async record(records: readonly FillAuditRecord[]): Promise<Result<void, AppError>> {
    const existing = await this.collection.listByIndex(AUDIT_TIMESTAMP_INDEX, CORRECTION_SCAN_LIMIT);
    if (!existing.ok) return existing;

    const priorOutcomes = new Map(
      existing.value.map(normaliseOutcome).map((row) => [row.id, row]),
    );

    const merged = records.map((record) => {
      if (record.outcome !== 'unreviewed') return record;
      const prior = priorOutcomes.get(record.id);
      if (prior === undefined || prior.outcome === 'unreviewed') return record;
      return {
        ...record,
        outcome: prior.outcome,
        ...(prior.supersededByLaterCorrection === true
          ? { supersededByLaterCorrection: true }
          : {}),
      };
    });

    return this.collection.putMany(merged);
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
    return rows.ok ? ok(groupIntoRuns(rows.value.map(normaliseOutcome))) : rows;
  }

  /**
   * Record what a correction said about every recent row for a field.
   *
   * By fingerprint rather than by row id because a correction arrives from the
   * side panel, which knows the field but not which history row it produced -
   * and the same question genuinely can appear in more than one recent run
   * (the user reloaded the form, or applied to two roles at the same company).
   * Marking all of them is right FOR HISTORY: the correction says that mapping
   * was wrong, and it was wrong every time it was used.
   *
   * IT IS NOT RIGHT FOR METRICS, which is why supersession exists.
   * One correction is one piece of evidence. Counted once per row, a user who
   * applies to four roles at the same company would push the incorrect-fill
   * rate up four times for one mistake - so the rate would measure how often
   * they reuse a careers site, not how often we are wrong. The newest matching
   * row carries the verdict; the older ones keep the outcome for DISPLAY and
   * are flagged `supersededByLaterCorrection`, which metrics.ts drops from both
   * the numerator and the denominator.
   *
   * The outcome itself is DERIVED per row rather than passed in: only the row
   * knows what the policy decided about it, and a correction on a field we
   * refused means something opposite to a correction on a field we filled.
   *
   * Bounded to the rows a history view would show. A correction should not walk
   * the whole store.
   */
  async recordOutcome(
    fieldFingerprint: string,
    profilePath: string | null,
    limit = CORRECTION_SCAN_LIMIT,
  ): Promise<Result<number, AppError>> {
    const rows = await this.collection.listByIndex(AUDIT_TIMESTAMP_INDEX, limit);
    if (!rows.ok) return rows;

    // `listByIndex` is newest first, so the first match is the run the user was
    // actually looking at when they corrected it.
    const matching = rows.value
      .map(normaliseOutcome)
      .filter((row) => row.fieldFingerprint === fieldFingerprint);

    const updated = matching.map((row, index) => ({
      ...row,
      outcome: deriveCorrectionOutcome(row.decidedAction, profilePath),
      ...(index === 0 ? {} : { supersededByLaterCorrection: true }),
    }));

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
 * Give a row written before the outcome split something an outcome-shaped
 * reader can use.
 *
 * These rows live in IndexedDB, which `runMigrations` does not walk, so they
 * are normalised on the way out instead of being rewritten in place.
 *
 * A pre-split `userCorrected: true` becomes `corrected_legacy` and NOT one of
 * the real outcomes. The boolean genuinely did not record which of them
 * happened, and picking the most likely one would fabricate exactly the data
 * this split exists to make trustworthy: `corrected_legacy` is counted in no
 * numerator and excluded from every denominator. `false` becomes `unreviewed`,
 * which is the same claim the boolean was making - nobody said anything.
 */
function normaliseOutcome(row: FillAuditRecord): FillAuditRecord {
  if (row.outcome !== undefined) return row;

  const legacy = (row as { userCorrected?: boolean }).userCorrected === true;
  const outcome: FieldOutcome = legacy ? 'corrected_legacy' : 'unreviewed';
  const { userCorrected: _dropped, ...rest } = row as FillAuditRecord & {
    userCorrected?: boolean;
  };
  return { ...rest, outcome };
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

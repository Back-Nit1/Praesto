/**
 * What recent scans cost.
 * ---------------------------------------------------------------------------
 * The panel is deliberately silent about the semantic fallback unless it
 * FAILED - a panel that narrates its own internals on every scan is one the
 * user stops reading. The cost of that silence is that "how much of today's
 * budget did this form use" could not be answered anywhere in the UI
 * (limitation 14). This is where it gets answered, on the settings screen,
 * away from an application in progress.
 *
 * WHAT IS IN A ROW: A TIME AND A COUNT.
 * No hostname, no question, no field. Application history already records which
 * forms were filled and is documented and prunable; a second, undocumented copy
 * of that disclosure living in a settings widget is exactly the kind of quiet
 * accumulation this product does not do.
 */
import { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import type { KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';

/** One scan that spent model calls. Scans that spent none are not recorded. */
export interface ScanCost {
  /** Epoch ms. */
  at: number;
  modelCalls: number;
}

/**
 * How many scans are kept.
 *
 * Small on purpose. The question is "what did that form cost", asked minutes
 * later; a long log would be a usage history nobody asked for.
 */
export const MAX_LOGGED_SCANS = 20;

export class ScanCostLog {
  constructor(private readonly store: KeyValueStore) {}

  /**
   * Record a scan's cost. A scan that made no model calls is not recorded.
   *
   * Never fails a scan: the caller logs and continues. A cost readout is a
   * convenience, and a fill that worked must not be reported as failed because
   * a usage row could not be written.
   */
  async record(cost: ScanCost): Promise<Result<void, AppError>> {
    if (cost.modelCalls <= 0) return ok(undefined);

    const existing = await this.recent();
    const next = [cost, ...existing].slice(0, MAX_LOGGED_SCANS);
    return this.store.set(STORAGE_KEYS.modelUsageLog, next);
  }

  /** Newest first. A read failure reads as an empty log, never as an error. */
  async recent(): Promise<ScanCost[]> {
    const stored = await this.store.get<unknown>(STORAGE_KEYS.modelUsageLog);
    if (!stored.ok || !Array.isArray(stored.value)) return [];

    // Validated field by field rather than trusted: this is parsed JSON from
    // disk, and a hand-edited or half-migrated value must produce an empty log
    // rather than NaN arithmetic in a readout.
    return stored.value
      .filter(
        (row): row is ScanCost =>
          typeof row === 'object' &&
          row !== null &&
          Number.isFinite((row as ScanCost).at) &&
          Number.isFinite((row as ScanCost).modelCalls),
      )
      .slice(0, MAX_LOGGED_SCANS);
  }

  async clear(): Promise<Result<void, AppError>> {
    return this.store.remove(STORAGE_KEYS.modelUsageLog);
  }
}

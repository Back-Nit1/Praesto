/**
 * The pending-run stash: how a fill result finds the scan that produced it.
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * Spec section 24 wants an audit record carrying the detected label, the
 * mapping confidence and WHICH STAGE of the cascade produced the mapping. Only
 * the service worker ever knows those - they exist for a few milliseconds
 * inside `resolveFields` and are deliberately not sent to the page, which has
 * no business knowing how we decided.
 *
 * But the fill result arrives later, in a separate message, and by then the
 * worker may well be a DIFFERENT INSTANCE: MV3 evicts it after ~30 seconds
 * idle, and a user reading a job description before clicking Fill will cross
 * that boundary almost every time. A module-level variable holding the scan
 * would be empty exactly when it mattered, and the failure would look like
 * "history is missing labels sometimes".
 *
 * So the scan's audit metadata is written to `chrome.storage.session` at
 * resolve time and read back at report time. Session storage is the right area
 * for it, and not merely a convenient one:
 *
 *   - it is cleared when the browser closes, which is what this data deserves;
 *   - it is never written to disk by Chrome, so an in-flight scan of a page the
 *     user then abandons leaves nothing behind;
 *   - it survives service-worker eviction, which is the whole requirement.
 *
 * WHAT IS IN HERE IS PAGE DATA, NOT APPLICANT DATA
 * Labels and fingerprints come from the form. The applicant's answers are not
 * stashed - they are resolved, sent to the page, and forgotten.
 */
import type { ATSKind } from '@ats/types';
import type { MappingSource } from '@form-engine/mapper/types';
import { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import { ChromeLocalStore, InMemoryStore, type KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';

/** What the worker knew about one field at the moment it decided. */
export interface PendingFieldAudit {
  localId: string;
  fieldFingerprint: string;
  detectedLabel?: string;
  mappedProfilePath?: string;
  mappingConfidence: number;
  mappingSource: MappingSource;
  decidedAction: 'fill' | 'suggest' | 'skip' | 'attach_resume';
}

/** One scan, awaiting the fill results that will complete its history rows. */
export interface PendingRun {
  runId: string;
  /** Epoch ms. Only used for expiry and eviction ordering. */
  createdAt: number;
  pageUrl: string;
  hostname: string;
  ats: ATSKind;
  fields: PendingFieldAudit[];
}

/**
 * How long a stashed scan stays useful.
 *
 * Thirty minutes is far longer than any real scan-to-fill gap and short enough
 * that a tab left open overnight does not keep a stale field list around. An
 * expired stash is not an error: the fill still happens, and history simply
 * records the outcome without the mapping metadata.
 */
export const PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * How many scans may be pending at once.
 *
 * A user applying in several tabs is ordinary; a user with nine live scans is
 * not. The bound exists because this is one storage key holding a map, and an
 * unbounded map in session storage is a slow leak that nothing would ever
 * notice - each entry is small, and there is no natural moment of deletion for
 * a tab the user simply closed.
 */
export const MAX_PENDING_RUNS = 8;

/**
 * Identify a scan by TAB AND ADDRESS.
 *
 * Neither alone is enough, and the gap is not theoretical - it is the same one
 * the side panel documents. Every posting on a careers site shares a hostname,
 * so a URL-less key would join this fill's results against the previous
 * posting's field list. And a tab id alone would do the same thing after the
 * user navigated within the tab.
 *
 * `tabId` is undefined when a message comes from an extension page rather than
 * a content script; those share the `0` slot, which is correct because a fill
 * is always reported by the page it happened in.
 */
export function pendingKey(tabId: number | undefined, canonicalPageUrl: string): string {
  return `${tabId ?? 0}|${canonicalPageUrl}`;
}

type PendingMap = Record<string, PendingRun>;

export class PendingRunStore {
  /**
   * @param store `chrome.storage.session` in production. Injected so this is
   *              testable against `InMemoryStore` with no chrome global, and so
   *              a context without a session area degrades rather than throws.
   * @param clock injected for the same reason the retention plan takes a date:
   *              expiry that can only be tested by waiting is expiry that does
   *              not get tested.
   */
  constructor(
    private readonly store: KeyValueStore = sessionStore(),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Record a scan, replacing any previous scan of the same tab and address.
   *
   * Replacement rather than merge: a rescan means the page changed, so the old
   * field list is not merely stale, it is wrong - its localIds may now point at
   * different controls.
   */
  async stash(key: string, run: PendingRun): Promise<Result<void, AppError>> {
    const current = await this.read();
    if (!current.ok) return current;

    const next: PendingMap = { ...current.value, [key]: run };
    return this.store.set(STORAGE_KEYS.pendingRuns, this.evict(next));
  }

  /**
   * Read a stashed scan back.
   *
   * Does NOT delete it. A run legitimately reports results more than once - the
   * user fills the safe fields, reads what happened, then accepts two
   * suggestions individually - and consuming the stash on first read would
   * leave the later rows without their mapping metadata. It is replaced by the
   * next scan of the same page and expires on its own.
   */
  async get(key: string): Promise<Result<PendingRun | undefined, AppError>> {
    const current = await this.read();
    if (!current.ok) return current;

    const run = current.value[key];
    if (run === undefined) return ok(undefined);
    if (this.clock() - run.createdAt > PENDING_TTL_MS) return ok(undefined);
    return ok(run);
  }

  /** Forget one scan. Used when a tab closes or a scan is abandoned. */
  async drop(key: string): Promise<Result<void, AppError>> {
    const current = await this.read();
    if (!current.ok) return current;

    const next = { ...current.value };
    delete next[key];
    return this.store.set(STORAGE_KEYS.pendingRuns, next);
  }

  private async read(): Promise<Result<PendingMap, AppError>> {
    const raw = await this.store.get<PendingMap>(STORAGE_KEYS.pendingRuns);
    if (!raw.ok) return raw;
    // A missing key and a corrupted one are both "nothing pending". This data
    // is a convenience, and refusing to fill because a session cache did not
    // parse would be a spectacular over-reaction.
    return ok(typeof raw.value === 'object' && raw.value !== null ? raw.value : {});
  }

  /** Drop expired entries, then the oldest, until the map is within bounds. */
  private evict(map: PendingMap): PendingMap {
    const now = this.clock();
    const live = Object.entries(map).filter(([, run]) => now - run.createdAt <= PENDING_TTL_MS);

    // Newest first, so `slice` keeps the most recent scans.
    live.sort(([, a], [, b]) => b.createdAt - a.createdAt);

    return Object.fromEntries(live.slice(0, MAX_PENDING_RUNS));
  }
}

/**
 * The session storage area, or `local` where there is not one.
 *
 * `chrome.storage.session` is MV3-only and absent in a test process. Falling
 * back keeps construction total - a missing area must not throw at module load
 * inside a service worker, where the throw would take the message listener down
 * with it and every subsequent message would fail silently.
 */
function sessionStore(): KeyValueStore {
  const area = globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
  // An in-memory store rather than a throw. This runs at module load inside a
  // service worker: a throw here would take the message listener down with it,
  // and every subsequent message would fail for a reason no log would explain.
  return area === undefined ? new InMemoryStore() : new ChromeLocalStore(area);
}

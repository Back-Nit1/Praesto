/**
 * The side panel's memory of its own last scan.
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * The panel's scan result lived in React state and nowhere else, so closing the
 * panel destroyed it. That is not a cosmetic loss: what it destroyed was the
 * record of WHICH FIELDS FAILED. A user who filled eighteen questions, closed
 * the panel to read the job description, and came back had no way to find the
 * two the extension could not drive - short of re-reading the whole form, which
 * is the exact work this product exists to remove.
 *
 * WHERE IT GOES
 * `chrome.storage.session`: it survives the panel closing and the service
 * worker being evicted, it is cleared when the browser closes, and Chrome never
 * writes it to disk. A scan holds the questions an employer asked and where our
 * answers went - it does not belong in `storage.local` alongside the profile,
 * outliving the session that produced it.
 *
 * WHAT MAKES A SNAPSHOT VALID
 * The tab AND the address, compared with the same `sameTarget` the live panel
 * uses. A field list is a set of `localId`s that mean something only to the
 * document that produced them; restoring one over a different page would invite
 * the user to click Fill on a form it was never about. The TTL below is a
 * backstop, not the real guard - the address check is.
 *
 * NO APPLICANT VALUES, WITH ONE DELIBERATE EXCEPTION
 * The stored actions carry the values the worker resolved for the page, because
 * that is what the panel needs to fill a suggestion after a restore without
 * rescanning. They are already in the panel's memory and already in the page;
 * session storage does not widen who can read them, and it does not survive the
 * browser closing. That is a real trade and it is made knowingly - see
 * `Security.md`. The durable history in IndexedDB, by contrast, never holds a
 * value at all.
 */
import type { ResolvedFieldAction } from '@shared/messages';
import type { FieldFillReport } from '@shared/page-protocol';
import { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import { ChromeLocalStore, InMemoryStore, type KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import { sameTarget, type ScanTarget } from './scan-target';

/** Exactly the part of the panel's state that is worth surviving a close. */
export interface PanelSnapshot {
  target: ScanTarget;
  /** Epoch ms. */
  savedAt: number;
  actions: ResolvedFieldAction[];
  fieldsDetected: number;
  outcomes: Record<string, FieldFillReport>;
  frameByLocalId: Record<string, number>;
}

/**
 * How long a snapshot may be restored.
 *
 * Six hours covers an application interrupted by a meeting or a lunch. It is a
 * backstop: session storage is already cleared when the browser closes, and the
 * address check already rejects a snapshot for a page the tab has left. What
 * the TTL catches is the narrow case of a tab sitting on one address for most
 * of a working day, where a morning scan is no longer a fair description of a
 * form the user has since edited by hand.
 */
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export class PanelSnapshotStore {
  constructor(
    private readonly store: KeyValueStore = sessionStore(),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** One key per tab, so two applications open side by side do not collide. */
  private keyFor(tabId: number): string {
    return `${STORAGE_KEYS.panelSnapshotPrefix}:${tabId}`;
  }

  async save(snapshot: PanelSnapshot): Promise<Result<void, AppError>> {
    return this.store.set(this.keyFor(snapshot.target.tabId), snapshot);
  }

  /**
   * Restore, but only for the page actually in front of the user.
   *
   * Takes the CURRENT target and compares it, rather than trusting the stored
   * one: the snapshot's own record of which page it describes is exactly what
   * we are checking, so it cannot also be the authority on it.
   */
  async load(current: ScanTarget): Promise<Result<PanelSnapshot | undefined, AppError>> {
    const raw = await this.store.get<PanelSnapshot>(this.keyFor(current.tabId));
    if (!raw.ok) return raw;

    const snapshot = raw.value;
    if (snapshot === undefined) return ok(undefined);
    if (!sameTarget(snapshot.target, current)) return ok(undefined);
    if (this.clock() - snapshot.savedAt > SNAPSHOT_TTL_MS) return ok(undefined);

    // A snapshot written by an older version may be missing fields this one
    // needs. Treated as absent rather than restored half-formed: a panel that
    // renders rows with no outcomes would claim nothing was filled.
    if (!Array.isArray(snapshot.actions) || typeof snapshot.outcomes !== 'object') {
      return ok(undefined);
    }

    return ok(snapshot);
  }

  /** Forget a tab's scan. Called when the page it described is gone. */
  async clear(tabId: number): Promise<Result<void, AppError>> {
    return this.store.remove(this.keyFor(tabId));
  }
}

/** See the identical note in audit/pending.ts: construction must never throw. */
function sessionStore(): KeyValueStore {
  const area = globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
  // An in-memory store rather than a throw. This runs at module load inside a
  // service worker: a throw here would take the message listener down with it,
  // and every subsequent message would fail for a reason no log would explain.
  return area === undefined ? new InMemoryStore() : new ChromeLocalStore(area);
}

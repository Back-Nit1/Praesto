/**
 * Handoff from the toolbar action to the side panel.
 * ---------------------------------------------------------------------------
 * Chrome grants `activeTab` when the toolbar action is invoked, but not when a
 * button inside an already-open side panel is clicked. The action and panel are
 * separate extension contexts, and the panel may not exist yet when the action
 * fires. A tiny record in `chrome.storage.session` bridges that race:
 *
 *   toolbar click -> queue tab id -> open panel -> panel consumes -> scan
 *
 * The record contains no page URL or applicant data, is removed on read, and
 * expires quickly if the panel never opens.
 */
import { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import { ChromeLocalStore, InMemoryStore, type KeyValueStore } from './key-value-store';
import { STORAGE_KEYS } from './keys';

export const TOOLBAR_SCAN_SIGNAL = 'TOOLBAR_SCAN_REQUESTED';
export const TOOLBAR_SCAN_TTL_MS = 30_000;

export interface ToolbarScanSignal {
  type: typeof TOOLBAR_SCAN_SIGNAL;
  tabId: number;
}

interface ToolbarScanRequest {
  tabId: number;
  requestedAt: number;
}

export function isToolbarScanSignal(value: unknown): value is ToolbarScanSignal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolbarScanSignal>;
  return candidate.type === TOOLBAR_SCAN_SIGNAL && Number.isInteger(candidate.tabId);
}

export class ToolbarScanStore {
  constructor(
    private readonly store: KeyValueStore = sessionStore(),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private keyFor(tabId: number): string {
    return `${STORAGE_KEYS.toolbarScanPrefix}:${tabId}`;
  }

  /** Remember that a toolbar invocation asked the panel to scan this tab. */
  async request(tabId: number): Promise<Result<void, AppError>> {
    return this.store.set(this.keyFor(tabId), { tabId, requestedAt: this.clock() });
  }

  /**
   * Consume a pending request exactly once from the persistent point of view.
   *
   * The panel also guards concurrent calls in memory, because a just-opened
   * panel can observe both its mount-time read and the live runtime signal.
   */
  async take(tabId: number): Promise<Result<boolean, AppError>> {
    const key = this.keyFor(tabId);
    const loaded = await this.store.get<unknown>(key);
    if (!loaded.ok) return loaded;

    const removed = await this.store.remove(key);
    if (!removed.ok) return removed;

    const value = loaded.value;
    if (typeof value !== 'object' || value === null) return ok(false);

    const request = value as Partial<ToolbarScanRequest>;
    if (request.tabId !== tabId || typeof request.requestedAt !== 'number') return ok(false);

    const age = this.clock() - request.requestedAt;
    return ok(age >= 0 && age <= TOOLBAR_SCAN_TTL_MS);
  }
}

/** Construct safely in extension contexts and browser-free tests alike. */
function sessionStore(): KeyValueStore {
  const area = globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
  return area === undefined ? new InMemoryStore() : new ChromeLocalStore(area);
}

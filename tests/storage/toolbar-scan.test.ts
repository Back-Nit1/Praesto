/**
 * The toolbar-click handoff.
 *
 * A click on the extension icon is two things at once: the browser gesture that
 * grants `activeTab`, and the user asking for a scan. The second has to survive
 * the moment between the worker seeing the click and the side panel finishing
 * opening - so it is written down, with a TTL.
 *
 * What these assertions protect is that it is consumed EXACTLY once. Handed out
 * twice, a panel that reopens would scan a page nobody asked it to; handed out
 * never, the click does nothing and the user clicks Scan by hand, which is the
 * loop this handoff removed.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@storage/key-value-store';
import {
  isToolbarScanSignal,
  TOOLBAR_SCAN_SIGNAL,
  TOOLBAR_SCAN_TTL_MS,
  ToolbarScanStore,
} from '@storage/toolbar-scan';

describe('ToolbarScanStore', () => {
  it('hands one toolbar click to the panel exactly once', async () => {
    const store = new ToolbarScanStore(new InMemoryStore(), () => 1_000);

    expect((await store.request(7)).ok).toBe(true);
    expect(await store.take(7)).toEqual({ ok: true, value: true });
    expect(await store.take(7)).toEqual({ ok: true, value: false });
  });

  it('does not consume another tab request or act on a stale click', async () => {
    let now = 1_000;
    const store = new ToolbarScanStore(new InMemoryStore(), () => now);

    await store.request(9);
    expect(await store.take(7)).toEqual({ ok: true, value: false });
    expect(await store.take(9)).toEqual({ ok: true, value: true });

    await store.request(7);
    now += TOOLBAR_SCAN_TTL_MS + 1;
    expect(await store.take(7)).toEqual({ ok: true, value: false });
  });
});

describe('toolbar scan signal', () => {
  it('accepts only a well-formed tab signal', () => {
    expect(isToolbarScanSignal({ type: TOOLBAR_SCAN_SIGNAL, tabId: 7 })).toBe(true);
    expect(isToolbarScanSignal({ type: TOOLBAR_SCAN_SIGNAL, tabId: 7.5 })).toBe(false);
    expect(isToolbarScanSignal({ type: 'PAGE_FIELDS_CHANGED', tabId: 7 })).toBe(false);
  });
});

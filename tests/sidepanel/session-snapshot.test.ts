/**
 * Panel recovery: what may be restored, and what must not be.
 */
import { describe, expect, it } from 'vitest';
import { PanelSnapshotStore, SNAPSHOT_TTL_MS, type PanelSnapshot } from '@/entrypoints/sidepanel/session-snapshot';
import { InMemoryStore } from '@storage/key-value-store';

const TARGET = { tabId: 7, url: 'https://boards.greenhouse.io/acme/jobs/1', host: 'boards.greenhouse.io' };

function snapshot(overrides: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    target: TARGET,
    savedAt: 1_000,
    fieldsDetected: 3,
    actions: [
      {
        localId: 'f1',
        action: 'fill',
        profilePath: 'identity.email',
        mappingConfidence: 0.97,
        knowledgeState: 'known',
      },
    ],
    outcomes: { f1: { localId: 'f1', attempted: true, verified: true } },
    frameByLocalId: { f1: 0 },
    ...overrides,
  };
}

function storeAt(times: { now: number }): PanelSnapshotStore {
  return new PanelSnapshotStore(new InMemoryStore(), () => times.now);
}

describe('PanelSnapshotStore', () => {
  it('restores the scan for the same tab and address', async () => {
    const times = { now: 1_000 };
    const store = storeAt(times);
    await store.save(snapshot());

    const restored = await store.load(TARGET);

    expect(restored.ok && restored.value?.outcomes.f1?.verified).toBe(true);
  });

  it('refuses a snapshot from a different address in the same tab', async () => {
    // The user navigated from one posting to the next on the same careers site.
    const times = { now: 1_000 };
    const store = storeAt(times);
    await store.save(snapshot());

    const restored = await store.load({ ...TARGET, url: 'https://boards.greenhouse.io/acme/jobs/2' });

    expect(restored.ok && restored.value).toBeUndefined();
  });

  it('does not leak one tab\'s scan into another', async () => {
    const times = { now: 1_000 };
    const store = storeAt(times);
    await store.save(snapshot());

    const restored = await store.load({ ...TARGET, tabId: 8 });

    expect(restored.ok && restored.value).toBeUndefined();
  });

  it('refuses a snapshot past its lifetime', async () => {
    const times = { now: 1_000 };
    const store = storeAt(times);
    await store.save(snapshot({ savedAt: 1_000 }));

    times.now = 1_000 + SNAPSHOT_TTL_MS + 1;

    const restored = await store.load(TARGET);
    expect(restored.ok && restored.value).toBeUndefined();
  });

  it('treats a malformed snapshot as absent rather than restoring it half-formed', async () => {
    const backing = new InMemoryStore();
    await backing.set('aa:session:panel:7', { target: TARGET, savedAt: 1_000, actions: 'broken' });
    const store = new PanelSnapshotStore(backing, () => 1_000);

    const restored = await store.load(TARGET);

    expect(restored.ok && restored.value).toBeUndefined();
  });

  it('clears a tab on request', async () => {
    const times = { now: 1_000 };
    const store = storeAt(times);
    await store.save(snapshot());

    await store.clear(7);

    const restored = await store.load(TARGET);
    expect(restored.ok && restored.value).toBeUndefined();
  });
});

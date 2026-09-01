/**
 * The scan-cost log.
 *
 * What it must never become is a usage history: a time and a count, nothing
 * that says which employer or which question.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LOGGED_SCANS, ScanCostLog } from '@backend/usage-log';
import { InMemoryStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';

describe('ScanCostLog', () => {
  it('does not record a scan that cost nothing', async () => {
    const log = new ScanCostLog(new InMemoryStore());
    await log.record({ at: 1, modelCalls: 0 });

    expect(await log.recent()).toHaveLength(0);
  });

  it('keeps the newest scans first and forgets the rest', async () => {
    const log = new ScanCostLog(new InMemoryStore());
    for (let index = 0; index < MAX_LOGGED_SCANS + 5; index++) {
      await log.record({ at: index, modelCalls: 1 });
    }

    const recent = await log.recent();
    expect(recent).toHaveLength(MAX_LOGGED_SCANS);
    expect(recent[0]?.at).toBe(MAX_LOGGED_SCANS + 4);
  });

  it('holds nothing but a time and a count', async () => {
    const log = new ScanCostLog(new InMemoryStore());
    await log.record({ at: 1, modelCalls: 2 });

    // Asserted from outside the type, like the audit redaction test: a future
    // "just add the hostname" would fail here rather than quietly duplicating
    // a disclosure that history already documents and prunes.
    expect(Object.keys((await log.recent())[0] ?? {}).sort()).toEqual(['at', 'modelCalls']);
  });

  it('reads a corrupt stored value as an empty log rather than throwing', async () => {
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.modelUsageLog, { not: 'an array' });

    expect(await new ScanCostLog(store).recent()).toHaveLength(0);
  });

  it('drops a row that is not a time and a count', async () => {
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.modelUsageLog, [{ at: 'yesterday' }, { at: 5, modelCalls: 1 }]);

    expect(await new ScanCostLog(store).recent()).toEqual([{ at: 5, modelCalls: 1 }]);
  });
});

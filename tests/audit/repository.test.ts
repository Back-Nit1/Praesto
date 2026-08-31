/**
 * The history repository, against a real in-memory collection.
 */
import { describe, expect, it } from 'vitest';
import { AuditRepository, InMemoryAuditCollection } from '@audit/repository';
import type { FillAuditRecord } from '@audit/types';

function row(overrides: Partial<FillAuditRecord> & { id: string; runId: string }): FillAuditRecord {
  return {
    timestamp: '2026-08-31T10:00:00.000Z',
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fieldFingerprint: 'fp-a',
    mappingConfidence: 0.9,
    mappingSource: 'alias',
    decidedAction: 'fill',
    fillAttempted: true,
    fillVerified: true,
    userCorrected: false,
    ...overrides,
  };
}

describe('AuditRepository', () => {
  it('stores rows and reads them back grouped into runs', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());
    await repo.record([row({ id: 'r1:a', runId: 'r1' }), row({ id: 'r1:b', runId: 'r1' })]);

    const runs = await repo.recentRuns();

    expect(runs.ok).toBe(true);
    expect(runs.ok && runs.value).toHaveLength(1);
    expect(runs.ok && runs.value[0]?.counts.filled).toBe(2);
  });

  it('upserts by id, so a second report of the same run does not duplicate a field', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());

    // The panel fills the safe fields...
    await repo.record([row({ id: 'r1:a', runId: 'r1', fillAttempted: false, fillVerified: false })]);
    // ...then the user accepts the suggestion for that same field.
    await repo.record([row({ id: 'r1:a', runId: 'r1', fillAttempted: true, fillVerified: true })]);

    const runs = await repo.recentRuns();

    expect(runs.ok && runs.value[0]?.fields).toHaveLength(1);
    expect(runs.ok && runs.value[0]?.counts).toMatchObject({ fields: 1, filled: 1, skipped: 0 });
  });

  it('marks every recent row for a corrected field, and reports how many', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());
    await repo.record([
      row({ id: 'r1:a', runId: 'r1', fieldFingerprint: 'fp-target' }),
      row({ id: 'r2:a', runId: 'r2', fieldFingerprint: 'fp-target' }),
      row({ id: 'r2:b', runId: 'r2', fieldFingerprint: 'fp-other' }),
    ]);

    const marked = await repo.markCorrected('fp-target');

    expect(marked.ok && marked.value).toBe(2);
    const runs = await repo.recentRuns();
    const corrected = runs.ok
      ? runs.value.flatMap((run) => run.fields).filter((field) => field.userCorrected)
      : [];
    expect(corrected.map((field) => field.id).sort()).toEqual(['r1:a', 'r2:a']);
  });

  it('does not rewrite rows that are already marked corrected', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());
    await repo.record([row({ id: 'r1:a', runId: 'r1', userCorrected: true })]);

    const marked = await repo.markCorrected('fp-a');

    expect(marked.ok && marked.value).toBe(0);
  });

  it('prunes to the retention policy and reports the number dropped', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection(), {
      maxRuns: 1,
      maxRecords: 100,
      maxAgeDays: 90,
    });
    await repo.record([
      row({ id: 'new:a', runId: 'new', timestamp: '2026-08-31T10:00:00.000Z' }),
      row({ id: 'old:a', runId: 'old', timestamp: '2026-08-30T10:00:00.000Z' }),
      row({ id: 'old:b', runId: 'old', timestamp: '2026-08-30T10:00:00.000Z' }),
    ]);

    const pruned = await repo.prune(new Date('2026-08-31T12:00:00.000Z'));

    expect(pruned.ok && pruned.value).toBe(2);
    const runs = await repo.recentRuns();
    expect(runs.ok && runs.value.map((run) => run.runId)).toEqual(['new']);
  });

  it('clear removes everything', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());
    await repo.record([row({ id: 'r1:a', runId: 'r1' })]);

    await repo.clear();

    const runs = await repo.recentRuns();
    expect(runs.ok && runs.value).toEqual([]);
  });
});

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
    outcome: 'unreviewed',
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

    const marked = await repo.recordOutcome('fp-target', 'contact.email');

    expect(marked.ok && marked.value).toBe(2);
    const runs = await repo.recentRuns();
    const corrected = runs.ok
      ? runs.value.flatMap((run) => run.fields).filter((field) => field.outcome !== 'unreviewed')
      : [];
    expect(corrected.map((field) => field.id).sort()).toEqual(['r1:a', 'r2:a']);
  });

  it('derives the outcome per row from what the policy had decided about it', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());
    await repo.record([
      row({ id: 'r1:filled', runId: 'r1', fieldFingerprint: 'fp-x', decidedAction: 'fill' }),
    ]);
    await repo.record([
      row({
        id: 'r1:refused',
        runId: 'r1',
        fieldFingerprint: 'fp-y',
        decidedAction: 'skip',
        fillAttempted: false,
        fillVerified: false,
      }),
    ]);

    await repo.recordOutcome('fp-x', 'contact.email');
    await repo.recordOutcome('fp-y', 'contact.email');

    const runs = await repo.recentRuns();
    const byId = new Map(
      (runs.ok ? runs.value.flatMap((run) => run.fields) : []).map((field) => [
        field.id,
        field.outcome,
      ]),
    );
    expect(byId.get('r1:filled')).toBe('corrected_wrong_fill');
    expect(byId.get('r1:refused')).toBe('assigned_unmapped');
  });

  it('one correction on a repeated question is attributed to one run, not to each', async () => {
    const repo = new AuditRepository(new InMemoryAuditCollection());
    await repo.record([
      row({ id: 'r1:a', runId: 'r1', fieldFingerprint: 'fp-x', timestamp: '2026-08-29T10:00:00.000Z' }),
      row({ id: 'r2:a', runId: 'r2', fieldFingerprint: 'fp-x', timestamp: '2026-08-30T10:00:00.000Z' }),
      row({ id: 'r3:a', runId: 'r3', fieldFingerprint: 'fp-x', timestamp: '2026-08-31T10:00:00.000Z' }),
    ]);

    await repo.recordOutcome('fp-x', null);

    const runs = await repo.recentRuns();
    const fields = runs.ok ? runs.value.flatMap((run) => run.fields) : [];

    // Every row still READS as corrected - the mapping was wrong each time it
    // was used - but only the newest carries the evidence a metric may count.
    expect(fields.every((field) => field.outcome === 'rejected_to_none')).toBe(true);
    expect(fields.filter((field) => field.supersededByLaterCorrection !== true)).toHaveLength(1);
    expect(fields.find((field) => field.supersededByLaterCorrection !== true)?.id).toBe('r3:a');
  });

  it('reads a pre-split row as corrected_legacy rather than guessing what it meant', async () => {
    const collection = new InMemoryAuditCollection();
    const repo = new AuditRepository(collection);

    // A row as written before the outcome split existed. Cast because the type
    // no longer admits it - which is the point: only old STORAGE has this shape.
    const { outcome: _dropped, ...legacy } = row({ id: 'r1:a', runId: 'r1' });
    await collection.putMany([{ ...legacy, userCorrected: true } as unknown as FillAuditRecord]);

    const runs = await repo.recentRuns();
    const field = runs.ok ? runs.value[0]?.fields[0] : undefined;

    expect(field?.outcome).toBe('corrected_legacy');
    expect(field).not.toHaveProperty('userCorrected');
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

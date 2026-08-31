/**
 * Retention rules.
 *
 * These are privacy behaviour, not housekeeping, so they are tested as
 * behaviour: what a user would find still in their history, and what they
 * would find gone.
 */
import { describe, expect, it } from 'vitest';
import { planPrune, type RetentionEntry, type RetentionPolicy } from '@audit/retention';

const NOW = new Date('2026-08-31T12:00:00.000Z');

const POLICY: RetentionPolicy = { maxRuns: 3, maxRecords: 100, maxAgeDays: 30 };

/** Rows for one run, newest-first ordering handled by the caller. */
function run(runId: string, daysAgo: number, fields: number): RetentionEntry[] {
  const timestamp = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return Array.from({ length: fields }, (_, index) => ({
    id: `${runId}:f${index}`,
    runId,
    timestamp,
  }));
}

/** Newest first, as an index walk in `prev` order produces them. */
function newestFirst(...runs: RetentionEntry[][]): RetentionEntry[] {
  return runs.flat().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

describe('planPrune', () => {
  it('keeps everything inside every limit', () => {
    const entries = newestFirst(run('a', 1, 4), run('b', 2, 4));
    expect(planPrune(entries, POLICY, NOW)).toEqual([]);
  });

  it('drops runs past the run cap, newest kept', () => {
    const entries = newestFirst(run('a', 1, 2), run('b', 2, 2), run('c', 3, 2), run('d', 4, 2));

    const doomed = planPrune(entries, POLICY, NOW);

    expect(doomed).toEqual(['d:f0', 'd:f1']);
  });

  it('drops a run older than the age limit even when the history is nearly empty', () => {
    const entries = newestFirst(run('recent', 1, 2), run('ancient', 400, 2));

    const doomed = planPrune(entries, POLICY, NOW);

    expect(doomed).toEqual(['ancient:f0', 'ancient:f1']);
  });

  it('cuts on a run boundary rather than leaving half an application', () => {
    // Row cap of 5 against runs of 4: the second run would straddle it.
    const policy: RetentionPolicy = { maxRuns: 100, maxRecords: 5, maxAgeDays: 30 };
    const entries = newestFirst(run('a', 1, 4), run('b', 2, 4));

    const doomed = planPrune(entries, policy, NOW);

    // Either the whole of run b survives or none of it does - never two fields.
    expect(doomed).toEqual(['b:f0', 'b:f1', 'b:f2', 'b:f3']);
  });

  it('keeps a run that sits exactly on the age boundary', () => {
    const entries = run('edge', 30, 1);
    // 30 days ago with a 30-day policy is the cutoff itself, not past it.
    expect(planPrune(entries, POLICY, NOW)).toEqual([]);
  });

  it('always keeps the newest run, even when it alone exceeds the row ceiling', () => {
    // A 400-control form against a ceiling of 5. Dropping it would mean the
    // user finishes a fill and finds no trace of it in their history.
    const policy: RetentionPolicy = { maxRuns: 100, maxRecords: 5, maxAgeDays: 30 };

    expect(planPrune(run('huge', 0, 400), policy, NOW)).toEqual([]);
  });

  it('is a no-op on an empty history', () => {
    expect(planPrune([], POLICY, NOW)).toEqual([]);
  });
});

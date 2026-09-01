/**
 * The metrics, named after the bugs they exist to prevent.
 * ---------------------------------------------------------------------------
 * Every test here is a specific way a metrics screen lies. The first is the
 * conflation the outcome enum was created to fix; the rest are the ways a
 * number can look precise while resting on nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  formatRate,
  INCORRECT_FILL_OUTCOMES,
  MIN_REVIEWED_FOR_A_NUMBER,
} from '@audit/metrics';
import { groupIntoRuns, type FillAuditRecord } from '@audit/types';

function row(overrides: Partial<FillAuditRecord> & { id: string; runId: string }): FillAuditRecord {
  return {
    timestamp: '2026-08-31T10:00:00.000Z',
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fieldFingerprint: 'fp',
    mappedProfilePath: 'contact.email',
    mappingConfidence: 0.9,
    mappingSource: 'alias',
    decidedAction: 'fill',
    fillAttempted: true,
    fillVerified: true,
    outcome: 'unreviewed',
    ...overrides,
  };
}

/** A field we did not understand. No mapped path at all, not an empty one. */
function unmapped(overrides: { id: string; runId: string }): FillAuditRecord {
  const { mappedProfilePath: _absent, ...rest } = row({
    ...overrides,
    decidedAction: 'skip',
    mappingSource: 'none',
    fillAttempted: false,
    fillVerified: false,
  });
  return rest;
}

function metricsOver(rows: FillAuditRecord[]) {
  return computeMetrics(groupIntoRuns(rows));
}

describe('computeMetrics', () => {
  it('does not count a user teaching us a blank field as an incorrect fill', () => {
    // The bug this whole change exists to fix. Under `userCorrected: boolean`
    // this row was indistinguishable from a wrong fill, so the most important
    // metric in spec section 26 went UP when the learning loop worked.
    const metrics = metricsOver([
      row({
        id: 'r1:a',
        runId: 'r1',
        decidedAction: 'skip',
        fillAttempted: false,
        fillVerified: false,
        outcome: 'assigned_unmapped',
      }),
    ]);

    expect(metrics.incorrectFill.numerator).toBe(0);
    // And it moved the other way: the field is no longer one we do not know.
    expect(metrics.unknownField.numerator).toBe(0);
  });

  it('one correction on a repeated question counts once, not once per run', () => {
    // The same question, filled in three applications to the same company. One
    // correction. Counted per row, the incorrect-fill rate would measure how
    // often the user revisits a careers site.
    const metrics = metricsOver([
      row({ id: 'r1:a', runId: 'r1', outcome: 'corrected_wrong_fill', supersededByLaterCorrection: true }),
      row({ id: 'r2:a', runId: 'r2', outcome: 'corrected_wrong_fill', supersededByLaterCorrection: true }),
      row({ id: 'r3:a', runId: 'r3', outcome: 'corrected_wrong_fill' }),
    ]);

    expect(metrics.incorrectFill.numerator).toBe(1);
    expect(metrics.incorrectFill.reviewed).toBe(1);
    expect(metrics.countedFields).toBe(1);
  });

  it('an unreviewed row is not evidence of a correct fill', () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row({ id: `r1:${index}`, runId: 'r1' }),
    );

    const metrics = metricsOver(rows);

    expect(metrics.incorrectFill).toEqual({ numerator: 0, reviewed: 0, unreviewed: 100 });
    // A hundred fills and no complaints is not a 0% error rate. It is no data.
    expect(formatRate(metrics.incorrectFill)).toBeNull();
  });

  it('a legacy row is excluded from both sides of every rate', () => {
    const metrics = metricsOver([
      row({ id: 'r1:a', runId: 'r1', outcome: 'corrected_legacy' }),
      row({ id: 'r1:b', runId: 'r1', outcome: 'corrected_wrong_fill' }),
    ]);

    expect(metrics.countedFields).toBe(1);
    expect(metrics.incorrectFill).toEqual({ numerator: 1, reviewed: 1, unreviewed: 0 });
    expect(metrics.userCorrection.reviewed).toBe(1);
  });

  it('keeps a corrected suggestion out of the incorrect-fill numerator', () => {
    // A wrong mapping, but nothing reached the page unattended: a person read
    // it and declined. That is the review step working, not a bad fill.
    const metrics = metricsOver([
      row({ id: 'r1:a', runId: 'r1', decidedAction: 'suggest', outcome: 'corrected_wrong_suggestion' }),
    ]);

    expect(metrics.incorrectFill.numerator).toBe(0);
    expect(metrics.userCorrection.numerator).toBe(1);
  });

  it('counts a field we should never have touched as an incorrect fill', () => {
    const metrics = metricsOver([
      row({ id: 'r1:a', runId: 'r1', outcome: 'rejected_to_none' }),
    ]);

    expect(metrics.incorrectFill.numerator).toBe(1);
  });

  it('reports fill execution against attempts, including rows a correction superseded', () => {
    // Two separate attempts the fill engine really made. Supersession exists to
    // stop one CORRECTION being counted twice; it says nothing about whether
    // the page took a value.
    const metrics = metricsOver([
      row({ id: 'r1:a', runId: 'r1', supersededByLaterCorrection: true, outcome: 'corrected_wrong_fill' }),
      row({ id: 'r2:a', runId: 'r2', fillVerified: false, outcome: 'corrected_wrong_fill' }),
      row({ id: 'r2:b', runId: 'r2', decidedAction: 'skip', fillAttempted: false, fillVerified: false }),
    ]);

    expect(metrics.fillExecutionSuccess).toEqual({ numerator: 1, denominator: 2 });
  });

  it('counts reuse only over the fields we actually mapped', () => {
    const metrics = metricsOver([
      row({ id: 'r1:a', runId: 'r1', mappingSource: 'memory' }),
      row({ id: 'r1:b', runId: 'r1', mappingSource: 'alias' }),
      unmapped({ id: 'r1:c', runId: 'r1' }),
    ]);

    expect(metrics.repeatedQuestionReuse).toEqual({ numerator: 1, reviewed: 2, unreviewed: 0 });
  });
});

/**
 * An assertion from OUTSIDE the module, in the style of the redaction block in
 * join.test.ts. Adding an outcome must be a deliberate act with a test to
 * update, not a change that silently alters what the most important metric in
 * the spec means.
 */
describe('the incorrect-fill numerator', () => {
  it('accepts only the two outcomes where a value reached the page unattended', () => {
    expect([...INCORRECT_FILL_OUTCOMES].sort()).toEqual([
      'corrected_wrong_fill',
      'rejected_to_none',
    ]);
  });

  it('never admits the outcome that means the learning loop worked', () => {
    expect(INCORRECT_FILL_OUTCOMES).not.toContain('assigned_unmapped');
  });
});

describe('formatRate', () => {
  it('refuses a number below the evidence floor', () => {
    expect(formatRate({ numerator: 2, reviewed: 3, unreviewed: 0 })).toBeNull();
  });

  it('marks a rate with unreviewed rows as a lower bound', () => {
    const formatted = formatRate({
      numerator: 2,
      reviewed: MIN_REVIEWED_FOR_A_NUMBER,
      unreviewed: 310,
    });

    expect(formatted).toBe('≥ 10.0%');
  });

  it('drops the bound when every row in the population was observed', () => {
    expect(formatRate({ numerator: 5, reviewed: 50, unreviewed: 0 })).toBe('10.0%');
  });
});

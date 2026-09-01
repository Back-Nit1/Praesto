/**
 * Grouping rows into runs, and the counts the history view reports.
 */
import { describe, expect, it } from 'vitest';
import { canonicalUrl, groupIntoRuns, type FillAuditRecord } from '@audit/types';

function row(overrides: Partial<FillAuditRecord> & { id: string; runId: string }): FillAuditRecord {
  return {
    timestamp: '2026-08-31T10:00:00.000Z',
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fieldFingerprint: 'fp',
    mappingConfidence: 0.9,
    mappingSource: 'alias',
    decidedAction: 'fill',
    fillAttempted: true,
    fillVerified: true,
    outcome: 'unreviewed',
    ...overrides,
  };
}

describe('groupIntoRuns', () => {
  it('groups rows by run and orders runs newest first', () => {
    const runs = groupIntoRuns([
      row({ id: 'old:1', runId: 'old', timestamp: '2026-08-30T09:00:00.000Z' }),
      row({ id: 'new:1', runId: 'new', timestamp: '2026-08-31T09:00:00.000Z' }),
      row({ id: 'old:2', runId: 'old', timestamp: '2026-08-30T09:00:00.000Z' }),
    ]);

    expect(runs.map((r) => r.runId)).toEqual(['new', 'old']);
    expect(runs[1]?.fields).toHaveLength(2);
  });

  it('counts an attempted-but-unverified field as failed, never as filled', () => {
    const runs = groupIntoRuns([
      row({ id: 'r:1', runId: 'r' }),
      row({ id: 'r:2', runId: 'r', fillVerified: false }),
      row({ id: 'r:3', runId: 'r', fillAttempted: false, fillVerified: false, decidedAction: 'skip' }),
      row({ id: 'r:4', runId: 'r', outcome: 'corrected_wrong_fill' }),
    ]);

    expect(runs[0]?.counts).toEqual({
      fields: 4,
      filled: 2,
      failed: 1,
      skipped: 1,
      corrected: 1,
    });
  });

  it('returns nothing for no rows', () => {
    expect(groupIntoRuns([])).toEqual([]);
  });
});

describe('canonicalUrl', () => {
  it('strips the query string, which on an ATS link is tracking parameters', () => {
    expect(canonicalUrl('https://boards.greenhouse.io/acme/jobs/12?gh_src=abc&utm_campaign=x')).toBe(
      'https://boards.greenhouse.io/acme/jobs/12',
    );
  });

  it('strips the fragment, which is a scroll position and not a page', () => {
    expect(canonicalUrl('https://jobs.lever.co/acme/1234#apply')).toBe(
      'https://jobs.lever.co/acme/1234',
    );
  });

  it('does not throw on an unparseable URL from a hostile page', () => {
    expect(canonicalUrl('not a url')).toBe('not a url');
  });
});

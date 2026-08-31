/**
 * The scan-to-history join, including the privacy invariant.
 */
import { describe, expect, it } from 'vitest';
import { buildAuditRecords, buildUnmatchedRecords, type FillResultInput } from '@audit/join';
import type { PendingRun } from '@audit/pending';

const NOW = new Date('2026-08-31T12:00:00.000Z');

function pending(overrides: Partial<PendingRun> = {}): PendingRun {
  return {
    runId: 'run-1',
    createdAt: 0,
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fields: [
      {
        localId: 'email',
        fieldFingerprint: 'fp-email',
        detectedLabel: 'email address',
        mappedProfilePath: 'identity.email',
        mappingConfidence: 0.97,
        mappingSource: 'alias',
        decidedAction: 'fill',
      },
      {
        localId: 'hub',
        fieldFingerprint: 'fp-hub',
        detectedLabel: 'preferred hub',
        mappingConfidence: 0,
        mappingSource: 'none',
        decidedAction: 'skip',
      },
    ],
    ...overrides,
  };
}

function result(overrides: Partial<FillResultInput> & { localId: string }): FillResultInput {
  return { attempted: true, verified: true, ...overrides };
}

describe('buildAuditRecords', () => {
  it('writes a row for every scanned field, not only the filled ones', () => {
    const rows = buildAuditRecords(pending(), [result({ localId: 'email' })], NOW);

    expect(rows.map((row) => row.id)).toEqual(['run-1:email', 'run-1:hub']);
    // The question we did not understand is recorded as unattempted, which is
    // what it was - not as a failure.
    expect(rows[1]).toMatchObject({ fillAttempted: false, fillVerified: false, mappingSource: 'none' });
  });

  it('gives every row of a run the same timestamp, so retention can cut on a run boundary', () => {
    const rows = buildAuditRecords(pending(), [], NOW);

    expect(new Set(rows.map((row) => row.timestamp)).size).toBe(1);
  });

  it('records an attempted-but-unverified fill with its failure code', () => {
    const rows = buildAuditRecords(
      pending(),
      [result({ localId: 'email', verified: false, failureReason: 'READBACK_MISMATCH', adapter: 'text' })],
      NOW,
    );

    expect(rows[0]).toMatchObject({
      fillAttempted: true,
      fillVerified: false,
      failureReason: 'READBACK_MISMATCH',
      adapter: 'text',
    });
  });

  it('keeps the mapping metadata only the worker knew', () => {
    const rows = buildAuditRecords(pending(), [result({ localId: 'email' })], NOW);

    expect(rows[0]).toMatchObject({
      detectedLabel: 'email address',
      mappedProfilePath: 'identity.email',
      mappingConfidence: 0.97,
      mappingSource: 'alias',
      fieldFingerprint: 'fp-email',
    });
  });

  it('still records a field the page reported that the scan never saw', () => {
    // A form that revealed a control between the scan and the fill.
    const rows = buildAuditRecords(pending(), [result({ localId: 'surprise' })], NOW);

    const orphan = rows.find((row) => row.id === 'run-1:surprise');
    expect(orphan).toMatchObject({ fillAttempted: true, mappingSource: 'none', mappingConfidence: 0 });
  });

  it('does not duplicate a field that appears in both the scan and the results', () => {
    const rows = buildAuditRecords(pending(), [result({ localId: 'email' })], NOW);

    expect(rows.filter((row) => row.id === 'run-1:email')).toHaveLength(1);
  });
});

describe('buildUnmatchedRecords', () => {
  it('claims no mapping metadata it does not have', () => {
    const rows = buildUnmatchedRecords(
      { runId: 'r', pageUrl: 'https://x.test/a', hostname: 'x.test', ats: 'unknown' },
      [result({ localId: 'f1' })],
      NOW,
    );

    expect(rows[0]).toMatchObject({ mappingSource: 'none', mappingConfidence: 0, fieldFingerprint: '' });
    expect(rows[0]?.detectedLabel).toBeUndefined();
  });
});

/**
 * The privacy invariant, asserted from outside the type system.
 *
 * A history row may carry the QUESTION the form asked. It must never carry the
 * ANSWER. This test fails the moment a new key appears on a record, which is
 * the point: adding one has to be a deliberate act with a test to update, not
 * a field that slips in with an unrelated change.
 */
describe('redaction', () => {
  const ALLOWED_KEYS = [
    'adapter',
    'ats',
    'decidedAction',
    'detectedLabel',
    'failureReason',
    'fieldFingerprint',
    'fillAttempted',
    'fillVerified',
    'hostname',
    'id',
    'mappedProfilePath',
    'mappingConfidence',
    'mappingSource',
    'pageUrl',
    'runId',
    'timestamp',
    'userCorrected',
  ];

  it('never writes a key outside the agreed set', () => {
    const rows = buildAuditRecords(
      pending(),
      [result({ localId: 'email', adapter: 'text', failureReason: 'X' })],
      NOW,
    );

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(ALLOWED_KEYS).toContain(key);
      }
    }
  });

  it('has no key whose name suggests it holds an applicant value', () => {
    const rows = buildAuditRecords(pending(), [result({ localId: 'email' })], NOW);
    const forbidden = /value|answer|filledWith|text|content|input/i;

    for (const key of Object.keys(rows[0] ?? {})) {
      expect(key).not.toMatch(forbidden);
    }
  });
});

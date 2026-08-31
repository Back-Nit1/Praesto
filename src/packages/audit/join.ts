/**
 * Turning a scan plus its fill results into history rows.
 * ---------------------------------------------------------------------------
 * The one piece of this feature with real logic in it, and therefore the piece
 * that is a pure function: descriptors in, records out, no storage, no clock,
 * no chrome. The service worker below it does nothing but read, call this, and
 * write.
 *
 * EVERY SCANNED FIELD GETS A ROW, NOT ONLY THE FILLED ONES
 * A history that lists thirteen successes and says nothing about the five
 * questions we did not understand is a history that flatters us. The five are
 * the interesting ones: they are what the user had to type by hand, and they
 * are what a mapping fix would have to target. So the row set comes from the
 * SCAN, and fill results are joined onto it.
 */
import type { ATSKind } from '@ats/types';
import type { PendingRun } from './pending';
import type { FillAuditRecord } from './types';

/** The part of a fill report history cares about. Never carries a value. */
export interface FillResultInput {
  localId: string;
  attempted: boolean;
  verified: boolean;
  adapter?: string;
  /** A failure CODE from the fill engine. */
  failureReason?: string;
}

/** Page identity for rows that have lost their scan. */
export interface OrphanContext {
  runId: string;
  pageUrl: string;
  hostname: string;
  ats: ATSKind;
}

/**
 * Join a stashed scan with what the page reported.
 *
 * `now` is passed in rather than read here so that every row of a run carries
 * ONE timestamp - which is what keeps a run's rows contiguous in the time index
 * and lets retention cut on a run boundary.
 */
export function buildAuditRecords(
  run: PendingRun,
  results: readonly FillResultInput[],
  now: Date,
): FillAuditRecord[] {
  const byLocalId = new Map(results.map((result) => [result.localId, result]));
  const timestamp = now.toISOString();

  const rows = run.fields.map((field) => {
    const outcome = byLocalId.get(field.localId);
    byLocalId.delete(field.localId);

    return {
      id: `${run.runId}:${field.localId}`,
      runId: run.runId,
      timestamp,
      pageUrl: run.pageUrl,
      hostname: run.hostname,
      ats: run.ats,
      fieldFingerprint: field.fieldFingerprint,
      ...(field.detectedLabel !== undefined ? { detectedLabel: field.detectedLabel } : {}),
      ...(field.mappedProfilePath !== undefined
        ? { mappedProfilePath: field.mappedProfilePath }
        : {}),
      mappingConfidence: field.mappingConfidence,
      mappingSource: field.mappingSource,
      decidedAction: field.decidedAction,
      // Absent from the report means the field was never sent to the fill
      // engine - the user filled the safe fields and left this suggestion
      // alone. That is a real outcome and it is recorded as itself, not as a
      // failure.
      fillAttempted: outcome?.attempted ?? false,
      fillVerified: outcome?.verified ?? false,
      // Set later, by a correction. Nothing at fill time can know it.
      userCorrected: false,
      ...(outcome?.adapter !== undefined ? { adapter: outcome.adapter } : {}),
      ...(outcome?.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
    } satisfies FillAuditRecord;
  });

  // Anything the page reported that the scan did not contain. In practice this
  // is a form that changed between scan and fill. The rows are still written -
  // an unexplained fill is exactly what a user debugging their history needs to
  // see - but they claim no mapping metadata they do not have.
  const unmatched = buildUnmatchedRecords(
    { runId: run.runId, pageUrl: run.pageUrl, hostname: run.hostname, ats: run.ats },
    [...byLocalId.values()],
    now,
  );

  return [...rows, ...unmatched];
}

/**
 * Rows for results whose scan is gone: the stash expired, or the worker was
 * restarted after the browser was closed and reopened.
 *
 * These say less, and say so honestly: confidence 0 and source `none` mean "we
 * no longer know why", not "we had no reason". A history that invented a
 * plausible-looking mapping source here would be lying in exactly the way this
 * product exists not to.
 */
export function buildUnmatchedRecords(
  context: OrphanContext,
  results: readonly FillResultInput[],
  now: Date,
): FillAuditRecord[] {
  const timestamp = now.toISOString();

  return results.map((result) => ({
    id: `${context.runId}:${result.localId}`,
    runId: context.runId,
    timestamp,
    pageUrl: context.pageUrl,
    hostname: context.hostname,
    ats: context.ats,
    fieldFingerprint: '',
    mappingConfidence: 0,
    mappingSource: 'none' as const,
    decidedAction: result.attempted ? ('fill' as const) : ('skip' as const),
    fillAttempted: result.attempted,
    fillVerified: result.verified,
    userCorrected: false,
    ...(result.adapter !== undefined ? { adapter: result.adapter } : {}),
    ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
  }));
}

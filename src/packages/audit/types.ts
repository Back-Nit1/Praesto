/**
 * Application history - what the extension did, and what it refused to do.
 * ---------------------------------------------------------------------------
 * Spec section 24. Two things live here, and the distinction matters:
 *
 *   FillAuditRecord   one row per FIELD. The debugging unit: which question,
 *                     which rule answered it, whether the value landed.
 *   ApplicationRun    a derived view over rows sharing a `runId`. The unit the
 *                     USER thinks in: "the Acme application, Tuesday, 13 of 18".
 *
 * The run is derived rather than stored so the two can never disagree. A stored
 * summary that says "13 filled" beside rows that say twelve is worse than no
 * summary at all - and this product's entire claim is that it does not assert
 * things it was not told.
 *
 * WHAT IS DELIBERATELY ABSENT: THE VALUE
 * There is no `value`, `filledWith` or `previousValue` field on this type, and
 * that is the privacy design rather than an omission. History answers WHICH
 * QUESTION was answered and WHETHER it worked; it never records the applicant's
 * answer. Enforcing that in the type means a future contributor cannot add one
 * by accident at a call site - they would have to change this file, next to
 * this paragraph. The `redaction` block in `tests/audit/join.test.ts` asserts
 * it from the outside.
 *
 * The one page-derived string kept is `detectedLabel` - the question text the
 * FORM displayed ("Preferred start date"). That is the employer's prose, not
 * the applicant's data, and without it a history row is an unreadable hash.
 */
import type { ATSKind } from '@ats/types';
import type { MappingSource } from '@form-engine/mapper/types';

/**
 * What the user's action said about this row's decision.
 * ---------------------------------------------------------------------------
 * This replaces a `userCorrected: boolean`, which could not tell two opposite
 * events apart:
 *
 *   we filled a field wrongly and the user fixed it      <- the failure the
 *                                                           product exists to
 *                                                           avoid
 *   we correctly refused a field and the user taught us   <- the learning loop
 *                                                           working as designed
 *
 * Counting the second as an incorrect fill is why the most important metric in
 * spec section 26 could not be computed from this table. It also matters which
 * way each one moves: a correction on a refused field lowers the UNKNOWN-field
 * rate; only a correction on something we WROTE raises the incorrect-fill rate.
 *
 * `unreviewed` is the default and it is not a synonym for "correct". Most
 * fields are never corrected, and silence is not evidence - see metrics.ts.
 */
export type FieldOutcome =
  /** Default. Nobody said anything about this row. NOT "correct". */
  | 'unreviewed'
  /** The user read a suggestion and accepted it. The only positive evidence. */
  | 'accepted_suggestion'
  /** We wrote a value; the user changed what the field means. */
  | 'corrected_wrong_fill'
  /** We offered a value; the user changed it before accepting. */
  | 'corrected_wrong_suggestion'
  /** We refused the field; the user taught us what it is. */
  | 'assigned_unmapped'
  /** We touched a field that should have been left alone. */
  | 'rejected_to_none'
  /** Pre-split `userCorrected: true`. Counted in nothing. See metrics.ts. */
  | 'corrected_legacy';

/**
 * The outcome a correction implies for a row that already exists.
 *
 * Pure, and exported, so the classification can be tested without a database:
 * everything it needs is what the POLICY decided (`decidedAction`) and what the
 * USER said (`profilePath`, where `null` means "this field means nothing").
 *
 * `attach_resume` is folded in with `fill` deliberately. Attaching a document
 * to a field that wanted something else is a wrong fill by any reading, and
 * giving it its own outcome would add a case to every numerator for no gain.
 */
export function deriveCorrectionOutcome(
  decidedAction: FillAuditRecord['decidedAction'],
  profilePath: string | null,
): FieldOutcome {
  // We had already decided to leave this field alone, and the user is telling
  // us what it means. That is the loop working - never an incorrect fill.
  if (decidedAction === 'skip') return 'assigned_unmapped';

  // "This field means nothing." We acted on something we should not have
  // touched, whether we wrote it or merely offered it.
  if (profilePath === null) return 'rejected_to_none';

  return decidedAction === 'suggest' ? 'corrected_wrong_suggestion' : 'corrected_wrong_fill';
}

/**
 * One field, one fill run.
 *
 * `id` is `${runId}:${localId}` rather than a random id, which makes the write
 * an UPSERT. That is load-bearing: the user can fill the safe fields, then
 * accept two suggestions individually, and each report re-writes the same rows
 * instead of accumulating a duplicate history of the same field.
 */
export interface FillAuditRecord {
  /** `${runId}:${localId}`. Stable, so a second report updates this row. */
  id: string;
  /** Groups every field scanned in one pass over one page. */
  runId: string;
  /**
   * ISO timestamp, IDENTICAL for every row in a run.
   *
   * Shared rather than per-row so the `byTimestamp` index keeps a run's rows
   * contiguous - which is what lets retention cut on a run boundary instead of
   * leaving half an application in the history.
   */
  timestamp: string;
  /** Origin + path only. Query and fragment are stripped before it gets here. */
  pageUrl: string;
  hostname: string;
  ats: ATSKind;
  /** The `exact` scope fingerprint - the one a correction is keyed by. */
  fieldFingerprint: string;
  /** The question as the form asked it. Never the applicant's answer. */
  detectedLabel?: string;
  mappedProfilePath?: string;
  mappingConfidence: number;
  mappingSource: MappingSource;
  /** What the confidence policy decided before any fill was attempted. */
  decidedAction: 'fill' | 'suggest' | 'skip' | 'attach_resume';
  fillAttempted: boolean;
  /** True ONLY when the page read the value back. Never "we sent it". */
  fillVerified: boolean;
  /** What the user's action said about this decision. Default `unreviewed`. */
  outcome: FieldOutcome;
  /**
   * This row shares a fingerprint with a later row the same correction hit.
   *
   * It keeps its outcome so history still shows it as corrected - the mapping
   * WAS wrong here too - but metrics skip it on both sides of every rate. One
   * correction is one piece of evidence, not one per run it happened to touch.
   */
  supersededByLaterCorrection?: boolean;
  adapter?: string;
  /** A failure CODE from the fill engine, never the value that failed. */
  failureReason?: string;
}

/** Counts for one run. Derived; never stored. */
export interface RunCounts {
  fields: number;
  filled: number;
  failed: number;
  /** Scanned, understood or not, and deliberately left alone. */
  skipped: number;
  corrected: number;
}

/** One application attempt, as the user thinks of it. */
export interface ApplicationRun {
  runId: string;
  startedAt: string;
  pageUrl: string;
  hostname: string;
  ats: ATSKind;
  counts: RunCounts;
  /** Rows in the order they were scanned. */
  fields: FillAuditRecord[];
}

/**
 * Group rows into runs, newest first.
 *
 * Pure, so the history view has no logic of its own to get wrong and the
 * grouping is testable without a database or a DOM.
 */
export function groupIntoRuns(records: readonly FillAuditRecord[]): ApplicationRun[] {
  const byRun = new Map<string, FillAuditRecord[]>();
  for (const record of records) {
    const existing = byRun.get(record.runId);
    if (existing === undefined) byRun.set(record.runId, [record]);
    else existing.push(record);
  }

  const runs: ApplicationRun[] = [];
  for (const [runId, fields] of byRun) {
    const first = fields[0];
    if (first === undefined) continue;
    runs.push({
      runId,
      startedAt: first.timestamp,
      pageUrl: first.pageUrl,
      hostname: first.hostname,
      ats: first.ats,
      counts: countRun(fields),
      fields,
    });
  }

  // Newest first. Ties broken by runId so the order is stable across reads -
  // a list that reshuffles between renders reads as a bug to the user.
  return runs.sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
  );
}

function countRun(fields: readonly FillAuditRecord[]): RunCounts {
  let filled = 0;
  let failed = 0;
  let skipped = 0;
  let corrected = 0;

  for (const field of fields) {
    // Any verdict at all, including the pre-split legacy one. The history view
    // says "corrected" and means "the user touched this", which is exactly the
    // set of outcomes that are not `unreviewed`. Metrics, which need the
    // distinctions this count throws away, do not use it.
    if (field.outcome !== 'unreviewed') corrected++;
    if (!field.fillAttempted) {
      skipped++;
      continue;
    }
    // Attempted-but-unverified is a FAILURE, not a partial success. Counting it
    // as filled is the exact bug the side panel's header comment warns about:
    // a user told "13 filled" who finds two empty has to check all thirteen
    // forever afterwards.
    if (field.fillVerified) filled++;
    else failed++;
  }

  return { fields: fields.length, filled, failed, skipped, corrected };
}

/**
 * Strip a URL to what history should keep.
 *
 * Origin and path only. A Greenhouse or Lever link routinely carries
 * `?gh_src=`, a referrer id and campaign parameters; none of that says which
 * job it was, and all of it is a tracking token we would be persisting on the
 * user's disk for ninety days. The path alone answers the question history
 * exists to answer: have I applied here before?
 *
 * Returns a bounded string on an unparseable input rather than throwing - a
 * malformed URL from a hostile page must not be able to abort a fill.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return raw.slice(0, 512);
  }
}

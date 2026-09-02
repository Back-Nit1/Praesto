/**
 * Development metrics, computed only from evidence.
 * ---------------------------------------------------------------------------
 * Spec section 26 asks for seven numbers and names the incorrect-fill rate as
 * the most important one. This module computes what the audit trail can
 * actually support, and refuses the rest.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * Silence is not evidence of correctness.
 *
 * Most fields are never corrected. A user who fills forty fields and fixes one
 * has told us about exactly one of them; the other thirty-nine are unexamined,
 * not verified. So `corrections ÷ fills` is a LOWER BOUND, permanently, and
 * printing it as a single percentage would turn it into the one lying number in
 * a product whose whole claim is that it does not overstate what it knows.
 * `ObservedRate` therefore carries its own denominator and the count of rows
 * that said nothing, and there is no way to get a bare percentage out of it.
 *
 * Pure. No storage, no chrome, no React, no clock - `groupIntoRuns` is the
 * model. Everything here is testable in a Node process against rows built by
 * hand, which is what a metric has to be before it is worth trusting.
 */
import type { ApplicationRun, FieldOutcome, FillAuditRecord } from './types';

/**
 * A rate that cannot be read as more certain than it is.
 *
 * `numerator` is always a subset of `reviewed`, never of `reviewed +
 * unreviewed`. Rendering is required to show all three - see
 * `MIN_REVIEWED_FOR_A_NUMBER`.
 */
export interface ObservedRate {
  numerator: number;
  /** Rows that produced evidence either way. The denominator. */
  reviewed: number;
  /** Rows that produced none. Rendered beside the rate, never hidden. */
  unreviewed: number;
}

/**
 * A ratio where every case is observed, so there is nothing to disclose.
 *
 * Deliberately a different type from `ObservedRate`. Fill execution is the one
 * metric here that is fully observed - the page either read the value back or
 * it did not, on every attempt - and giving it the same shape as the inferred
 * rates would invite someone to render them the same way.
 */
export interface ObservedRatio {
  numerator: number;
  denominator: number;
}

/** The four §26 metrics this table can support, plus what they were computed over. */
export interface DevelopmentMetrics {
  /** Runs the metrics were computed over. */
  runs: number;
  /** Rows counted, after superseded and pre-split rows are dropped. */
  countedFields: number;

  /**
   * Of the fields we WROTE or offered, how many the user had to undo.
   *
   * The most important number in section 26, and the reason the outcome enum
   * exists. See `incorrectFillNumerator` for what is allowed into it.
   */
  incorrectFill: ObservedRate;

  /** Of every field, how many the user corrected in any direction. */
  userCorrection: ObservedRate;

  /** Of every field, how many we still have nothing to say about. */
  unknownField: ObservedRate;

  /**
   * Of the fields we mapped, how many came from something we had seen before.
   *
   * AN UPPER BOUND, and the only metric here that is. `mappingSource` records
   * `'semantic'` for both a cache hit and a fresh model call, so a first-ever
   * question answered by the model is counted as reuse. Separating them needs a
   * cache-hit signal that does not exist yet.
   */
  repeatedQuestionReuse: ObservedRate;

  /** Of the fills we attempted, how many the page read back. Fully observed. */
  fillExecutionSuccess: ObservedRatio;
}

/**
 * Below this many reviewed rows, the UI must print no number at all.
 *
 * Not a display preference. Two corrections out of three reviewed rows is
 * "67%", and there is no honest way to render that figure to someone who will
 * remember it as a fact about the system. Refusing to answer under a floor is
 * the same architecture as every other refusal in this product; a metrics
 * screen that guesses would make all of them a lie.
 */
export const MIN_REVIEWED_FOR_A_NUMBER = 20;

/**
 * The outcomes the incorrect-fill numerator accepts, and no others.
 *
 * Exported so a test can assert the set from OUTSIDE this module. A future
 * contributor adding an eighth outcome should fail a test rather than silently
 * change what the most important metric in the spec means.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   assigned_unmapped           the user teaching us a field we refused. That
 *                               is the learning loop working, and counting it
 *                               here was the original bug. It moves the
 *                               UNKNOWN-field rate down instead - the opposite
 *                               direction.
 *   corrected_wrong_suggestion  a wrong mapping, but nothing was written
 *                               unattended: a person read it and said no. That
 *                               is the review step doing its job.
 *   accepted_suggestion         positive evidence.
 *   corrected_legacy            a pre-split boolean that cannot be attributed.
 */
export const INCORRECT_FILL_OUTCOMES: readonly FieldOutcome[] = [
  'corrected_wrong_fill',
  'rejected_to_none',
];

/** Every outcome that means the user changed something. */
const CORRECTION_OUTCOMES: readonly FieldOutcome[] = [
  'corrected_wrong_fill',
  'corrected_wrong_suggestion',
  'assigned_unmapped',
  'rejected_to_none',
];

/** Mapping sources that mean "we had seen this question before". */
const REUSE_SOURCES = new Set(['memory', 'semantic']);

export function computeMetrics(runs: readonly ApplicationRun[]): DevelopmentMetrics {
  const all = runs.flatMap((run) => run.fields);
  const counted = all.filter(isCountable);

  return {
    runs: runs.length,
    countedFields: counted.length,
    incorrectFill: rate(
      counted.filter((row) => row.decidedAction !== 'skip'),
      (row) => INCORRECT_FILL_OUTCOMES.includes(row.outcome),
    ),
    userCorrection: rate(counted, (row) => CORRECTION_OUTCOMES.includes(row.outcome)),
    unknownField: fullyObserved(
      counted,
      // Refused, and still refused: a field the user has since taught us is no
      // longer one we do not understand, which is why a correction on a skipped
      // field moves this DOWN rather than moving incorrect-fill up.
      (row) => row.decidedAction === 'skip' && row.outcome !== 'assigned_unmapped',
    ),
    repeatedQuestionReuse: fullyObserved(
      counted.filter((row) => row.mappedProfilePath !== undefined),
      (row) => REUSE_SOURCES.has(row.mappingSource),
    ),
    // Every attempted row, INCLUDING superseded ones. Supersession exists to
    // stop one correction being counted once per run; a fill attempt in one run
    // and another in the next are two separate events the fill engine really
    // did have, and dropping either would understate the sample this number is
    // built from. It is the only metric here that reads a superseded row.
    fillExecutionSuccess: ratio(all.filter((row) => row.fillAttempted), (row) => row.fillVerified),
  };
}

/**
 * Is this row allowed to speak?
 *
 * Two exclusions, for two different reasons:
 *
 *   superseded      the same correction already spoke through a newer row.
 *                   Counting both would make the incorrect-fill rate scale with
 *                   how often the user applies to the same company.
 *   legacy          written before the outcome split, when a single boolean
 *                   covered a wrong fill and a taught field alike. Which one it
 *                   was is not recoverable, and guessing would fabricate
 *                   exactly the data this module exists to make trustworthy.
 */
function isCountable(row: FillAuditRecord): boolean {
  return row.supersededByLaterCorrection !== true && row.outcome !== 'corrected_legacy';
}

/**
 * A rate over rows where only SOME rows carry evidence.
 *
 * `reviewed` counts the rows that said something, in either direction. The rest
 * are reported as `unreviewed` and are never quietly moved to the denominator,
 * which is the arithmetic that turns "we know of two mistakes" into the much
 * stronger claim "we make mistakes 0.6% of the time".
 */
function rate(
  population: readonly FillAuditRecord[],
  isNumerator: (row: FillAuditRecord) => boolean,
): ObservedRate {
  let numerator = 0;
  let reviewed = 0;
  let unreviewed = 0;

  for (const row of population) {
    if (row.outcome === 'unreviewed') {
      unreviewed++;
      continue;
    }
    reviewed++;
    if (isNumerator(row)) numerator++;
  }

  return { numerator, reviewed, unreviewed };
}

/**
 * A rate where every row in the population is evidence about itself.
 *
 * Whether we understood a field, and which stage of the cascade answered it,
 * are recorded at scan time for every row - nobody has to review anything for
 * those to be known. So `unreviewed` is zero, and the shape is kept only so the
 * renderer treats every rate the same way and still shows the denominator.
 */
function fullyObserved(
  population: readonly FillAuditRecord[],
  isNumerator: (row: FillAuditRecord) => boolean,
): ObservedRate {
  return {
    numerator: population.filter(isNumerator).length,
    reviewed: population.length,
    unreviewed: 0,
  };
}

function ratio(
  population: readonly FillAuditRecord[],
  isNumerator: (row: FillAuditRecord) => boolean,
): ObservedRatio {
  return { numerator: population.filter(isNumerator).length, denominator: population.length };
}

/**
 * How a rate is allowed to be read aloud.
 *
 * Returns null below the floor, and the caller must render the words rather
 * than a figure. The `>=` in the formatted string is not decoration: the true
 * rate cannot be LOWER than this, and where there are unreviewed rows it may be
 * considerably higher.
 */
export function formatRate(rate: ObservedRate): string | null {
  if (rate.reviewed < MIN_REVIEWED_FOR_A_NUMBER) return null;
  const percent = ((rate.numerator / rate.reviewed) * 100).toFixed(1);
  const bound = rate.unreviewed > 0 ? '≥ ' : '';
  return `${bound}${percent}%`;
}

/**
 * Retention - deciding what history to forget.
 * ---------------------------------------------------------------------------
 * History that grows forever is two problems, not one. The obvious problem is
 * disk. The real problem is that a record of every application the user has
 * ever made is a profile of them, sitting on a machine they may not be the only
 * user of, long after it stopped being useful to anyone.
 *
 * So retention is a product decision, not a cleanup job: keep enough to answer
 * "did I already apply here, and did it work?", and drop the rest.
 *
 * THE PLAN IS A PURE FUNCTION
 * The decision (which ids to delete) is separated from the mechanism (walking
 * an IndexedDB cursor). That is what makes every rule below testable from plain
 * objects in a Node process, and it is why the IndexedDB layer contains no
 * policy at all - only "delete these ids".
 */

/** What the user's history is allowed to hold. */
export interface RetentionPolicy {
  /** Applications, not fields. The unit the user would name if asked. */
  maxRuns: number;
  /**
   * Hard ceiling on rows, as a backstop against pathological pages.
   *
   * A run is normally 10-40 fields. One badly built form with 400 controls
   * should not be able to consume the whole budget on its own, so the row cap
   * bites first in that case - always rounded OUT to a run boundary, because
   * half an application in the history is worse than none of it.
   */
  maxRecords: number;
  maxAgeDays: number;
}

/**
 * Defaults.
 *
 * 200 runs is several months of heavy applying; 90 days is the point past
 * which "did I apply here?" stops being a live question and the answer is in
 * the user's inbox anyway. 2000 rows is ~80 average runs' worth of headroom
 * over the row cap, so it only ever engages for unusually large forms.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  maxRuns: 200,
  maxRecords: 2000,
  maxAgeDays: 90,
};

/** The minimum a row must expose to be judged. */
export interface RetentionEntry {
  id: string;
  runId: string;
  /** ISO. Compared lexicographically, which is ordering-correct for ISO-8601. */
  timestamp: string;
}

/**
 * Which ids to delete.
 *
 * @param entries newest first, as an index walk in `prev` order produces them.
 * @param now     injected rather than read from the clock, so the age rule is
 *                testable without freezing time globally.
 *
 * All three rules cut on a RUN boundary. Once a run is condemned, every row of
 * it goes - including rows that individually pass the age check because the
 * user came back to the same form the next day.
 */
export function planPrune(
  entries: readonly RetentionEntry[],
  policy: RetentionPolicy,
  now: Date,
): string[] {
  const cutoff = new Date(now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  // Group first, decide second. The three rules are all about RUNS, and a rule
  // applied row by row cannot answer "would admitting this run overflow the
  // ceiling?" without already knowing how big the run is.
  const runs = new Map<string, RetentionEntry[]>();
  for (const entry of entries) {
    const existing = runs.get(entry.runId);
    if (existing === undefined) runs.set(entry.runId, [entry]);
    else existing.push(entry);
  }

  const doomed: string[] = [];
  let runsKept = 0;
  let rowsKept = 0;

  // Map iteration is insertion order, and `entries` arrives newest first, so
  // this walks runs from most to least recent.
  for (const [, rows] of runs) {
    const timestamp = rows[0]?.timestamp ?? '';

    // Age first, and it is absolute: an old run goes even when the history is
    // otherwise empty. Retention is a privacy promise, not only a size limit.
    const tooOld = timestamp < cutoff;

    // The caps, in contrast, never take the newest surviving run. A user who
    // has just filled a 400-field form must still see that run in their
    // history; a ceiling that made the thing you just did invisible would read
    // as the feature being broken.
    const isFirstKept = runsKept === 0;
    const overRunCap = !isFirstKept && runsKept >= policy.maxRuns;
    const overRowCap = !isFirstKept && rowsKept + rows.length > policy.maxRecords;

    if (tooOld || overRunCap || overRowCap) {
      for (const row of rows) doomed.push(row.id);
      continue;
    }

    runsKept++;
    rowsKept += rows.length;
  }

  return doomed;
}

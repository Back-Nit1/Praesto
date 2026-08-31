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

  const condemned = new Set<string>();
  const seenRuns = new Set<string>();
  let rowsKept = 0;

  // First pass: decide which RUNS die. Entries arrive newest first, so a run's
  // position in `seenRuns` is its recency rank.
  for (const entry of entries) {
    if (condemned.has(entry.runId)) continue;

    const isNewRun = !seenRuns.has(entry.runId);

    // Age. Checked before the caps so an old run is dropped even when the
    // history is nearly empty - retention is a privacy promise, not only a
    // storage limit.
    if (entry.timestamp < cutoff) {
      condemned.add(entry.runId);
      continue;
    }

    // Run cap. `seenRuns.size` is the number of runs already being kept, so a
    // NEW run arriving when the cap is full is the first one over the line.
    if (isNewRun && seenRuns.size >= policy.maxRuns) {
      condemned.add(entry.runId);
      continue;
    }

    // Row cap. Applied to whole runs: a run that would take us past the ceiling
    // is refused entirely rather than half-stored.
    if (isNewRun && rowsKept >= policy.maxRecords) {
      condemned.add(entry.runId);
      continue;
    }

    seenRuns.add(entry.runId);
    rowsKept++;
  }

  // Second pass: every row of every condemned run, including rows that the
  // first pass had already counted as kept before the run was condemned.
  return entries.filter((entry) => condemned.has(entry.runId)).map((entry) => entry.id);
}

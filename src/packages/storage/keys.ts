/**
 * Storage keys.
 * ---------------------------------------------------------------------------
 * Every key the extension writes is declared here, in one place, for reasons
 * that only become obvious once data is in real users' browsers:
 *
 *  - A migration must be able to enumerate what exists. Keys invented ad hoc at
 *    call sites cannot be migrated because nothing knows they are there.
 *  - Export/import (Phase 1 requirement) needs the complete key set.
 *  - A typo'd key at a call site is not a crash; it is a value that writes
 *    successfully and is never read again. Constants make that a compile error.
 *
 * The `aa:` prefix namespaces our data inside a storage area we may one day
 * share with another module, and makes a manual inspection of
 * chrome.storage.local legible.
 */

const PREFIX = 'aa';

export const STORAGE_KEYS = {
  /**
   * Version of the whole persisted storage layout - distinct from the profile's
   * own `schemaVersion`. Storage-level migrations (renaming a key, splitting a
   * collection) are versioned separately from document-level ones because they
   * change at different times for different reasons.
   */
  storageVersion: `${PREFIX}:storageVersion`,

  /** The active ApplicantProfile document. */
  activeProfile: `${PREFIX}:profile:active`,

  /** Id of the active profile, so multiple profiles can be supported later. */
  activeProfileId: `${PREFIX}:profile:activeId`,

  /** User settings: log level, debug mode, autofill thresholds. */
  settings: `${PREFIX}:settings`,

  /**
   * Learned field mappings (spec section 19).
   *
   * In chrome.storage rather than IndexedDB for now: the working set is small
   * (hundreds of rules at most), it is read on the hot path during every field
   * resolution, and chrome.storage reads are markedly cheaper than opening an
   * IndexedDB transaction in an MV3 service worker that may have just been
   * woken from eviction. Moving it later is a one-line change because it sits
   * behind a repository interface.
   */
  learnedMappings: `${PREFIX}:learning:mappings`,

  /**
   * The semantic fallback's question/answer memory (spec section 20).
   *
   * DELIBERATELY NOT `learnedMappings`, even though both are
   * fingerprint-to-path. That store's entries carry the USER's authority -
   * `userConfirmed` is what lets a rule short-circuit the mapping cascade - and
   * these carry a model's. Merging them would mean either lying about which is
   * which, or teaching the mapper a third state on a boolean it branches on.
   * See semantic/cache.ts for the full argument.
   *
   * A separate key is also what makes "forget what the model told us" and
   * "forget what I taught you" two genuinely separate buttons in settings.
   */
  semanticConcepts: `${PREFIX}:semantic:concepts`,

  /**
   * Per-install device token for the backend gateway.
   *
   * NOT an API key. It identifies THIS INSTALL to our own backend, which holds
   * the provider key. Compromising it costs one user's quota, not the account -
   * which is the entire reason the architecture is shaped this way. See
   * Security.md.
   */
  deviceToken: `${PREFIX}:backend:deviceToken`,

  /**
   * Client-side spend window for model calls.
   *
   * Storage-backed rather than in-memory because MV3 evicts the service worker
   * every ~30s idle and an in-memory counter would reset with it. This is a
   * courtesy limit; the enforceable one is the backend's.
   */
  modelQuota: `${PREFIX}:backend:modelQuota`,

  /**
   * Scans awaiting their fill results, keyed by tab and address.
   *
   * SESSION AREA, not local. It is short-lived join state - the mapping
   * metadata a history row needs, held between the scan that produced it and
   * the fill report that completes it - and it should not outlive the browser
   * session or ever reach the disk. See audit/pending.ts.
   */
  pendingRuns: `${PREFIX}:session:pendingRuns`,

  /**
   * The side panel's last scan, per tab, so closing the panel does not destroy
   * the record of what was filled. Also session-area, for the same reasons.
   * The tab id is appended: `aa:session:panel:42`.
   */
  panelSnapshotPrefix: `${PREFIX}:session:panel`,
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** Current storage layout version. Bump alongside a new migration step. */
export const STORAGE_VERSION = 1;

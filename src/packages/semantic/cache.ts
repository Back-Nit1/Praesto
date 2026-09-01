/**
 * The semantic concept cache - "have I already paid to understand this question?"
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND STORE AND NOT AN EXTENSION OF `LearnedMappingStore`
 * (the brief asks for this decision to be recorded here, so here it is.)
 *
 * The two look alike - both map a semantic fingerprint to a profile path, at
 * one of four scopes - and merging them was the first thing considered. Three
 * things make it wrong:
 *
 *  1. AUTHORITY. A `LearnedMapping` records what the USER said a field means.
 *     That is why the cascade scores it at 0.96, above the autofill threshold:
 *     the user is the authority on their own application. A cached concept
 *     records what a MODEL guessed. Putting a guess in the store the mapper
 *     reads would hand it the user's authority, silently, for free - and the
 *     brief's confidence cap would be defeated by the storage layer rather
 *     than by any line of code anyone would think to review.
 *
 *  2. THE HOT PATH. `LearnedMappingIndex` is built on every resolve batch and
 *     capped at 1000 rules, with eviction. One entry per novel question would
 *     compete for that budget and start evicting real user corrections - a
 *     model guess pushing out a correction the user made by hand.
 *
 *  3. LIFECYCLE. A learned rule that is corrected three times is RETIRED and
 *     kept, so the settings screen can show the user their own history. A
 *     cached guess that turns out wrong should simply be deleted; there is
 *     nothing for the user to see and nothing they said.
 *
 * They share the fingerprint vocabulary, which is the part worth sharing, and
 * nothing else.
 *
 * WHAT IS STORED, AND AT WHICH SCOPE
 * Recorded at `global`. A stage-1 answer is derived from the question text, the
 * control kind and the offered options - none of which is site-specific - so
 * the answer is not site-specific either. This is also what makes the second
 * application free: a narrower scope would re-ask on every new employer, and
 * a new employer is what an application IS.
 *
 * Lookup still walks all four scopes, narrowest first, so a future
 * user-authored narrowing ("at THIS company that question means something
 * else") has somewhere to live without a migration.
 *
 * A NULL PATH IS A REAL ANSWER
 * "We asked, and there is no path for this question" is cached exactly like a
 * positive answer. Without it, decision #2 - at most one model call per
 * distinct question, ever - is false for precisely the questions we can never
 * answer, which are the ones a user meets on every form.
 *
 * NO NETWORK. This module imports no gateway and there is a test asserting it
 * never will.
 *
 * AN ANSWER IS BOUND TO THE QUESTION THAT WAS ACTUALLY ASKED
 * The fingerprint and the payload sent to the model are computed from the same
 * material but not by the same rules: the fingerprint hashes the first twelve
 * options, sorted; the request sends up to sixty, unsorted. So two fields can
 * share a fingerprint and put DIFFERENT text in front of the model - and since
 * this cache is global by design, one of those two fields can be on a page
 * written by somebody who would like to choose what the other one is told.
 *
 * That is a cross-site cache-poisoning route: craft a control whose first
 * twelve sorted options match a common real question, put whatever you like in
 * the rest, and the answer the model gives about YOUR question is the answer
 * this extension reuses on somebody else's form.
 *
 * So every entry also carries `payloadDigest` - a hash of the question, kind and
 * option labels handed to the port - and a lookup whose digest does not match is
 * a MISS. The cost of a mismatch is one model call. The cost of ignoring it is a
 * suggestion chosen by a third party.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { err, ok, type Result } from '@shared/result';
import type { KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import { isProfilePath, type ProfilePath } from '@profile/paths';
import type { FieldFingerprints } from '@form-engine/fingerprints/fingerprint';
import type { MappingScope } from '@learning/types';

const log = createLogger('semantic:cache');

/**
 * Scope precedence, narrowest first. Deliberately the same order as
 * `LearnedMappingStore` uses: two different answers to "which rule wins" would
 * be a bug nobody could see, because each would look right in its own file.
 */
const SCOPE_PRECEDENCE: readonly MappingScope[] = ['exact_field', 'company', 'ats', 'global'];

/**
 * Cap on cached concepts.
 *
 * Read in full on every scan that has refusals, so it must stay cheap to
 * deserialise. A heavy user meets hundreds of distinct novel questions, not
 * hundreds of thousands.
 */
const DEFAULT_MAX_ENTRIES = 500;

/** One remembered question. */
export interface CachedConcept {
  readonly scope: MappingScope;
  readonly fingerprint: string;
  /**
   * The concept, or null for "asked, and we have no path for this".
   * A null is as valuable as a path: it is what stops us re-asking forever.
   */
  readonly profilePath: ProfilePath | null;
  /** The question as a human would read it. For the settings screen only. */
  readonly normalizedLabel?: string;
  /**
   * Hash of the exact payload this answer was given for.
   *
   * Absent on entries written before this existed. Those are treated as misses
   * rather than trusted: what they were asked cannot be reconstructed, and the
   * price of finding out again is one model call, once.
   */
  readonly payloadDigest?: string;
  readonly createdAt: string;
}

export interface CacheOptions {
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export class SemanticConceptCache {
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: KeyValueStore,
    options: CacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The concept for this question, or null for a miss.
   *
   * A miss and a read failure are the same answer on purpose: losing the cache
   * degrades this feature to "ask again", which costs a call. Failing the scan
   * because a cache could not be read would turn a small problem into a broken
   * page - the same reasoning as `LearnedMappingStore.index()`.
   */
  async lookup(
    fingerprints: FieldFingerprints,
    payloadDigest: string,
  ): Promise<CachedConcept | null> {
    const entries = await this.load();

    for (const scope of SCOPE_PRECEDENCE) {
      const fingerprint = fingerprintForScope(fingerprints, scope);
      const match = entries.find(
        (entry) => entry.scope === scope && entry.fingerprint === fingerprint,
      );
      if (match === undefined) continue;

      // The fingerprint says "the same question"; the digest says "the same
      // question, asked the same way". Only the second is a safe basis for
      // reusing an answer across sites - see the header.
      if (match.payloadDigest !== payloadDigest) {
        log.debugLazy(() => ['Cached concept ignored: it answered a different payload']);
        return null;
      }
      return match;
    }
    return null;
  }

  /**
   * Remember a concept for this question. `null` records a known-unanswerable.
   *
   * Recorded at `global` - see the header for why that is the scope that makes
   * the second application free.
   */
  async record(
    fingerprints: FieldFingerprints,
    profilePath: ProfilePath | null,
    details: { normalizedLabel?: string; payloadDigest: string },
  ): Promise<Result<void, AppError>> {
    const entries = await this.load();
    const fingerprint = fingerprints.global;

    const entry: CachedConcept = {
      scope: 'global',
      fingerprint,
      profilePath,
      ...(details.normalizedLabel !== undefined
        ? { normalizedLabel: details.normalizedLabel }
        : {}),
      // Required, not optional, at the write site: an answer recorded without
      // the question it answered can never be safely reused, and making the
      // caller pass it means a new call site cannot forget.
      payloadDigest: details.payloadDigest,
      createdAt: this.now().toISOString(),
    };

    // Re-recording a question REPLACES it rather than appending. A second
    // answer to the same question is a correction, not a competitor, and two
    // entries with one fingerprint would make which one wins depend on array
    // order.
    const kept = entries.filter(
      (existing) => !(existing.scope === 'global' && existing.fingerprint === fingerprint),
    );
    kept.push(entry);

    return this.save(this.evictIfNeeded(kept));
  }

  /** Number of remembered questions. For the settings screen and for tests. */
  async size(): Promise<number> {
    return (await this.load()).length;
  }

  /** Forget everything. The user's escape hatch when the cache has gone wrong. */
  async clear(): Promise<Result<void, AppError>> {
    return this.store.remove(STORAGE_KEYS.semanticConcepts);
  }

  /**
   * Read and VALIDATE. Storage is a trust boundary like any other: these
   * entries may have been written by an older version of the extension that
   * knew a path this one no longer has, and an entry naming a vanished path
   * would resolve to `unknown_path` on every scan forever.
   */
  private async load(): Promise<CachedConcept[]> {
    const raw = await this.store.get<unknown>(STORAGE_KEYS.semanticConcepts);
    if (!raw.ok) {
      log.warn('Could not read the semantic cache; continuing without it', raw.error.code);
      return [];
    }
    if (!Array.isArray(raw.value)) return [];
    return raw.value.filter(isValidEntry);
  }

  private async save(entries: readonly CachedConcept[]): Promise<Result<void, AppError>> {
    const written = await this.store.set(STORAGE_KEYS.semanticConcepts, entries);
    if (!written.ok) {
      log.warn('Could not write the semantic cache', written.error.code);
      return err(written.error);
    }
    return ok(undefined);
  }

  /**
   * Drop the oldest entries when full.
   *
   * OLDEST-FIRST, NOT LEAST-RECENTLY-USED, and the difference is deliberate.
   * LRU needs a write on every read, and this is read once per scanned form -
   * so LRU would turn a free cache hit into a storage write on the hot path,
   * which is the one property this cache exists to avoid. Insertion order is a
   * worse eviction policy and a much cheaper one, and at 500 entries the
   * difference is theoretical.
   */
  private evictIfNeeded(entries: CachedConcept[]): CachedConcept[] {
    if (entries.length <= this.maxEntries) return entries;
    return entries.slice(entries.length - this.maxEntries);
  }
}

/** Pick the fingerprint a scope keys on. */
function fingerprintForScope(fingerprints: FieldFingerprints, scope: MappingScope): string {
  switch (scope) {
    case 'exact_field':
      return fingerprints.exact;
    case 'company':
      return fingerprints.company;
    case 'ats':
      return fingerprints.ats;
    case 'global':
      return fingerprints.global;
  }
}

/** Structural validation of one stored entry. */
function isValidEntry(value: unknown): value is CachedConcept {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<CachedConcept>;

  if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) return false;
  if (typeof entry.createdAt !== 'string') return false;
  if (
    entry.scope !== 'global' &&
    entry.scope !== 'ats' &&
    entry.scope !== 'company' &&
    entry.scope !== 'exact_field'
  ) {
    return false;
  }

  // A digest, when present, must be a plain string. An entry with a
  // non-string digest is a hand-edited or corrupted row; dropping it costs one
  // model call and removes the only way a stored value could confuse the
  // comparison below.
  if (entry.payloadDigest !== undefined && typeof entry.payloadDigest !== 'string') return false;

  // The important one. `null` is valid and meaningful; a string that is no
  // longer a path we have is not.
  if (entry.profilePath === null) return true;
  return typeof entry.profilePath === 'string' && isProfilePath(entry.profilePath);
}

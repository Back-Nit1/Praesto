/**
 * The semantic concept cache - Phase 8's question/answer memory.
 * ---------------------------------------------------------------------------
 * Maps a field fingerprint to the concept a previous semantic resolution found,
 * so that decision #2 of the design ("deterministic first, model last, cache
 * forever") is true rather than aspirational: each distinct question costs at
 * most ONE model call, ever, and a second application on the same ATS makes
 * none at all.
 *
 * =========================================================================
 * WHY THIS IS A SECOND STORE AND NOT AN EXTENSION OF `LearnedMappingStore`
 * =========================================================================
 * The brief asked for this decision to be made explicitly, because the shapes
 * genuinely do fit: both are keyed by the same four `FieldFingerprints`, both
 * resolve narrow-to-broad, both hold a profile path. Reusing the store was the
 * starting assumption. Five things killed it, in descending order of weight:
 *
 *  1. `userConfirmed` IS THE USER'S AUTHORITY, AND IT IS LOAD-BEARING.
 *     In `mapper.ts`, a user-confirmed rule with an empty path SHORT-CIRCUITS
 *     the entire cascade - it cancels other candidates rather than competing
 *     with them. Writing model output into that store means either setting
 *     `userConfirmed: true` (handing a model the power to silence a field the
 *     user never touched) or adding a third state to a boolean the mapper
 *     branches on. The first is a safety bug; the second makes the most
 *     safety-critical branch in the repo harder to read. A second store costs
 *     neither.
 *
 *  2. PROVENANCE HAS TO SURVIVE INTO SCORING. A semantic answer must be capped
 *     below `autofillThreshold` on first sight, while a learned correction sits
 *     at `sourceScores.learnedMapping`. `LearnedMapping` has no field saying
 *     where its claim came from, so a merged store could not score the two
 *     differently without inventing one - and that field IS the store boundary,
 *     just written in a worse place.
 *
 *  3. THE TWO WANT OPPOSITE EVICTION ORDERS. `evictIfNeeded` protects
 *     `userConfirmed` rules and ranks by `successfulUses - correctedUses`.
 *     Model-cached entries start at zero and would be evicted first - but they
 *     are precisely the entries whose loss COSTS MONEY to replace, while a
 *     discarded correction costs one re-correction. Here, nothing carries the
 *     user's authority, so nothing needs protecting and plain LRU is correct.
 *
 *  4. THE TYPE SYSTEM ALREADY SAYS THEY ARE DIFFERENT. `MappingSource` has
 *     both `'memory'` and `'semantic'`. Storing them together would contradict
 *     a distinction the rest of the codebase already draws.
 *
 *  5. THEY MUST BE SEPARATELY FORGETTABLE. "Clear what the model told us" is a
 *     privacy action; "clear my corrections" is a reset. One key each is what
 *     makes them two buttons instead of one destructive one.
 *
 * WHAT IS REUSED: `FieldFingerprints` / `FingerprintQuery`, the `MappingScope`
 * vocabulary, and the narrow-to-broad precedence rule. There is still exactly
 * one definition of "what makes two questions the same question".
 *
 * SCOPE, AND WHY ALMOST EVERYTHING LANDS ON `global`
 * Stage one is shown the question, the control kind and the options. It is NOT
 * shown the company, the ATS or the URL. An answer derived from that evidence
 * can only honestly be filed at `global`, and filing it narrower would both
 * overstate what it knows and force a fresh paid call for the same question at
 * the next company - defeating the point. Lookup still walks all four scopes
 * narrowest-first, so a future narrower writer works without a migration and
 * without a second precedence rule to keep in sync.
 *
 * NO PER-FIELD `lookup()`
 * `index()` loads the set once and returns a synchronous view, for the reason
 * spelled out in `learning/types.ts`: a per-field async lookup is one storage
 * round trip per field on every scan. The set is small - hundreds of entries,
 * a few KB.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { err, ok, type Result } from '@shared/result';
import type { KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import type { ControlKind } from '@form-engine/descriptor/types';
import type { FingerprintQuery, MappingScope } from '@learning/types';
import { isProfilePath, type ProfilePath } from '@profile/paths';
import type { ConceptResolution } from './types';

const log = createLogger('semantic:cache');

/**
 * Scope precedence, narrowest first. The lookup walks this order and returns
 * the first match, so the ordering IS the precedence rule - deliberately the
 * same order `LearnedMappingIndex` uses, because two stores that disagreed
 * about which scope wins would be indistinguishable from a bug.
 */
const SCOPE_PRECEDENCE: readonly MappingScope[] = ['exact_field', 'company', 'ats', 'global'];

/**
 * One remembered answer.
 *
 * There is no `id`. `(scope, fingerprint)` is already unique, and a synthetic
 * id would be a second identity for the same row - the kind of redundancy that
 * eventually lets two rows claim the same key.
 */
export interface CachedConcept {
  readonly scope: MappingScope;
  readonly semanticFingerprint: string;
  /**
   * The path this question means.
   *
   * `''` means "this question maps to NOTHING in the profile", and it is the
   * single most valuable entry the cache holds. Without a negative entry, a
   * form's untranslatable question ("How did you hear about us?") is paid for
   * on every scan, forever, to be told the same nothing each time. Empty string
   * rather than null so the stored shape matches `LearnedMapping.profilePath`,
   * which uses the same convention for the same meaning.
   */
  readonly profilePath: string;
  /** Mapping confidence, 0..1, as the resolving stage assessed it. */
  readonly confidence: number;
  /**
   * The question as it was asked, and the control it was asked with.
   *
   * Not needed to look anything up - the fingerprint does that. Kept because a
   * cache the user cannot read is a cache they cannot audit or trust, and
   * because a fingerprint you cannot explain is a fingerprint you cannot debug
   * (the same argument `SemanticSignature` makes).
   */
  readonly question: string;
  readonly kind: ControlKind;
  readonly createdAt: string;
  /** Drives LRU eviction. Advanced by `touch`, never on the read path. */
  readonly lastUsedAt: string;
}

/** What a caller supplies when remembering an answer. */
export interface ConceptRecord {
  readonly fingerprints: FingerprintQuery;
  /** Defaults to `global` - see the header for why that is the honest default. */
  readonly scope?: MappingScope;
  /** `null` records "maps to nothing", which is a real answer. */
  readonly profilePath: ProfilePath | null;
  readonly confidence: number;
  readonly question: string;
  readonly kind: ControlKind;
}

/**
 * A synchronous view over the cache, built once per scan.
 *
 * Mirrors `LearnedMappingIndex` on purpose: two indexes over the same key space
 * that read differently would be two chances to get the precedence wrong.
 */
export class SemanticCacheIndex {
  private readonly byScopeAndFingerprint = new Map<string, CachedConcept>();

  constructor(entries: readonly CachedConcept[]) {
    for (const entry of entries) {
      // Storage is a trust boundary, even when it is our own. An entry written
      // by an older build may name a path the registry has since dropped, and a
      // stale pointer must read as "not cached" - NOT as "maps to nothing",
      // which is a different claim and one we have no evidence for.
      if (!isStorable(entry)) continue;
      this.byScopeAndFingerprint.set(key(entry.scope, entry.semanticFingerprint), entry);
    }
  }

  find(query: FingerprintQuery): CachedConcept | null {
    for (const scope of SCOPE_PRECEDENCE) {
      const match = this.byScopeAndFingerprint.get(key(scope, fingerprintForScope(query, scope)));
      if (match !== undefined) return match;
    }
    return null;
  }

  get size(): number {
    return this.byScopeAndFingerprint.size;
  }
}

/** Storage-backed concept memory. */
export class SemanticConceptCache {
  /**
   * Cap on remembered concepts.
   *
   * The whole set is deserialised on every scan, so it has to stay small. Five
   * hundred is far more distinct questions than a heavy applicant meets in a
   * year of applying, and a few tens of KB in `chrome.storage.local`.
   */
  static readonly MAX_ENTRIES = 500;

  constructor(private readonly store: KeyValueStore) {}

  /** Every entry, for the settings screen. */
  async all(): Promise<Result<CachedConcept[], AppError>> {
    const raw = await this.store.get<CachedConcept[]>(STORAGE_KEYS.semanticConcepts);
    if (!raw.ok) return err(raw.error);
    return ok(raw.value ?? []);
  }

  /**
   * Build the index a scan consumes.
   *
   * A read failure yields an EMPTY index rather than an error, which is the
   * rule for this whole subsystem: every failure degrades to today's behaviour.
   * Losing the cache costs money on the next call; failing the scan costs the
   * user their application.
   */
  async index(): Promise<SemanticCacheIndex> {
    const all = await this.all();
    if (!all.ok) {
      log.warn('Could not load the concept cache; continuing without it', all.error.code);
      return new SemanticCacheIndex([]);
    }
    return new SemanticCacheIndex(all.value);
  }

  /**
   * Remember one answer.
   *
   * Upserts on `(scope, fingerprint)`: resolving the same question twice
   * replaces the entry rather than stacking two that then disagree.
   */
  async record(input: ConceptRecord, now = new Date()): Promise<Result<CachedConcept, AppError>> {
    // A path outside the registry is refused rather than stored. A model naming
    // a path we do not have is a refusal, not a fill - and it is certainly not
    // something to remember AS an answer, where it would be re-served for free
    // on every future scan without anyone re-checking it.
    if (input.profilePath !== null && !isProfilePath(input.profilePath)) {
      return err(
        new AppError('SCHEMA_VALIDATION_FAILED', 'Refusing to cache an unknown profile path', {
          context: { profilePath: input.profilePath },
        }),
      );
    }

    const existing = await this.all();
    if (!existing.ok) return err(existing.error);

    const scope = input.scope ?? 'global';
    const fingerprint = fingerprintForScope(input.fingerprints, scope);
    const stamp = now.toISOString();
    const entries = [...existing.value];
    const at = entries.findIndex(
      (entry) => entry.scope === scope && entry.semanticFingerprint === fingerprint,
    );

    const saved: CachedConcept = {
      scope,
      semanticFingerprint: fingerprint,
      profilePath: input.profilePath ?? '',
      confidence: input.confidence,
      question: input.question,
      kind: input.kind,
      createdAt: at >= 0 ? (entries[at]?.createdAt ?? stamp) : stamp,
      lastUsedAt: stamp,
    };

    if (at >= 0) entries[at] = saved;
    else entries.push(saved);

    const written = await this.store.set(STORAGE_KEYS.semanticConcepts, evictIfNeeded(entries));
    if (!written.ok) return err(written.error);

    log.info(`Cached: ${fingerprint} -> ${saved.profilePath || '(nothing)'} at ${scope}`);
    return ok(saved);
  }

  /**
   * Mark an entry as used, so eviction can prefer to forget what nobody needs.
   *
   * A WRITE, so it is deliberately NOT on the lookup path - call it once after
   * a scan has decided, with the fingerprints that actually hit, rather than
   * per field while the user waits. An un-touched cache still works; it just
   * evicts less cleverly, which is the correct thing to trade away.
   */
  async touch(fingerprints: FingerprintQuery, now = new Date()): Promise<Result<void, AppError>> {
    const existing = await this.all();
    if (!existing.ok) return err(existing.error);

    const hit = new SemanticCacheIndex(existing.value).find(fingerprints);
    if (hit === null) return ok(undefined); // Nothing was used.

    const stamp = now.toISOString();
    const updated = existing.value.map((entry) =>
      entry.scope === hit.scope && entry.semanticFingerprint === hit.semanticFingerprint
        ? { ...entry, lastUsedAt: stamp }
        : entry,
    );

    const written = await this.store.set(STORAGE_KEYS.semanticConcepts, updated);
    return written.ok ? ok(undefined) : err(written.error);
  }

  /** Forget one answer. Keyed the way it is stored, because that key is unique. */
  async remove(scope: MappingScope, fingerprint: string): Promise<Result<void, AppError>> {
    const existing = await this.all();
    if (!existing.ok) return err(existing.error);

    const remaining = existing.value.filter(
      (entry) => !(entry.scope === scope && entry.semanticFingerprint === fingerprint),
    );
    const written = await this.store.set(STORAGE_KEYS.semanticConcepts, remaining);
    return written.ok ? ok(undefined) : err(written.error);
  }

  /**
   * Forget everything the model ever told us.
   *
   * Touches only this key, so it cannot take the user's own corrections with
   * it. That separation is one of the reasons this is not the same store.
   */
  async clear(): Promise<Result<void, AppError>> {
    const written = await this.store.set(STORAGE_KEYS.semanticConcepts, []);
    return written.ok ? ok(undefined) : err(written.error);
  }
}

/**
 * Present a cache hit as a resolution.
 *
 * `previously_seen` in both directions, including for a remembered "maps to
 * nothing": we HAVE seen this question and we DO know the answer, and the
 * answer happens to be that there is nothing to fill. `decideFill` skips a null
 * path already, so the honest state is the one that says we recognised it.
 *
 * Lives here rather than at the call site so exactly one place decides what a
 * cache hit claims about our knowledge.
 */
export function toResolution(fieldId: string, entry: CachedConcept): ConceptResolution {
  return {
    fieldId,
    profilePath: entry.profilePath === '' ? null : (entry.profilePath as ProfilePath),
    confidence: entry.confidence,
    knowledgeState: 'previously_seen',
    origin: 'cache',
  };
}

/** Composite index key. The separator cannot occur in a hex fingerprint. */
function key(scope: MappingScope, fingerprint: string): string {
  return `${scope}:${fingerprint}`;
}

/** The fingerprint a given scope keys on. */
function fingerprintForScope(query: FingerprintQuery, scope: MappingScope): string {
  switch (scope) {
    case 'exact_field':
      return query.exact;
    case 'company':
      return query.company;
    case 'ats':
      return query.ats;
    case 'global':
      return query.global;
  }
}

/**
 * Whether a stored entry may still be believed.
 *
 * Runs on READ, not only on write, because the entry may have been written by a
 * build that knew a path this one does not - and because a cache that re-serves
 * a value nobody re-checks is exactly where a stale mistake becomes permanent.
 */
function isStorable(entry: CachedConcept): boolean {
  if (entry.profilePath !== '' && !isProfilePath(entry.profilePath)) return false;
  return (
    Number.isFinite(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 1
  );
}

/**
 * Keep the set under its cap by forgetting what has gone longest unused.
 *
 * Plain LRU, and notably NOT the learned-mapping store's policy. There, some
 * rules are the user's and must be protected from silent deletion. Here every
 * entry is ours, they differ only in what they cost to replace, and the
 * cheapest one to lose is the one nothing has needed.
 */
function evictIfNeeded(entries: CachedConcept[]): CachedConcept[] {
  if (entries.length <= SemanticConceptCache.MAX_ENTRIES) return entries;

  const byRecency = [...entries].sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
  const evicted = byRecency.length - SemanticConceptCache.MAX_ENTRIES;
  log.info(`Concept cache is full; forgetting ${evicted} least-recently-used answers`);
  return byRecency.slice(evicted);
}

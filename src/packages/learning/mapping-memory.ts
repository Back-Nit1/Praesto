/**
 * Learned mapping memory.
 * ---------------------------------------------------------------------------
 * Spec section 19, and the single feature that separates this tool from a
 * generic autofiller:
 *
 *   > Generic products must work reasonably for everyone. This tool should
 *   > become extremely good for the specific applicant using it.
 *
 * A generic autofiller has to stay conservative forever, because it can never
 * learn anything about you. This one gets a signal every time you correct a
 * field, and every correction is permanent.
 *
 * THE FOUR SCOPES, AND WHY NARROWER WINS
 *
 *     exact_field  this precise question, on this precise form
 *     company      at this company, "Preferred hub" means preferredLocations
 *     ats          on Greenhouse, "Phone" means contact.phone
 *     global       "Given name" means legalFirstName, everywhere
 *
 * A narrower rule is a more specific claim about the world, and specific
 * information must not be overridden by general information. "At THIS company
 * this field means X" is strictly more informative than "this field usually
 * means X", so scope precedence runs narrow-to-broad.
 *
 * WHY THE WHOLE SET IS LOADED AT ONCE
 * The mapper runs over every field on a page and its lookup is synchronous (see
 * `types.ts` for why). So the service worker loads the rule set once per resolve
 * batch and hands the mapper an in-memory index. The set is small - a heavy user
 * accumulates hundreds of rules, not millions - so this is a few KB and removes
 * an entire class of per-field latency.
 *
 * BAD RULES MUST NOT TRAP THE SYSTEM
 * Spec section 19 is explicit that a wrong learned rule must be escapable.
 * Three mechanisms, layered:
 *   1. correction counts feed an UNCAPPED confidence penalty, so a repeatedly
 *      wrong rule falls out of contention on its own,
 *   2. a rule corrected past `MAX_CORRECTIONS_BEFORE_RETIREMENT` is retired and
 *      stops being returned at all,
 *   3. the user can delete any rule from the settings screen.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { newId } from '@shared/ids';
import { err, ok, type Result } from '@shared/result';
import type { KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import type { ATSKind } from '@ats/types';
import type {
  FingerprintQuery,
  LearnedMapping,
  LearnedMappingLookup,
  MappingScope,
} from './types';

const log = createLogger('learning:mappings');

/**
 * Scope precedence, narrowest first. The lookup walks this order and returns
 * the first match, so the ordering IS the precedence rule - there is no second
 * place where it could disagree.
 */
const SCOPE_PRECEDENCE: readonly MappingScope[] = ['exact_field', 'company', 'ats', 'global'];

/**
 * A rule the user has corrected this many times is retired.
 *
 * Three is chosen to be forgiving of a single mis-click while still being
 * decisive: if you have told the system three times that a rule is wrong, it
 * has no business continuing to suggest it. Retired rules are kept rather than
 * deleted so the settings screen can show them and the user can see the system
 * actually listened.
 */
const MAX_CORRECTIONS_BEFORE_RETIREMENT = 3;

/**
 * Cap on stored rules.
 *
 * Rules live in `chrome.storage.local` and are read on every resolve batch, so
 * the set has to stay small enough to deserialise cheaply. When full, the
 * least-recently-useful rule is evicted - see `evictIfNeeded`.
 */
const MAX_STORED_MAPPINGS = 1000;

/** What the caller supplies when recording a correction. */
export interface CorrectionInput {
  /** Fingerprints of the field being corrected, at every scope. */
  fingerprints: FingerprintQuery;
  /** How broadly the user wants this correction to apply. */
  scope: MappingScope;
  /** The path the user says this field means. `null` means "maps to nothing". */
  profilePath: string | null;
  hostname: string;
  ats: ATSKind;
  /** The field's normalized label, for the settings screen. */
  normalizedLabel?: string;
  fieldType?: string;
}

/**
 * An index over the rule set, built once per resolve batch.
 *
 * Implements the synchronous `LearnedMappingLookup` the mapper needs. The
 * index is a plain Map keyed by `scope + fingerprint`, so a lookup is four Map
 * hits regardless of how many rules are stored.
 */
export class LearnedMappingIndex implements LearnedMappingLookup {
  private readonly byScopeAndFingerprint = new Map<string, LearnedMapping>();

  constructor(mappings: readonly LearnedMapping[]) {
    for (const mapping of mappings) {
      // A retired rule is indexed as if it did not exist. It stays in storage
      // so the user can see it in settings, but it must never influence a fill.
      if (isRetired(mapping)) continue;
      this.byScopeAndFingerprint.set(key(mapping.scope, mapping.semanticFingerprint), mapping);
    }
  }

  find(query: FingerprintQuery): LearnedMapping | null {
    for (const scope of SCOPE_PRECEDENCE) {
      const fingerprint = fingerprintForScope(query, scope);
      const match = this.byScopeAndFingerprint.get(key(scope, fingerprint));
      if (match !== undefined) return match;
    }
    return null;
  }

  get size(): number {
    return this.byScopeAndFingerprint.size;
  }
}

/** Storage-backed rule set. */
export class LearnedMappingStore {
  constructor(private readonly store: KeyValueStore) {}

  /** Every rule, retired ones included. Used by the settings screen. */
  async all(): Promise<Result<LearnedMapping[], AppError>> {
    const raw = await this.store.get<LearnedMapping[]>(STORAGE_KEYS.learnedMappings);
    if (!raw.ok) return err(raw.error);
    return ok(raw.value ?? []);
  }

  /**
   * Build the index the mapper consumes.
   *
   * A read failure yields an EMPTY index rather than an error. Losing learned
   * mappings degrades the extension to its generic behaviour, which still
   * works; failing the whole resolve batch because a cache could not be read
   * would turn a minor problem into a broken page.
   */
  async index(): Promise<LearnedMappingIndex> {
    const all = await this.all();
    if (!all.ok) {
      log.warn('Could not load learned mappings; continuing without them', all.error.code);
      return new LearnedMappingIndex([]);
    }
    return new LearnedMappingIndex(all.value);
  }

  /**
   * Record a user correction.
   *
   * Upserts on (scope, fingerprint): correcting the same field twice updates
   * the existing rule rather than stacking duplicates that would then disagree
   * with each other.
   *
   * A correction always sets `userConfirmed: true`, which is what lets it
   * override the alias registry in the mapper. The user is the authority on
   * their own application; a table we wrote is not.
   */
  async recordCorrection(input: CorrectionInput): Promise<Result<LearnedMapping, AppError>> {
    const existing = await this.all();
    if (!existing.ok) return err(existing.error);

    const fingerprint = fingerprintForScope(input.fingerprints, input.scope);
    const now = new Date().toISOString();
    const mappings = [...existing.value];

    const index = mappings.findIndex(
      (mapping) => mapping.scope === input.scope && mapping.semanticFingerprint === fingerprint,
    );

    let saved: LearnedMapping;

    if (index >= 0) {
      const previous = mappings[index];
      if (previous === undefined) return err(new AppError('UNKNOWN', 'Rule vanished mid-update'));

      // The user is REPLACING an existing rule's target. Reset the counters:
      // the history belonged to the old target and says nothing about the new
      // one, and carrying a correction count over would penalise a rule the
      // user has just personally endorsed.
      const targetChanged = previous.profilePath !== (input.profilePath ?? '');
      saved = {
        ...previous,
        profilePath: input.profilePath ?? '',
        userConfirmed: true,
        successfulUses: targetChanged ? 0 : previous.successfulUses,
        correctedUses: targetChanged ? 0 : previous.correctedUses,
        updatedAt: now,
      };
      mappings[index] = saved;
    } else {
      saved = {
        id: newId('lm'),
        scope: input.scope,
        semanticFingerprint: fingerprint,
        profilePath: input.profilePath ?? '',
        userConfirmed: true,
        successfulUses: 0,
        correctedUses: 0,
        createdAt: now,
        updatedAt: now,
        ...(input.scope !== 'global' ? { ats: input.ats } : {}),
        ...(input.scope === 'company' || input.scope === 'exact_field'
          ? { hostname: input.hostname }
          : {}),
        ...(input.normalizedLabel !== undefined ? { normalizedLabel: input.normalizedLabel } : {}),
        ...(input.fieldType !== undefined ? { fieldType: input.fieldType } : {}),
      };
      mappings.push(saved);
    }

    const written = await this.store.set(STORAGE_KEYS.learnedMappings, evictIfNeeded(mappings));
    if (!written.ok) return err(written.error);

    log.info(`Learned: ${fingerprint} -> ${saved.profilePath || '(none)'} at ${input.scope}`);
    return ok(saved);
  }

  /**
   * Record that a rule produced a fill the user did not change.
   *
   * Called after a fill run. Each uncorrected use nudges confidence up, capped
   * by the policy - a rule that has worked fifty times is more trustworthy than
   * one used once, but not without limit.
   */
  async recordSuccess(
    fingerprints: FingerprintQuery,
  ): Promise<Result<void, AppError>> {
    return this.adjust(fingerprints, (mapping) => ({
      ...mapping,
      successfulUses: mapping.successfulUses + 1,
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * Record that the user changed a value this rule produced.
   *
   * Feeds the uncapped correction penalty in the confidence policy, and
   * eventually retires the rule outright.
   */
  async recordMiss(fingerprints: FingerprintQuery): Promise<Result<void, AppError>> {
    return this.adjust(fingerprints, (mapping) => ({
      ...mapping,
      correctedUses: mapping.correctedUses + 1,
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Delete one rule. The user's escape hatch from a bad correction. */
  async remove(id: string): Promise<Result<void, AppError>> {
    const existing = await this.all();
    if (!existing.ok) return err(existing.error);

    const remaining = existing.value.filter((mapping) => mapping.id !== id);
    const written = await this.store.set(STORAGE_KEYS.learnedMappings, remaining);
    return written.ok ? ok(undefined) : err(written.error);
  }

  /** Delete everything. Offered in settings as a hard reset. */
  async clear(): Promise<Result<void, AppError>> {
    const written = await this.store.set(STORAGE_KEYS.learnedMappings, []);
    return written.ok ? ok(undefined) : err(written.error);
  }

  /**
   * Apply a change to whichever rule the lookup would have matched.
   *
   * Resolving through the same precedence the mapper used matters: the
   * feedback has to land on the rule that actually produced the fill, not on
   * some other rule that also happens to match at a broader scope.
   */
  private async adjust(
    fingerprints: FingerprintQuery,
    mutate: (mapping: LearnedMapping) => LearnedMapping,
  ): Promise<Result<void, AppError>> {
    const existing = await this.all();
    if (!existing.ok) return err(existing.error);

    const matched = new LearnedMappingIndex(existing.value).find(fingerprints);
    if (matched === null) return ok(undefined); // No rule was responsible.

    const updated = existing.value.map((mapping) =>
      mapping.id === matched.id ? mutate(mapping) : mapping,
    );
    const written = await this.store.set(STORAGE_KEYS.learnedMappings, updated);
    return written.ok ? ok(undefined) : err(written.error);
  }
}

/** True when a rule has been corrected too often to be trusted. */
export function isRetired(mapping: LearnedMapping): boolean {
  return mapping.correctedUses >= MAX_CORRECTIONS_BEFORE_RETIREMENT;
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
 * Keep the stored set under its cap.
 *
 * Evicts the least useful rules first, where "useful" is
 * `successfulUses - correctedUses`, breaking ties by age. User-confirmed rules
 * are protected: the user typed those deliberately, and silently discarding one
 * would make the system feel like it forgets - the exact failure this whole
 * subsystem exists to prevent.
 */
function evictIfNeeded(mappings: LearnedMapping[]): LearnedMapping[] {
  if (mappings.length <= MAX_STORED_MAPPINGS) return mappings;

  const scored = [...mappings].sort((a, b) => {
    if (a.userConfirmed !== b.userConfirmed) return a.userConfirmed ? 1 : -1;
    const usefulness = (m: LearnedMapping) => m.successfulUses - m.correctedUses;
    const delta = usefulness(a) - usefulness(b);
    if (delta !== 0) return delta;
    return a.updatedAt.localeCompare(b.updatedAt);
  });

  const evicted = scored.length - MAX_STORED_MAPPINGS;
  log.info(`Learned-mapping store is full; evicting ${evicted} least-useful rules`);
  return scored.slice(evicted);
}

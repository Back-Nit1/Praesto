/**
 * Learned mapping memory - types and the lookup contract.
 * ---------------------------------------------------------------------------
 * Spec section 19: "Generic products must work reasonably for everyone. This
 * tool should become extremely good for the specific applicant using it."
 *
 * That is the whole thesis. A generic autofiller has to be conservative forever
 * because it cannot learn anything about you. This one gets a correction signal
 * every time you fix a field, and every correction is permanent.
 *
 * WHY THE TYPES LIVE IN THEIR OWN MODULE
 * The mapper needs to CONSULT learned mappings; it must not depend on how they
 * are stored. Defining the lookup contract here - with no storage imports - lets
 * the mapper stay a pure function of its inputs, which is what makes the entire
 * mapping cascade testable in Node with hand-written fixtures.
 */
import type { ATSKind } from '@ats/types';

/**
 * How broadly a learned mapping applies.
 *
 * Narrower scopes are stronger claims and win when several match. "At THIS
 * company, 'Preferred hub' means preferred locations" is more specific
 * information than "'Preferred hub' generally means preferred locations", and
 * specific information should not be overridden by general information.
 */
export type MappingScope = 'global' | 'ats' | 'company' | 'exact_field';

export interface LearnedMapping {
  id: string;
  scope: MappingScope;

  /** Set when scope is 'ats' or narrower. */
  ats?: ATSKind;
  /** Set when scope is 'company' or narrower. */
  hostname?: string;

  /**
   * The fingerprint this rule keys on, at the matching scope.
   * See fingerprints/fingerprint.ts for why this is meaning-derived.
   */
  semanticFingerprint: string;

  /** Kept for the settings UI, so a user can read their own learned rules. */
  normalizedLabel?: string;
  fieldType?: string;

  /** The canonical path the user said this field means. */
  profilePath: string;

  /**
   * True when this came from an explicit user correction, as opposed to being
   * inferred from a successful automatic fill.
   *
   * A user-confirmed rule outranks every heuristic in the cascade: the user is
   * the authority on their own application, and a rule they set must not be
   * quietly overruled by an alias table we wrote.
   */
  userConfirmed: boolean;

  /** Times this rule produced a fill the user did not change. */
  successfulUses: number;
  /** Times the user corrected a field this rule had mapped. */
  correctedUses: number;

  createdAt: string;
  updatedAt: string;
}

/**
 * The set of fingerprints a lookup is performed against.
 * Mirrors `FieldFingerprints`, restated here so this module stays independent
 * of the form-engine package.
 */
export interface FingerprintQuery {
  global: string;
  ats: string;
  company: string;
  exact: string;
}

/**
 * Read side of the learning store, as seen by the mapper.
 *
 * SYNCHRONOUS ON PURPOSE. The mapper runs over every field of a page, and an
 * async lookup per field would either serialise into hundreds of awaits or
 * force the whole cascade to be async - which would in turn make the mapping
 * logic untestable without a promise-aware harness. Instead the service worker
 * loads the learned-mapping set ONCE per resolution batch and hands the mapper
 * an in-memory view. The set is small (hundreds of rules), so this costs a few
 * KB and removes an entire class of latency.
 */
export interface LearnedMappingLookup {
  /**
   * Best matching rule for these fingerprints, or null.
   *
   * The implementation is responsible for scope precedence: exact_field beats
   * company beats ats beats global.
   */
  find(query: FingerprintQuery): LearnedMapping | null;
}

/** A lookup that knows nothing. The default before Phase 5 is wired up. */
export const EMPTY_LOOKUP: LearnedMappingLookup = {
  find: () => null,
};

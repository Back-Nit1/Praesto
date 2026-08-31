/**
 * Semantic fallback - the shared vocabulary.
 * ---------------------------------------------------------------------------
 * This package exists to answer ONE question, on the fields the deterministic
 * pipeline refused:
 *
 *     "The mapper could not name this question, or the resolver could not match
 *      our answer to any option it offered. Is there a defensible answer here?"
 *
 * WHAT IT IS NOT
 * It is not a second mapper, and nothing here is permitted to fill a field. A
 * semantic result re-enters the EXISTING pipeline - `resolveValue`, then
 * `decideFill` - so the sensitive-path gate in `confidence/policy.ts` applies to
 * a model-derived mapping exactly as it applies to an alias match. That gate is
 * the entire safety story of this feature, and it is deliberately not
 * reimplemented here: there is one copy of it, upstream of everything.
 *
 * THE ORDER, WHICH IS THE WHOLE DESIGN
 *     cache      -> free, private, instant. A question is asked at most once, ever.
 *     scorer     -> free, private, deterministic. Kills the easy option-matching cases.
 *     model      -> last. Two stages, minimal data, and its answer is a
 *                   SUGGESTION that must survive `decideFill` like any other.
 *
 * PRIVACY SHAPE (Security.md, and decision #4 of the brief)
 * Stage 1 sends the question, the control kind, and the offered options - all
 * of which the PAGE wrote. No profile data crosses it at all. Stage 2 sends one
 * already-resolved value plus that field's option list, and only when the
 * deterministic scorer could not settle the match on its own.
 */
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { ProfilePath } from '@profile/paths';

/**
 * Why a field reached this package.
 *
 * Only two, and the pairing is not arbitrary: both are MATCHING failures, which
 * is the kind of problem a model can plausibly help with. The resolver's other
 * refusals (`no_value`, `no_entry`, `unknown_path`) mean the profile is
 * incomplete or a stored rule is stale - problems no amount of language
 * understanding can fix, and asking about them would spend the user's quota to
 * arrive back where we started.
 */
export type SemanticRefusalKind =
  /** The cascade did not recognise the question at all. Needs stage 1. */
  | 'no_mapping'
  /** We know what the field asks and our answer matched no offered option. */
  | 'no_matching_option';

/** One field the deterministic pipeline declined, held for a second attempt. */
export interface RefusedField {
  /** The descriptor's `localId`. */
  readonly fieldId: string;
  /**
   * The full descriptor.
   *
   * Carried whole rather than reduced to a question string, because stage 1
   * needs the control kind and the option list, the cache needs the
   * fingerprints, and `resolveValue` needs the descriptor itself. Reducing it
   * here would mean reconstructing it three times downstream.
   */
  readonly descriptor: FieldDescriptor;
  readonly kind: SemanticRefusalKind;
  /**
   * The path the mapper already found. Always null for `no_mapping`, and always
   * set for `no_matching_option` - in the second case the concept was never in
   * doubt, only its rendering against this control's options.
   */
  readonly profilePath: ProfilePath | null;
}

/**
 * How a concept for a previously-unmapped field was arrived at.
 *
 * Kept distinct from `MappingSource` because the interesting distinction here
 * is what it COST and how much it should be trusted, not which stage of the
 * cascade fired.
 */
export type ConceptOrigin =
  /** A previous answer for this exact question, from local storage. Free. */
  | 'cache'
  /** A remote stage-1 call. Costs a call, and is capped below the fill line. */
  | 'model';

/** A question resolved to a canonical concept. */
export interface ConceptResolution {
  readonly fieldId: string;
  /** Always a validated `ProfilePath`. A path we do not have is a refusal. */
  readonly profilePath: ProfilePath;
  readonly origin: ConceptOrigin;
  /**
   * Mapping confidence, capped below `autofillThreshold` by construction.
   * See `SEMANTIC_MAPPING_CONFIDENCE` in `confidence/policy.ts` for why.
   */
  readonly confidence: number;
}

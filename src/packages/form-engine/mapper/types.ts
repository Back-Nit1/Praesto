/**
 * Mapping result types.
 * ---------------------------------------------------------------------------
 * Spec section 12.3 is emphatic that these five states must never collapse into
 * a single guess:
 *
 *     I KNOW this answer.
 *     I can DERIVE this answer.
 *     I have SEEN the user answer this before.
 *     I THINK this is probably the answer.
 *     I DON'T KNOW.
 *
 * Most autofill tools flatten all five into "here is a value" and let the user
 * discover which one it was. Keeping them distinct all the way to the UI is
 * what lets the side panel say "3 need review, 2 unknown" instead of silently
 * filling five fields and hoping.
 */
import type { ProfilePath } from '@profile/paths';

/**
 * What the system knows about this field.
 * Ordered from most to least certain.
 */
export type KnowledgeState =
  /** A stored, high-confidence value maps directly. */
  | 'known'
  /** Composable from stored values (full name from first + last). */
  | 'derived'
  /** The user has answered this exact question before. */
  | 'previously_seen'
  /** Our best interpretation, below the certainty bar. Needs review. */
  | 'probable'
  /** No idea. Left untouched, surfaced to the user. */
  | 'unknown';

/** Which stage of the cascade produced the mapping. */
export type MappingSource =
  | 'html' // autocomplete attribute
  | 'alias' // normalized label matched the alias registry
  | 'ats' // an ATS-specific rule
  | 'memory' // a learned mapping from a past correction
  | 'fuzzy' // token-overlap similarity
  | 'semantic' // remote semantic fallback (not wired yet)
  | 'none';

/**
 * One piece of the explanation for a mapping.
 *
 * Reasons are structured data, not prose, so the debug panel can render them,
 * tests can assert on them, and a future calibration pass can aggregate them
 * across a corpus to find which signals actually pay for themselves.
 */
export interface MappingReason {
  /** Which signal fired. */
  signal:
    | 'autocomplete'
    | 'label_exact'
    | 'name_exact'
    | 'compact_match'
    | 'ats_rule'
    | 'learned_mapping'
    | 'fuzzy_label'
    | 'section_context'
    | 'option_shape'
    | 'negation_detected'
    | 'ambiguous_alias';
  /** The text or token that matched, for display. */
  matched?: string;
  /** This signal's independent contribution, for debugging the arithmetic. */
  score?: number;
  /** Free-text detail for the debug panel only. */
  detail?: string;
}

export interface FieldMappingResult {
  /** The descriptor's `localId`. Ties the result back to a DOM element. */
  fieldId: string;
  /** The canonical path, or null when we do not know. */
  profilePath: ProfilePath | null;
  /** 0..1. How sure we are about the mapping - NOT about the value. */
  confidence: number;
  knowledgeState: KnowledgeState;
  /** Every signal that contributed, strongest first. */
  reasons: MappingReason[];
  source: MappingSource;
  /**
   * Other paths that also matched.
   *
   * Present so ambiguity is visible rather than discarded. When "start date"
   * matches both an education and an employment path, the user (or a later ATS
   * rule) can see the alternative instead of only our first choice.
   */
  alternatives?: Array<{ profilePath: ProfilePath; confidence: number }>;
}

/** The "we do not know" result. Its own constructor so it reads deliberately. */
export function unknownMapping(fieldId: string, reasons: MappingReason[] = []): FieldMappingResult {
  return {
    fieldId,
    profilePath: null,
    confidence: 0,
    knowledgeState: 'unknown',
    reasons,
    source: 'none',
  };
}

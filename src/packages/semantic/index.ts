/**
 * The semantic fallback package - its one entry point.
 * ---------------------------------------------------------------------------
 * Everything a caller needs, and deliberately nothing else. The internals
 * (`cache.ts`, `concept.ts`, `option-match.ts`) are importable for tests, but a
 * consumer wiring this into the pipeline should need only what is here.
 *
 * THE SEQUENCE A CALLER RUNS, and why it is a caller's job rather than this
 * package's: stage 2 needs a resolved profile VALUE, and this package must not
 * read the profile. Keeping the sequencing in `background.ts` - which already
 * holds the profile and already owns the pipeline - is what lets `@semantic`
 * stay free of `@profile` data access entirely.
 *
 *     1. collectRefusals(outcomes)         what the pipeline declined
 *     2. resolveConcepts({...})            cache, then one batched call
 *     3. resolveValue(...)                 EXISTING, unchanged
 *     4. chooseOption({...})               scorer, then at most one call
 *     5. decideFill(...)                   EXISTING, unchanged - the safety gate
 */
export { collectRefusals, type FieldOutcome } from './queue';
export { resolveConcepts, type ConceptStageInput, type ConceptStageOutcome } from './concept';
export {
  matchOption,
  chooseOption,
  type MatchStrategy,
  type OptionMatch,
  type OptionStageInput,
  type OptionStageOutcome,
} from './option-match';
export { SemanticConceptCache, type CachedConcept, type CacheOptions } from './cache';
export type {
  ConceptAnswer,
  ConceptQuestion,
  OptionChoiceAnswer,
  OptionChoiceQuestion,
  SemanticPort,
} from './port';
export type {
  ConceptOrigin,
  ConceptResolution,
  RefusedField,
  SemanticRefusalKind,
} from './types';

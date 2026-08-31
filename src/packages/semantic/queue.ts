/**
 * The refusal queue - the gate on the whole semantic subsystem.
 * ---------------------------------------------------------------------------
 * PURE, SYNCHRONOUS, NO I/O. It takes what the existing pipeline already
 * decided and emits the subset worth a second attempt. That shape is what keeps
 * this feature additive: the mapper stays synchronous and pure, and a form the
 * extension already understands produces an EMPTY queue and therefore costs
 * nothing - no storage read, no network, no latency.
 *
 * The interesting logic is entirely subtractive. Five distinct situations all
 * present as "this field was not filled", and only two of them are ours:
 *
 *     no_mapping           we did not recognise the question    -> OURS
 *     no_matching_option   our answer fit none of the options   -> OURS
 *     no_value/no_entry    the profile is incomplete            -> a UI problem
 *     unknown_path         a stale learned rule                 -> a bug
 *     user_declined        the user said leave this alone       -> AN INSTRUCTION
 *
 * The last one is the reason this module exists as a named thing rather than as
 * a filter expression at a call site. `profilePath === null` is true for it and
 * for a genuinely unrecognised question, and treating the two alike would mean
 * the extension asking a model about a field its user had explicitly told it to
 * stop touching. That is a one-character mistake to make and an invisible one to
 * live with, so it is written down, and there is a test named after it.
 */
import { selectQuestionText } from '@form-engine/fingerprints/fingerprint';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { FieldMappingResult } from '@form-engine/mapper/types';
import type { ResolutionResult } from '@form-engine/resolver/resolver';
import type { RefusedField } from './types';

/** What the pipeline concluded about one field. */
export interface FieldOutcome {
  readonly descriptor: FieldDescriptor;
  readonly mapping: FieldMappingResult;
  /** Absent when the mapper refused, since resolution never ran. */
  readonly resolution?: ResolutionResult;
}

/**
 * Select the fields worth a second attempt.
 *
 * Returns a new array; never mutates its input. An empty result is the common
 * case and the cheap one - callers are expected to short-circuit on it.
 */
export function collectRefusals(outcomes: readonly FieldOutcome[]): RefusedField[] {
  const queued: RefusedField[] = [];

  for (const outcome of outcomes) {
    const { descriptor, mapping, resolution } = outcome;

    // --- reasons to skip a field regardless of WHY it was refused -----------
    //
    // Both of these would spend a model call on a field that could not be
    // filled even with a perfect answer, so they are checked before the
    // refusal kind rather than duplicated into each branch.

    // We never overwrite a value the user or the ATS already put there
    // (`decideFill` enforces this), so asking about it is pure waste.
    if ((descriptor.currentValue ?? '').trim().length > 0) continue;

    // Stage 1's entire input is the question text. A control with no label, no
    // accessible name, no nearby prose and no placeholder gives a model nothing
    // to reason from, and an answer derived from nothing is a guess wearing a
    // confidence score.
    if (selectQuestionText(descriptor).length === 0) continue;

    if (mapping.profilePath === null) {
      // ONLY `no_mapping`. `user_declined` is an instruction and
      // `unfillable_control` is unactionable; both are silently correct
      // behaviour that this package must not undo.
      if (mapping.refusalReason !== 'no_mapping') continue;

      queued.push({
        fieldId: descriptor.localId,
        descriptor,
        kind: 'no_mapping',
        profilePath: null,
      });
      continue;
    }

    // Mapped. The only failure worth retrying is the matching one.
    if (resolution === undefined || resolution.ok) continue;
    if (resolution.reason !== 'no_matching_option') continue;

    queued.push({
      fieldId: descriptor.localId,
      descriptor,
      kind: 'no_matching_option',
      profilePath: mapping.profilePath,
    });
  }

  return queued;
}

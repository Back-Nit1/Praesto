/**
 * The refusal queue.
 * ---------------------------------------------------------------------------
 * Takes what the deterministic pipeline decided about every field on a page and
 * emits only the fields worth a second attempt. Pure, synchronous, no I/O.
 *
 * THIS MODULE IS THE GATE, AND THE GATE IS THE SAFETY STORY
 * Everything admitted here may eventually be described to a remote model. A
 * field dropped here can never leak, no matter what a later stage does or how
 * it is later rewritten. That makes the drop list the most important part of
 * the file, so it is written out explicitly rather than expressed as the
 * complement of an admit list.
 *
 * WHAT IS ADMITTED - and only these two:
 *
 *   no_mapping          The cascade recognised no signal at all. The question
 *                       may well have an answer; we did not recognise it.
 *   no_matching_option  We know the question AND our answer, and the control's
 *                       vocabulary spells it differently. This is a string
 *                       matching problem, and it is solvable.
 *
 * WHAT IS DROPPED, AND WHY EACH ONE IS NOT OURS TO FIX:
 *
 *   user_suppressed       The user told us to leave this field alone. This is
 *                         the user's own answer, not an absence of one, and
 *                         nothing in this package may reopen it.
 *   unsupported_control   Disabled, or a `kind` no adapter can drive. A perfect
 *                         answer would still be unfillable.
 *   no_value              The profile has no answer. This is a UI problem -
 *                         "fill in your profile" - not a matching problem.
 *   no_entry              The user has not added that school or job yet. Same.
 *   unknown_path          A bug or a stale learned rule pointing at nothing.
 *                         Asking a model to fix our own data error is absurd.
 *   no_representation     We hold the value and cannot render it for this
 *                         control. A formatting gap, ours to close in code.
 *   already filled        `decideFill` refuses to overwrite at ANY confidence,
 *                         so resolving this field could not change the outcome.
 *                         Admitting it would be cost and exposure for nothing.
 *   no question text      There is literally nothing to ask about. A field
 *                         whose only signals are `name="q_4821"` gives a second
 *                         opinion no more to work with than it gave the first.
 *
 * The last two are not failures of the pipeline at all. They are here because
 * "the pipeline refused" and "a second opinion could help" are different sets,
 * and conflating them is how a subsystem like this quietly becomes expensive.
 */
import { selectQuestionText } from '@form-engine/fingerprints/fingerprint';
import type { FieldOutcome, RefusedField } from './types';

/**
 * Cap on one page's queue.
 *
 * The queue's length is the length of an outbound payload and the number of
 * answers a reply may contain, so it needs a bound that does not depend on how
 * hostile the page is. Twenty-five is comfortably above what a real Greenhouse
 * or Lever application asks in custom questions, and far below what a page
 * built to run up our bill could offer.
 *
 * A FIXED CONSTANT, not a runtime-budget knob. `shared/runtime-budget.ts` scales
 * work by device capability, and that is right for scanning - but a budget that
 * varied per machine would mean the same form produced different questions on a
 * Chromebook and a workstation, and therefore different cache contents. Smaller
 * budget must mean slower, never different.
 */
export const MAX_QUEUED_FIELDS = 25;

export interface CollectOptions {
  /** Lower the cap. Cannot raise it above `MAX_QUEUED_FIELDS`. */
  readonly maxFields?: number;
}

/**
 * Gather the fields worth a second attempt.
 *
 * Reads as a series of refusals ending in the two cases that are admitted -
 * the same shape as `decideFill`, and for the same reason: the safe path is the
 * default and every way to reach an admission is visible in one screen.
 */
export function collect(
  outcomes: readonly FieldOutcome[],
  options: CollectOptions = {},
): RefusedField[] {
  const limit = Math.min(options.maxFields ?? MAX_QUEUED_FIELDS, MAX_QUEUED_FIELDS);
  const queued: RefusedField[] = [];

  for (const outcome of outcomes) {
    if (queued.length >= limit) break;

    const admitted = classify(outcome);
    if (admitted !== null) queued.push(admitted);
  }

  return queued;
}

/** Decide one field's fate, or null to drop it. */
function classify(outcome: FieldOutcome): RefusedField | null {
  const { descriptor, mapping, resolution } = outcome;

  // We never overwrite, at any confidence, so there is no outcome a second
  // opinion could produce that would change what happens to this control.
  if ((descriptor.currentValue ?? '').trim().length > 0) return null;

  const question = selectQuestionText(descriptor);
  // Nothing to ask about. `selectQuestionText` has already tried the label, the
  // accessible name, the nearby prose and the placeholder; if all four are
  // empty, the page has told us nothing a model could interpret either.
  if (question.length === 0) return null;

  const base = { fieldId: descriptor.localId, descriptor, question };

  // --- the mapping refused -------------------------------------------------
  if (mapping.profilePath === null) {
    // Only `no_signal`. `user_suppressed` is the user's instruction and
    // `unsupported_control` is a control we could not drive anyway - see the
    // header, and `mapper/types.ts` for why the three are distinguished.
    if (mapping.refusalReason !== 'no_signal') return null;
    return { ...base, reason: 'no_mapping', profilePath: null };
  }

  // --- the mapping succeeded, so the resolver ran ---------------------------
  // A field with no resolution was understood and never asked about. Nothing
  // refused it, so there is nothing here to retry.
  if (resolution === undefined || resolution.ok) return null;

  if (resolution.reason !== 'no_matching_option') return null;

  // Structural invariant, not a real form: `no_matching_option` can only come
  // from an option-based control. Enforcing it here lets every stage downstream
  // assume a non-empty list instead of re-checking.
  const options = descriptor.options ?? [];
  if (options.length === 0) return null;

  return {
    ...base,
    reason: 'no_matching_option',
    profilePath: mapping.profilePath,
  };
}

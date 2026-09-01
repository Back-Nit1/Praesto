/**
 * What the FORM said about a field, stamped onto the action the panel receives.
 * ---------------------------------------------------------------------------
 * Two facts travel with every action: whether the employer marked the field
 * required, and whether the control already held a value when we scanned. The
 * panel needs both to name the fields that will stop a submit (spec §33), and
 * neither is a decision - they are the page's own markup, copied through.
 *
 * WHY THIS IS A SEPARATE STEP, APPLIED LAST
 * The semantic pass REPLACES an action object rather than editing it, which is
 * right: a decision that changed should not inherit half of the decision it
 * replaced. But it means anything stamped onto an action before that pass is
 * silently lost, and the loss is invisible - the field simply stops appearing
 * in the panel's "Required, still blank" list, on exactly the fields the AI
 * fallback helped with.
 *
 * Stamping these facts AFTER every decision has been made removes the class of
 * bug rather than the instance: no future pass can drop them, because none of
 * them runs afterwards.
 *
 * `prefilled` IS A BOOLEAN AND NEVER THE VALUE. The panel needs to know that a
 * required field is already answered; it has no need of the answer, and a page
 * value in a message that does not need one is page content travelling for no
 * reason - see the data-minimisation note in messages.ts.
 */
import type { ResolvedFieldAction } from './messages';

/**
 * The parts of a descriptor this reads.
 *
 * Structural rather than the whole `FieldDescriptor` so this module stays in
 * `@shared`, which the form engine and the entrypoints both depend on and
 * which depends on neither.
 */
export interface FormFactSource {
  localId: string;
  required: boolean;
  /** The value already in the control. Read for its EMPTINESS, never its text. */
  currentValue?: string;
}

/**
 * Copy each field's form facts onto its action, in place.
 *
 * Actions whose descriptor is missing are left exactly as they are: an action
 * with no descriptor is one the page reported and the scan did not contain, and
 * inventing `required: false` for it would be asserting something nobody said.
 */
export function stampFormFacts(
  actions: ResolvedFieldAction[],
  descriptors: readonly FormFactSource[],
): void {
  const byLocalId = new Map(descriptors.map((descriptor) => [descriptor.localId, descriptor]));

  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (action === undefined) continue;

    const descriptor = byLocalId.get(action.localId);
    if (descriptor === undefined) continue;

    actions[index] = {
      ...action,
      ...(descriptor.required ? { required: true } : {}),
      ...((descriptor.currentValue ?? '').trim().length > 0 ? { prefilled: true } : {}),
    };
  }
}

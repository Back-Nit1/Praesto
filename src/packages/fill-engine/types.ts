/**
 * Fill engine contracts.
 * ---------------------------------------------------------------------------
 * The fill engine answers the last question in the pipeline (spec section 15):
 *
 *     "How do I make THIS specific UI control actually accept the value?"
 *
 * Separate from the resolver on purpose. The resolver decided the value should
 * be the string "May"; the fill engine works out that this particular control is
 * a React-controlled `<select>` that ignores `.value =` and needs a native
 * setter plus a bubbling `change` event. Those are unrelated concerns, and
 * mixing them is how a codebase ends up with date formatting inside a Workday
 * adapter.
 *
 * THE RULE THAT DEFINES THIS PACKAGE
 * Spec section 15.1: "A fill is not considered successful merely because no
 * exception was thrown."
 *
 * Setting a value on a modern web form frequently appears to work and does
 * nothing - the framework's state never updated, and on submit the field is
 * empty. So `fill()` is always followed by `verify()`, which READS THE CONTROL
 * BACK and compares. Anything else would let the side panel report a fill that
 * did not happen, which is worse than reporting a failure: the user stops
 * checking.
 */

/** Everything an adapter needs to act on one control. */
export interface ControlContext {
  element: HTMLElement;
  /** The descriptor's control kind, so an adapter need not re-derive it. */
  kind: string;
  /** For option controls, the option value the resolver chose. */
  optionValue?: string;
}

/** Why a fill did not succeed. Codes, because the UI branches on them. */
export type FillFailureReason =
  /** No adapter claimed this control. */
  | 'no_adapter'
  /** The element vanished between the scan and the fill. */
  | 'element_gone'
  /** The adapter ran but the control did not accept the value. */
  | 'rejected'
  /** The value went in but read back as something else. */
  | 'verification_failed'
  /** The control is disabled or read-only right now. */
  | 'not_editable'
  /** An option control offered nothing matching. */
  | 'option_not_found';

export type FillResult =
  | { readonly ok: true; readonly adapter: string }
  | { readonly ok: false; readonly adapter: string; readonly reason: FillFailureReason };

/**
 * A strategy for driving one family of controls.
 *
 * The adapter model is what keeps ATS-specific hacks contained. A Workday
 * combobox needs click-open, type-to-filter, wait-for-list, click-option - and
 * all of that lives inside one adapter that answers `canHandle`, rather than
 * leaking `if (ats === 'workday')` branches through the fill path
 * (spec section 18).
 */
export interface ControlAdapter {
  /** Stable name, recorded in the audit log so failures are attributable. */
  readonly name: string;

  /** Can this adapter drive this control? Checked in registration order. */
  canHandle(context: ControlContext): boolean;

  /** Current value, for the never-overwrite check and for verification. */
  read(context: ControlContext): Promise<unknown> | unknown;

  /** Attempt the fill. Must not throw - failures come back as FillResult. */
  fill(context: ControlContext, value: string | boolean): Promise<FillResult>;

  /**
   * Did the UI actually take it?
   *
   * Separate from `fill` so verification can be re-run later (after a framework
   * re-render, say) without repeating the fill itself.
   */
  verify(context: ControlContext, expected: string | boolean): Promise<boolean>;
}

/**
 * Native control adapters.
 * ---------------------------------------------------------------------------
 * One adapter per family of standard HTML control. They are deliberately dull:
 * all the difficulty of driving a framework-controlled input is factored into
 * `native/set-value.ts`, so each adapter here is a thin, readable statement of
 * how its control kind works.
 *
 * That dullness is the design goal. When a Workday combobox adapter is added
 * later it will be genuinely complicated, and it should be obvious at a glance
 * that its complexity is specific to Workday and has not leaked into the path
 * every other control takes.
 *
 * REGISTRATION ORDER IS SIGNIFICANT
 * `canHandle` is checked in order and the first match wins, so more specific
 * adapters must be registered before more general ones. The order in
 * `NATIVE_ADAPTERS` at the bottom is the contract.
 */
import { createLogger } from '@shared/logging';
import {
  dispatchInputEvents,
  isEditable,
  readControlValue,
  setNativeValue,
} from '../native/set-value';
import { CustomComboboxAdapter } from './combobox';
import { FileUploadAdapter } from './file-upload';
import type { ControlAdapter, FillFailureReason, FillResult } from '../types';

const log = createLogger('fill:native');

const success = (adapter: string): FillResult => ({ ok: true, adapter });
const failure = (adapter: string, reason: FillFailureReason): FillResult => ({
  ok: false,
  adapter,
  reason,
});

/**
 * Text, email, tel, url, number, and textarea.
 *
 * One adapter rather than six, because from the DOM's point of view they behave
 * identically - the differences (what value is valid) were already handled by
 * the resolver. Splitting them would produce five copies of the same code and
 * five places to fix the next controlled-input bug.
 */
export const NativeTextAdapter: ControlAdapter = {
  name: 'NativeText',

  canHandle: (context) =>
    context.element instanceof HTMLTextAreaElement ||
    (context.element instanceof HTMLInputElement &&
      ['text', 'email', 'tel', 'url', 'number', 'search', 'date', 'month', ''].includes(
        context.element.type,
      )) ||
    context.element.isContentEditable,

  read: (context) => readControlValue(context.element),

  async fill(context, value) {
    if (!isEditable(context.element)) return failure(this.name, 'not_editable');
    if (typeof value !== 'string') return failure(this.name, 'rejected');

    // Focus first. Some forms only initialise their validation on focus, and a
    // value written into an unfocused field is discarded on the next render.
    context.element.focus?.();

    const accepted = setNativeValue(context.element, value);
    return accepted ? success(this.name) : failure(this.name, 'rejected');
  },

  async verify(context, expected) {
    const actual = readControlValue(context.element);
    if (typeof expected !== 'string' || typeof actual !== 'string') return false;

    // Exact match first. Then a normalized comparison, because input masks
    // legitimately reformat what we wrote: a phone field may turn "6095551234"
    // into "(609) 555-1234". That is the control accepting our value, not
    // rejecting it, and failing it would produce a false negative on every
    // masked field.
    if (actual === expected) return true;
    return normalizeForComparison(actual) === normalizeForComparison(expected);
  },
};

/**
 * Native `<select>`.
 *
 * Selects the option by VALUE, using the option the resolver already matched.
 * Re-searching by label here would risk picking a different option that happens
 * to share display text - the matching decision was made once, deliberately,
 * with the unique-match rule, and must not be quietly redone.
 */
export const NativeSelectAdapter: ControlAdapter = {
  name: 'NativeSelect',

  canHandle: (context) => context.element instanceof HTMLSelectElement,

  read: (context) => (context.element as HTMLSelectElement).value,

  async fill(context, value) {
    const select = context.element;
    if (!(select instanceof HTMLSelectElement)) return failure(this.name, 'no_adapter');
    if (!isEditable(select)) return failure(this.name, 'not_editable');

    const wanted = context.optionValue ?? String(value);
    const option = [...select.options].find((candidate) => candidate.value === wanted);
    if (option === undefined) {
      // The option list changed between the scan and the fill - common on forms
      // where one dropdown repopulates another. Reporting it is correct; the
      // MutationObserver rescan will produce a fresh descriptor.
      return failure(this.name, 'option_not_found');
    }

    select.value = option.value;
    // A `<select>` is not typed into, so `input` is arguably wrong - but React
    // listens for it on selects too, and dispatching both is the only way to
    // satisfy both native forms and framework-controlled ones.
    dispatchInputEvents(select);

    return select.value === option.value ? success(this.name) : failure(this.name, 'rejected');
  },

  async verify(context, expected) {
    const select = context.element;
    if (!(select instanceof HTMLSelectElement)) return false;
    return select.value === (context.optionValue ?? String(expected));
  },
};

/**
 * Checkbox.
 *
 * The only adapter that takes a boolean. Note that it sets `checked` to the
 * requested state rather than toggling: a toggle would invert the answer if the
 * control already happened to be checked, which is exactly the kind of
 * order-dependent bug that is invisible until a user submits the wrong answer.
 */
export const NativeCheckboxAdapter: ControlAdapter = {
  name: 'NativeCheckbox',

  canHandle: (context) =>
    context.element instanceof HTMLInputElement && context.element.type === 'checkbox',

  read: (context) => (context.element as HTMLInputElement).checked,

  async fill(context, value) {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return failure(this.name, 'no_adapter');
    if (!isEditable(input)) return failure(this.name, 'not_editable');

    const wanted = typeof value === 'boolean' ? value : value === 'true' || value === 'yes';
    if (input.checked === wanted) return success(this.name); // already correct

    // `click()` rather than assigning `.checked`. A click produces the full
    // native event sequence a framework expects, and it respects a label
    // wrapper's own click handling. Assigning `.checked` updates the DOM
    // without telling anyone, which is the controlled-input problem again.
    input.click();

    return input.checked === wanted ? success(this.name) : failure(this.name, 'rejected');
  },

  async verify(context, expected) {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return false;
    const wanted = typeof expected === 'boolean' ? expected : expected === 'true';
    return input.checked === wanted;
  },
};

/**
 * Radio group.
 *
 * The scan produced ONE descriptor for the group, so the element we hold is the
 * first radio in it. The option to select is found by walking the group by
 * `name`, which is how the HTML spec defines a radio group in the first place.
 */
export const NativeRadioAdapter: ControlAdapter = {
  name: 'NativeRadio',

  canHandle: (context) =>
    context.element instanceof HTMLInputElement && context.element.type === 'radio',

  read: (context) => {
    const input = context.element as HTMLInputElement;
    const group = radioGroupFor(input);
    return group.find((radio) => radio.checked)?.value;
  },

  async fill(context, value) {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return failure(this.name, 'no_adapter');

    const wanted = context.optionValue ?? String(value);
    const target = radioGroupFor(input).find((radio) => radio.value === wanted);
    if (target === undefined) return failure(this.name, 'option_not_found');
    if (!isEditable(target)) return failure(this.name, 'not_editable');

    target.click();
    return target.checked ? success(this.name) : failure(this.name, 'rejected');
  },

  async verify(context, expected) {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return false;
    const wanted = context.optionValue ?? String(expected);
    return radioGroupFor(input).some((radio) => radio.checked && radio.value === wanted);
  },
};

/** Every radio sharing this one's `name`, within the same form. */
function radioGroupFor(input: HTMLInputElement): HTMLInputElement[] {
  const scope: ParentNode = input.form ?? input.ownerDocument;
  const name = input.name;
  if (name.length === 0) return [input];

  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(name) : name;
  try {
    return [...scope.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${escaped}"]`)];
  } catch (error) {
    // A name containing characters CSS.escape cannot handle. Degrade to just
    // this input rather than throwing into the host page.
    log.debugLazy(() => ['Could not query radio group', name, error]);
    return [input];
  }
}

/**
 * Registry, in `canHandle` precedence order.
 *
 * Checkbox and radio come first because they are `<input>` elements that the
 * text adapter's type list must never claim. Select is unambiguous. Text is
 * last because it is the broadest.
 */
export const NATIVE_ADAPTERS: readonly ControlAdapter[] = [
  // File first: it is an <input>, and the text adapter must never claim it.
  FileUploadAdapter,
  NativeCheckboxAdapter,
  NativeRadioAdapter,
  NativeSelectAdapter,
  // Before the text adapter, and after the native select. A custom dropdown is
  // frequently a text input with `role="combobox"`, which the text adapter
  // would happily claim and then "fill" by writing into a box the widget
  // discards on blur. A real <select> never reaches here - the combobox
  // adapter declines it, because a <select> cannot be opened by script.
  CustomComboboxAdapter,
  NativeTextAdapter,
];

/**
 * Loosen a value for comparison, for the input-mask case only.
 *
 * Strips everything but alphanumerics and lowercases, so "(609) 555-1234" and
 * "6095551234" compare equal. Deliberately NOT used for the primary comparison:
 * it would also make "May 2025" equal "may2025", which is fine, but it would
 * hide a control that silently truncated our value - so it runs only after an
 * exact comparison has already failed.
 */
function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

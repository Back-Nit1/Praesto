/**
 * Setting a value on a control that a framework is watching.
 * ---------------------------------------------------------------------------
 * This file exists because of one fact that catches out every autofill
 * implementation at least once:
 *
 *     input.value = 'text';     // looks like it worked. React disagrees.
 *
 * WHY IT FAILS
 * React (and Vue, and Angular, and Svelte) render "controlled" inputs: the
 * framework holds the value in its own state and re-renders the DOM from it.
 * To detect user typing, React installs its own `value` property descriptor on
 * the element instance and listens for `input` events. Assigning to `.value`:
 *
 *   1. goes through React's own setter (or, on the instance, shadows the
 *      prototype's), so React's internal "last known value" is updated too,
 *   2. fires no event,
 *
 * so when React next re-renders, it writes its unchanged state back over our
 * text and the field silently reverts. The user sees a field that flashed and
 * emptied - or worse, sees text that is not in the form's actual state and
 * submits an empty field.
 *
 * THE FIX, WHICH IS EXACT AND NOT A HACK
 *   1. Call the NATIVE setter from the element's prototype, bypassing the
 *      instance-level descriptor the framework installed. The DOM value now
 *      changes without the framework's bookkeeping being updated.
 *   2. Dispatch a bubbling `input` event. The framework's listener fires, reads
 *      the DOM value, sees it differs from its state, and updates state - which
 *      is precisely what happens when a human types.
 *
 * The result is indistinguishable from real user input, which is the only
 * standard worth aiming at: anything less works on some forms and fails on
 * others, and we would never know which.
 *
 * Spec section 28: "do not assume setting .value is enough."
 */

/**
 * Cached native setters, looked up once per element TYPE.
 *
 * `Object.getOwnPropertyDescriptor` on the PROTOTYPE gives the browser's own
 * setter, before any framework had a chance to shadow it on the instance.
 * Cached because the lookup is not free and a fill run touches many controls.
 *
 * The cache stores the UNBOUND setter, and the caller supplies the element at
 * call time. Caching a bound setter instead would be a serious bug: the cache
 * is keyed by prototype, so every input on the page would share one entry, and
 * every fill after the first would write into whichever element happened to be
 * filled first. The symptom is one correct field and a page of empty ones.
 *
 * A `null` entry means "we looked and this prototype has no value setter",
 * which is distinct from "not yet looked up" and must not be re-probed.
 */
const nativeSetters = new WeakMap<object, ((this: HTMLElement, value: string) => void) | null>();

function nativeValueSetter(
  element: HTMLElement,
): ((this: HTMLElement, value: string) => void) | undefined {
  const prototype = Object.getPrototypeOf(element) as object | null;
  if (prototype === null) return undefined;

  if (nativeSetters.has(prototype)) {
    return nativeSetters.get(prototype) ?? undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  const setter = descriptor?.set;

  nativeSetters.set(prototype, setter ?? null);
  return setter;
}

/**
 * Set a text-like control's value the way a human would.
 *
 * @returns true when the DOM value reads back as expected. A false here means
 *          the control rejected the write outright (read-only, or a masked
 *          input that reformatted it) - the caller must NOT report success.
 */
export function setNativeValue(element: HTMLElement, value: string): boolean {
  const setter = nativeValueSetter(element);

  if (setter !== undefined) {
    // `.call` supplies the element the cached setter was deliberately not
    // bound to. See the cache comment above.
    setter.call(element, value);
  } else if ('value' in element) {
    // No prototype descriptor (a custom element, or an unusual DOM
    // implementation). Direct assignment is the only option left; the event
    // dispatch below still gives a listening framework its chance to react.
    (element as unknown as { value: string }).value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    return false;
  }

  dispatchInputEvents(element);

  const readBack = readControlValue(element);
  return readBack === value;
}

/**
 * Fire the events a real keystroke would produce.
 *
 * `input` is what React and Vue listen to. `change` is what plain HTML forms
 * and jQuery-era validation listen to. Both are dispatched because a form may
 * use either, and a spurious extra event is harmless where a missing one is
 * silent failure.
 *
 * `bubbles: true` is mandatory: framework listeners are attached at the
 * document root (event delegation), not on the input, so a non-bubbling event
 * reaches nobody.
 */
export function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/**
 * Blur the control.
 *
 * Some forms only run validation, or only commit a value, on blur. Dispatched
 * separately from the input events because it is not always wanted: blurring
 * mid-fill can close a custom dropdown we are about to interact with.
 */
export function dispatchBlur(element: HTMLElement): void {
  element.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  element.dispatchEvent(new Event('focusout', { bubbles: true }));
}

/** Read a control's current value, whatever kind of control it is. */
export function readControlValue(element: HTMLElement): string | boolean | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') return element.checked;
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  if (element.isContentEditable) return element.textContent ?? '';
  if ('value' in element) return (element as unknown as { value: string }).value;
  return undefined;
}

/**
 * Is this control editable right now?
 *
 * Checked before every fill. Writing to a disabled or read-only control can
 * appear to succeed in the DOM while the form ignores it entirely.
 */
export function isEditable(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element.hasAttribute('readonly')) return false;
  if (element.getAttribute('aria-readonly') === 'true') return false;
  return true;
}

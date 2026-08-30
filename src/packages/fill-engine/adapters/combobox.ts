/**
 * Custom combobox adapter - the dropdowns that are not `<select>`.
 * ---------------------------------------------------------------------------
 * Workday, Ashby and most modern ATS platforms render their dropdowns as a
 * `<div role="combobox">` (or a text input with `aria-haspopup="listbox"`)
 * whose options do not exist in the DOM until the control is opened. The
 * scanner already recognises these - `classifyControl` returns `combobox` for
 * them - but until this adapter existed the fill engine had nothing that could
 * claim one, so every country, state, degree and "how did you hear about us"
 * dropdown on those platforms failed with `no_adapter`.
 *
 * WHY THIS CANNOT BE DONE BY SETTING A VALUE
 * There is nothing to set. The visible text is rendered by the widget from its
 * own internal state; writing to it changes a `<div>`'s text content and the
 * form still submits nothing. The only thing that updates the widget's state is
 * the interaction it is listening for - so this adapter does what a person
 * does: open it, wait for the list, click the matching option, and then read
 * the control back to confirm.
 *
 * THE SAFETY RULE IS THE SAME ONE THE RESOLVER USES
 * An option is chosen only when EXACTLY ONE option matches. A dropdown that
 * offers both "United States" and "United States Minor Outlying Islands" is
 * ambiguous under a loose comparison, and picking the first match is not a
 * decision, it is a coin flip. Ambiguity is reported as `option_not_found` and
 * left for the user.
 *
 * WHAT THIS ADAPTER WILL NOT DO
 * It will not type a value into a free-text combobox and leave it uncommitted.
 * Many of these widgets discard typed text that was never resolved to an
 * option, so a "successful" type would submit an empty field. If no option
 * matches, the control is restored (Escape) and the failure is reported.
 */
import { createLogger } from '@shared/logging';
import { dispatchInputEvents, isEditable, setNativeValue } from '../native/set-value';
import type { ControlAdapter, FillFailureReason, FillResult } from '../types';

const log = createLogger('fill:combobox');

const success = (adapter: string): FillResult => ({ ok: true, adapter });
const failure = (adapter: string, reason: FillFailureReason): FillResult => ({
  ok: false,
  adapter,
  reason,
});

/**
 * How long to wait for a popup to render, and how often to look.
 *
 * These widgets open on an animation frame or after a network fetch for their
 * options. 800ms is generous for a local render and short enough that a
 * genuinely broken control fails while the user is still watching the panel;
 * 40ms between polls is well under a frame's worth of idle time.
 */
const OPEN_TIMEOUT_MS = 800;
const POLL_INTERVAL_MS = 40;

/** Roles and attributes that mark an element as a custom dropdown. */
function isCombobox(element: HTMLElement): boolean {
  const role = element.getAttribute('role');
  if (role === 'combobox' || role === 'listbox') return true;
  // Some widgets put the role on a wrapper and leave the input plain, marking
  // it only with the popup relationship.
  const haspopup = element.getAttribute('aria-haspopup');
  return haspopup === 'listbox' || haspopup === 'menu';
}

export const CustomComboboxAdapter: ControlAdapter = {
  name: 'CustomCombobox',

  canHandle: (context) => {
    // A native <select> is handled by its own, far simpler adapter - and it
    // must be, because clicking a <select> open is not something script can do.
    if (context.element instanceof HTMLSelectElement) return false;
    return isCombobox(context.element) || context.kind === 'combobox';
  },

  read: (context) => readDisplayedValue(context.element),

  async fill(context, value) {
    const element = context.element;
    if (!isEditable(element)) return failure(this.name, 'not_editable');

    // The option the resolver matched, if it matched one. Falling back to the
    // raw value covers the case where the scanner could not read the options at
    // scan time (they did not exist yet) and the resolver had nothing to match.
    const wanted = context.optionValue ?? String(value);
    if (wanted.length === 0) return failure(this.name, 'rejected');

    element.scrollIntoView?.({ block: 'center' });
    element.focus?.();

    // Opening is a click on the control itself. `mousedown` is dispatched too:
    // a surprising number of these widgets open on mousedown and ignore click,
    // and one that listens for both is not harmed by receiving both.
    openControl(element);

    /**
     * Typing filters the list.
     *
     * On a long list (a country dropdown) the option we want is frequently not
     * rendered until the list is filtered - these widgets virtualise. Typing is
     * therefore not a convenience, it is how the option comes into existence.
     * Only done for a control that actually accepts text.
     */
    const textInput = editableTextInput(element);
    // Kept so a failed attempt can put the control back exactly as it was.
    // Without this, typing to filter LEAVES the typed text in the field on
    // every failure path - which is precisely the "uncommitted text" this
    // adapter's header promises not to produce, and it is worse than a blank
    // field: the widget discards it on blur and the form submits nothing while
    // the user saw a filled-in box.
    const originalText = textInput?.value ?? '';
    if (textInput !== null) {
      setNativeValue(textInput, wanted);
      dispatchInputEvents(textInput);
    }

    const listbox = await waitForListbox(element);
    if (listbox === null) {
      /**
       * No popup - but not necessarily a failure.
       *
       * A plain `<input role="combobox">` with an autocomplete that offered no
       * suggestions is still an input: the text we typed IS the submitted
       * value, and the executor's read-back will confirm it. Treating this as
       * a failure would be a regression against the text adapter, which used
       * to claim these controls and fill them correctly.
       *
       * A non-input control (a `<div role="combobox">`) has nowhere for a
       * value to live, so there it is a genuine failure.
       */
      if (textInput !== null) return success(this.name);
      dismiss(element);
      return failure(this.name, 'rejected');
    }

    const match = findUniqueOption(listbox, wanted);
    if (match === null) {
      // Either nothing matched or several did. Both are the user's call, and
      // both must leave the control as we found it - including the text we
      // typed to filter with.
      if (textInput !== null) {
        setNativeValue(textInput, originalText);
        dispatchInputEvents(textInput);
      }
      dismiss(element);
      return failure(this.name, 'option_not_found');
    }

    selectOption(match);

    // Give the widget a moment to close and write its value back before the
    // executor's verify step reads it.
    await settle();

    return success(this.name);
  },

  async verify(context, expected) {
    const wanted = context.optionValue ?? String(expected);
    const actual = readDisplayedValue(context.element);
    if (actual === undefined) return false;

    // Compared loosely on purpose: these widgets routinely render the selected
    // option with decoration ("United States  ×" for a clearable chip) or with
    // different casing from the option text we clicked.
    return compact(actual).includes(compact(wanted)) || compact(wanted).includes(compact(actual));
  },
};

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function openControl(element: HTMLElement): void {
  for (const type of ['pointerdown', 'mousedown', 'mouseup'] as const) {
    element.dispatchEvent(pointerLike(type, element));
  }
  element.click();
}

/**
 * A mouse-shaped event.
 *
 * `view` is deliberately NOT set. It is optional in every listener that matters
 * here, and supplying a Window from a different realm - which is what happens
 * in a content script and under jsdom - is rejected outright by the DOM
 * ("member view is not of type Window"), taking the whole fill down over a
 * field nobody reads.
 *
 * `PointerEvent` is feature-detected: widgets increasingly listen for it, but
 * it is absent in some embedded contexts, and a missing constructor must not
 * be a crash.
 */
function pointerLike(type: string, element: HTMLElement): Event {
  const init: MouseEventInit = { bubbles: true, cancelable: true };

  if (type.startsWith('pointer')) {
    const view = element.ownerDocument.defaultView as unknown as
      | { PointerEvent?: typeof PointerEvent }
      | null;
    const Constructor = view?.PointerEvent;
    if (typeof Constructor !== 'function') {
      return new Event(type, { bubbles: true, cancelable: true });
    }
    return new Constructor(type, init);
  }

  return new MouseEvent(type, init);
}

/**
 * Close the control without changing anything.
 *
 * Leaving an open dropdown covering the rest of the form after a failed fill is
 * a real cost to the user: the next field is behind it, and they did not open
 * it. Escape is the standard dismissal for a listbox popup.
 */
function dismiss(element: HTMLElement): void {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  element.blur?.();
}

/** The text input to type into, when this control has one. */
function editableTextInput(element: HTMLElement): HTMLInputElement | null {
  if (element instanceof HTMLInputElement && element.type !== 'hidden' && !element.readOnly) {
    return element;
  }
  // Workday's pattern: a wrapper carries the combobox role, the real input is
  // inside it.
  const nested = element.querySelector('input:not([type="hidden"])');
  return nested instanceof HTMLInputElement && !nested.readOnly ? nested : null;
}

/**
 * The popup list belonging to this control.
 *
 * Ordered by how certain the association is:
 *   1. `aria-controls` / `aria-owns` - the widget naming its own popup;
 *   2. a listbox inside the control's own subtree;
 *   3. the only listbox currently in the document.
 *
 * The third is the fallback and is deliberately last: it is right in practice
 * (a page rarely has two dropdowns open at once) but it is an assumption, not a
 * statement by the page, so it is only used when the page said nothing.
 */
function findListbox(element: HTMLElement): HTMLElement | null {
  const owned = element.getAttribute('aria-controls') ?? element.getAttribute('aria-owns');
  if (owned !== null) {
    for (const id of owned.split(/\s+/)) {
      const referenced = element.ownerDocument.getElementById(id);
      if (referenced !== null && hasOptions(referenced)) return referenced;
    }
  }

  const nested = element.querySelector('[role="listbox"], [role="menu"]');
  if (nested instanceof HTMLElement && hasOptions(nested)) return nested;

  const open = [...element.ownerDocument.querySelectorAll<HTMLElement>('[role="listbox"], [role="menu"]')]
    .filter((candidate) => hasOptions(candidate) && isOnScreen(candidate));

  // Exactly one, or we do not know which popup belongs to us.
  return open.length === 1 ? (open[0] ?? null) : null;
}

function hasOptions(container: HTMLElement): boolean {
  return container.querySelector('[role="option"], [role="menuitem"], li') !== null;
}

function isOnScreen(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/** Poll until the popup renders, or give up. */
async function waitForListbox(element: HTMLElement): Promise<HTMLElement | null> {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  for (;;) {
    const listbox = findListbox(element);
    if (listbox !== null) return listbox;
    if (Date.now() >= deadline) {
      log.debugLazy(() => ['No option list appeared for this combobox']);
      return null;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * The single option matching what we want.
 *
 * Progressively looser comparisons, each stopping at a UNIQUE match - the same
 * rule the value resolver applies to a native `<select>`, and for the same
 * reason: "the first thing that matched" is not a decision anyone made.
 */
function findUniqueOption(listbox: HTMLElement, wanted: string): HTMLElement | null {
  const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"], li')];
  if (options.length === 0) return null;

  const target = normalize(wanted);
  const targetCompact = compact(wanted);

  const strategies: Array<(option: HTMLElement) => boolean> = [
    // The value attribute the widget carries, when it has one - the closest
    // thing these controls have to an <option value>.
    (option) => normalize(option.getAttribute('data-value') ?? '') === target,
    (option) => normalize(option.textContent) === target,
    (option) => compact(option.textContent) === targetCompact,
    // "United States" against "United States of America". Prefix only: a
    // mid-string match ("Virginia" inside "West Virginia") is the near-miss
    // that produces a confidently wrong answer.
    (option) => targetCompact.length >= 3 && compact(option.textContent).startsWith(targetCompact),
  ];

  for (const matches of strategies) {
    const found = options.filter(matches);
    if (found.length === 1) return found[0] ?? null;
  }
  return null;
}

/**
 * Click an option the way a person does.
 *
 * The full sequence matters: some widgets commit on `mousedown` and close
 * before `click` arrives, others ignore everything but `click`. Sending all
 * three satisfies both without needing to know which library this is.
 */
function selectOption(option: HTMLElement): void {
  option.scrollIntoView?.({ block: 'nearest' });
  for (const type of ['pointerdown', 'mousedown', 'mouseup'] as const) {
    option.dispatchEvent(pointerLike(type, option));
  }
  option.click();
}

/**
 * What the control currently displays.
 *
 * Four places a custom dropdown can keep its selected value, in order of how
 * explicit they are. `aria-activedescendant` is checked before the text because
 * the visible text of a filterable combobox may still hold what we typed.
 */
function readDisplayedValue(element: HTMLElement): string | undefined {
  const activeId = element.getAttribute('aria-activedescendant');
  if (activeId !== null) {
    const active = element.ownerDocument.getElementById(activeId);
    const text = clean(active?.textContent);
    if (text !== undefined) return text;
  }

  const selected = element.querySelector('[aria-selected="true"], [role="option"][selected]');
  const selectedText = clean(selected?.textContent);
  if (selectedText !== undefined) return selectedText;

  const input = editableTextInput(element);
  if (input !== null && input.value.length > 0) return input.value;

  return clean(displayText(element));
}

/**
 * The control's own text, WITHOUT the popup it may contain.
 *
 * Some widgets render their option list inside the combobox element. Reading
 * `textContent` there returns every option label, so a verify comparing
 * loosely would find the wanted value among 250 country names and report a
 * fill that never happened - the exact false "verified" this whole change set
 * exists to eliminate.
 *
 * The clone is paid for once per verified field, on a subtree the scan already
 * capped, and only when the earlier and more explicit signals said nothing.
 */
function displayText(element: HTMLElement): string | undefined {
  const popup = element.querySelector('[role="listbox"], [role="menu"]');
  if (popup === null) return element.textContent ?? undefined;

  const clone = element.cloneNode(true) as HTMLElement;
  for (const nested of clone.querySelectorAll('[role="listbox"], [role="menu"]')) nested.remove();
  return clone.textContent ?? undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clean(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) return undefined;
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function compact(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One macrotask, so a widget's own state update lands before we verify. */
function settle(): Promise<void> {
  return delay(POLL_INTERVAL_MS);
}

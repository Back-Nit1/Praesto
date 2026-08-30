// @vitest-environment jsdom
/**
 * Fill adapter tests.
 *
 * The controlled-input test is the one that justifies this whole package. It
 * simulates what React does - shadowing the element's `value` property and
 * reverting the DOM from its own state unless it sees an `input` event - and
 * asserts that our fill survives it. Without that behaviour the extension looks
 * like it works and silently submits empty fields.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_ADAPTERS,
  NativeCheckboxAdapter,
  NativeRadioAdapter,
  NativeSelectAdapter,
  NativeTextAdapter,
} from '@fill-engine/adapters/native-adapters';
import { executeFills } from '@fill-engine/executor';
import { __setRuntimeBudgetForTesting, budgetFor } from '@shared/runtime-budget';
import type { ResolvedFieldAction } from '@shared/messages';

beforeEach(() => {
  document.body.innerHTML = '';
  __setRuntimeBudgetForTesting(budgetFor(8, 8));
});

function makeInput(html: string): HTMLElement {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error('fixture produced no element');
  return element;
}

describe('NativeTextAdapter', () => {
  it('fills a plain text input and verifies the read-back', async () => {
    const element = makeInput('<input type="text" />');
    const context = { element, kind: 'text' };

    const result = await NativeTextAdapter.fill(context, 'Nityanth');
    expect(result.ok).toBe(true);
    expect(await NativeTextAdapter.verify(context, 'Nityanth')).toBe(true);
  });

  it('dispatches bubbling input and change events, as real typing does', async () => {
    const element = makeInput('<input type="text" />');
    const seen: string[] = [];
    // Listeners on the DOCUMENT, not the input: frameworks use event
    // delegation, so a non-bubbling event would reach nobody.
    document.addEventListener('input', () => seen.push('input'));
    document.addEventListener('change', () => seen.push('change'));

    await NativeTextAdapter.fill({ element, kind: 'text' }, 'value');
    expect(seen).toEqual(['input', 'change']);
  });

  it('survives a React-style controlled input', async () => {
    const element = makeInput('<input type="text" />') as HTMLInputElement;

    // Simulate React: shadow `value` on the INSTANCE, keep private state, and
    // revert the DOM from that state unless an input event says otherwise.
    let frameworkState = '';
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    );
    Object.defineProperty(element, 'value', {
      configurable: true,
      get: () => frameworkState,
      set: (next: string) => {
        // The framework's own setter ignores writes it did not originate.
        frameworkState = next === frameworkState ? next : frameworkState;
      },
    });
    element.addEventListener('input', () => {
      // On a real input event React reads the DOM value and adopts it.
      const domValue = prototypeDescriptor?.get?.call(element) as string | undefined;
      if (domValue !== undefined) frameworkState = domValue;
    });

    const result = await NativeTextAdapter.fill({ element, kind: 'text' }, 'Nityanth');

    // Assigning `.value` would have been swallowed by the shadowing setter. The
    // native prototype setter plus a bubbling input event gets through.
    expect(result.ok).toBe(true);
    expect(frameworkState).toBe('Nityanth');
  });

  it('accepts a value an input mask reformatted', async () => {
    const element = makeInput('<input type="tel" />') as HTMLInputElement;
    await NativeTextAdapter.fill({ element, kind: 'tel' }, '6095551234');
    // A mask rewriting our digits IS the control accepting the value. Failing
    // verification here would report a false negative on every masked field.
    element.setAttribute('value', '(609) 555-1234');
    Object.defineProperty(element, 'value', { value: '(609) 555-1234', configurable: true });
    expect(await NativeTextAdapter.verify({ element, kind: 'tel' }, '6095551234')).toBe(true);
  });

  it('refuses a read-only or disabled control', async () => {
    const readonly = makeInput('<input type="text" readonly />');
    const disabled = makeInput('<input type="text" disabled />');

    expect(await NativeTextAdapter.fill({ element: readonly, kind: 'text' }, 'x')).toMatchObject({
      ok: false,
      reason: 'not_editable',
    });
    expect(await NativeTextAdapter.fill({ element: disabled, kind: 'text' }, 'x')).toMatchObject({
      ok: false,
      reason: 'not_editable',
    });
  });
});

describe('NativeSelectAdapter', () => {
  it('selects the option the resolver already matched, by value', async () => {
    const element = makeInput(
      '<select><option value=""></option><option value="US">United States</option></select>',
    ) as HTMLSelectElement;
    const context = { element, kind: 'select', optionValue: 'US' };

    expect(await NativeSelectAdapter.fill(context, 'United States')).toMatchObject({ ok: true });
    expect(element.value).toBe('US');
    expect(await NativeSelectAdapter.verify(context, 'United States')).toBe(true);
  });

  it('reports option_not_found when the list changed since the scan', async () => {
    const element = makeInput('<select><option value="CA">Canada</option></select>');
    const result = await NativeSelectAdapter.fill(
      { element, kind: 'select', optionValue: 'US' },
      'United States',
    );
    expect(result).toMatchObject({ ok: false, reason: 'option_not_found' });
  });
});

describe('NativeCheckboxAdapter', () => {
  it('sets the requested state rather than toggling', async () => {
    const element = makeInput('<input type="checkbox" checked />') as HTMLInputElement;
    // A toggle would turn this OFF and invert the applicant's answer.
    const result = await NativeCheckboxAdapter.fill({ element, kind: 'checkbox' }, true);
    expect(result.ok).toBe(true);
    expect(element.checked).toBe(true);
  });

  it('unchecks when asked for false', async () => {
    const element = makeInput('<input type="checkbox" checked />') as HTMLInputElement;
    await NativeCheckboxAdapter.fill({ element, kind: 'checkbox' }, false);
    expect(element.checked).toBe(false);
  });
});

describe('NativeRadioAdapter', () => {
  it('selects the right member of the group by value', async () => {
    document.body.innerHTML = `
      <form>
        <input type="radio" name="auth" value="Yes" />
        <input type="radio" name="auth" value="No" />
      </form>`;
    const first = document.querySelector<HTMLInputElement>('input[value="Yes"]');
    const second = document.querySelector<HTMLInputElement>('input[value="No"]');
    expect(first).not.toBeNull();
    if (first === null || second === null) return;

    const context = { element: first, kind: 'radio', optionValue: 'No' };
    expect(await NativeRadioAdapter.fill(context, 'No')).toMatchObject({ ok: true });
    expect(second.checked).toBe(true);
    expect(first.checked).toBe(false);
  });
});

describe('executeFills', () => {
  const action = (overrides: Partial<ResolvedFieldAction>): ResolvedFieldAction => ({
    localId: 'f1',
    action: 'fill',
    value: 'Nityanth',
    profilePath: 'identity.legalFirstName',
    mappingConfidence: 0.99,
    knowledgeState: 'known',
    ...overrides,
  });

  it('only acts on fill actions', async () => {
    const element = makeInput('<input type="text" />') as HTMLInputElement;
    const outcomes = await executeFills(
      [
        action({ localId: 'f1' }),
        action({ localId: 'f2', action: 'suggest' }),
        action({ localId: 'f3', action: 'skip' }),
      ],
      { resolveElement: () => element, adapters: NATIVE_ADAPTERS },
    );

    expect(outcomes.map((o) => o.attempted)).toEqual([true, false, false]);
  });

  it('reports verified separately from attempted', async () => {
    const element = makeInput('<input type="text" />');
    const [outcome] = await executeFills([action({})], {
      resolveElement: () => element,
      adapters: NATIVE_ADAPTERS,
    });
    expect(outcome).toMatchObject({ attempted: true, verified: true, adapter: 'NativeText' });
  });

  it('reports element_gone when the page re-rendered between scan and fill', async () => {
    const [outcome] = await executeFills([action({})], {
      resolveElement: () => null,
      adapters: NATIVE_ADAPTERS,
    });
    expect(outcome).toMatchObject({ attempted: false, failureReason: 'element_gone' });
  });

  it('does not let one failing field abort the rest of the run', async () => {
    const good = makeInput('<input type="text" id="good" />');
    const outcomes = await executeFills(
      [action({ localId: 'missing' }), action({ localId: 'good' })],
      {
        resolveElement: (localId) => (localId === 'good' ? good : null),
        adapters: NATIVE_ADAPTERS,
      },
    );
    expect(outcomes[0]?.failureReason).toBe('element_gone');
    expect(outcomes[1]?.verified).toBe(true);
  });

  it('reports no_adapter for a control nothing can drive', async () => {
    const element = makeInput('<input type="color" />');
    const [outcome] = await executeFills([action({})], {
      resolveElement: () => element,
      adapters: NATIVE_ADAPTERS,
    });
    expect(outcome).toMatchObject({ attempted: false, failureReason: 'no_adapter' });
  });
});

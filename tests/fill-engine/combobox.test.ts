// @vitest-environment jsdom
/**
 * Custom combobox adapter tests.
 *
 * The fixture here is the shape that actually broke the product: a
 * `<div role="combobox">` whose options do not exist until it is clicked, which
 * is how Workday, Ashby and most modern ATS platforms render every dropdown.
 * Before this adapter, every one of them failed with `no_adapter` - the
 * scanner recognised them and nothing could drive them.
 *
 * The tests assert the two properties that make it safe to use at all:
 *   - a value is only committed by clicking a real option;
 *   - an ambiguous list is refused rather than resolved by position.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CustomComboboxAdapter } from '@fill-engine/adapters/combobox';
import { NATIVE_ADAPTERS } from '@fill-engine/adapters/native-adapters';
import type { ControlContext } from '@fill-engine/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * A dropdown that renders its options only while open, and writes the chosen
 * option back into its own text - exactly like the real thing.
 */
function mountCombobox(options: string[]): HTMLElement {
  document.body.innerHTML = `
    <div>
      <div id="cb" role="combobox" aria-controls="lb" aria-expanded="false" tabindex="0">Select...</div>
      <div id="lb" role="listbox" hidden></div>
    </div>`;

  const combobox = document.getElementById('cb') as HTMLElement;
  const listbox = document.getElementById('lb') as HTMLElement;

  // jsdom gives every element a zero-size rect, so the adapter's on-screen
  // check would reject the popup. The association here is explicit
  // (aria-controls), which is the path that does not need the rect - but the
  // stub keeps the fixture honest about the popup being visible.
  listbox.getBoundingClientRect = () => ({ width: 200, height: 100 }) as DOMRect;

  combobox.addEventListener('mousedown', () => {
    listbox.hidden = false;
    combobox.setAttribute('aria-expanded', 'true');
    listbox.innerHTML = options
      .map((option) => `<div role="option" data-value="${option}">${option}</div>`)
      .join('');

    for (const option of listbox.querySelectorAll<HTMLElement>('[role="option"]')) {
      option.addEventListener('click', () => {
        combobox.textContent = option.textContent;
        listbox.hidden = true;
        listbox.innerHTML = '';
        combobox.setAttribute('aria-expanded', 'false');
      });
    }
  });

  return combobox;
}

const contextFor = (element: HTMLElement, optionValue?: string): ControlContext =>
  optionValue === undefined
    ? { element, kind: 'combobox' }
    : { element, kind: 'combobox', optionValue };

describe('CustomComboboxAdapter', () => {
  it('claims an ARIA combobox that no native adapter can drive', () => {
    const element = mountCombobox(['United States']);
    expect(CustomComboboxAdapter.canHandle(contextFor(element))).toBe(true);

    // And the registry hands it to this adapter rather than to the text one,
    // which would "fill" it by writing into a div.
    const chosen = NATIVE_ADAPTERS.find((adapter) => adapter.canHandle(contextFor(element)));
    expect(chosen?.name).toBe('CustomCombobox');
  });

  it('declines a native <select>, which cannot be opened by script', () => {
    document.body.innerHTML = '<select><option value="us">United States</option></select>';
    const select = document.body.firstElementChild as HTMLElement;
    expect(CustomComboboxAdapter.canHandle({ element: select, kind: 'select' })).toBe(false);
  });

  it('opens the list, clicks the matching option, and verifies the read-back', async () => {
    const element = mountCombobox(['Canada', 'Mexico', 'United States']);

    const result = await CustomComboboxAdapter.fill(contextFor(element), 'United States');
    expect(result.ok).toBe(true);
    expect(element.textContent).toBe('United States');
    expect(await CustomComboboxAdapter.verify(contextFor(element), 'United States')).toBe(true);
  });

  it('matches a fuller option label by prefix', async () => {
    const element = mountCombobox(['United States of America', 'Canada']);

    const result = await CustomComboboxAdapter.fill(contextFor(element), 'United States');
    expect(result.ok).toBe(true);
    expect(element.textContent).toBe('United States of America');
  });

  it('refuses an ambiguous list instead of taking the first match', async () => {
    // The exact failure this rule exists for: a prefix comparison matches both,
    // and choosing between them would be a coin flip presented as an answer.
    const element = mountCombobox([
      'United States Minor Outlying Islands',
      'United States Virgin Islands',
    ]);

    const result = await CustomComboboxAdapter.fill(contextFor(element), 'United States');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('option_not_found');
    // And it left the control as it found it.
    expect(element.textContent).toBe('Select...');
  });

  it('reports a control whose list never appears rather than claiming success', async () => {
    document.body.innerHTML = '<div role="combobox" tabindex="0">Select...</div>';
    const element = document.body.firstElementChild as HTMLElement;

    const result = await CustomComboboxAdapter.fill(contextFor(element), 'Anything');
    expect(result.ok).toBe(false);
    expect(await CustomComboboxAdapter.verify(contextFor(element), 'Anything')).toBe(false);
  });

  it('prefers the option value the resolver already matched', async () => {
    const element = mountCombobox(['Bachelor of Science', 'Bachelor of Arts']);

    // The label would be ambiguous by prefix; the resolver's exact choice is
    // not, and it must not be silently re-derived from the display value.
    const result = await CustomComboboxAdapter.fill(
      contextFor(element, 'Bachelor of Arts'),
      'Bachelor',
    );
    expect(result.ok).toBe(true);
    expect(element.textContent).toBe('Bachelor of Arts');
  });

  it('does not touch a disabled control', async () => {
    const element = mountCombobox(['Canada']);
    element.setAttribute('aria-disabled', 'true');

    const result = await CustomComboboxAdapter.fill(contextFor(element), 'Canada');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_editable');
  });
});

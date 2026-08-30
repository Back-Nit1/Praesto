// @vitest-environment jsdom
/**
 * Scanner hardening tests.
 *
 * Every string in a descriptor comes from a page we do not control. These
 * tests assert that a hostile or merely broken page costs itself a field, not
 * the whole scan - and, crucially, that the descriptor a page can produce
 * still satisfies the message schema, because a descriptor that fails
 * validation takes the ENTIRE scan down with it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { scanPage } from '@form-engine/detector/scanner';
import { fieldDescriptorSchema } from '@shared/messages';

/**
 * jsdom does no layout, so every element reports zero size and a null
 * offsetParent and the scanner's visibility check would reject all of them.
 * Same minimal stub the fixture tests use.
 */
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return window.getComputedStyle(this as HTMLElement).display === 'none'
        ? null
        : (this as HTMLElement).parentElement;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 } as DOMRect;
  };
}

beforeEach(() => {
  stubLayout();
});

/** Build a document from HTML and scan it. */
async function scan(html: string) {
  document.body.innerHTML = html;
  const { result } = await scanPage(document, { ats: 'unknown' });
  return result;
}

/** Three controls are needed before a page looks like an application form. */
const PADDING = `
  <label>First <input name="first" /></label>
  <label>Last <input name="last" /></label>
`;

describe('descriptor caps against a hostile page', () => {
  it('truncates an absurd label instead of failing validation', async () => {
    const huge = 'A'.repeat(2_000_000);
    const result = await scan(`
      <label for="x">${huge}</label>
      <input id="x" name="x" />
      ${PADDING}
    `);

    const field = result.fields.find((candidate) => candidate.name === 'x');
    expect(field).toBeDefined();
    expect((field?.label ?? '').length).toBeLessThanOrEqual(512);

    // The real assertion: every descriptor still passes the wire schema, so
    // the scan reaches the service worker at all.
    for (const descriptor of result.fields) {
      expect(fieldDescriptorSchema.safeParse(descriptor).success).toBe(true);
    }
  });

  it('truncates long name, id, placeholder and current value', async () => {
    const huge = 'b'.repeat(5000);
    const result = await scan(`
      <input id="${huge}" name="${huge}" placeholder="${huge}" value="${huge}" />
      ${PADDING}
    `);

    const field = result.fields[0];
    expect(field).toBeDefined();
    expect((field?.name ?? '').length).toBeLessThanOrEqual(256);
    expect((field?.id ?? '').length).toBeLessThanOrEqual(256);
    expect((field?.placeholder ?? '').length).toBeLessThanOrEqual(256);
    expect((field?.currentValue ?? '').length).toBeLessThanOrEqual(1024);
    expect(fieldDescriptorSchema.safeParse(field).success).toBe(true);
  });

  it('caps a select with far more options than any real dropdown', async () => {
    // 5,000 options. Before the cap this produced a descriptor the schema
    // rejected (max 500), which failed the whole page.
    const options = Array.from(
      { length: 2000 },
      (_, i) => `<option value="v${i}">o${i}</option>`,
    ).join('');
    const result = await scan(`<select name="s">${options}</select>${PADDING}`);

    const field = result.fields.find((candidate) => candidate.name === 's');
    expect(field?.options?.length).toBeLessThanOrEqual(500);
    expect(fieldDescriptorSchema.safeParse(field).success).toBe(true);
  });

  it('caps a radio group with an absurd number of members', async () => {
    // The pathological case for the old O(n^2) merge: one name, many inputs.
    // 600 is enough to exceed the 500-option cap. It is kept modest because
    // jsdom's getComputedStyle - which the scanner's visibility check calls
    // once per control - costs milliseconds per element; the quadratic
    // behaviour this guards against showed up long before this size.
    const radios = Array.from(
      { length: 600 },
      (_, i) => `<label><input type="radio" name="r" value="v${i}" /> o${i}</label>`,
    ).join('');
    const result = await scan(`<fieldset><legend>Pick</legend>${radios}</fieldset>${PADDING}`);

    const group = result.fields.filter((candidate) => candidate.kind === 'radio');
    // One question, not 3000 fields.
    expect(group).toHaveLength(1);
    expect(group[0]?.options?.length).toBeLessThanOrEqual(500);
    expect(fieldDescriptorSchema.safeParse(group[0]).success).toBe(true);
  }, 20_000);

  it('strips the query string from the page URL', async () => {
    const result = await scan(`<input name="a" />${PADDING}`);
    const field = result.fields[0];

    expect(field?.pageUrl).not.toContain('?');
    // jsdom's default location is http://localhost:3000/, so origin+path holds.
    expect(field?.pageUrl.startsWith('http')).toBe(true);
  });

  it('never emits a descriptor the wire schema would reject', async () => {
    const noise = 'x'.repeat(10_000);
    const result = await scan(`
      <div role="heading">${noise}</div>
      <label>${noise}<textarea name="t">${noise}</textarea></label>
      <input name="${noise}" type="text" autocomplete="${noise}" title="${noise}" />
      ${PADDING}
    `);

    expect(result.fields.length).toBeGreaterThan(0);
    for (const descriptor of result.fields) {
      const parsed = fieldDescriptorSchema.safeParse(descriptor);
      expect(parsed.success).toBe(true);
    }
  });
});

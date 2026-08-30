/**
 * DOM scanner - turning a webpage into FieldDescriptors.
 * ---------------------------------------------------------------------------
 * The only module in the form engine that touches the DOM, and the reason
 * everything else can be tested in Node.
 *
 * Its whole job is: find the controls, describe them honestly, and hand off.
 * It makes no mapping decisions and reads no applicant data.
 *
 * PERFORMANCE IS A CORRECTNESS CONCERN HERE
 * This code runs on the main thread of someone else's page, while they are in
 * the middle of a job application. A Workday form can carry several hundred
 * controls, and building a descriptor walks upward through the DOM looking for
 * labels and headings. Done naively on a 4 GB Chromebook that is a visible
 * freeze and, past a few seconds, Chrome's "page is unresponsive" dialog.
 *
 * Three defences, all driven by shared/runtime-budget.ts rather than by
 * constants tuned on a fast machine:
 *   1. work is chunked, yielding to the event loop between chunks,
 *   2. the total number of controls examined is capped,
 *   3. harvested context text is length-bounded.
 *
 * None of them affect WHAT we conclude about a field - only how much of the
 * page we are willing to look at in one go.
 */
import { newId } from '@shared/ids';
import { createLogger } from '@shared/logging';
import { getRuntimeBudget } from '@shared/runtime-budget';
import type { ATSKind } from '@ats/types';
import { computeSemanticFingerprint } from '../fingerprints/fingerprint';
import type { ControlKind, FieldDescriptor, FieldOption, ScanResult } from '../descriptor/types';

const log = createLogger('scanner');

/**
 * Selector for anything that might be an application field.
 *
 * Includes ARIA roles because a great many ATS platforms build custom widgets
 * out of divs; `[role="combobox"]` is how a Workday dropdown announces itself.
 */
const CANDIDATE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="listbox"]',
  '[contenteditable="true"]',
].join(',');

/**
 * Input types that are never application content.
 *
 * `hidden` carries CSRF tokens; `submit`/`button`/`reset`/`image` are actions,
 * and typing into them is meaningless. Excluding them here rather than in the
 * mapper keeps the field count (and therefore the user-facing "18 fields
 * detected") honest.
 */
const IGNORED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/**
 * Attributes that mark a control as site navigation rather than application
 * content. Spec section 11: ignore "search/navigation controls outside the
 * application area where detectable."
 */
const SEARCH_HINTS = /\b(search|filter|query|newsletter|subscribe|coupon|promo)\b/i;

export interface ScanOptions {
  ats: ATSKind;
  /** Root to scan. Defaults to the whole document; a MutationObserver rescan
   *  passes the changed subtree so we do not reprocess the page. */
  root?: ParentNode;
  /** Overrides the runtime budget. Tests only. */
  maxFields?: number;
}

/**
 * What a scan produces.
 *
 * The two halves are deliberately separate and travel differently:
 *
 *   result    plain, serializable data. This is what crosses the message
 *             boundary to the service worker.
 *   elements  live DOM references, keyed by the same localIds. This NEVER
 *             leaves the page context - it cannot be serialized, and that is
 *             the point. The worker can say "fill the field you called f_12";
 *             it cannot address a DOM node.
 *
 * The alternative - stamping a `data-aa-id` attribute on every control so the
 * element can be found again later - was rejected: it mutates a page we do not
 * own, is visible in the user's devtools and in any DOM the site itself
 * serializes, and can be observed (or stripped) by the page's own scripts.
 * Holding references in a Map costs nothing and touches nothing.
 */
export interface ScanOutcome {
  result: ScanResult;
  elements: Map<string, HTMLElement>;
}

/**
 * Scan for application fields.
 *
 * Async because it yields between chunks. The caller awaits a complete result;
 * the page stays responsive throughout.
 */
export async function scanPage(document: Document, options: ScanOptions): Promise<ScanOutcome> {
  const startedAt = performance.now();
  const budget = getRuntimeBudget();
  const maxFields = options.maxFields ?? budget.maxFieldsPerScan;
  const root = options.root ?? document;

  const elements = [...root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)];
  const fields: FieldDescriptor[] = [];
  const elementsById = new Map<string, HTMLElement>();
  let truncated = false;

  // Radio groups: many DOM elements, ONE question. Tracked so the descriptor
  // carries every option and the side panel reports one field, not five.
  const radioGroups = new Map<string, FieldDescriptor>();

  for (let index = 0; index < elements.length; index++) {
    if (fields.length >= maxFields) {
      truncated = true;
      log.warn(`Scan truncated at ${maxFields} fields; the page has ${elements.length} candidates`);
      break;
    }

    const element = elements[index];
    if (element === undefined) continue;

    // A single unusual element must not abort the scan. Spec section 29:
    // "an unsupported field should remain untouched, not crash the entire scan."
    try {
      const descriptor = describeElement(element, document, options.ats, budget.maxNearbyTextChars);
      if (descriptor === null) continue;

      if (descriptor.kind === 'radio' && descriptor.name !== undefined) {
        mergeRadioOption(radioGroups, fields, elementsById, descriptor, element);
        continue;
      }

      fields.push(descriptor);
      elementsById.set(descriptor.localId, element);
    } catch (error) {
      log.debugLazy(() => ['Skipped an element that could not be described', error]);
    }

    // Yield between chunks so the host page can paint and respond to input.
    // Without this the whole scan is one long task and the page visibly locks.
    if ((index + 1) % budget.scanChunkSize === 0) {
      await yieldToEventLoop();
    }
  }

  // Radio-group fingerprints must be recomputed now that every option has been
  // merged in. The first radio in a group established the descriptor before its
  // siblings were seen, so its fingerprint covered a one-option answer space -
  // which would not match the same question on another page. The fingerprint
  // has to describe the finished question, not the partially-built one.
  for (const group of radioGroups.values()) {
    group.semanticFingerprint = computeSemanticFingerprint(group);
  }

  return {
    result: {
      page: {
        url: document.location?.href ?? '',
        hostname: document.location?.hostname ?? '',
        ats: options.ats,
      },
      fields,
      truncated,
      scanDurationMs: Math.round(performance.now() - startedAt),
    },
    elements: elementsById,
  };
}

/**
 * Hand control back to the browser.
 *
 * `scheduler.yield()` is the purpose-built API and keeps our continuation at
 * high priority, so a yielding scan finishes promptly instead of being starved.
 * `setTimeout(0)` is the fallback for Chrome versions without it.
 */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Describe one element, or return null when it is not an application field.
 */
function describeElement(
  element: HTMLElement,
  document: Document,
  ats: ATSKind,
  maxNearbyTextChars: number,
): FieldDescriptor | null {
  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute('type')?.toLowerCase();

  if (type !== undefined && IGNORED_INPUT_TYPES.has(type)) return null;
  if (!isVisible(element)) return null;
  if (looksLikeSiteChrome(element)) return null;

  const kind = classifyControl(element, tag, type);
  if (kind === 'unsupported') return null;

  const label = findLabel(element, document);
  const options = collectOptions(element, kind);

  // Assembled without the fingerprint first, then hashed - so the fingerprint
  // is always computed from the finished descriptor and the two cannot drift.
  const base: Omit<FieldDescriptor, 'semanticFingerprint'> = {
    localId: newId('f'),
    tag,
    kind,
    required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
    disabled:
      element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
    pageUrl: document.location?.href ?? '',
    hostname: document.location?.hostname ?? '',
    ats,
    inIframe: window.self !== window.top,
  };

  if (type !== undefined) base.type = type;

  const role = element.getAttribute('role');
  if (role !== null) base.role = role;

  const autocomplete = element.getAttribute('autocomplete');
  if (autocomplete !== null) base.autocomplete = autocomplete;

  if (label !== undefined) base.label = label;

  const accessibleName = computeAccessibleName(element, document);
  if (accessibleName !== undefined) base.accessibleName = accessibleName;

  const name = element.getAttribute('name');
  if (name !== null) base.name = name;
  if (element.id.length > 0) base.id = element.id;

  const placeholder = element.getAttribute('placeholder');
  if (placeholder !== null) base.placeholder = placeholder;

  if (options !== undefined) base.options = options;

  const nearby = collectNearbyText(element, maxNearbyTextChars);
  if (nearby !== undefined) base.nearbyText = nearby;

  const heading = findSectionHeading(element);
  if (heading !== undefined) base.sectionHeading = heading;

  const currentValue = readCurrentValue(element);
  if (currentValue !== undefined) base.currentValue = currentValue;

  const maxLength = element.getAttribute('maxlength');
  if (maxLength !== null) {
    const parsed = Number(maxLength);
    // A negative or absurd maxlength is markup noise, not a constraint.
    if (Number.isInteger(parsed) && parsed > 0) base.maxLength = parsed;
  }

  return { ...base, semanticFingerprint: computeSemanticFingerprint(base) };
}

/** Map tag + type + role onto our control vocabulary. */
function classifyControl(element: HTMLElement, tag: string, type?: string): ControlKind {
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';

  if (tag === 'input') {
    switch (type) {
      case undefined:
      case 'text':
        return 'text';
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      case 'url':
        return 'url';
      case 'number':
        return 'number';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'file':
        return 'file';
      case 'date':
      case 'month':
        return 'date';
      case 'search':
        // A search box on an application page is site chrome, not a question.
        return 'unsupported';
      default:
        // password, color, range, and anything a future HTML version adds. We
        // do not know how to fill them safely, so we do not claim to.
        return 'unsupported';
    }
  }

  switch (element.getAttribute('role')) {
    case 'textbox':
      return 'text';
    case 'combobox':
    case 'listbox':
      return 'combobox';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    default:
      return element.isContentEditable ? 'textarea' : 'unsupported';
  }
}

/**
 * Is the element actually on screen and interactive?
 *
 * Checked because forms routinely keep hidden template rows and collapsed
 * conditional sections in the DOM. Filling one is invisible to the user and
 * frequently submits a value they never saw.
 *
 * `offsetParent === null` is the cheap check that catches `display:none` and
 * detached subtrees without forcing a style recalculation; the explicit
 * `getComputedStyle` covers `visibility:hidden` and `opacity:0`, which
 * offsetParent does not. `position:fixed` elements legitimately have a null
 * offsetParent, hence the exemption.
 */
function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;

  if (element.offsetParent === null && style.position !== 'fixed') return false;

  // A zero-size control cannot be interacted with. Radios and checkboxes are
  // exempt: the common pattern is a visually-hidden input driven by a styled
  // label, and that IS a real, answerable question.
  const rect = element.getBoundingClientRect();
  const isChoice = element.getAttribute('type') === 'radio' || element.getAttribute('type') === 'checkbox';
  if (!isChoice && rect.width === 0 && rect.height === 0) return false;

  return true;
}

/** Filter out site search, newsletter signup, and similar page furniture. */
function looksLikeSiteChrome(element: HTMLElement): boolean {
  const haystack = [
    element.getAttribute('name'),
    element.id,
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join(' ');

  if (SEARCH_HINTS.test(haystack)) return true;

  // A control inside the page header, footer, or nav is site chrome by
  // definition. `closest` is a single upward walk, not a tree search.
  return element.closest('header, footer, nav, [role="navigation"], [role="search"]') !== null;
}

/**
 * Find the human-readable label for a control.
 *
 * Ordered by how much the association can be trusted:
 *   1. `<label for="id">`   - an explicit, unambiguous declaration
 *   2. an ancestor `<label>` - implicit wrapping, also explicit enough
 *   3. `aria-label`
 *   4. `aria-labelledby` -> the referenced element's text
 *
 * Nearby-text guessing is deliberately NOT here; it is collected separately as
 * `nearbyText` so the mapper knows it is a weaker signal.
 */
function findLabel(element: HTMLElement, document: Document): string | undefined {
  if (element.id.length > 0) {
    // CSS.escape guards against ids containing brackets or colons, which Rails-
    // and Workday-style markup produces constantly and which would otherwise
    // throw a SyntaxError from querySelector.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(element.id) : element.id;
    const explicit = document.querySelector(`label[for="${escaped}"]`);
    const text = cleanText(explicit?.textContent);
    if (text !== undefined) return text;
  }

  const wrapping = element.closest('label');
  if (wrapping !== null) {
    // Exclude the control's own text (a select's options) from its label.
    const clone = wrapping.cloneNode(true) as HTMLElement;
    for (const child of clone.querySelectorAll('input, select, textarea')) child.remove();
    const text = cleanText(clone.textContent);
    if (text !== undefined) return text;
  }

  const ariaLabel = cleanText(element.getAttribute('aria-label'));
  if (ariaLabel !== undefined) return ariaLabel;

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent)
      .filter((value): value is string => value !== null && value !== undefined);
    const text = cleanText(parts.join(' '));
    if (text !== undefined) return text;
  }

  return undefined;
}

/**
 * The accessible name, approximated.
 *
 * A full ACCNAME implementation is large and mostly redundant with findLabel.
 * This covers the cases that differ in practice - `title`, and a wrapping
 * fieldset's legend for a radio group whose individual inputs are labelled with
 * their option text rather than the question.
 */
function computeAccessibleName(element: HTMLElement, _document: Document): string | undefined {
  const title = cleanText(element.getAttribute('title'));
  if (title !== undefined) return title;

  const legend = element.closest('fieldset')?.querySelector('legend');
  return cleanText(legend?.textContent);
}

/** Options for a select, listbox, or ARIA combobox. */
function collectOptions(element: HTMLElement, kind: ControlKind): FieldOption[] | undefined {
  if (element instanceof HTMLSelectElement) {
    return [...element.options]
      // A leading "Select..." placeholder is not an answer. Offering it as one
      // would let the resolver "successfully" choose the empty option.
      .filter((option) => option.value !== '' || cleanText(option.textContent) !== undefined)
      .map((option) => ({
        value: option.value,
        label: cleanText(option.textContent) ?? option.value,
        selected: option.selected,
      }));
  }

  if (kind === 'combobox') {
    const listboxId = element.getAttribute('aria-controls') ?? element.getAttribute('aria-owns');
    const listbox = listboxId === null ? null : document.getElementById(listboxId);
    if (listbox === null) return undefined;

    // A custom dropdown usually renders its options only while open, so an
    // empty list here is expected, not an error - the fill adapter opens the
    // control and reads them at fill time.
    const options = [...listbox.querySelectorAll('[role="option"]')]
      .map((option) => {
        const label = cleanText(option.textContent);
        return label === undefined
          ? null
          : { value: option.getAttribute('data-value') ?? label, label };
      })
      .filter((option): option is FieldOption => option !== null);

    return options.length > 0 ? options : undefined;
  }

  return undefined;
}

/**
 * Text surrounding the control, for questions whose label is not a `<label>`.
 *
 * Walks UP to the nearest plausible question container rather than grabbing a
 * fixed number of sibling nodes: a question's wording and its input are almost
 * always inside one wrapper, and the wrapper boundary is what stops us from
 * harvesting the next question's text.
 *
 * Length-bounded by the runtime budget: unbounded harvesting is both a memory
 * cost and a privacy cost, since it copies unrelated page content into the
 * extension.
 */
function collectNearbyText(element: HTMLElement, maxChars: number): string | undefined {
  const container = element.closest(
    'fieldset, .field, .form-group, .question, [class*="field"], [class*="question"], li, td, div',
  );
  if (container === null) return undefined;

  const clone = container.cloneNode(true) as HTMLElement;
  for (const child of clone.querySelectorAll('input, select, textarea, option, script, style')) {
    child.remove();
  }

  const text = cleanText(clone.textContent);
  if (text === undefined) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Nearest preceding section heading.
 *
 * The signal that disambiguates "Start date" under "Education" from the same
 * question under "Work experience" - a distinction no amount of label analysis
 * can make, because the labels are identical.
 */
function findSectionHeading(element: HTMLElement): string | undefined {
  // Bounded upward walk. Unbounded would run to <html> on a deep React tree and
  // return the page's <h1>, which is not a section heading.
  const MAX_ANCESTOR_HOPS = 8;

  let current: HTMLElement | null = element.parentElement;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && current !== null; hop++) {
    const heading = current.querySelector('h1, h2, h3, h4, legend, [role="heading"]');
    const text = cleanText(heading?.textContent);
    if (text !== undefined && text.length < 100) return text;
    current = current.parentElement;
  }
  return undefined;
}

/** What the control currently holds. Used to enforce "never overwrite". */
function readCurrentValue(element: HTMLElement): string | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.checked ? 'checked' : undefined;
    }
    return element.value.length > 0 ? element.value : undefined;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value.length > 0 ? element.value : undefined;
  }
  return cleanText(element.textContent);
}

/**
 * Merge one radio input into its group's descriptor.
 *
 * A radio group is ONE question with N options. Reporting five descriptors for
 * "Are you authorized to work in the US? Yes/No/Prefer not to say" would make
 * the side panel's field counts meaningless and would ask the mapper to map an
 * option, not a question.
 */
function mergeRadioOption(
  groups: Map<string, FieldDescriptor>,
  fields: FieldDescriptor[],
  elementsById: Map<string, HTMLElement>,
  descriptor: FieldDescriptor,
  element: HTMLElement,
): void {
  const groupName = descriptor.name;
  if (groupName === undefined) return;

  const optionLabel = descriptor.label ?? descriptor.accessibleName ?? '';
  const optionValue = element.getAttribute('value') ?? optionLabel;
  const option: FieldOption = {
    value: optionValue,
    label: optionLabel,
    selected: element instanceof HTMLInputElement ? element.checked : false,
  };

  const existing = groups.get(groupName);
  if (existing !== undefined) {
    existing.options = [...(existing.options ?? []), option];
    return;
  }

  // The first radio establishes the group. Its question is the fieldset legend
  // or surrounding text, NOT its own label - its own label is "Yes".
  const question = descriptor.accessibleName ?? descriptor.sectionHeading ?? descriptor.nearbyText;
  const groupDescriptor: FieldDescriptor = {
    ...descriptor,
    options: [option],
  };
  if (question !== undefined) groupDescriptor.label = question;

  groups.set(groupName, groupDescriptor);
  fields.push(groupDescriptor);
  // The group's element is its FIRST radio. The radio adapter walks the rest of
  // the group by `name` from there, which is how HTML itself defines a radio
  // group - so one reference is enough and stays correct if options are added.
  elementsById.set(groupDescriptor.localId, element);
}

/** Collapse whitespace and drop empty strings. */
function cleanText(input: string | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;
  const text = input.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

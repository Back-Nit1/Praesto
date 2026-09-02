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

/**
 * SECURITY: length caps for every page-controlled string in a descriptor.
 *
 * THE BUG THESE FIX. Every value below is written by the page. The message
 * schema in shared/messages.ts already caps them - but it caps them on the
 * RECEIVING side, where the only available response to an over-long string is
 * to reject the ENTIRE message. So a page that rendered one label containing a
 * megabyte of text did not get its own field dropped: it made the whole scan
 * fail Zod validation, and the side panel told the user "this page could not be
 * scanned". A hostile page could disable the extension with one attribute, and
 * a merely sloppy one could do it by accident.
 *
 * Truncating at the source fixes both halves:
 *   - correctness: a huge label costs that label, not the page,
 *   - memory: the megabyte is never copied across the message boundary, held
 *     in the service worker, or retained in `lastDescriptors`. On the low-RAM
 *     machines this extension targets, an unbounded harvest of page text is
 *     the single easiest way to get the tab killed.
 *
 * Every number here is <= its counterpart in `fieldDescriptorSchema`. They must
 * stay that way; the schema is the contract and this is the enforcement.
 */
const MAX = {
  type: 32,
  role: 64,
  autocomplete: 128,
  label: 512,
  accessibleName: 512,
  name: 256,
  id: 256,
  placeholder: 256,
  sectionHeading: 256,
  currentValue: 1024,
  pageUrl: 2048,
  hostname: 256,
  tag: 32,
  optionValue: 512,
  optionLabel: 512,
} as const;

/**
 * Largest number of options carried for one control.
 *
 * A country dropdown is ~250 entries, so 500 is generous. It matches the
 * schema's cap for the same reason as the string limits: a `<select>` with
 * 100,000 synthetic options would otherwise fail validation for the whole page
 * (and cost 100,000 string allocations first).
 */
const MAX_OPTIONS_PER_FIELD = 500;

/**
 * Truncate a page-controlled string.
 *
 * Returns `undefined` for absent input so it composes with the optional-field
 * assignments below. O(1) for the overwhelmingly common short string - `slice`
 * only allocates when the cap is actually exceeded.
 */
function capped(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * SECURITY / DATA MINIMISATION: reduce a page URL to origin + path.
 *
 * ATS URLs routinely carry session identifiers, applicant tokens and tracking
 * parameters in the query string ("?gh_src=...&token=..."). Nothing downstream
 * reads more than the hostname, so carrying the rest into the service worker,
 * into `lastDescriptors`, and potentially into an audit record would be storing
 * a credential for no reason at all.
 *
 * Falls back to a truncated raw string when the URL will not parse - a
 * descriptor is never worth throwing over.
 */
function minimizeUrl(href: string): string {
  try {
    const url = new URL(href);
    return capped(`${url.origin}${url.pathname}`, MAX.pageUrl) ?? '';
  } catch {
    return capped(href, MAX.pageUrl) ?? '';
  }
}

/** What to scan, and how much of it. */
export interface ScanOptions {
  ats: ATSKind;
  /** Root to scan. Defaults to the whole document; a MutationObserver rescan
   *  passes the changed subtree so we do not reprocess the page. */
  root?: ParentNode;
  /**
   * Several subtrees, scanned as one pass. Overrides `root` when present.
   *
   * A conditional question rarely appears in one place: answering "yes" to
   * sponsorship can reveal a block here and enable a field there, and each
   * arrives as its own mutation. Scanning them together produces ONE scan -
   * one page context, one truncation decision, one set of ids - where scanning
   * them one at a time would produce three partial scans the panel would then
   * have to reconcile.
   *
   * A root that is itself a form control is included, which `querySelectorAll`
   * alone would miss: a page that appends a bare `<input>` produces a mutation
   * whose added node IS the field.
   */
  roots?: readonly ParentNode[];
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
  const roots = options.roots ?? [options.root ?? document];

  const elements = collectCandidates(roots);
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
  // SECURITY: every string below is page-controlled and is capped at its
  // source. See the MAX table for why truncating here rather than at the
  // schema is the difference between "one weird field" and "the whole scan
  // failed validation".
  const base: Omit<FieldDescriptor, 'semanticFingerprint'> = {
    localId: newId('f'),
    tag: capped(tag, MAX.tag) ?? '',
    kind,
    required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
    disabled:
      element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
    // Origin + path only - the query string is stripped, see minimizeUrl.
    pageUrl: minimizeUrl(document.location?.href ?? ''),
    hostname: capped(document.location?.hostname, MAX.hostname) ?? '',
    ats,
    inIframe: window.self !== window.top,
  };

  const cappedType = capped(type, MAX.type);
  if (cappedType !== undefined) base.type = cappedType;

  const role = capped(element.getAttribute('role'), MAX.role);
  if (role !== undefined) base.role = role;

  const autocomplete = capped(element.getAttribute('autocomplete'), MAX.autocomplete);
  if (autocomplete !== undefined) base.autocomplete = autocomplete;

  const cappedLabel = capped(label, MAX.label);
  if (cappedLabel !== undefined) base.label = cappedLabel;

  const accessibleName = capped(computeAccessibleName(element, document), MAX.accessibleName);
  if (accessibleName !== undefined) base.accessibleName = accessibleName;

  const name = capped(element.getAttribute('name'), MAX.name);
  if (name !== undefined) base.name = name;

  const id = capped(element.id, MAX.id);
  if (id !== undefined && id.length > 0) base.id = id;

  const placeholder = capped(element.getAttribute('placeholder'), MAX.placeholder);
  if (placeholder !== undefined) base.placeholder = placeholder;

  if (options !== undefined) base.options = options;

  // Already bounded by the runtime budget (<= 400 chars), which is well under
  // the schema's 1024.
  const nearby = collectNearbyText(element, maxNearbyTextChars);
  if (nearby !== undefined) base.nearbyText = nearby;

  const heading = capped(findSectionHeading(element), MAX.sectionHeading);
  if (heading !== undefined) base.sectionHeading = heading;

  const currentValue = capped(readCurrentValue(element), MAX.currentValue);
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
 * Every candidate control under the given roots, in document order, once each.
 *
 * Deduplicated because subtrees overlap: two mutations inside the same
 * container yield two roots, one of which may contain the other, and a control
 * described twice would become two panel rows for one question.
 *
 * `compareDocumentPosition` restores document order across roots, so the field
 * list reads in the order the user sees the form regardless of the order the
 * mutations arrived in.
 */
function collectCandidates(roots: readonly ParentNode[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();

  for (const root of roots) {
    // A root that is itself a control: `querySelectorAll` searches DESCENDANTS
    // only, so an appended bare input would otherwise never be described.
    if (root instanceof HTMLElement && root.matches(CANDIDATE_SELECTOR)) seen.add(root);
    for (const element of root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) seen.add(element);
  }

  if (roots.length === 1) return [...seen];

  return [...seen].sort((a, b) =>
    // eslint-disable-next-line no-bitwise -- the DOM API is a bitmask
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
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
  // The attribute, on this element OR any ancestor. A conditional question is
  // usually revealed by unhiding the BLOCK that contains it, not the input, and
  // the browser's own `[hidden] { display: none }` is only a default an author
  // stylesheet is free to override. Reading the attribute directly means the
  // rule holds on a page whose CSS reset dropped it, and the direction of the
  // mistake is the safe one: we refuse a field rather than fill one nobody can
  // see.
  if (element.closest('[hidden]') !== null) return false;

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

/**
 * Options for a select, listbox, or ARIA combobox.
 *
 * SECURITY / MEMORY: capped at MAX_OPTIONS_PER_FIELD, and the cap is applied
 * DURING the walk rather than by slicing afterwards. A page with a synthetic
 * 100,000-option `<select>` therefore costs 500 allocations, not 100,000 -
 * and, before this cap existed, produced a descriptor the message schema
 * rejected, which failed the whole scan rather than this one control.
 */
function collectOptions(element: HTMLElement, kind: ControlKind): FieldOption[] | undefined {
  if (element instanceof HTMLSelectElement) {
    const collected: FieldOption[] = [];
    // Indexed loop over the live HTMLOptionsCollection: no intermediate array
    // copy of every option before filtering, which is what `[...element.options]`
    // was doing.
    for (let index = 0; index < element.options.length; index++) {
      if (collected.length >= MAX_OPTIONS_PER_FIELD) break;
      const option = element.options[index];
      if (option === undefined) continue;

      const text = cleanText(option.textContent);
      // A leading "Select..." placeholder is not an answer. Offering it as one
      // would let the resolver "successfully" choose the empty option.
      if (option.value === '' && text === undefined) continue;

      collected.push({
        value: capped(option.value, MAX.optionValue) ?? '',
        label: capped(text ?? option.value, MAX.optionLabel) ?? '',
        selected: option.selected,
      });
    }
    return collected;
  }

  if (kind === 'combobox') {
    const listboxId = element.getAttribute('aria-controls') ?? element.getAttribute('aria-owns');
    const listbox = listboxId === null ? null : document.getElementById(listboxId);
    if (listbox === null) return undefined;

    // A custom dropdown usually renders its options only while open, so an
    // empty list here is expected, not an error - the fill adapter opens the
    // control and reads them at fill time.
    const options: FieldOption[] = [];
    for (const option of listbox.querySelectorAll('[role="option"]')) {
      if (options.length >= MAX_OPTIONS_PER_FIELD) break;
      const label = cleanText(option.textContent);
      if (label === undefined) continue;
      options.push({
        value: capped(option.getAttribute('data-value') ?? label, MAX.optionValue) ?? '',
        label: capped(label, MAX.optionLabel) ?? '',
      });
    }

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

  /**
   * PERFORMANCE FIX (this was a real hang, not a theoretical one).
   *
   * This function used to do:
   *
   *     const clone = container.cloneNode(true);          // deep copy
   *     clone.querySelectorAll('input, ...').forEach(remove);
   *     cleanText(clone.textContent);
   *
   * which is O(size of the container subtree) PER FIELD. When many controls
   * share one large container - a `<fieldset>` holding a big radio group, a
   * long `<div>` wrapping a whole application section - that is quadratic in
   * the size of the page, executed on the host page's main thread. A fieldset
   * with 3,000 radios meant ~9,000,000 node clones and a hung tab. It
   * reproduced on the first hostile-page test written against it.
   *
   * The replacement is a TreeWalker that reads text nodes directly and STOPS
   * as soon as it has `maxChars`. No copy is made, nothing is mutated, and the
   * cost is O(maxChars) - roughly 300 characters - regardless of how large the
   * container is. `visited` bounds the pathological case where a huge subtree
   * contains almost no text.
   */
  const MAX_NODES_VISITED = 400;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      // Reject text that belongs to a control (an option list, a value) or to
      // a script/style block - the same exclusions the clone made, done
      // without building a clone.
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        tag === 'OPTION' ||
        tag === 'SCRIPT' ||
        tag === 'STYLE'
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts: string[] = [];
  let length = 0;
  let visited = 0;

  // Accumulate into an array and join once: repeated `+=` on a growing string
  // is what makes this kind of loop quietly quadratic in some engines.
  while (length < maxChars && visited < MAX_NODES_VISITED) {
    const node = walker.nextNode();
    if (node === null) break;
    visited++;

    const raw = node.nodeValue;
    if (raw === null || raw.trim().length === 0) continue;

    parts.push(raw);
    length += raw.length;
  }

  const text = cleanText(parts.join(' '));
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

  const optionLabel = capped(descriptor.label ?? descriptor.accessibleName ?? '', MAX.optionLabel) ?? '';
  const optionValue = capped(element.getAttribute('value') ?? optionLabel, MAX.optionValue) ?? '';
  const option: FieldOption = {
    value: optionValue,
    label: optionLabel,
    selected: element instanceof HTMLInputElement ? element.checked : false,
  };

  const existing = groups.get(groupName);
  if (existing !== undefined) {
    /**
     * PERFORMANCE + SECURITY: push, do not re-spread.
     *
     * This was `existing.options = [...(existing.options ?? []), option]`,
     * which copies the whole array once per radio - O(n^2) over a group. A page
     * with 20,000 radios sharing one `name` (trivial to render) turned a scan
     * into ~200 million copies on the host page's main thread, which is a
     * hung tab, not a slow one. The cap then bounds the group so a descriptor
     * cannot exceed what the message schema will accept.
     */
    if (existing.options === undefined) existing.options = [option];
    else if (existing.options.length < MAX_OPTIONS_PER_FIELD) existing.options.push(option);
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

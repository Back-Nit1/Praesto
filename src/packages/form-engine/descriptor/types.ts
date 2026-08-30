/**
 * FieldDescriptor - the DOM-free description of one form control.
 * ---------------------------------------------------------------------------
 * This type is the seam that makes the whole architecture testable.
 *
 * The content script produces descriptors from real DOM elements. Everything
 * downstream - the mapper, the confidence policy, the resolver, the learning
 * store - consumes descriptors and has never heard of an `HTMLElement`. That
 * means the entire intelligence of the product can be unit tested in Node, in
 * milliseconds, from plain objects, with no browser and no fixtures
 * (spec section 29: "Keep DOM-specific code out of pure mapping logic").
 *
 * It is also the privacy seam. A descriptor contains what the PAGE said - its
 * labels, its placeholders, its options. It never contains applicant data. So
 * the message that crosses from the webpage's context to the service worker
 * carries only the page's own words, and the reply carries only the handful of
 * values those specific fields need (spec section 21.1).
 *
 * SIGNAL PLURALITY IS THE POINT
 * Spec section 11.1 lists fourteen signals and warns that "no single signal
 * should be treated as universally trustworthy". Real forms have `name="q_5"`,
 * `id="input-2941"`, placeholder text used as a label, labels that are `<div>`s,
 * and `autocomplete` attributes copied from an unrelated template. Collecting
 * every signal and letting the mapper weigh them is the only approach that
 * survives contact with real ATS markup.
 */
import type { ATSKind } from '@ats/types';

/** The kinds of control the fill engine can be asked to drive. */
export type ControlKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'date'
  | 'combobox' // ARIA combobox / custom dropdown - not a native <select>
  | 'unsupported';

/** One choice in a select, radio group, or listbox. */
export interface FieldOption {
  /** The submitted value, when it differs from the visible text. */
  value: string;
  /** What the user sees. This is what semantic matching compares against. */
  label: string;
  /** True when this option is currently selected/checked. */
  selected?: boolean;
}

export interface FieldDescriptor {
  /**
   * Identifies this control WITHIN the current page session only.
   *
   * Not persisted and not meaningful across page loads: many ATS platforms
   * generate DOM ids per render, so a stored DOM id would point at a different
   * field tomorrow. Cross-page identity is `semanticFingerprint`, below.
   */
  localId: string;

  // --- structural ----------------------------------------------------------
  tag: string;
  /** The `type` attribute for an `<input>`. */
  type?: string;
  /** ARIA role, explicit or implicit. */
  role?: string;
  kind: ControlKind;

  // --- naming signals, strongest first ------------------------------------
  /**
   * The browser's own `autocomplete` token ("given-name", "tel", "email").
   * The single most trustworthy signal available, because it is a *declaration
   * of meaning* by the page author rather than something we inferred - but only
   * when present and not set to a template default like "off".
   */
  autocomplete?: string;
  /** Text of the associated `<label>`, or the labelling element. */
  label?: string;
  /** Computed accessible name (aria-label / aria-labelledby / label). */
  accessibleName?: string;
  name?: string;
  id?: string;
  placeholder?: string;

  // --- context signals -----------------------------------------------------
  required: boolean;
  disabled: boolean;
  /** Choices, for select/radio/checkbox-group/combobox controls. */
  options?: FieldOption[];
  /**
   * Text near the control that is not its label - the wording of a question
   * whose actual `<label>` is missing or unhelpful. Bounded by the runtime
   * budget's `maxNearbyTextChars`, because unbounded text harvesting copies
   * unrelated page content into extension memory.
   */
  nearbyText?: string;
  /** Nearest enclosing section/fieldset heading ("Education", "Voluntary"). */
  sectionHeading?: string;
  /** Value already in the control. A pre-filled field is not ours to overwrite. */
  currentValue?: string;
  /** Character limit, when the control declares one. */
  maxLength?: number;

  // --- page identity -------------------------------------------------------
  pageUrl: string;
  hostname: string;
  ats: ATSKind;
  /**
   * True when the control lives in an iframe rather than the top document.
   * Recorded now (spec section 17) so cross-frame support is an added
   * coordinator, not a redesign.
   */
  inIframe?: boolean;

  /**
   * Stable identity for "this same question", across pages and across renders.
   *
   * The key to the entire learning system: correcting "Preferred hub" once on
   * one company's form must improve the mapping the next time that question
   * appears, even though the DOM around it is completely different. Computed by
   * `fingerprints/fingerprint.ts` from normalized SEMANTIC signals only - never
   * from generated ids or DOM position.
   */
  semanticFingerprint: string;
}

/** What the content script reports after one scan of a page. */
export interface ScanResult {
  page: { url: string; hostname: string; ats: ATSKind };
  fields: FieldDescriptor[];
  /**
   * True when the scan hit `maxFieldsPerScan` and stopped.
   *
   * Surfaced to the user rather than hidden: silently processing "most" of a
   * form would leave them believing it was fully handled. Freezing a low-end
   * machine to process all of it is not the alternative we want either.
   */
  truncated: boolean;
  /** Wall-clock duration, for the performance budget in the debug panel. */
  scanDurationMs: number;
}

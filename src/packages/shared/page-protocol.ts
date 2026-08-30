/**
 * Side panel <-> page scanner protocol.
 * ---------------------------------------------------------------------------
 * `shared/messages.ts` describes the messages that cross into the SERVICE
 * WORKER, and validates them with Zod because a content script is an untrusted
 * sender. This file describes a different hop:
 *
 *     side panel  --chrome.tabs.sendMessage-->  scanner (in the page)
 *
 * Both ends of that hop are our own code in contexts we control, so the
 * enforcement here is the type system rather than a runtime schema. What it
 * buys is the thing that was actually broken before it existed: the panel and
 * the scanner used to agree on these shapes only by duck-typed casts on both
 * sides, which is how the scanner came to answer `{ ok: true }` to a fill while
 * the panel rendered "Filled" without reading the reply at all.
 *
 * THE RULE THIS FILE ENCODES
 * A fill reports what HAPPENED, per field, including the failures. The UI is
 * not permitted to invent an outcome it was not told, so every response type
 * here carries enough information for the panel to be honest.
 */
import type { FillFailureReason } from '@fill-engine/types';
import type { ResolvedFieldAction } from './messages';

/**
 * A resume, encoded for transport into the page context.
 *
 * `chrome.tabs.sendMessage` serialises through JSON, not structured clone, so
 * an ArrayBuffer or a File arrives as `{}`. Base64 costs about a third in size
 * on a one-off, user-initiated action - a fair price for a transport that
 * works.
 */
export interface ResumePayload {
  name: string;
  type: string;
  base64: string;
}

// ---------------------------------------------------------------------------
// Requests (side panel -> scanner)
// ---------------------------------------------------------------------------

export interface ContentScanRequest {
  type: 'CONTENT_SCAN';
}

export interface ContentFillRequest {
  type: 'CONTENT_FILL';
  /**
   * Exactly the fields to act on.
   *
   * The panel sends `fill` and `attach_resume` actions. A `suggest` the user
   * has explicitly accepted is converted to `fill` AT THE POINT OF THE CLICK -
   * see the side panel - so the page context never decides for itself whether
   * a suggestion is safe.
   */
  actions: ResolvedFieldAction[];
  resume?: ResumePayload;
}

export interface ContentCorrectRequest {
  type: 'CONTENT_CORRECT';
  localId: string;
  profilePath: string | null;
  scope: 'global' | 'ats' | 'company' | 'exact_field';
}

export type ContentRequest = ContentScanRequest | ContentFillRequest | ContentCorrectRequest;

// ---------------------------------------------------------------------------
// Responses (scanner -> side panel)
// ---------------------------------------------------------------------------

/** A failure the panel must be able to explain to the user. */
export interface ContentErrorResponse {
  ok: false;
  /** The service worker's code where there is one, so the UI can branch. */
  code: string;
  message: string;
}

export interface ContentScanResponse {
  ok: true;
  actions: ResolvedFieldAction[];
  /**
   * How many controls the scan actually found.
   *
   * Reported separately from `actions.length` so the panel can tell "there is
   * no application form here" apart from "there is a form and we could say
   * nothing useful about it". Those need different words, and conflating them
   * is how a missing profile came to be reported as a missing form.
   */
  fieldsDetected: number;
}

/** What one field's fill attempt actually did. Mirrors FieldFillOutcome. */
export interface FieldFillReport {
  localId: string;
  attempted: boolean;
  /** True ONLY when a read-back confirmed the value landed. */
  verified: boolean;
  adapter?: string;
  failureReason?: FillFailureReason;
}

export interface ContentFillResponse {
  ok: true;
  outcomes: FieldFillReport[];
}

export interface ContentCorrectResponse {
  ok: boolean;
}

/**
 * Human-readable explanation of a fill failure.
 *
 * Lives here, next to the wire type, so the panel and any future surface show
 * the same words - and so adding a `FillFailureReason` without giving it a
 * sentence is a compile error rather than a UI that says "undefined".
 */
export const FILL_FAILURE_TEXT: Readonly<Record<FillFailureReason, string>> = {
  no_adapter: 'This control is a kind the extension cannot drive yet',
  element_gone: 'The field disappeared before it could be filled - rescan',
  rejected: 'The page refused the value',
  verification_failed: 'The value was entered but the page did not keep it',
  not_editable: 'The field is read-only or disabled',
  option_not_found: 'None of the options matched your answer',
};

/** Explanation for any reason code, including one we do not recognise. */
export function describeFillFailure(reason: string | undefined): string {
  if (reason === undefined) return 'It was not filled';
  return FILL_FAILURE_TEXT[reason as FillFailureReason] ?? 'It could not be filled';
}

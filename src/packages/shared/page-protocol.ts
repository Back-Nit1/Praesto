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
import type { ResolvedFieldAction, SemanticRunSummary } from './messages';

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
   * Origins of the cross-origin iframes on this page.
   *
   * `chrome.scripting.executeScript({ allFrames: true })` CHOOSES frames; it
   * does not grant access to them. `activeTab` covers the tab's own origin, so
   * an application embedded from another origin - which is how nearly every
   * employer runs Greenhouse, Lever or Workday on their own careers page - is
   * silently skipped: the injection succeeds, returns only the frames we were
   * allowed into, and the panel reports a page with no form on it.
   *
   * The top frame can still READ the `src` attribute of a cross-origin iframe
   * (the same-origin policy stops it reading the DOCUMENT, not the tag), so it
   * can name the origins involved. The panel turns that into a one-click
   * permission request for the site the form actually comes from.
   */
  embeddedOrigins?: string[];
  /**
   * How many controls the scan actually found.
   *
   * Reported separately from `actions.length` so the panel can tell "there is
   * no application form here" apart from "there is a form and we could say
   * nothing useful about it". Those need different words, and conflating them
   * is how a missing profile came to be reported as a missing form.
   */
  fieldsDetected: number;
  /**
   * What the semantic fallback cost on this scan, and whether it failed.
   *
   * ABSENT WHENEVER IT DID NOT RUN, which is every form the deterministic
   * pipeline understood - so its absence means "there was nothing here it could
   * have helped with", not "it failed quietly".
   *
   * Passed through to the panel for ONE reason: a user whose fields silently
   * stop improving cannot tell "we are out of AI answers until tomorrow" from
   * "this form just did not match", and only the first is something they can
   * act on. It carries no field ids, labels or values - see
   * `semanticRunSummarySchema`.
   */
  semantic?: SemanticRunSummary;
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

/**
 * What to say when the AI fallback could not run.
 *
 * Same rule as `FILL_FAILURE_TEXT`, for the same reason: two of this project's
 * worst bugs were honest code with dishonest messages, both because one
 * sentence was shown for several different causes. So each kind gets its own,
 * and a new kind without a sentence is a compile error.
 *
 * Every sentence ends by saying what STILL WORKS. The deterministic engine is
 * unaffected by any of these, and a user who reads "AI unavailable" and
 * concludes the extension is broken has been misinformed by omission.
 */
export const SEMANTIC_FAILURE_TEXT: Readonly<
  Record<NonNullable<SemanticRunSummary['error']>['kind'], string>
> = {
  rate_limited: "You have used today's AI answers. Recognised fields are still filled.",
  offline: 'You appear to be offline, so AI help was skipped. Recognised fields are still filled.',
  unavailable: 'AI help is unavailable right now. Recognised fields are still filled.',
};

/**
 * "in about 2 hours", from a millisecond count.
 *
 * Rounded, and deliberately vague past an hour: the exact reset instant is not
 * something a person acts on, and stating it precisely invites them to believe
 * a number our client-side counter cannot actually promise - the enforceable
 * limit is the backend's.
 */
export function describeQuotaReset(retryAfterMs: number | undefined): string | undefined {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return undefined;

  const minutes = Math.round(retryAfterMs / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'tomorrow';
}

/**
 * Message contracts between extension contexts.
 * ---------------------------------------------------------------------------
 * Spec section 23: "Use Zod/runtime validation at trust boundaries. Do not
 * trust arbitrary message payloads from content scripts."
 *
 * WHY A CONTENT SCRIPT IS AN UNTRUSTED SENDER
 * This is the least obvious and most important idea in this file. A content
 * script is OUR code - but it runs inside a webpage we do not control, on a
 * page that may be hostile, and `chrome.runtime.sendMessage` can be called from
 * any extension page or any other extension the user has installed. The service
 * worker holds the applicant's full profile. So the boundary between the page
 * context and the service worker is a real security boundary, and every payload
 * crossing it is validated as if it came from the open internet.
 *
 * TypeScript types alone would give us exactly nothing here: they vanish at
 * runtime. Zod schemas are the actual enforcement; the types are derived from
 * them so the two cannot drift apart.
 *
 * DATA MINIMISATION IS ENCODED IN THE SHAPES (spec 21.1)
 * There is deliberately NO message that returns the applicant profile to a
 * content script. The page context sends descriptors for the fields it found
 * and receives values for those specific fields only. If a page compromises the
 * content script, the most it can extract is the answers to the questions it
 * actually displayed - not the profile.
 */
import { z } from 'zod';

/**
 * Protocol version.
 *
 * Included in every message because an extension update can land while a
 * content script from the previous version is still running in an open tab.
 * Without this the old script silently sends a shape the new worker cannot
 * read, and the failure looks like "autofill randomly stopped working".
 */
export const MESSAGE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

export const atsKindSchema = z.enum([
  'greenhouse',
  'lever',
  'workday',
  'ashby',
  'smartrecruiters',
  'unknown',
]);

export const controlKindSchema = z.enum([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'file',
  'date',
  'combobox',
  'unsupported',
]);

export const fieldOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  selected: z.boolean().optional(),
});

/**
 * Descriptor schema, with LENGTH CAPS on every string.
 *
 * The caps are not tidiness. A malicious or merely broken page can render a
 * label containing a megabyte of text; without caps that lands in the service
 * worker, is held in memory, and may be written to the audit log. Bounding at
 * the boundary is the cheapest possible defence, and the limits are far above
 * anything a real form label needs.
 */
export const fieldDescriptorSchema = z.object({
  localId: z.string().max(128),
  tag: z.string().max(32),
  type: z.string().max(32).optional(),
  role: z.string().max(64).optional(),
  kind: controlKindSchema,

  autocomplete: z.string().max(128).optional(),
  label: z.string().max(512).optional(),
  accessibleName: z.string().max(512).optional(),
  name: z.string().max(256).optional(),
  id: z.string().max(256).optional(),
  placeholder: z.string().max(256).optional(),

  required: z.boolean(),
  disabled: z.boolean(),
  // A country dropdown is ~250 entries; 500 is generous and still bounded.
  options: z.array(fieldOptionSchema).max(500).optional(),
  nearbyText: z.string().max(1024).optional(),
  sectionHeading: z.string().max(256).optional(),
  currentValue: z.string().max(1024).optional(),
  maxLength: z.number().int().positive().optional(),

  pageUrl: z.string().max(2048),
  hostname: z.string().max(256),
  ats: atsKindSchema,
  inIframe: z.boolean().optional(),
  semanticFingerprint: z.string().max(64),
});

/**
 * The four scoped fingerprints for one field.
 *
 * Sent with fill results and corrections rather than recomputed in the service
 * worker. The worker is stateless between messages (MV3 evicts it), so it would
 * otherwise need the full descriptor back just to re-derive four short hashes -
 * and any drift between the fingerprints used to MAP a field and those used to
 * record feedback about it would silently attach the feedback to the wrong rule.
 */
export const fingerprintQuerySchema = z.object({
  global: z.string().max(64),
  ats: z.string().max(64),
  company: z.string().max(64),
  exact: z.string().max(64),
});

export const pageContextSchema = z.object({
  url: z.string().max(2048),
  hostname: z.string().max(256),
  ats: atsKindSchema,
});

// ---------------------------------------------------------------------------
// Requests (content script / UI -> service worker)
// ---------------------------------------------------------------------------

/**
 * Liveness check. The Phase 0 definition of done ("content script can send a
 * typed ping to the service worker") and a genuinely useful diagnostic: it
 * distinguishes "the extension is broken" from "the service worker was asleep".
 */
export const pingRequestSchema = z.object({
  type: z.literal('PING'),
  version: z.number().int(),
  sentAt: z.number(),
});

/**
 * The core request: "here are the fields I found, tell me what to do."
 *
 * Note the direction of information. The page sends what IT knows (its own
 * labels and options). The worker replies with only the values those fields
 * need. The profile never crosses this boundary.
 */
export const resolveApplicationFieldsRequestSchema = z.object({
  type: z.literal('RESOLVE_APPLICATION_FIELDS'),
  version: z.number().int(),
  page: pageContextSchema,
  // Bounded by the runtime budget's maxFieldsPerScan on the sending side; the
  // cap here is the receiving side refusing to trust that it was respected.
  fields: z.array(fieldDescriptorSchema).max(500),
});

/**
 * Report of what actually happened after a fill attempt.
 *
 * Separate from the resolve request because a fill can fail in ways only the
 * page can observe - a React component rejecting a synthetic event, an option
 * list that re-rendered. Feeding that back is what makes the audit record
 * honest about whether the fill VERIFIED, not merely whether it was attempted.
 */
export const reportFillResultsRequestSchema = z.object({
  type: z.literal('REPORT_FILL_RESULTS'),
  version: z.number().int(),
  page: pageContextSchema,
  results: z
    .array(
      z.object({
        localId: z.string().max(128),
        fingerprints: fingerprintQuerySchema,
        profilePath: z.string().max(128).nullable(),
        attempted: z.boolean(),
        verified: z.boolean(),
        /**
         * The user pressed accept on a suggestion, rather than this being a
         * fill we decided on ourselves.
         *
         * The ONLY positive evidence in the system. Everything else the audit
         * trail records is either a failure or a silence, and silence is not
         * evidence of correctness - see audit/metrics.ts.
         *
         * Optional so a content script still running in a tab from before this
         * shipped keeps working. Absent means "we do not know", which is
         * `unreviewed`. It must never be read as "accepted".
         */
        userInitiated: z.boolean().optional(),
        adapter: z.string().max(64).optional(),
        // A CODE, never the value that failed to fill - that value is applicant
        // PII and has no business in a log.
        failureReason: z.string().max(128).optional(),
      }),
    )
    .max(500),
});

/** Side panel asking the worker what it knows about the active tab. */
export const getPageStateRequestSchema = z.object({
  type: z.literal('GET_PAGE_STATE'),
  version: z.number().int(),
});

/**
 * The page revealed or removed form controls after the last scan.
 *
 * Broadcast by the scanner's MutationObserver. It is addressed to the SIDE
 * PANEL, but a content script cannot message an extension page directly - a
 * `chrome.runtime.sendMessage` reaches every extension context that is
 * listening, which includes the panel and the worker.
 *
 * It exists in this schema so the worker recognises it and answers OK instead
 * of rejecting it as a malformed message on every re-render of a dynamic form.
 * The worker does nothing else with it: acting on a page change without the
 * user asking would be an auto-fill path, and there is deliberately none.
 */
export const pageFieldsChangedRequestSchema = z.object({
  type: z.literal('PAGE_FIELDS_CHANGED'),
  version: z.number().int(),
  page: pageContextSchema,
});

/**
 * The user teaching the system what a field means (spec section 19).
 *
 * Carries the whole descriptor rather than a fingerprint. Fingerprinting stays
 * the service worker's job so there is exactly ONE implementation of it: if the
 * side panel computed fingerprints itself, a future change to the fingerprint
 * inputs would have to be made in two places, and the failure mode of getting
 * that wrong is corrections that quietly never match anything again.
 */
export const recordCorrectionRequestSchema = z.object({
  type: z.literal('RECORD_CORRECTION'),
  version: z.number().int(),
  field: fieldDescriptorSchema,
  /** null means "this field maps to nothing" - itself a useful correction. */
  profilePath: z.string().max(128).nullable(),
  scope: z.enum(['global', 'ats', 'company', 'exact_field']),
});

/**
 * Every request, as a discriminated union.
 *
 * Zod discriminates on `type`, so an unknown message type is rejected by the
 * schema rather than falling through to a default branch that has to guess.
 */
export const extensionRequestSchema = z.discriminatedUnion('type', [
  pingRequestSchema,
  resolveApplicationFieldsRequestSchema,
  reportFillResultsRequestSchema,
  getPageStateRequestSchema,
  recordCorrectionRequestSchema,
  pageFieldsChangedRequestSchema,
]);

export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;
export type PingRequest = z.infer<typeof pingRequestSchema>;
export type ResolveApplicationFieldsRequest = z.infer<typeof resolveApplicationFieldsRequestSchema>;
export type ReportFillResultsRequest = z.infer<typeof reportFillResultsRequestSchema>;
export type RecordCorrectionRequest = z.infer<typeof recordCorrectionRequestSchema>;
export type PageFieldsChangedRequest = z.infer<typeof pageFieldsChangedRequestSchema>;

// ---------------------------------------------------------------------------
// Responses (service worker -> caller)
// ---------------------------------------------------------------------------

/**
 * What to do with one field.
 *
 * `action` mirrors the confidence policy's decision, so the page context does
 * not re-derive it - and therefore CANNOT get it wrong. The policy lives in one
 * place and its output travels as data.
 */
export const resolvedFieldActionSchema = z.object({
  localId: z.string(),
  /**
   * `attach_resume` is its own action rather than a `fill` with a special
   * value. A resume is a document, not a profile value: it has no canonical
   * path, it is executed by a different adapter, and the side panel counts it
   * separately ("1 resume attached"). Overloading `fill` would have hidden all
   * three of those differences behind a sentinel string.
   */
  action: z.enum(['fill', 'suggest', 'skip', 'attach_resume']),
  /** Present for fill and suggest. Absent for skip - there is nothing to send. */
  value: z.union([z.string(), z.boolean()]).optional(),
  /** For option controls, the option value the adapter should select. */
  optionValue: z.string().optional(),
  /**
   * The control kind from the descriptor.
   *
   * Sent back so the fill engine can pick an adapter by what the control IS,
   * not only by what its DOM element looks like. A Workday dropdown is a
   * `<div role="combobox">`, and a `<div>` alone tells an adapter nothing.
   *
   * Optional so an older content script - one still running in an open tab
   * after an update - keeps working: adapters fall back to element inspection.
   */
  controlKind: controlKindSchema.optional(),
  profilePath: z.string().nullable(),
  /**
   * The FORM said this field is required (`required`, or `aria-required`).
   *
   * Sent back so the panel can name the fields that will stop a submit. It is
   * the employer's own markup, not anything about the applicant, which is why
   * it may cross this boundary at all.
   *
   * Optional so an older side panel keeps working; absent means "we were not
   * told", never "optional".
   */
  required: z.boolean().optional(),
  /**
   * The control already held a value when we scanned.
   *
   * A BOOLEAN, never the value. The panel needs it to tell "required and still
   * empty" - the row that matters before a submit - apart from "required, and
   * the page had already answered it", which is not the user's problem. Sending
   * the value itself would put page content the applicant may have typed into a
   * message that does not need it.
   */
  prefilled: z.boolean().optional(),
  /**
   * This action exists because a person read a suggestion and accepted it.
   *
   * Set by the side panel at the point of the click, never by the worker - the
   * worker cannot know what a human did. Carried through the page so the fill
   * report can say which fills were authorised one by one, which is the only
   * positive signal the audit trail gets.
   */
  userInitiated: z.boolean().optional(),
  mappingConfidence: z.number().min(0).max(1),
  knowledgeState: z.enum(['known', 'derived', 'previously_seen', 'probable', 'unknown']),
  /** Short human-readable explanation for the side panel's audit list. */
  explanation: z.string().max(256).optional(),
});

export type ResolvedFieldAction = z.infer<typeof resolvedFieldActionSchema>;

export const pongResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal('PONG'),
  version: z.number().int(),
  /** Round-trip diagnostics: proves the worker woke and storage was reachable. */
  workerStartedAt: z.number(),
  storageReady: z.boolean(),
});

/**
 * What the semantic fallback cost and whether it failed.
 *
 * ABSENT ON MOST SCANS, and its absence is meaningful: a form the deterministic
 * pipeline understood produces no refusals, so the subsystem does not run and
 * there is nothing to report.
 *
 * NOTE WHAT IS NOT IN HERE: no field ids, no labels, no values. It answers "did
 * this cost anything, did it fail, and how much is left" - never what the
 * applicant was asked or what they would have said. The panel needs the
 * difference between "nothing matched" and "you are out of AI answers until
 * tomorrow", because only the second is something a user can act on; it does
 * not need anything else.
 */
export const semanticRunSummarySchema = z.object({
  modelCalls: z.number().int().nonnegative(),
  error: z
    .object({
      /**
       * A CLOSED vocabulary, not the underlying `AppErrorCode`.
       *
       * The panel needs exactly three distinct sentences, and the raw code
       * never crosses this boundary - so there is no path by which
       * "BACKEND_REJECTED" reaches a user, and adding a kind without giving it
       * a sentence is a compile error (see `SEMANTIC_FAILURE_TEXT`).
       */
      kind: z.enum(['rate_limited', 'offline', 'unavailable']),
      /** Present on `rate_limited`. The actionable part of that failure. */
      retryAfterMs: z.number().nonnegative().optional(),
    })
    .optional(),
  quota: z
    .object({
      used: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      resetsInMs: z.number().nonnegative(),
    })
    .optional(),
});

export type SemanticRunSummary = z.infer<typeof semanticRunSummarySchema>;

export const resolveApplicationFieldsResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal('RESOLVE_APPLICATION_FIELDS_RESULT'),
  actions: z.array(resolvedFieldActionSchema),
  /** Counts for the side panel header, so it does not recount the actions. */
  summary: z.object({
    detected: z.number().int(),
    readyToFill: z.number().int(),
    needsReview: z.number().int(),
    unknown: z.number().int(),
  }),
  /** Absent when the semantic fallback did not run. See the schema above. */
  semantic: semanticRunSummarySchema.optional(),
});

export const genericOkResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal('OK'),
});

/**
 * Failure response.
 *
 * Carries a code, not a stack trace. A stack could name internal paths, and the
 * message may be shown to the user - so it is a short sentence written to be
 * read by a person, with details left in the developer log.
 */
export const errorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
});

export const extensionResponseSchema = z.union([
  pongResponseSchema,
  resolveApplicationFieldsResponseSchema,
  genericOkResponseSchema,
  errorResponseSchema,
]);

export type ExtensionResponse = z.infer<typeof extensionResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate an inbound message.
 *
 * Returns a discriminated result rather than throwing: an invalid message is an
 * expected condition (a stale content script, another extension, a page probing
 * us), not an exceptional one, and it must never take down the service worker's
 * message listener.
 */
export function parseRequest(
  raw: unknown,
): { ok: true; request: ExtensionRequest } | { ok: false; issue: string } {
  const parsed = extensionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issue: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
  }

  // Version skew is a separate failure from a malformed shape, and needs a
  // different message: "reload the page", not "this is a bug".
  if (parsed.data.version !== MESSAGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      issue: `protocol version ${parsed.data.version} != ${MESSAGE_PROTOCOL_VERSION}`,
    };
  }

  return { ok: true, request: parsed.data };
}

/** Build an error response from an AppError-shaped value. */
export function errorResponse(code: string, message: string): ErrorResponse {
  return { ok: false, code, message };
}

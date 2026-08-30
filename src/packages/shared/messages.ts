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
        semanticFingerprint: z.string().max(64),
        profilePath: z.string().max(128).nullable(),
        attempted: z.boolean(),
        verified: z.boolean(),
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

/** The user teaching the system what a field means (spec section 19). */
export const recordCorrectionRequestSchema = z.object({
  type: z.literal('RECORD_CORRECTION'),
  version: z.number().int(),
  semanticFingerprint: z.string().max(64),
  normalizedLabel: z.string().max(512).optional(),
  hostname: z.string().max(256),
  ats: atsKindSchema,
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
]);

export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;
export type PingRequest = z.infer<typeof pingRequestSchema>;
export type ResolveApplicationFieldsRequest = z.infer<typeof resolveApplicationFieldsRequestSchema>;
export type ReportFillResultsRequest = z.infer<typeof reportFillResultsRequestSchema>;
export type RecordCorrectionRequest = z.infer<typeof recordCorrectionRequestSchema>;

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
  action: z.enum(['fill', 'suggest', 'skip']),
  /** Present for fill and suggest. Absent for skip - there is nothing to send. */
  value: z.union([z.string(), z.boolean()]).optional(),
  /** For option controls, the option value the adapter should select. */
  optionValue: z.string().optional(),
  profilePath: z.string().nullable(),
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

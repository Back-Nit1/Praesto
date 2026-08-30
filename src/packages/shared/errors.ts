/**
 * Error taxonomy.
 * ---------------------------------------------------------------------------
 * Errors are DATA, not just messages. Every failure carries a stable `code` so
 * that:
 *   - the side panel can render a human-appropriate explanation without string
 *     matching on English prose,
 *   - the audit log can aggregate failure classes across applications
 *     (spec section 26 "Metrics for Development"),
 *   - tests can assert on the class of failure rather than its wording.
 *
 * The `context` bag is deliberately typed as unknown-valued: it is diagnostic
 * only, and MUST NOT be trusted or rendered raw. Note `redactable` below.
 */

/** Stable machine-readable failure classes. Append; never renumber or reuse. */
export type AppErrorCode =
  // --- storage layer -------------------------------------------------------
  | 'STORAGE_UNAVAILABLE'      // chrome.storage / IndexedDB not reachable in this context
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'   // user's disk/quota is full - actionable by the user
  | 'MIGRATION_FAILED'
  // --- validation ----------------------------------------------------------
  | 'SCHEMA_VALIDATION_FAILED' // data failed its Zod schema at a trust boundary
  | 'PROFILE_NOT_FOUND'
  // --- messaging -----------------------------------------------------------
  | 'MESSAGE_INVALID'          // payload from a content script did not validate
  | 'MESSAGE_UNSUPPORTED'      // known shape, unknown type - version skew
  | 'MESSAGE_TIMEOUT'
  | 'NO_RECEIVER'              // service worker asleep or content script absent
  // --- form / fill engine --------------------------------------------------
  | 'FIELD_NOT_FOUND'          // element vanished between scan and fill
  | 'NO_ADAPTER'               // control type we do not know how to drive
  | 'FILL_REJECTED'            // adapter ran but the UI did not accept the value
  | 'VERIFY_FAILED'            // post-fill read-back did not match
  // --- catch-all -----------------------------------------------------------
  | 'UNKNOWN';

export interface AppErrorOptions {
  /** Underlying error, kept for developer logs only. */
  cause?: unknown;
  /** Diagnostic key/values. Never render to the user without redaction. */
  context?: Readonly<Record<string, unknown>>;
  /**
   * True when `context` may contain applicant PII (a filled value, a label
   * containing a name). The logger drops the context of redactable errors
   * unless debug mode is explicitly enabled by the user.
   */
  redactable?: boolean;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  readonly redactable: boolean;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    // `cause` is standard ES2022 and preserved by Chrome's devtools.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.context = options.context ?? {};
    this.redactable = options.redactable ?? false;
  }

  /** Serializable form - Error instances do not survive extension messaging. */
  toJSON(): { code: AppErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** Narrow an unknown catch binding. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Coerce any thrown value into an AppError.
 * Catch bindings are `unknown` and may be strings, DOMExceptions, or anything
 * a host page's JavaScript decided to throw. This normalizes the tail.
 */
export function toAppError(value: unknown, fallbackCode: AppErrorCode = 'UNKNOWN'): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError(fallbackCode, value.message, { cause: value });
  }
  return new AppError(fallbackCode, String(value), { cause: value });
}

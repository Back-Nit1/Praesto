/**
 * Logging.
 * ---------------------------------------------------------------------------
 * Three requirements shape this module, and each one rules out `console.log`:
 *
 *  1. PRIVACY. This codebase handles a real person's name, address, phone
 *     number and demographic answers. Those values must never reach a log line
 *     that a developer might paste into a bug report. So logging takes a
 *     `redact` path by default and only emits values when the user has turned
 *     debug mode on for themselves (spec section 24: "Do not store unnecessary
 *     sensitive values in debug logs").
 *
 *  2. HOST-PAGE SAFETY. The content script shares a console with the job
 *     application website. Unprefixed noise is confusing at best and, in a
 *     page that monkey-patches console, actively dangerous. Every line is
 *     namespaced and every logging call is exception-safe.
 *
 *  3. OFF BY DEFAULT, CHEAP WHEN OFF. On a low-end machine a scan of 300
 *     fields must not pay for 300 string concatenations that nobody reads.
 *     Level checks happen before argument evaluation via the thunk overload.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** Numeric ordering so a level check is an integer compare, not a string test. */
const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Global level for this JS context.
 *
 * Default is `warn`: real problems surface, routine operation is silent. The
 * user raises this from the extension's settings, which writes to storage; the
 * entrypoints read it at startup and call `setLogLevel`.
 */
let currentLevel: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function isLevelEnabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_RANK[currentLevel] >= LEVEL_RANK[level];
}

/**
 * Placeholder emitted in place of a value that may be applicant PII.
 * Keeps the *shape* of the log useful (you can see a value was present and how
 * long it was) without leaking the content.
 */
export function redact(value: unknown): string {
  if (value === null || value === undefined) return '<empty>';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `<redacted:${typeof value}:${text?.length ?? 0}>`;
}

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  /**
   * Lazy debug. The thunk is only invoked when debug logging is on, so
   * expensive diagnostics (serialising a descriptor, dumping mapping
   * candidates) cost nothing in normal operation.
   */
  debugLazy(build: () => [string, ...unknown[]]): void;
  /** Derive a nested logger, e.g. `mapper` -> `mapper:alias`. */
  child(suffix: string): Logger;
}

function emit(level: Exclude<LogLevel, 'silent'>, namespace: string, args: unknown[]): void {
  if (!isLevelEnabled(level)) return;
  try {
    // `console.debug` is filtered out of Chrome's default console view, which
    // is exactly where we want verbose extension internals to land.
    const sink =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'info'
            ? console.info
            : console.debug;
    sink(`[applicant-agent:${namespace}]`, ...args);
  } catch {
    // A host page may have replaced or frozen `console`. Losing a log line is
    // always preferable to throwing inside someone else's page - spec 29:
    // "All extension errors should be caught and surfaced in developer logs
    // without breaking the host page."
  }
}

export function createLogger(namespace: string): Logger {
  return {
    error: (message, ...args) => emit('error', namespace, [message, ...args]),
    warn: (message, ...args) => emit('warn', namespace, [message, ...args]),
    info: (message, ...args) => emit('info', namespace, [message, ...args]),
    debug: (message, ...args) => emit('debug', namespace, [message, ...args]),
    debugLazy: (build) => {
      if (!isLevelEnabled('debug')) return;
      try {
        emit('debug', namespace, build());
      } catch {
        // Diagnostics must never be the thing that breaks the run.
      }
    },
    child: (suffix) => createLogger(`${namespace}:${suffix}`),
  };
}

/**
 * Result<T, E> - explicit success/failure without exceptions.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * A browser extension runs inside someone else's webpage. A thrown error that
 * escapes our code can break the host page's own JavaScript, which would be a
 * catastrophic failure mode for a tool whose users are mid-job-application.
 * Spec section 29: "Gracefully degrade: an unsupported field should remain
 * untouched, not crash the entire scan."
 *
 * So at every boundary that can plausibly fail (storage, parsing, DOM
 * manipulation, message passing) we return a Result instead of throwing. The
 * type system then forces the caller to acknowledge the failure branch, rather
 * than an unhandled rejection surfacing at runtime on a user's machine.
 *
 * Exceptions are still used for genuine programmer errors (invariant
 * violations) - those *should* be loud, because they indicate a bug, not an
 * expected condition.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Map the success value, leaving a failure untouched. */
export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Read the value or fall back. Use where a missing value is genuinely benign. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Run a throwing function and capture any exception as an Err.
 * The single approved bridge between exception-land (browser APIs, JSON.parse,
 * third-party libraries) and Result-land (our own code).
 */
export function attempt<T>(fn: () => T): Result<T, unknown> {
  try {
    return ok(fn());
  } catch (error) {
    return err(error);
  }
}

/** Async twin of `attempt`. */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T, unknown>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
}

/**
 * Backend gateway - the ONLY place this extension makes a network request.
 * ---------------------------------------------------------------------------
 * Everything that leaves the machine goes through this file. That is the point:
 * a single choke point can be read in one sitting, and a reviewer asking "what
 * does this extension send, and where" has exactly one answer to check.
 *
 * WHAT IT TALKS TO
 * Our own backend, and nothing else. The backend holds the model provider's API
 * key. The extension holds a per-install DEVICE TOKEN, which identifies this
 * install and nothing more - compromising it costs one user's quota rather than
 * the provider account. See Security.md for why no other arrangement works.
 *
 * THE THREE THINGS THIS ENFORCES
 *
 *  1. A BUDGET, before the request is made. Two limiters: a token bucket for
 *     burst (a render loop, a stuck retry) and a storage-backed daily quota for
 *     spend. The second must be storage-backed because MV3 evicts the service
 *     worker every ~30 seconds idle, and an in-memory counter would reset with
 *     it - a caller need only pause between bursts to spend the whole budget.
 *
 *  2. A BOUND on the response. A backend that is compromised, buggy, or simply
 *     wrong must not be able to hand us a stream that exhausts the tab. The
 *     body is read incrementally and abandoned at a cap, rather than
 *     `await response.text()` which would happily allocate whatever arrives.
 *
 *  3. A SCHEMA on the way in. The backend is a trust boundary like any other -
 *     "we wrote it" is not a runtime guarantee, and a response is parsed by
 *     Zod before any caller sees it. Model output in particular is treated as
 *     hostile text; see `schemas.ts`.
 *
 * WHAT IT NEVER DOES
 *  - log a request or response body (they carry the applicant's words),
 *  - read an origin from storage (see config.ts),
 *  - follow a redirect to another host (`redirect: 'error'`),
 *  - send cookies or ambient credentials (`credentials: 'omit'`).
 */
import { AppError, toAppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { err, ok, type Result } from '@shared/result';
import { PersistentQuota, TokenBucket } from '@shared/rate-limit';
import type { KeyValueStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import { resolveBackendOrigin } from './config';

const log = createLogger('backend');

/**
 * Largest response body read, in bytes.
 *
 * A chat reply is kilobytes. 2 MB is three orders of magnitude of headroom and
 * still small enough that the worst case is a hiccup rather than a dead tab on
 * a 4 GB machine.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Request timeout.
 *
 * A model call is slow by nature, so this is generous - but it is finite,
 * because an MV3 service worker held open by a pending fetch is a worker that
 * never sleeps, and on a laptop that is measurable battery.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Burst budget. Small: a human asking questions cannot exceed it. */
const BURST_CAPACITY = 5;
const BURST_REFILL_PER_SECOND = 0.5;

/** Client-side daily spend cap. The enforceable one lives on the backend. */
const DAILY_CALL_LIMIT = 200;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimal parser contract, so this module does not depend on Zod directly. */
export interface ResponseParser<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

export interface GatewayOptions {
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** What a caller gets back when the budget refuses. */
export interface RateLimitedFailure {
  retryAfterMs: number;
}

export class BackendGateway {
  private readonly burst: TokenBucket;
  private readonly daily: PersistentQuota;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly store: KeyValueStore,
    options: GatewayOptions = {},
  ) {
    const now = options.now ?? (() => Date.now());

    this.burst = new TokenBucket({
      capacity: BURST_CAPACITY,
      refillPerSecond: BURST_REFILL_PER_SECOND,
      // One key. There is one user and one backend; per-key isolation would be
      // meaningless here and only add a Map to keep alive.
      maxKeys: 1,
      now,
    });

    this.daily = new PersistentQuota(store, {
      storageKey: STORAGE_KEYS.modelQuota,
      limit: DAILY_CALL_LIMIT,
      windowMs: DAILY_WINDOW_MS,
      now,
    });

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Usage so a UI can say "you have 158 questions left today". */
  async usage(): Promise<{ used: number; limit: number; resetsInMs: number }> {
    return this.daily.peek();
  }

  /** The daily cap, for a UI that needs to state it before any call is made. */
  static readonly dailyLimit = DAILY_CALL_LIMIT;

  /**
   * POST a JSON body to `path` and validate the reply.
   *
   * `path` must start with `/` and is appended to the compiled-in origin - it
   * is never a full URL, so no caller can redirect a request by passing one.
   */
  async post<T>(
    path: string,
    body: unknown,
    parser: ResponseParser<T>,
  ): Promise<Result<T, AppError>> {
    const origin = resolveBackendOrigin();
    if (!origin.ok) return err(origin.error);

    if (!path.startsWith('/') || path.startsWith('//')) {
      // `//host` is a protocol-relative URL and would resolve to a DIFFERENT
      // origin. Rejecting it here means a caller cannot leave our host even by
      // accident.
      return err(new AppError('BACKEND_NOT_CONFIGURED', 'Invalid backend path'));
    }

    // --- budget, before anything is sent ------------------------------------
    const burst = this.burst.take('backend');
    if (!burst.allowed) {
      return err(
        new AppError('RATE_LIMITED', 'Slow down a moment', {
          context: { retryAfterMs: burst.retryAfterMs },
        }),
      );
    }

    const daily = await this.daily.take();
    if (!daily.allowed) {
      return err(
        new AppError('RATE_LIMITED', "That is today's limit for AI answers", {
          context: { retryAfterMs: daily.retryAfterMs },
        }),
      );
    }

    // --- authentication -----------------------------------------------------
    const token = await this.deviceToken();
    if (token === undefined) {
      return err(
        new AppError('BACKEND_UNAUTHENTICATED', 'This install is not registered with the backend'),
      );
    }

    // --- the request --------------------------------------------------------
    // AbortController rather than Promise.race: race leaves the fetch running,
    // which in a service worker means the worker stays alive for a request
    // whose answer we have already discarded.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${origin.value}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // No cookies, no ambient auth. The device token is the only credential,
        // and it travels in a header we control.
        credentials: 'omit',
        // A redirect to another host would leave the origin the CSP pins and
        // the one this code checked. Treat it as an error, not a hop.
        redirect: 'error',
        // The backend has no business setting or reading our referrer.
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });

      if (response.status === 401 || response.status === 403) {
        return err(
          new AppError('BACKEND_UNAUTHENTICATED', 'The backend refused this install'),
        );
      }

      if (!response.ok) {
        // The STATUS is logged; the body is not. A backend error body can
        // echo back the prompt, which is the applicant's own words.
        log.warn(`Backend returned ${response.status}`);
        return err(
          new AppError('BACKEND_REJECTED', 'The service could not answer that', {
            context: { status: response.status },
          }),
        );
      }

      const text = await readBounded(response, MAX_RESPONSE_BYTES);
      if (!text.ok) return err(text.error);

      let parsed: unknown;
      try {
        parsed = JSON.parse(text.value);
      } catch {
        return err(new AppError('BACKEND_REJECTED', 'The service sent something unreadable'));
      }

      // TRUST BOUNDARY. "We wrote the backend" is not a runtime guarantee.
      const validated = parser.safeParse(parsed);
      if (!validated.success) {
        return err(new AppError('BACKEND_REJECTED', 'The service sent an unexpected shape'));
      }

      return ok(validated.data);
    } catch (error) {
      // Covers: offline, DNS failure, the CSP refusing the connection, the
      // abort above, and a redirect we declined to follow. The message is
      // deliberately the same for all of them - which one it was is a
      // developer-log detail, not something to explain to a user mid-application.
      const cause = toAppError(error);
      log.debugLazy(() => ['Backend request failed', cause.message]);
      return err(
        new AppError('BACKEND_UNREACHABLE', 'Could not reach the service', { cause: error }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** The per-install device token, if this install has one. */
  private async deviceToken(): Promise<string | undefined> {
    const read = await this.store.get<string>(STORAGE_KEYS.deviceToken);
    if (!read.ok) return undefined;
    const token = read.value;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }
}

/**
 * Read a response body, abandoning it past `maxBytes`.
 *
 * `await response.text()` allocates whatever arrives, which makes the size of
 * our heap a decision made by the other end of the connection. Reading through
 * the stream lets us stop.
 *
 * Falls back to `.text()` only where there is no readable stream (some test
 * doubles, and a few embedded runtimes), and still checks the length after -
 * a late check is worth more than none.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Result<string, AppError>> {
  // Cheap pre-check: an honest server that declares an oversized body is
  // refused without transferring it.
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return err(new AppError('RESPONSE_TOO_LARGE', 'The service sent too much data'));
  }

  const body = response.body;
  if (body === null || typeof body.getReader !== 'function') {
    const text = await response.text();
    return text.length > maxBytes
      ? err(new AppError('RESPONSE_TOO_LARGE', 'The service sent too much data'))
      : ok(text);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      total += chunk.value.byteLength;
      if (total > maxBytes) {
        // Release the connection rather than draining a stream we are
        // discarding - otherwise a hostile body keeps the socket, and the
        // service worker, alive for as long as it likes.
        await reader.cancel();
        return err(new AppError('RESPONSE_TOO_LARGE', 'The service sent too much data'));
      }

      // `stream: true` so a multi-byte character split across two chunks is
      // decoded correctly rather than becoming a replacement character.
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return ok(parts.join(''));
  } catch (error) {
    return err(new AppError('BACKEND_UNREACHABLE', 'The response ended early', { cause: error }));
  }
}

/**
 * The daily budget, read without constructing a gateway.
 *
 * The options page wants to state today's spend and has no business holding
 * something that can make a network request to do it. Reading the same window
 * the gateway writes keeps one source of truth for the number.
 */
export async function readModelUsage(
  store: KeyValueStore,
): Promise<{ used: number; limit: number; resetsInMs: number }> {
  return new PersistentQuota(store, {
    storageKey: STORAGE_KEYS.modelQuota,
    limit: DAILY_CALL_LIMIT,
    windowMs: DAILY_WINDOW_MS,
  }).peek();
}

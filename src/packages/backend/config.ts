/**
 * Backend gateway configuration.
 * ---------------------------------------------------------------------------
 * WHERE THE ONE PIECE OF NETWORK CONFIGURATION LIVES, AND WHY IT IS THE ONLY
 * ONE.
 *
 * This extension may talk to exactly one host: our own backend. That backend
 * holds the model provider's API key; the extension never sees it. The reason
 * is not policy, it is arithmetic - a published extension bundle is downloaded
 * by every user and by anyone who wants it, and Vite inlines
 * `import.meta.env.*` values into that bundle as string literals. There is no
 * such thing as a secret in a client. See Security.md.
 *
 * SO WHAT MAY GO IN A BUILD VARIABLE
 * Only things that are safe to publish. A backend ORIGIN is safe to publish -
 * it is a hostname anyone can see in devtools the first time a request goes
 * out. An API key is not. `WXT_BACKEND_ORIGIN` is therefore the only build
 * variable this codebase reads, and `assertNoSecretShaped` below makes a
 * mistake here loud rather than silent.
 *
 * WHY IT IS NOT RUNTIME-CONFIGURABLE
 * A tempting design is "let the user set the backend URL in settings". That
 * would mean anything able to write one storage key could redirect every
 * request - including the applicant's resume - to a host of its choosing.
 * Compiling the origin in means the destination is fixed at build time and
 * pinned a second time by the manifest's `connect-src`, which the browser
 * enforces regardless of what our code asks for. Two independent controls, one
 * of which is not ours to get wrong.
 */
import { AppError } from '@shared/errors';
import { err, ok, type Result } from '@shared/result';

/**
 * Build-time environment, typed.
 *
 * Declared structurally rather than imported: this module is the only place
 * that reads the build environment, so the shape belongs here, and tests can
 * exercise `resolveBackendOrigin` directly without a build.
 */
interface BuildEnv {
  WXT_BACKEND_ORIGIN?: string;
}

/** Read the compiled-in environment, tolerating its absence (Node, tests). */
function buildEnv(): BuildEnv {
  try {
    return (import.meta as unknown as { env?: BuildEnv }).env ?? {};
  } catch {
    return {};
  }
}

/**
 * Patterns that must never appear in a build variable.
 *
 * The build already fails if a credential reaches `dist/`
 * (scripts/check-bundle-secrets.mjs). This is the same check one layer earlier,
 * at the point where somebody would first be tempted - "just put the key in
 * WXT_BACKEND_ORIGIN for now" - so the mistake is caught while it is still a
 * typo rather than after it has been published.
 */
const SECRET_SHAPED = /sk-|api[_-]?key|secret|password|token=|Bearer\s/i;

/**
 * Validate a backend origin.
 *
 * Rules, each one a thing that has gone wrong in a real extension:
 *   - HTTPS only. An http:// backend means the applicant's resume crosses the
 *     network in clear text on whatever café wifi they are applying from.
 *     localhost is exempt because that is how the backend gets developed.
 *   - Origin only - no path, no query, no fragment. The gateway builds paths
 *     itself; accepting one here means a misconfigured value silently changes
 *     every endpoint.
 *   - No embedded credentials (`https://user:pass@host`). That is a secret in
 *     the bundle wearing a different hat.
 *
 * Exported and pure so it is unit-testable without a build.
 */
export function validateBackendOrigin(raw: string): Result<string, AppError> {
  const value = raw.trim();

  if (value.length === 0) {
    return err(new AppError('BACKEND_NOT_CONFIGURED', 'No backend origin was configured'));
  }

  if (SECRET_SHAPED.test(value)) {
    return err(
      new AppError(
        'BACKEND_NOT_CONFIGURED',
        'The backend origin looks like it contains a credential. Credentials never ship in the bundle - see Security.md',
      ),
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(new AppError('BACKEND_NOT_CONFIGURED', 'The backend origin is not a valid URL'));
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    return err(
      new AppError('BACKEND_NOT_CONFIGURED', 'The backend origin must use https (localhost aside)'),
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return err(
      new AppError('BACKEND_NOT_CONFIGURED', 'The backend origin must not embed credentials'),
    );
  }

  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    return err(
      new AppError('BACKEND_NOT_CONFIGURED', 'The backend origin must be an origin, with no path'),
    );
  }

  return ok(url.origin);
}

/**
 * The configured backend origin, or a failure explaining what to do.
 *
 * Returns a Result rather than throwing or returning a default: there is no
 * safe default for "where should I send this person's resume", and a silent
 * fallback is exactly how data ends up somewhere nobody chose.
 */
export function resolveBackendOrigin(): Result<string, AppError> {
  const configured = buildEnv().WXT_BACKEND_ORIGIN;

  if (configured === undefined || configured.trim().length === 0) {
    return err(
      new AppError(
        'BACKEND_NOT_CONFIGURED',
        'This build has no backend configured, so nothing can be sent anywhere',
      ),
    );
  }

  return validateBackendOrigin(configured);
}

/** True when this build can talk to a backend at all. Cheap feature gate. */
export function backendIsConfigured(): boolean {
  return resolveBackendOrigin().ok;
}

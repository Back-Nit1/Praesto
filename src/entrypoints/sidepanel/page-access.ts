/**
 * Why can (or can't) we touch this page?
 * ---------------------------------------------------------------------------
 * This module exists because the panel used to answer that question by
 * guessing. Any injection failure produced one hard-coded sentence:
 *
 *   "This page cannot be scanned. Chrome blocks extensions on its own pages,
 *    the Web Store, and PDFs."
 *
 * That sentence is true of SOME failures. It was shown for all of them -
 * including the most common one, which is none of those things and is fixable
 * in one click. A user on an ordinary job posting was told their page was
 * fundamentally off-limits, which is both wrong and a dead end.
 *
 * THE COMMON CASE, AND WHY IT SURPRISES PEOPLE
 * The extension runs on `activeTab`, deliberately - it means no host
 * permissions at install time and no "read and change all your data on all
 * websites" warning. But `activeTab` is narrower than it looks:
 *
 *   - it is granted when the user INVOKES the extension (clicks the toolbar
 *     icon, a context menu item, or a keyboard shortcut);
 *   - the grant is for that one tab;
 *   - and it is REVOKED as soon as that tab navigates.
 *
 * A side panel is its own document. Clicking a button inside it is not an
 * invocation on the tab. So the ordinary flow - open the panel, browse to a job
 * posting, click Scan - arrives with no grant at all, because the navigation
 * that got you to the posting revoked it.
 *
 * The honest fix is not to request host permissions up front. It is to detect
 * this case and offer the user a one-click grant for the site they are actually
 * on, which is what `optional_host_permissions` in the manifest is for.
 */

/**
 * URL schemes and hosts no extension may script, by Chrome's own rules.
 *
 * These are genuinely Chrome's blocks, not ours. `chrome://` and the Web Store
 * are hard-coded refusals in the browser; asking for permission cannot help,
 * and offering the user a button would be a lie.
 */
const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
  'about:',
  'edge:',
  'brave:',
  'moz-extension:',
];

/** Chrome refuses extension scripting on its own web properties. */
const RESTRICTED_HOSTS = [
  'chromewebstore.google.com',
  'chrome.google.com', // the legacy Web Store path lives here
];

/** What kind of page this is, from the extension's point of view. */
export type PageAccess =
  /** Ordinary http(s). We can run here, given the grant. */
  | { kind: 'injectable'; origin: string }
  /** Chrome forbids extensions here outright. No permission can change it. */
  | { kind: 'restricted'; reason: string }
  /** A local file. Needs a per-extension toggle the user must flip themselves. */
  | { kind: 'local_file' }
  /** No URL at all - a tab still loading, or one we cannot see. */
  | { kind: 'unknown' };

/**
 * Classify a tab's URL.
 *
 * Pure and synchronous, so the panel can decide what to SAY without performing
 * any privileged operation first.
 */
export function classifyPage(url: string | undefined): PageAccess {
  if (url === undefined || url.length === 0) return { kind: 'unknown' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown' };
  }

  if (parsed.protocol === 'file:') return { kind: 'local_file' };

  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) {
    return { kind: 'restricted', reason: `Chrome does not allow extensions on ${parsed.protocol} pages` };
  }

  if (RESTRICTED_HOSTS.includes(parsed.hostname)) {
    return { kind: 'restricted', reason: 'Chrome does not allow extensions to run on the Web Store' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'restricted', reason: `Pages served over ${parsed.protocol} cannot be scanned` };
  }

  return { kind: 'injectable', origin: parsed.origin };
}

/**
 * The match pattern to request for a site.
 *
 * Scoped to the ORIGIN and all its paths - `https://boards.greenhouse.io/*` -
 * rather than to `https://*​/*`. Asking for one site is what makes the Chrome
 * prompt something a reasonable person says yes to, and it means a grant for
 * one employer's careers site does not silently extend to every site the user
 * ever visits.
 */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

/** Do we already hold host permission for this origin? */
export async function hasAccess(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(origin)] });
  } catch {
    // A malformed pattern, or an origin Chrome will not accept. Treat as "no",
    // which routes the user to the request flow rather than to a silent failure.
    return false;
  }
}

/**
 * Ask the user for permanent access to this site.
 *
 * MUST be called directly from a user gesture - a click handler in the panel.
 * Chrome refuses the prompt otherwise, and refuses it silently by resolving
 * `false`, which is indistinguishable from the user declining. So this is never
 * called from an effect, a retry, or a timer.
 */
export async function requestAccess(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [originPattern(origin)] });
  } catch {
    return false;
  }
}

/** Drop a site's access again. Offered so a grant is not a one-way door. */
export async function revokeAccess(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [originPattern(origin)] });
  } catch {
    return false;
  }
}

/**
 * Does this injection error mean "you lack permission for this host"?
 *
 * Chrome reports it as a plain `Error` with one of a few messages and no code,
 * so string matching is the only option available. It is used ONLY to choose
 * between two explanations, never to decide whether to do something - a
 * mismatch costs the user a slightly less specific message, nothing more.
 */
export function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Cannot access contents of the page') ||
    message.includes('must request permission') ||
    message.includes('Cannot access a chrome') ||
    message.includes('Missing host permission')
  );
}

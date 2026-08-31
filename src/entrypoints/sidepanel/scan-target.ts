/**
 * Which page a scan belongs to.
 * ---------------------------------------------------------------------------
 * Extracted from the panel so that the session snapshot - which has to decide
 * whether a stored scan still describes the tab in front of the user - answers
 * that question with the SAME code the live panel uses. Two implementations of
 * "is this still the same page?" would eventually disagree, and the failure
 * would be the panel restoring one application's field list over another's.
 */

/**
 * SECURITY: only ordinary web pages may be scanned or filled.
 *
 * Deliberately an ALLOWLIST of schemes rather than a denylist of chrome:// and
 * friends. A denylist has to be right about every scheme a browser will ever
 * add; an allowlist is wrong only in the safe direction (an unusual page is
 * not scanned).
 */
export function isScannableUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'https:' || scheme === 'http:';
  } catch {
    return false;
  }
}

/**
 * WHICH PAGE a scan belongs to.
 *
 * The hostname alone was not enough, and the gap was not theoretical: every
 * application on a careers site shares one hostname, so scanning
 * `boards.greenhouse.io/acme/jobs/1`, navigating to `.../jobs/2` and clicking
 * Fill passed the hostname check and then filled the SECOND application from
 * the FIRST one's field list - by localId, against elements that no longer
 * mean what they meant. The tab id matters for the same reason in the other
 * direction: the panel outlives the tab it was opened over, and the user can
 * switch tabs mid-application.
 *
 * The URL is compared without its fragment. `#section` is a scroll position,
 * not a different page, and treating it as one would invalidate a scan every
 * time the form scrolled itself.
 */
export interface ScanTarget {
  tabId: number;
  /** Full URL, fragment stripped. */
  url: string;
  /** Hostname, for the one thing the user actually needs to read. */
  host: string;
}

export function targetFromTab(tab: chrome.tabs.Tab | undefined): ScanTarget | undefined {
  if (tab?.id === undefined || !isScannableUrl(tab.url)) return undefined;
  try {
    const parsed = new URL(tab.url ?? '');
    parsed.hash = '';
    return { tabId: tab.id, url: parsed.href, host: parsed.hostname };
  } catch {
    return undefined;
  }
}

/** The page the user is looking at right now. */
export async function activeTarget(): Promise<ScanTarget | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return targetFromTab(tab);
}

/** Same tab, same address - the two conditions for a scan still being valid. */
export function sameTarget(a: ScanTarget | undefined, b: ScanTarget | undefined): boolean {
  return a !== undefined && b !== undefined && a.tabId === b.tabId && a.url === b.url;
}

/**
 * ATS detection.
 * ---------------------------------------------------------------------------
 * Spec section 18: ONE generic engine, with optional ATS specialisation layered
 * on top. Detection exists to unlock those specialisations - it is never a
 * precondition for filling a form.
 *
 * Everything here is deliberately conservative. Misidentifying the ATS would
 * apply the wrong platform's quirk rules to a page, which is worse than the
 * `unknown` path (which simply uses the generic engine and works fine).
 *
 * TWO SIGNALS, IN ORDER
 *   1. HOSTNAME. Cheap, available in the service worker without DOM access, and
 *      unambiguous for hosted boards (boards.greenhouse.io, jobs.lever.co).
 *   2. DOM MARKERS. Needed for the common case of an ATS embedded in a
 *      company's own careers site, where the hostname says nothing.
 *
 * The detector is split so step 1 is a pure function testable without a
 * browser, and step 2 is an optional enhancement the content script supplies.
 */
import type { ATSKind, PageContext } from './types';

/**
 * Hostname patterns for the hosted case.
 *
 * Anchored to the END of the hostname, so `boards.greenhouse.io` matches but
 * `greenhouse.io.evil.example` does not. Substring matching here would be a
 * genuine spoofing hole: a page that convinces us it is Greenhouse gets
 * Greenhouse's quirk handling applied to its controls.
 */
const HOSTNAME_PATTERNS: ReadonlyArray<{ suffix: string; ats: ATSKind }> = [
  { suffix: 'greenhouse.io', ats: 'greenhouse' },
  { suffix: 'boards.greenhouse.io', ats: 'greenhouse' },
  { suffix: 'job-boards.greenhouse.io', ats: 'greenhouse' },
  { suffix: 'lever.co', ats: 'lever' },
  { suffix: 'jobs.lever.co', ats: 'lever' },
  { suffix: 'myworkdayjobs.com', ats: 'workday' },
  { suffix: 'myworkdaysite.com', ats: 'workday' },
  { suffix: 'workday.com', ats: 'workday' },
  { suffix: 'ashbyhq.com', ats: 'ashby' },
  { suffix: 'jobs.ashbyhq.com', ats: 'ashby' },
  { suffix: 'smartrecruiters.com', ats: 'smartrecruiters' },
];

/** True when `hostname` is exactly `suffix` or a subdomain of it. */
function hostMatches(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Detect from URL alone. Pure - no DOM, no browser.
 *
 * Returns `unknown` rather than a best guess. The generic engine handles
 * `unknown` perfectly well, so there is no cost to admitting ignorance and a
 * real cost to guessing wrong.
 */
export function detectATSFromUrl(context: PageContext): ATSKind {
  for (const { suffix, ats } of HOSTNAME_PATTERNS) {
    if (hostMatches(context.hostname, suffix)) return ats;
  }

  // Some companies proxy an ATS under their own domain but keep the platform's
  // path structure. Path checks are narrower and more distinctive than a bare
  // keyword search over the whole URL.
  const url = context.url.toLowerCase();
  if (url.includes('/embed/job_app') || url.includes('greenhouse.io/embed')) return 'greenhouse';
  if (/\/wday\/[a-z]+\//.test(url)) return 'workday';

  return 'unknown';
}

/**
 * DOM markers, checked only when the URL was inconclusive.
 *
 * Each selector is a structural element the platform emits and a hand-built
 * form would be unlikely to reproduce by accident. They are checked in one
 * `querySelector` pass per platform so an embedded form costs a handful of
 * selector evaluations, not a tree walk.
 */
const DOM_MARKERS: ReadonlyArray<{ selector: string; ats: ATSKind }> = [
  { selector: '#grnhse_app, [id^="grnhse"], form[action*="greenhouse.io"]', ats: 'greenhouse' },
  { selector: '.lever-application, form[action*="lever.co"], [data-qa="application-form"]', ats: 'lever' },
  // Specific automation ids only. A bare `[data-automation-id]` would match
  // many unrelated test-instrumented apps and mislabel them as Workday.
  {
    selector:
      '[data-automation-id="jobApplication"], [data-automation-id="applyFlow"], [data-automation-id="legalNameSection"]',
    ats: 'workday',
  },
  { selector: '[data-ashby-application], form[action*="ashbyhq.com"]', ats: 'ashby' },
  { selector: '#sr-application, form[action*="smartrecruiters.com"]', ats: 'smartrecruiters' },
];

/**
 * Full detection: URL first, then DOM.
 *
 * Takes the document as a parameter rather than reaching for a global, so it
 * can be exercised in a jsdom test and so the service worker cannot call it by
 * accident in a context that has no DOM.
 */
export function detectATS(context: PageContext, document?: Document): ATSKind {
  const fromUrl = detectATSFromUrl(context);
  if (fromUrl !== 'unknown') return fromUrl;
  if (document === undefined) return 'unknown';

  for (const { selector, ats } of DOM_MARKERS) {
    try {
      if (document.querySelector(selector) !== null) return ats;
    } catch {
      // An invalid selector in this table is our bug, but it must not abort
      // detection for the platforms after it, and it must never throw into the
      // host page. Skip and continue.
      continue;
    }
  }

  return 'unknown';
}

/** Display name for the side panel. */
export function atsDisplayName(ats: ATSKind): string {
  switch (ats) {
    case 'greenhouse':
      return 'Greenhouse';
    case 'lever':
      return 'Lever';
    case 'workday':
      return 'Workday';
    case 'ashby':
      return 'Ashby';
    case 'smartrecruiters':
      return 'SmartRecruiters';
    case 'unknown':
      return 'Generic';
  }
}

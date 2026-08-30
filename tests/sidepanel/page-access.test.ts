/**
 * Page-access classification tests.
 *
 * These exist because the panel previously answered "why can't we scan this?"
 * with a single hard-coded sentence blaming Chrome, shown for every failure
 * including the one the user could fix in a click. The distinctions below are
 * the whole point: each one leads to different words and a different next step,
 * so collapsing any two of them puts the user back where they started.
 */
import { describe, expect, it } from 'vitest';
import { classifyPage, isPermissionError, originPattern } from '@/entrypoints/sidepanel/page-access';

describe('classifyPage', () => {
  it.each([
    'https://boards.greenhouse.io/acme/jobs/123',
    'https://jobs.lever.co/acme/abc/apply',
    'http://localhost:5174/basic-contact.html',
    'https://careers.example.com/apply?src=li',
  ])('treats an ordinary web page as injectable: %s', (url) => {
    const access = classifyPage(url);
    expect(access.kind).toBe('injectable');
  });

  it('reports the origin, not the full URL, for an injectable page', () => {
    // The permission request is scoped to the origin. Including the path would
    // ask for something Chrome does not grant at that granularity, and
    // including the query would leak a job id into a permission prompt.
    const access = classifyPage('https://boards.greenhouse.io/acme/jobs/123?token=abc');
    expect(access).toEqual({ kind: 'injectable', origin: 'https://boards.greenhouse.io' });
  });

  it.each([
    ['chrome://extensions', 'chrome:'],
    ['chrome-extension://abcdef/options.html', 'chrome-extension:'],
    ['devtools://devtools/bundled/inspector.html', 'devtools:'],
    ['view-source:https://example.com', 'view-source:'],
    ['about:blank', 'about:'],
  ])('recognises %s as genuinely restricted by Chrome', (url) => {
    // These are the ONLY cases where blaming Chrome is accurate. No permission
    // can change them, so no button may be offered.
    expect(classifyPage(url).kind).toBe('restricted');
  });

  it('recognises the Web Store as restricted', () => {
    expect(classifyPage('https://chromewebstore.google.com/detail/x').kind).toBe('restricted');
    expect(classifyPage('https://chrome.google.com/webstore/detail/x').kind).toBe('restricted');
  });

  it('separates a local file from a restricted page', () => {
    // file:// is not forbidden - it is behind a per-extension toggle the user
    // controls. Telling them "Chrome blocks this" would be wrong AND would hide
    // the setting that fixes it.
    expect(classifyPage('file:///Users/someone/resume.pdf').kind).toBe('local_file');
  });

  it('returns unknown rather than guessing for a missing or malformed URL', () => {
    expect(classifyPage(undefined).kind).toBe('unknown');
    expect(classifyPage('').kind).toBe('unknown');
    expect(classifyPage('not a url').kind).toBe('unknown');
  });
});

describe('originPattern', () => {
  it('scopes a grant to one site, not to every site', () => {
    // `https://*/*` would be a prompt no reasonable person accepts, and a grant
    // for one employer's careers page must not silently cover the whole web.
    expect(originPattern('https://boards.greenhouse.io')).toBe('https://boards.greenhouse.io/*');
  });
});

describe('isPermissionError', () => {
  it('recognises the messages Chrome uses when host access is missing', () => {
    // Chrome reports this as a plain Error with no code, so string matching is
    // the only signal available.
    for (const message of [
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'Missing host permission for the tab',
    ]) {
      expect(isPermissionError(new Error(message)), message).toBe(true);
    }
  });

  it('does not claim an unrelated failure is a permission problem', () => {
    // A wrong answer here only costs a less specific message - it never gates
    // an action - but claiming "you need to grant permission" for a crashed tab
    // would send the user to a prompt that fixes nothing.
    expect(isPermissionError(new Error('The tab was closed'))).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });
});

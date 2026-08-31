/**
 * Playwright configuration - the only tests that run in a real browser.
 * ---------------------------------------------------------------------------
 * Everything else in this repo is tested in Node or jsdom, deliberately: the
 * mapping cascade, the confidence policy and the resolver are pure functions,
 * and testing them without a browser is what keeps the suite at two seconds.
 *
 * But jsdom is not Chrome. It has no extension runtime, no service worker, no
 * `chrome.scripting`, no content-script isolation and no MV3 lifecycle - so a
 * whole class of failure is invisible to it: a manifest Chrome rejects, a CSP
 * that blocks our own bundle, a service worker that never registers, a message
 * shape that survives a jsdom fake and not the real serialiser. Those are
 * exactly the failures a user meets first.
 *
 * These tests load the BUILT extension into a real Chromium and drive it
 * through its own service worker.
 *
 *     npm run test:e2e
 *
 * Kept out of `npm run check` on purpose: it needs a build and a browser
 * binary, and a unit suite that takes two seconds is a suite people run.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',

  /**
   * One worker, no parallelism.
   *
   * Each test loads an extension into its own persistent Chrome profile, which
   * is heavy, and they share one fixture server. Parallelism here buys seconds
   * and costs flakiness.
   */
  workers: 1,
  fullyParallel: false,

  // A browser launch plus an extension load is slow on a cold cache.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env['CI'] === undefined ? 'list' : 'dot',

  /**
   * The fixture server the extension is pointed at.
   *
   * Real http rather than `file://`: Chrome hides file URLs from extensions
   * unless a per-extension toggle is flipped, and a file page has a null origin
   * and different security behaviour - so testing there would prove less than
   * it appears to.
   */
  webServer: {
    command: 'node scripts/serve-fixtures.mjs',
    url: 'http://localhost:5174/',
    reuseExistingServer: true,
    timeout: 20_000,
  },

  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
});

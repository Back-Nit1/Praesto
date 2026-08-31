/**
 * Loading the built extension into a real Chromium.
 * ---------------------------------------------------------------------------
 * Two things here are not obvious and are the whole reason this file exists.
 *
 * 1. THE MANIFEST IS PATCHED FOR THE TEST RUN, AND ONLY FOR IT.
 *    The shipped extension holds `activeTab`, which Chrome grants when the
 *    user CLICKS THE TOOLBAR ICON. That click is browser chrome; no automation
 *    API can produce it, so an end-to-end test can never obtain the grant the
 *    way a user does. Rather than weaken the shipped permission model to make
 *    it testable - which would be optimising the product for the test suite -
 *    the build is copied and its manifest given host access to the local
 *    fixture server. Everything else about the extension under test is
 *    byte-identical to what ships.
 *
 * 2. THE TESTS DRIVE THE SERVICE WORKER, NOT THE SIDE PANEL.
 *    Playwright can evaluate code inside the extension's service worker, which
 *    is the context that holds the real `chrome.*` APIs, the real profile
 *    storage and the real message pipeline. The panel's own logic is covered
 *    in jsdom (tests/sidepanel); what jsdom cannot cover is whether Chrome
 *    accepts the manifest, registers the worker, injects the scanner, and
 *    carries a fill all the way into a live DOM. That is what these exercise.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = join(ROOT, 'dist', 'chrome-mv3');

/** Where the fixture server serves from. Must match playwright.config.ts. */
export const FIXTURES = 'http://localhost:5174';

/**
 * A copy of the build whose manifest can reach the fixture server.
 *
 * Copied rather than edited in place: `npm run build` output is what a user
 * loads, and a test that mutates it would leave a differently-permissioned
 * extension behind on disk.
 */
async function stageExtension(): Promise<string> {
  const staged = await mkdtemp(join(tmpdir(), 'applicant-agent-e2e-'));
  const directory = join(staged, 'extension');
  await cp(BUILD, directory, { recursive: true });

  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions?: string[];
  };

  // The one change. See the header: a toolbar click cannot be automated, so
  // the grant `activeTab` would give a real user is granted statically here.
  manifest.host_permissions = ['http://localhost:5174/*'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return staged;
}

interface ExtensionFixtures {
  context: BrowserContext;
  /** The MV3 service worker - our handle on the real chrome APIs. */
  worker: Worker;
  extensionId: string;
}

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const staged = await stageExtension();
    const profile = join(staged, 'chrome-profile');
    const extension = join(staged, 'extension');

    /**
     * A persistent context, because an extension cannot be loaded into an
     * ephemeral one.
     *
     * `channel: 'chromium'` matters: Playwright's DEFAULT headless browser is
     * the headless shell, a stripped build with no extension support at all -
     * it launches, loads nothing, and the context closes out from under the
     * first `waitForEvent('serviceworker')` with "Target page, context or
     * browser has been closed". The full Chromium build runs headless and does
     * support extensions, and asking for the channel by name is how you get it.
     */
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });

    await use(context);

    await context.close();
    await rm(staged, { recursive: true, force: true });
  },

  worker: async ({ context }, use) => {
    // The worker may already be running, or may take a moment to register.
    const existing = context.serviceWorkers()[0];
    const worker = existing ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },

  extensionId: async ({ worker }, use) => {
    // chrome-extension://<id>/background.js
    const id = new URL(worker.url()).host;
    expect(id).not.toHaveLength(0);
    await use(id);
  },
});

export { expect };

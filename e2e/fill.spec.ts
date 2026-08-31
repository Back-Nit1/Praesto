/**
 * End-to-end: a real profile, a real page, a real fill.
 *
 * The path under test is the one no unit test can reach:
 *
 *     chrome.storage -> service worker -> chrome.scripting.executeScript
 *       -> scanner in the page -> mapper -> resolver -> confidence policy
 *       -> fill adapters -> the live DOM -> verification -> back to the worker
 *
 * Everything in the middle has unit tests. What these assert is that Chrome
 * accepts the manifest, registers the worker, injects the built bundle into a
 * real page, and that a value actually lands in a real input - plus the two
 * refusals the product is built on, checked against a live document rather
 * than a fake one.
 */
import { STORAGE_KEYS } from '../src/packages/storage/keys';
import { createEmptyProfile, userValue, type ApplicantProfile } from '../src/packages/profile/schema';
import { parsePhone } from '../src/packages/profile/normalizers/phone';
import { expect, FIXTURES, test } from './fixtures';

/** A profile with the values the fixtures ask for, all user-verified. */
function seedProfile(): ApplicantProfile {
  const profile = createEmptyProfile('e2e-profile', '2026-01-01T00:00:00.000Z');
  profile.identity.legalFirstName = userValue('Nityanth');
  profile.identity.lastName = userValue('Maramreddy');
  profile.contact.email = userValue('nitu@example.com');
  profile.links.linkedin = userValue('https://www.linkedin.com/in/nitu');
  profile.links.github = userValue('https://github.com/nitu');

  const phone = parsePhone('(609) 555-1234');
  if (phone !== null) profile.contact.phone = userValue(phone, '(609) 555-1234');

  return profile;
}

/** What the in-worker routine reports back. */
interface ScanAndFillResult {
  scan: {
    ok: boolean;
    code?: string;
    actions: Array<{ action: string; profilePath: string | null }>;
  };
  outcomes: Array<{ localId: string; verified: boolean; failureReason?: string }>;
  fillOk: boolean;
}

/**
 * Scan and fill a page, entirely through the extension's own machinery.
 *
 * Runs inside the SERVICE WORKER, so every call is the real chrome API - the
 * same path the side panel drives, minus the React.
 *
 * Passed as a FUNCTION, not as a string. Playwright evaluates a string as an
 * expression, so a string holding an arrow function evaluates to a function
 * object, is not serializable, and comes back as `undefined` - having never
 * been called. Every assertion downstream then fails on a value that looks
 * like a broken extension and is actually a broken test.
 */
async function scanAndFill(url: string): Promise<ScanAndFillResult> {
  const [tab] = await chrome.tabs.query({ url });
  if (tab?.id === undefined) throw new Error(`no tab for ${url}`);
  const tabId = tab.id;

  await chrome.scripting.executeScript({ target: { tabId }, files: ['scanner.js'] });

  const scan = (await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_SCAN' })) as
    | ScanAndFillResult['scan']
    | undefined;

  if (scan === undefined || !scan.ok) {
    return { scan: scan ?? { ok: false, actions: [] }, outcomes: [], fillOk: false };
  }

  const actions = scan.actions.filter(
    (action) => action.action === 'fill' || action.action === 'attach_resume',
  );
  const fill = (await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_FILL', actions })) as
    | { ok: boolean; outcomes: ScanAndFillResult['outcomes'] }
    | undefined;

  return { scan, outcomes: fill?.outcomes ?? [], fillOk: fill?.ok === true };
}

test.beforeEach(async ({ worker }) => {
  await worker.evaluate(
    async ([key, profile]) => {
      await chrome.storage.local.set({ [key as string]: profile });
    },
    [STORAGE_KEYS.activeProfile, seedProfile()] as const,
  );
});

test('fills a contact form from the stored profile, and verifies it landed', async ({
  context,
  worker,
}) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/basic-contact.html`);

  const result = await worker.evaluate(scanAndFill, `${FIXTURES}/basic-contact.html`);

  expect(result.scan.ok).toBe(true);
  expect(result.fillOk).toBe(true);

  // Every attempted fill verified by a read-back IN THE PAGE, not by our own
  // report of what we sent.
  const failed = result.outcomes.filter((outcome) => !outcome.verified);
  expect(failed, JSON.stringify(failed)).toHaveLength(0);

  // And the values are actually in the DOM, in the format the control asked for.
  await expect(page.locator('#first')).toHaveValue('Nityanth');
  await expect(page.locator('#last')).toHaveValue('Maramreddy');
  await expect(page.locator('#email')).toHaveValue('nitu@example.com');
  await expect(page.locator('#phone')).toHaveValue('(609) 555-1234');
  await expect(page.locator('#linkedin')).toHaveValue('https://www.linkedin.com/in/nitu');
});

test('never touches a hidden field, whatever it is named', async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/basic-contact.html`);

  await worker.evaluate(scanAndFill, `${FIXTURES}/basic-contact.html`);

  // A CSRF token is the canonical hidden input. Writing to one would be
  // invisible in the UI and would break the submission the user is about to
  // make.
  await expect(page.locator('input[name="authenticity_token"]')).toHaveValue(
    'should-never-be-touched',
  );
});

test('leaves a work-authorization question blank when the user has not answered it', async ({
  context,
  worker,
}) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/radio-authorization.html`);

  const result = await worker.evaluate(scanAndFill, `${FIXTURES}/radio-authorization.html`);

  // The profile seeded above never answers these, and spec 21.3 says they may
  // come only from an explicit user statement - so the engine must decline to
  // fill them even though it recognises the question perfectly well.
  const filled = result.scan.actions.filter(
    (action) =>
      action.action === 'fill' && (action.profilePath ?? '').startsWith('applicationPreferences.'),
  );
  expect(filled).toHaveLength(0);

  // Nothing on the page is checked.
  expect(await page.locator('input[type="radio"]:checked').count()).toBe(0);
});

test('does not overwrite a value the user already typed', async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/basic-contact.html`);

  // The user's own answer - possibly a different address for this application.
  await page.locator('#email').fill('other@example.com');

  await worker.evaluate(scanAndFill, `${FIXTURES}/basic-contact.html`);

  await expect(page.locator('#email')).toHaveValue('other@example.com');
});

test('reports a missing profile as a missing profile, not as a missing form', async ({
  context,
  worker,
}) => {
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
  });

  const page = await context.newPage();
  await page.goto(`${FIXTURES}/basic-contact.html`);

  const result = await worker.evaluate(scanAndFill, `${FIXTURES}/basic-contact.html`);

  expect(result.scan.ok).toBe(false);
  expect(result.scan.code).toBe('PROFILE_NOT_FOUND');
});

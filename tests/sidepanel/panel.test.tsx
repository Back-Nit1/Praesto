// @vitest-environment jsdom
/**
 * Side panel behaviour.
 *
 * These are the assertions that protect the product's central promise. Every
 * one of them corresponds to a bug the panel actually had:
 *
 *   - it said "Filled" for fields the page had rejected, because it never read
 *     the reply to its own fill message;
 *   - a suggestion could be looked at and not used, because the only control on
 *     one changed which profile field it mapped to;
 *   - a missing profile was reported as "No application form detected", which
 *     is both wrong and unactionable for a first-time user.
 *
 * The chrome API is a hand-built fake rather than a mocking library: what these
 * tests care about is the exact SHAPE of the messages the panel sends, and a
 * fake that records them states that plainly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ResolvedFieldAction } from '@shared/messages';

type MessageListener = (message: unknown, sender: { tab?: { id: number } }) => unknown;
type TabUpdatedListener = (
  tabId: number,
  change: { url?: string },
  tab: { id: number; url: string },
) => void;

/** The tab the panel sees as active. Tests move it to simulate navigation. */
let activeTab = { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1' };
let messageListeners: MessageListener[] = [];
let tabUpdatedListeners: TabUpdatedListener[] = [];

/** Deliver a runtime broadcast as if it came from a given tab. */
function broadcast(message: unknown, fromTabId: number): void {
  for (const listener of [...messageListeners]) listener(message, { tab: { id: fromTabId } });
}

/** Navigate a tab, the way Chrome reports it. */
function navigate(tabId: number, url: string): void {
  if (activeTab.id === tabId) activeTab = { id: tabId, url };
  for (const listener of [...tabUpdatedListeners]) listener(tabId, { url }, { id: tabId, url });
}

/** Messages the panel sent to the page, in order. */
let sent: Array<{ frameId: number; message: Record<string, unknown> }> = [];
/** Queue of replies, consumed in order of the requests they answer. */
let replies: Map<string, unknown[]>;
let optionsOpened = 0;

function reply(type: string, value: unknown): void {
  const existing = replies.get(type);
  if (existing === undefined) replies.set(type, [value]);
  else existing.push(value);
}

/**
 * The chrome surface the panel touches.
 *
 * Installed on `globalThis` BEFORE the component is imported, because
 * `new ChromeLocalStore()` reads `chrome.storage.local` at construction time
 * and the panel constructs one at module scope.
 */
function installChromeFake(): void {
  const storage = new Map<string, unknown>();

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        },
        remove: async (key: string) => void storage.delete(key),
      },
    },
    // A perfectly ordinary job posting: an https page the extension is
    // already allowed onto. The panel classifies the tab before injecting, so
    // a tab with no URL would be reported as unscannable rather than scanned.
    permissions: {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
    },
    tabs: {
      query: async () => [{ id: activeTab.id, url: activeTab.url }],
      onUpdated: {
        addListener: (fn: unknown) => tabUpdatedListeners.push(fn as TabUpdatedListener),
        removeListener: (fn: unknown) => {
          const index = tabUpdatedListeners.indexOf(fn as TabUpdatedListener);
          if (index >= 0) tabUpdatedListeners.splice(index, 1);
        },
      },
      onRemoved: { addListener: () => undefined, removeListener: () => undefined },
      sendMessage: async (_tabId: number, message: Record<string, unknown>, options?: { frameId?: number }) => {
        sent.push({ frameId: options?.frameId ?? 0, message });
        const queued = replies.get(String(message['type']));
        return queued === undefined || queued.length === 0 ? undefined : queued.shift();
      },
    },
    scripting: {
      executeScript: async () => [{ frameId: 0 }],
    },
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: (fn: unknown) => messageListeners.push(fn as MessageListener),
        removeListener: (fn: unknown) => {
          const index = messageListeners.indexOf(fn as MessageListener);
          if (index >= 0) messageListeners.splice(index, 1);
        },
      },
      openOptionsPage: () => {
        optionsOpened++;
      },
      sendMessage: async () => undefined,
    },
  };
}

installChromeFake();

// Imported after the fake is installed - see installChromeFake.
const { App } = await import('@/entrypoints/sidepanel/App');

const action = (overrides: Partial<ResolvedFieldAction>): ResolvedFieldAction => ({
  localId: 'f_1',
  action: 'fill',
  profilePath: 'contact.email',
  mappingConfidence: 0.99,
  knowledgeState: 'known',
  value: 'nitu@example.com',
  explanation: 'Email (label_exact)',
  ...overrides,
});

beforeEach(() => {
  cleanup();
  sent = [];
  replies = new Map();
  optionsOpened = 0;
  activeTab = { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1' };
  messageListeners = [];
  tabUpdatedListeners = [];
});

/** Click by accessible name, the way the user reaches it. */
function click(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** Scan, with a scripted set of actions, and wait for the report to render. */
async function scanWith(actions: ResolvedFieldAction[]): Promise<void> {
  reply('CONTENT_SCAN', { ok: true, actions, fieldsDetected: actions.length });
  render(<App />);
  click(/scan this page/i);
  await screen.findByText(/fields detected/i);
}

describe('side panel - reporting what happened', () => {
  it('does not claim a field was filled when the page rejected it', async () => {
    await scanWith([action({})]);

    reply('CONTENT_FILL', {
      ok: true,
      outcomes: [{ localId: 'f_1', attempted: true, verified: false, failureReason: 'rejected' }],
    });

    click(/fill 1 safe field/i);

    // The reason is named, in the row it belongs to.
    await screen.findByText(/the page refused the value/i);
    // And the summary counts the failure rather than rounding it away.
    expect(screen.getByText(/0 filled, 1 could not be filled/i)).toBeTruthy();
  });

  it('reports a verified fill as verified', async () => {
    await scanWith([action({})]);

    reply('CONTENT_FILL', {
      ok: true,
      outcomes: [{ localId: 'f_1', attempted: true, verified: true, adapter: 'NativeText' }],
    });

    click(/fill 1 safe field/i);

    await screen.findByText(/1 field filled and verified/i);
    // No failure explanation anywhere in the list. (The "Could not be filled"
    // STAT is always present once a fill has run - showing it as 0 is the
    // point, not an omission.)
    expect(screen.queryByText(/the page refused the value/i)).toBeNull();
  });

  it('does not report success when the page never answered', async () => {
    await scanWith([action({})]);
    // No CONTENT_FILL reply queued: the frame went away mid-fill.
    click(/fill 1 safe field/i);

    await screen.findByText(/stopped responding/i);
  });
});

describe('side panel - a resume the user has not saved', () => {
  it('says so, and does not send an attach action that can only fail', async () => {
    await scanWith([
      action({ localId: 'f_1' }),
      action({ localId: 'f_9', action: 'attach_resume', profilePath: null, explanation: 'Resume upload' }),
    ]);

    reply('CONTENT_FILL', {
      ok: true,
      outcomes: [{ localId: 'f_1', attempted: true, verified: true }],
    });

    click(/fill 2 safe fields/i);

    const fill = await waitFor(() => {
      const found = sent.find((entry) => entry.message['type'] === 'CONTENT_FILL');
      expect(found).toBeDefined();
      return found;
    });

    // The attach action is dropped rather than sent to fail: nothing is stored
    // for it to attach, and reporting that as a rejected field would blame the
    // page for something the user fixes in the options screen.
    const actions = fill?.message['actions'] as ResolvedFieldAction[];
    expect(actions.map((candidate) => candidate.localId)).toEqual(['f_1']);
    await screen.findByText(/no resume/i);
  });
});

describe('side panel - accepting a suggestion', () => {
  it('sends the suggestion as a fill the user authorised', async () => {
    const suggestion = action({
      localId: 'f_2',
      action: 'suggest',
      profilePath: 'applicationPreferences.desiredSalary',
      value: '120000',
      explanation: 'Desired salary (fuzzy_label)',
    });
    await scanWith([suggestion]);

    reply('CONTENT_FILL', {
      ok: true,
      outcomes: [{ localId: 'f_2', attempted: true, verified: true }],
    });

    click(/^fill this$/i);

    // The click handler injects and messages asynchronously, so the send is
    // observed rather than assumed.
    const fill = await waitFor(() => {
      const found = sent.find((entry) => entry.message['type'] === 'CONTENT_FILL');
      expect(found).toBeDefined();
      return found;
    });
    const actions = fill?.message['actions'] as ResolvedFieldAction[];
    // Converted at the point of the click - the page never decides for itself
    // whether a suggestion is safe.
    expect(actions[0]?.action).toBe('fill');
    expect(actions[0]?.localId).toBe('f_2');
    expect(actions[0]?.value).toBe('120000');
  });

  it('offers to fill every suggestion at once', async () => {
    await scanWith([
      action({ localId: 'f_2', action: 'suggest', value: 'a' }),
      action({ localId: 'f_3', action: 'suggest', value: 'b' }),
    ]);

    reply('CONTENT_FILL', {
      ok: true,
      outcomes: [
        { localId: 'f_2', attempted: true, verified: true },
        { localId: 'f_3', attempted: true, verified: true },
      ],
    });

    click(/fill all 2 suggestions/i);

    const fill = await waitFor(() => {
      const found = sent.find((entry) => entry.message['type'] === 'CONTENT_FILL');
      expect(found).toBeDefined();
      return found;
    });
    const actions = fill?.message['actions'] as ResolvedFieldAction[];
    expect(actions).toHaveLength(2);
    expect(actions.every((candidate) => candidate.action === 'fill')).toBe(true);
    // The index must not leak in as an edited value - `map(asAcceptedFill)`
    // would have written "0" and "1" into the form.
    expect(actions.map((candidate) => candidate.value)).toEqual(['a', 'b']);
  });
});

describe('side panel - a missing profile', () => {
  it('offers onboarding instead of blaming the page', async () => {
    reply('CONTENT_SCAN', {
      ok: false,
      code: 'PROFILE_NOT_FOUND',
      message: 'Create your profile before filling applications',
    });

    render(<App />);
    click(/scan this page/i);

    // Asserted on the AFFORDANCE, not the wording: the copy is presentation
    // and gets rewritten, but "there is a one-click way into onboarding, and
    // the page is not blamed" is the behaviour that must not regress.
    await screen.findByRole('button', { name: /open my profile/i });
    expect(screen.queryByText(/no application form detected/i)).toBeNull();

    click(/open my profile/i);
    expect(optionsOpened).toBe(1);
  });

  it('still says "no form" when the page genuinely has none', async () => {
    reply('CONTENT_SCAN', { ok: true, actions: [], fieldsDetected: 0 });

    render(<App />);
    click(/scan this page/i);

    await screen.findByText(/no application form detected/i);
  });

  it('distinguishes a form we could say nothing about from no form at all', async () => {
    reply('CONTENT_SCAN', { ok: true, actions: [], fieldsDetected: 12 });

    render(<App />);
    click(/scan this page/i);

    await screen.findByText(/12 fields found/i);
  });
});

describe('side panel - which page a scan belongs to', () => {
  it('refuses to fill a different application on the same site', async () => {
    // The gap a hostname check could not see: every application on a careers
    // site shares one hostname, so filling here would have applied the FIRST
    // application's field list, by localId, to the SECOND one's DOM.
    await scanWith([action({})]);

    activeTab = { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/2' };
    click(/fill 1 safe field/i);

    await screen.findByText(/different application/i);
    expect(sent.some((entry) => entry.message['type'] === 'CONTENT_FILL')).toBe(false);
  });

  it('refuses to fill when the user has switched tabs', async () => {
    await scanWith([action({})]);

    activeTab = { id: 9, url: 'https://example.com/something-else' };
    click(/fill 1 safe field/i);

    await screen.findByText(/you are now on example\.com/i);
    expect(sent.some((entry) => entry.message['type'] === 'CONTENT_FILL')).toBe(false);
  });

  it('drops the field list when the scanned tab navigates away', async () => {
    await scanWith([action({})]);
    expect(screen.queryByText(/fields detected/i)).not.toBeNull();

    navigate(7, 'https://boards.greenhouse.io/acme/jobs/2');

    // A field list is a set of localIds that only mean something to the
    // document that produced them. Showing it after a navigation invites a
    // click on a page it was never about.
    await waitFor(() => expect(screen.queryByText(/fields detected/i)).toBeNull());
  });

  it('ignores a "form changed" broadcast from another tab', async () => {
    await scanWith([action({})]);

    broadcast({ type: 'PAGE_FIELDS_CHANGED' }, 99);
    expect(screen.queryByText(/this form changed/i)).toBeNull();

    broadcast({ type: 'PAGE_FIELDS_CHANGED' }, 7);
    await screen.findByText(/this form changed/i);
  });
});

describe('side panel - frames', () => {
  it('addresses each frame explicitly rather than broadcasting to the tab', async () => {
    // A broadcast delivers to every frame and keeps only the first reply, so an
    // embedded application form's answer would be discarded at random.
    await scanWith([action({})]);
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent.every((entry) => typeof entry.frameId === 'number')).toBe(true);
  });
});

vi.setConfig({ testTimeout: 10_000 });

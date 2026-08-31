// @vitest-environment jsdom
/**
 * What the panel says when the AI fallback runs out, or fails.
 *
 * Brief §5 requires that a rate limit is surfaced rather than swallowed, and
 * the reason is a specific user experience: fields that quietly stop improving
 * look exactly like a form that simply did not match. One of those is
 * something the user can act on - wait until tomorrow, or stop expecting help
 * on this form - and the other is not.
 *
 * In its own file rather than in `panel.test.tsx` because it needs no fill
 * flow, no correction flow and no navigation - just a scan reply carrying a
 * summary - and the harness for that is a fraction of the size.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ResolvedFieldAction, SemanticRunSummary } from '@shared/messages';

type MessageListener = (message: unknown, sender: { tab?: { id: number } }) => unknown;
type TabUpdatedListener = (
  tabId: number,
  change: { url?: string },
  tab: { id: number; url: string },
) => void;

let activeTab = { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1' };
let messageListeners: MessageListener[] = [];
let tabUpdatedListeners: TabUpdatedListener[] = [];
let replies: Map<string, unknown[]>;

function reply(type: string, value: unknown): void {
  const existing = replies.get(type);
  if (existing === undefined) replies.set(type, [value]);
  else existing.push(value);
}

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
    permissions: {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
    },
    tabs: {
      query: async () => [{ id: activeTab.id, url: activeTab.url }],
      onUpdated: {
        addListener: (fn: unknown) => tabUpdatedListeners.push(fn as TabUpdatedListener),
        removeListener: () => undefined,
      },
      onRemoved: { addListener: () => undefined, removeListener: () => undefined },
      sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
        const queued = replies.get(String(message['type']));
        return queued === undefined || queued.length === 0 ? undefined : queued.shift();
      },
    },
    scripting: { executeScript: async () => [{ frameId: 0 }] },
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: (fn: unknown) => messageListeners.push(fn as MessageListener),
        removeListener: () => undefined,
      },
      openOptionsPage: () => undefined,
      sendMessage: async () => undefined,
    },
  };
}

installChromeFake();

const { App } = await import('@/entrypoints/sidepanel/App');

const action = (overrides: Partial<ResolvedFieldAction> = {}): ResolvedFieldAction => ({
  localId: 'f_1',
  action: 'skip',
  profilePath: null,
  mappingConfidence: 0,
  knowledgeState: 'unknown',
  explanation: 'Not recognised',
  ...overrides,
});

beforeEach(() => {
  cleanup();
  replies = new Map();
  activeTab = { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1' };
  messageListeners = [];
  tabUpdatedListeners = [];
});

/** Scan with a scripted semantic summary attached to the reply. */
async function scanWith(semantic?: SemanticRunSummary): Promise<void> {
  reply('CONTENT_SCAN', {
    ok: true,
    actions: [action()],
    fieldsDetected: 1,
    ...(semantic !== undefined ? { semantic } : {}),
  });
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /scan this page/i }));
  await screen.findByText(/fields detected/i);
}

describe('the panel reports what the AI fallback cost', () => {
  it('says nothing at all when the fallback did not run', async () => {
    // The common case, and it must stay silent: a form the deterministic
    // engine understood should not grow a line of AI status telling the user
    // about a subsystem that did nothing.
    await scanWith(undefined);

    expect(screen.queryByText(/AI answers/i)).toBeNull();
    expect(screen.queryByText(/could not reach/i)).toBeNull();
  });

  it('says nothing when the fallback ran and worked', async () => {
    await scanWith({ modelCalls: 1 });
    expect(screen.queryByText(/AI answers/i)).toBeNull();
  });

  it('says the daily limit is reached, and when it resets', async () => {
    await scanWith({
      modelCalls: 1,
      error: { kind: 'rate_limited', retryAfterMs: 7_200_000 },
      quota: { used: 200, limit: 200, resetsInMs: 7_200_000 },
    });

    expect(screen.getByText(/today's AI answers/i)).toBeTruthy();
    // Stated in hours, because "7200000ms" is not a sentence.
    expect(screen.getByText(/about 2 hours/i)).toBeTruthy();
  });

  it('distinguishes being offline from having matched nothing', async () => {
    // The whole point of §5. Without this the two are the same blank field.
    await scanWith({
      modelCalls: 1,
      error: { kind: 'offline' },
    });

    expect(screen.getByText(/offline/i)).toBeTruthy();
  });

  it('never shows a raw error code or a millisecond count to the user', async () => {
    await scanWith({ modelCalls: 1, error: { kind: 'unavailable' } });

    const shown = document.body.textContent ?? '';
    // No SCREAMING_SNAKE code, no enum token, no raw duration. ("unavailable"
    // on its own is not checked: it is also an ordinary English word, and it
    // appears in the sentence this kind is supposed to produce.)
    expect(shown).not.toMatch(/[A-Z]{4,}_[A-Z_]+/);
    expect(shown).not.toContain('kind');
    expect(shown).not.toMatch(/\d{5,}/);
    // ...and it does say the useful thing, so the test is not vacuous.
    expect(shown).toContain('AI help is unavailable right now');
  });
});

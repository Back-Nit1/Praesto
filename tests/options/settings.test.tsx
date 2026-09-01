// @vitest-environment jsdom
/**
 * The settings screen.
 *
 * Two of the three panels here exist to answer questions the UI previously
 * could not answer at all: what did that form cost, and how do I make the
 * extension forget a wrong reading. The assertions are about saying so
 * accurately - a cache button that quietly cleared the user's own corrections
 * would be the worst bug this screen could have.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Settings, type SettingsDeps } from '@/entrypoints/options/Settings';
import { ScanCostLog } from '@backend/usage-log';
import { SemanticConceptCache } from '@semantic/cache';
import { InMemoryStore } from '@storage/key-value-store';

function deps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  const store = new InMemoryStore();
  return {
    cache: new SemanticConceptCache(store),
    scanCosts: new ScanCostLog(store),
    usage: async () => ({ used: 0, limit: 200, resetsInMs: 0 }),
    ...overrides,
  };
}

async function renderWith(settings: SettingsDeps, developerMode = false): Promise<() => boolean> {
  cleanup();
  let enabled = developerMode;
  render(
    <Settings
      developerMode={developerMode}
      onDeveloperMode={(next) => {
        enabled = next;
      }}
      deps={settings}
    />,
  );
  await screen.findByText(/AI usage/i);
  return () => enabled;
}

describe('Settings - AI usage', () => {
  it('answers what today has cost, which nothing in the UI could say before', async () => {
    await renderWith(deps({ usage: async () => ({ used: 12, limit: 200, resetsInMs: 3_600_000 }) }));

    await waitFor(() => expect(screen.getByText(/12 of 200 model calls used today/)).toBeTruthy());
    expect(screen.getByText(/resets in 1 hour/)).toBeTruthy();
  });

  it('lists what individual scans cost', async () => {
    const settings = deps();
    await settings.scanCosts.record({ at: Date.now(), modelCalls: 3 });

    await renderWith(settings);

    await waitFor(() => expect(screen.getByText('3 calls')).toBeTruthy());
  });

  it('says no scan has needed a model call rather than showing an empty list', async () => {
    await renderWith(deps());

    expect(screen.getByText(/No scan has needed a model call yet/i)).toBeTruthy();
  });
});

describe('Settings - remembered questions', () => {
  it('will not clear a cache that holds nothing', async () => {
    await renderWith(deps());

    const button = screen.getByRole('button', { name: /clear remembered questions/i });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('takes two clicks, and says what clearing costs', async () => {
    const settings = deps();
    const clear = vi.spyOn(settings.cache, 'clear');
    vi.spyOn(settings.cache, 'size').mockResolvedValue(4);

    await renderWith(settings);
    await waitFor(() => expect(screen.getByText(/4 questions/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /clear remembered questions/i }));
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /forget all of them/i }));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());

    // Not free, and the screen says so: the next application pays for these
    // questions again.
    await screen.findByText(/They will be asked again once/i);
  });

  it('says in the UI that it does not touch the user’s own corrections', async () => {
    // The two stores are easy to confuse and only one of them holds anything
    // the user said. A button that cleared learned rules would be the worst
    // bug this screen could have.
    await renderWith(deps());

    expect(screen.getByText(/not your corrections/i)).toBeTruthy();
  });
});

describe('Settings - developer mode', () => {
  it('is off unless the caller says otherwise', async () => {
    await renderWith(deps());

    const toggle = screen.getByRole('checkbox');
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('reports a change rather than keeping it to itself', async () => {
    const readEnabled = await renderWith(deps());

    fireEvent.click(screen.getByRole('checkbox'));

    expect(readEnabled()).toBe(true);
  });
});

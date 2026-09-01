/**
 * Settings, against a real in-memory store.
 *
 * The only setting so far gates a development surface, so the interesting
 * assertions are all about what happens when storage says something unexpected:
 * the answer has to be "off", every time.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';
import { SettingsRepository } from '@storage/settings';

describe('SettingsRepository', () => {
  it('defaults developer mode off on a fresh install', async () => {
    const result = await new SettingsRepository(new InMemoryStore()).get();

    expect(result.ok && result.value.developerMode).toBe(false);
  });

  it('does not write defaults, so a later change to one reaches existing users', async () => {
    const store = new InMemoryStore();
    await new SettingsRepository(store).get();

    const keys = await store.keys();
    expect(keys.ok && keys.value).not.toContain(STORAGE_KEYS.settings);
  });

  it('round-trips a change', async () => {
    const repository = new SettingsRepository(new InMemoryStore());
    await repository.setDeveloperMode(true);

    const result = await repository.get();
    expect(result.ok && result.value.developerMode).toBe(true);
  });

  it('falls back to off rather than throwing on a malformed stored value', async () => {
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.settings, { developerMode: 'yes please' });

    const result = await new SettingsRepository(store).get();
    expect(result.ok && result.value.developerMode).toBe(false);
  });

  it('preserves a setting it has never heard of', async () => {
    // A downgrade: storage written by a newer version, read and written by an
    // older one. It must not erase what it cannot name.
    const store = new InMemoryStore();
    await store.set(STORAGE_KEYS.settings, { developerMode: false, futureSetting: 42 });

    await new SettingsRepository(store).setDeveloperMode(true);

    const stored = await store.get<Record<string, unknown>>(STORAGE_KEYS.settings);
    expect(stored.ok && stored.value).toMatchObject({ developerMode: true, futureSetting: 42 });
  });
});

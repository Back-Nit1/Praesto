/**
 * ProfileRepository tests.
 *
 * The merge tests are the important ones. They encode the product's central
 * trust guarantee - a value the user personally verified is never overwritten
 * by a parser - as an executable rule rather than a comment.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@storage/key-value-store';
import { StoredProfileRepository } from '@profile/repository';
import { createEmptyProfile, resumeValue, userValue, type ProfileValue } from '@profile/schema';
import { STORAGE_KEYS } from '@storage/keys';

function makeRepository() {
  const store = new InMemoryStore();
  return { store, repository: new StoredProfileRepository(store) };
}

describe('StoredProfileRepository', () => {
  let store: InMemoryStore;
  let repository: StoredProfileRepository;

  beforeEach(() => {
    ({ store, repository } = makeRepository());
  });

  it('returns undefined rather than an empty profile before first run', async () => {
    const loaded = await repository.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toBeUndefined();
  });

  it('creates an empty profile on first use and persists it', async () => {
    const created = await repository.loadOrCreate();
    expect(created.ok).toBe(true);

    // Persistence, not just an in-memory object: a fresh repository over the
    // same store must see it, which is what surviving a browser restart means.
    const second = new StoredProfileRepository(store);
    const reloaded = await second.load();
    expect(reloaded.ok && reloaded.value?.id).toBe(created.ok ? created.value.id : undefined);
  });

  it('refuses to load a corrupted profile instead of silently repairing it', async () => {
    await store.set(STORAGE_KEYS.activeProfile, { schemaVersion: 1, nonsense: true });
    const loaded = await repository.load();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('refuses to save an invalid profile', async () => {
    const invalid = createEmptyProfile('p1');
    // An email that is not an email must not reach storage.
    invalid.contact.email = { value: 'not-an-email', evidence: [] };
    const saved = await repository.save(invalid);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  describe('mergeCandidates', () => {
    it('fills empty slots', async () => {
      await repository.loadOrCreate();
      const merged = await repository.mergeCandidates({
        'identity.legalFirstName': resumeValue('Nityanth', { confidence: 0.9 }),
      });

      expect(merged.ok).toBe(true);
      if (merged.ok) expect(merged.value.applied).toContain('identity.legalFirstName');

      const loaded = await repository.load();
      expect(loaded.ok && loaded.value?.identity.legalFirstName.value).toBe('Nityanth');
    });

    it('NEVER overwrites a user-verified value', async () => {
      await repository.update((profile) => ({
        ...profile,
        identity: { ...profile.identity, legalFirstName: userValue('Nityanth') },
      }));

      const merged = await repository.mergeCandidates({
        // A confident parser proposing something different. Confidence is
        // irrelevant: the user's own word outranks any extraction.
        'identity.legalFirstName': resumeValue('Nick', { confidence: 0.99 }),
      });

      expect(merged.ok).toBe(true);
      if (merged.ok) expect(merged.value.skippedVerified).toContain('identity.legalFirstName');

      const loaded = await repository.load();
      expect(loaded.ok && loaded.value?.identity.legalFirstName.value).toBe('Nityanth');
    });

    it('reports a conflict instead of overwriting an unverified disagreement', async () => {
      await repository.mergeCandidates({
        'contact.city': resumeValue('New Brunswick', { confidence: 0.7 }),
      });
      const merged = await repository.mergeCandidates({
        'contact.city': resumeValue('Piscataway', { confidence: 0.8 }),
      });

      expect(merged.ok).toBe(true);
      if (merged.ok) {
        expect(merged.value.conflicts.map((c) => c.path)).toContain('contact.city');
        expect(merged.value.applied).not.toContain('contact.city');
      }

      // The original value survives untouched until the user chooses.
      const loaded = await repository.load();
      expect(loaded.ok && loaded.value?.contact.city.value).toBe('New Brunswick');
    });

    it('accumulates evidence when the same value is extracted again', async () => {
      await repository.mergeCandidates({
        'contact.city': resumeValue('New Brunswick', { confidence: 0.7 }),
      });
      await repository.mergeCandidates({
        'contact.city': resumeValue('New Brunswick', { confidence: 0.8 }),
      });

      const loaded = await repository.load();
      expect(loaded.ok && loaded.value?.contact.city.evidence.length).toBe(2);
    });

    it('reports unknown paths rather than guessing a nearby field', async () => {
      const merged = await repository.mergeCandidates({
        // Plausible-looking but not in the vocabulary. Coercing it to
        // identity.legalFirstName would be exactly the wrong behaviour.
        'identity.firstName': resumeValue('Nityanth', { confidence: 0.9 }) as ProfileValue<unknown>,
      });
      expect(merged.ok).toBe(true);
      if (merged.ok) expect(merged.value.skippedUnknownPath).toContain('identity.firstName');
    });

    it('reports an out-of-range collection path rather than creating an entry', async () => {
      const merged = await repository.mergeCandidates({
        'education[0].institution': resumeValue('Rutgers', { confidence: 0.9 }),
      });
      // No education entries exist yet, so there is no slot. Inventing one would
      // be guessing at structure the parser did not report.
      expect(merged.ok).toBe(true);
      if (merged.ok) expect(merged.value.skippedUnknownPath).toContain('education[0].institution');
    });
  });

  describe('export / import', () => {
    it('round-trips a profile', async () => {
      await repository.update((profile) => ({
        ...profile,
        identity: { ...profile.identity, lastName: userValue('Maramreddy') },
      }));

      const exported = await repository.exportJson();
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;

      const fresh = makeRepository();
      const imported = await fresh.repository.importJson(exported.value);
      expect(imported.ok).toBe(true);
      if (imported.ok) expect(imported.value.identity.lastName.value).toBe('Maramreddy');
    });

    it('leaves the existing profile untouched when an import is invalid', async () => {
      await repository.update((profile) => ({
        ...profile,
        identity: { ...profile.identity, lastName: userValue('Maramreddy') },
      }));

      const imported = await repository.importJson('{"schemaVersion":1}');
      expect(imported.ok).toBe(false);

      const loaded = await repository.load();
      expect(loaded.ok && loaded.value?.identity.lastName.value).toBe('Maramreddy');
    });

    it('rejects malformed JSON without throwing', async () => {
      const imported = await repository.importJson('{not json');
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe('SCHEMA_VALIDATION_FAILED');
    });
  });
});

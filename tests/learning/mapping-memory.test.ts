/**
 * Learned mapping tests.
 *
 * The last describe block reproduces the demo target from `prompt.md` section
 * 31, steps 9-12, end to end:
 *
 *   > An intentionally ambiguous field is not blindly filled. The user assigns
 *   > it once. Reload another fixture containing the same semantic question with
 *   > different HTML. The extension remembers and maps it correctly.
 *
 * If that test passes, the fundamental product architecture is validated.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@storage/key-value-store';
import { LearnedMappingIndex, LearnedMappingStore, isRetired } from '@learning/mapping-memory';
import type { FingerprintQuery, LearnedMapping } from '@learning/types';
import { computeFingerprints } from '@form-engine/fingerprints/fingerprint';
import { mapField } from '@form-engine/mapper/mapper';
import { DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import { descriptor, resetDescriptorIds } from '../helpers/descriptors';

let store: InMemoryStore;
let learned: LearnedMappingStore;

beforeEach(() => {
  resetDescriptorIds();
  store = new InMemoryStore();
  learned = new LearnedMappingStore(store);
});

const query = (overrides: Partial<FingerprintQuery> = {}): FingerprintQuery => ({
  global: 'g1',
  ats: 'a1',
  company: 'c1',
  exact: 'e1',
  ...overrides,
});

const rule = (overrides: Partial<LearnedMapping> = {}): LearnedMapping => ({
  id: 'r1',
  scope: 'global',
  semanticFingerprint: 'g1',
  profilePath: 'contact.city',
  userConfirmed: true,
  successfulUses: 0,
  correctedUses: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('LearnedMappingIndex', () => {
  it('prefers a narrower scope over a broader one', () => {
    // "At THIS company this means X" is more specific information than "this
    // usually means X", and specific must not be overridden by general.
    const index = new LearnedMappingIndex([
      rule({ id: 'broad', scope: 'global', semanticFingerprint: 'g1', profilePath: 'contact.city' }),
      rule({
        id: 'narrow',
        scope: 'company',
        semanticFingerprint: 'c1',
        profilePath: 'applicationPreferences.preferredLocations',
      }),
    ]);

    expect(index.find(query())?.id).toBe('narrow');
  });

  it('walks the full precedence order', () => {
    const scopes = [
      { scope: 'exact_field' as const, fingerprint: 'e1' },
      { scope: 'company' as const, fingerprint: 'c1' },
      { scope: 'ats' as const, fingerprint: 'a1' },
      { scope: 'global' as const, fingerprint: 'g1' },
    ];

    // Removing the narrowest each time should fall through to the next.
    for (let i = 0; i < scopes.length; i++) {
      const remaining = scopes.slice(i);
      const index = new LearnedMappingIndex(
        remaining.map((entry, n) =>
          rule({ id: `r${n}`, scope: entry.scope, semanticFingerprint: entry.fingerprint }),
        ),
      );
      expect(index.find(query())?.scope).toBe(remaining[0]?.scope);
    }
  });

  it('returns null when nothing matches', () => {
    expect(new LearnedMappingIndex([]).find(query())).toBeNull();
  });

  it('ignores a retired rule entirely', () => {
    // Spec section 19: a bad learned rule must not permanently trap the system.
    const index = new LearnedMappingIndex([rule({ correctedUses: 3 })]);
    expect(index.find(query())).toBeNull();
  });
});

describe('LearnedMappingStore', () => {
  it('records a correction as user-confirmed', async () => {
    const result = await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'applicationPreferences.preferredLocations',
      hostname: 'boards.example.com',
      ats: 'unknown',
      normalizedLabel: 'preferred hub',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // userConfirmed is what lets a correction outrank the alias table.
    expect(result.value.userConfirmed).toBe(true);
    expect(result.value.profilePath).toBe('applicationPreferences.preferredLocations');
  });

  it('keys the rule on the fingerprint for the chosen scope', async () => {
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'company',
      profilePath: 'contact.city',
      hostname: 'acme.example',
      ats: 'greenhouse',
    });

    const all = await learned.all();
    expect(all.ok && all.value[0]?.semanticFingerprint).toBe('c1');
    expect(all.ok && all.value[0]?.hostname).toBe('acme.example');
  });

  it('updates an existing rule rather than stacking duplicates', async () => {
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.city',
      hostname: 'a.example',
      ats: 'unknown',
    });
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.state',
      hostname: 'a.example',
      ats: 'unknown',
    });

    const all = await learned.all();
    // Two rules for one fingerprint would disagree with each other forever.
    expect(all.ok && all.value).toHaveLength(1);
    expect(all.ok && all.value[0]?.profilePath).toBe('contact.state');
  });

  it('resets the track record when a correction changes the target', async () => {
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.city',
      hostname: 'a.example',
      ats: 'unknown',
    });
    await learned.recordSuccess(query());
    await learned.recordMiss(query());

    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.state',
      hostname: 'a.example',
      ats: 'unknown',
    });

    const all = await learned.all();
    // The old counts described the OLD target. Carrying a correction count over
    // would penalise a rule the user has just personally endorsed.
    expect(all.ok && all.value[0]).toMatchObject({ successfulUses: 0, correctedUses: 0 });
  });

  it('keeps the track record when a correction re-confirms the same target', async () => {
    const input = {
      fingerprints: query(),
      scope: 'global' as const,
      profilePath: 'contact.city',
      hostname: 'a.example',
      ats: 'unknown' as const,
    };
    await learned.recordCorrection(input);
    await learned.recordSuccess(query());
    await learned.recordCorrection(input);

    const all = await learned.all();
    expect(all.ok && all.value[0]?.successfulUses).toBe(1);
  });

  it('counts successes and misses against the rule that actually matched', async () => {
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'company',
      profilePath: 'contact.city',
      hostname: 'a.example',
      ats: 'unknown',
    });
    // A broader rule also exists; the feedback must land on the narrow one that
    // the lookup would have used.
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.state',
      hostname: 'a.example',
      ats: 'unknown',
    });

    await learned.recordSuccess(query());

    const all = await learned.all();
    if (!all.ok) return;
    const company = all.value.find((r) => r.scope === 'company');
    const global = all.value.find((r) => r.scope === 'global');
    expect(company?.successfulUses).toBe(1);
    expect(global?.successfulUses).toBe(0);
  });

  it('retires a rule the user has corrected too many times', async () => {
    await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.city',
      hostname: 'a.example',
      ats: 'unknown',
    });
    for (let i = 0; i < 3; i++) await learned.recordMiss(query());

    const all = await learned.all();
    if (!all.ok) return;
    const retired = all.value[0];
    expect(retired).toBeDefined();
    if (retired === undefined) return;

    expect(isRetired(retired)).toBe(true);
    // Retired means "no longer used", not "deleted" - the settings screen shows
    // it so the user can see the system listened.
    expect((await learned.index()).find(query())).toBeNull();
  });

  it('lets the user delete a rule outright', async () => {
    const created = await learned.recordCorrection({
      fingerprints: query(),
      scope: 'global',
      profilePath: 'contact.city',
      hostname: 'a.example',
      ats: 'unknown',
    });
    if (!created.ok) return;

    await learned.remove(created.value.id);
    const all = await learned.all();
    expect(all.ok && all.value).toHaveLength(0);
  });

  it('degrades to generic behaviour rather than failing when storage is broken', async () => {
    await store.set('aa:learning:mappings', 'not an array');
    // Losing learned rules costs us a feature. Failing the resolve batch would
    // cost the user the whole page.
    const index = await learned.index();
    expect(index.find(query())).toBeNull();
  });
});

describe('the demo target: correct once, then recognise elsewhere', () => {
  /**
   * Two descriptors for the SAME question with completely different markup,
   * on different sites, rendered by different platforms - the shape of the real
   * scenario in spec section 31.
   */
  const greenhouseField = descriptor({
    label: 'Preferred hub',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    name: 'job_application[answers_attributes][3][text_value]',
    id: 'job_application_answers_attributes_3_text_value',
  });

  const leverField = descriptor({
    label: 'Preferred hub',
    hostname: 'jobs.lever.co',
    ats: 'lever',
    name: 'cards[7f3a][field2]',
    id: 'cards-7f3a-field2',
  });

  it('starts by refusing to map an unfamiliar question', async () => {
    const index = await learned.index();
    expect(mapField(greenhouseField, { learned: index }).profilePath).toBeNull();
    expect(mapField(leverField, { learned: index }).profilePath).toBeNull();
  });

  it('maps the same question on a different site after ONE correction', async () => {
    // The user corrects it once, on the Greenhouse form.
    await learned.recordCorrection({
      fingerprints: computeFingerprints(greenhouseField),
      scope: 'global',
      profilePath: 'applicationPreferences.preferredLocations',
      hostname: greenhouseField.hostname,
      ats: greenhouseField.ats,
      normalizedLabel: 'preferred hub',
    });

    const index = await learned.index();

    // The SAME question, on Lever, with entirely different HTML, now maps.
    const result = mapField(leverField, { learned: index });
    expect(result.profilePath).toBe('applicationPreferences.preferredLocations');
    expect(result.source).toBe('memory');
    expect(result.knowledgeState).toBe('previously_seen');
    expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_POLICY.autofillThreshold);
  });

  it('confines a company-scoped correction to that company', async () => {
    await learned.recordCorrection({
      fingerprints: computeFingerprints(greenhouseField),
      scope: 'company',
      profilePath: 'applicationPreferences.preferredLocations',
      hostname: greenhouseField.hostname,
      ats: greenhouseField.ats,
    });

    const index = await learned.index();
    // The user said "only here". One employer's jargon must not start
    // overriding sensible defaults everywhere else.
    expect(mapField(greenhouseField, { learned: index }).profilePath).toBe(
      'applicationPreferences.preferredLocations',
    );
    expect(mapField(leverField, { learned: index }).profilePath).toBeNull();
  });

  it('lets the user teach it to leave a field alone', async () => {
    await learned.recordCorrection({
      fingerprints: computeFingerprints(greenhouseField),
      scope: 'global',
      // "This means nothing" is a real correction, and a useful one.
      profilePath: null,
      hostname: greenhouseField.hostname,
      ats: greenhouseField.ats,
    });

    const index = await learned.index();
    const stored = index.find(computeFingerprints(greenhouseField));
    expect(stored?.profilePath).toBe('');
  });
});

describe('a "leave this alone" rule', () => {
  it('suppresses a mapping the alias table would otherwise make', async () => {
    // "Email" matches the alias registry at high confidence. The user has
    // nonetheless said this particular question means nothing - perhaps it asks
    // for a REFERENCE's email. Their instruction has to win outright, not
    // merely compete, or we keep filling the field they told us to stop
    // touching.
    const field = descriptor({ label: 'Email' });
    expect(mapField(field).profilePath).toBe('contact.email');

    await learned.recordCorrection({
      fingerprints: computeFingerprints(field),
      scope: 'global',
      profilePath: null,
      hostname: field.hostname,
      ats: field.ats,
    });

    const result = mapField(field, { learned: await learned.index() });
    expect(result.profilePath).toBeNull();
    expect(result.knowledgeState).toBe('unknown');
    expect(result.reasons[0]?.signal).toBe('learned_mapping');
  });
});

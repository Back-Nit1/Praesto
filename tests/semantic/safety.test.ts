/**
 * The semantic route, end to end, through the REAL policy.
 *
 * Every other file in `tests/semantic/` tests one module. This one tests the
 * claim the whole feature rests on:
 *
 *     Widening the input to `decideFill` does not widen what `decideFill`
 *     permits.
 *
 * So nothing here is faked except the port. The queue, the concept stage, the
 * cache, `resolveValue` and `decideFill` are all the shipping code, wired the
 * way `background.ts` wires them - because a test that reimplemented the
 * sequencing would prove only that the test agrees with itself.
 */
import { describe, expect, it } from 'vitest';
import { resolveConcepts } from '@semantic/concept';
import { chooseOption } from '@semantic/option-match';
import { SemanticConceptCache } from '@semantic/cache';
import { collectRefusals } from '@semantic/queue';
import { unknownMapping } from '@form-engine/mapper/types';
import { resolveValue } from '@form-engine/resolver/resolver';
import { decideFill, DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import { createEmptyProfile, userValue, resumeValue, type ApplicantProfile } from '@profile/schema';
import { InMemoryStore } from '@storage/key-value-store';
import { AppError } from '@shared/errors';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { FillDecision } from '@form-engine/confidence/policy';
import { descriptor } from '../helpers/descriptors';
import { FakeSemanticPort } from './fakes';

/** A profile with every value the tests below reach for, all user-verified. */
function fullProfile(): ApplicantProfile {
  const profile = createEmptyProfile('p1');
  profile.identity.legalFirstName = userValue('Alex');
  profile.contact.city = userValue('Trenton');
  profile.applicationPreferences.authorizedToWorkUS = userValue(true);
  profile.applicationPreferences.requiresSponsorshipNow = userValue(false);
  profile.applicationPreferences.desiredSalary = userValue(120000);
  profile.demographics.gender = userValue('Prefer not to say');
  profile.demographics.veteranStatus = userValue('I am not a veteran');
  profile.education.push({
    id: 'e1',
    institution: userValue('Rutgers University'),
    fieldOfStudy: userValue('Computer Engineering'),
  } as ApplicantProfile['education'][number]);
  return profile;
}

/**
 * The pipeline, exactly as `background.ts` sequences it: an unmapped field goes
 * through the queue, the semantic stage, the REAL resolver and the REAL policy.
 */
async function decideViaSemanticRoute(
  field: FieldDescriptor,
  answer: string | null,
  profile: ApplicantProfile = fullProfile(),
): Promise<{ decision: FillDecision; path: string | null; value?: string | boolean }> {
  const port = new FakeSemanticPort({ concepts: { [field.localId]: answer } });
  const refusals = collectRefusals([
    { descriptor: field, mapping: unknownMapping(field.localId) },
  ]);

  const { resolutions } = await resolveConcepts({
    fields: refusals,
    port,
    cache: new SemanticConceptCache(new InMemoryStore()),
  });

  const concept = resolutions[0];
  if (concept === undefined) return { decision: 'skip', path: null };

  const resolution = resolveValue(profile, concept.profilePath, field);
  if (!resolution.ok) {
    return {
      decision: decideFill({
        mappingConfidence: concept.confidence,
        valueConfidence: 0,
        valueVerifiedByUser: false,
        profilePath: concept.profilePath,
        valueMissing: true,
        controlHasValue: false,
      }),
      path: concept.profilePath,
    };
  }

  return {
    decision: decideFill({
      mappingConfidence: concept.confidence,
      valueConfidence: resolution.resolved.confidence,
      valueVerifiedByUser: resolution.resolved.verifiedByUser,
      profilePath: concept.profilePath,
      valueMissing: false,
      controlHasValue: (field.currentValue ?? '').trim().length > 0,
    }),
    path: concept.profilePath,
    value: resolution.resolved.value,
  };
}

const yesNo = (label: string): FieldDescriptor =>
  descriptor({
    label,
    kind: 'select',
    options: [
      { value: 'y', label: 'Yes' },
      { value: 'n', label: 'No' },
    ],
  });

describe('the sensitive-field gate still holds on the semantic route', () => {
  const sensitive: Array<[string, FieldDescriptor, string]> = [
    [
      'work authorization',
      yesNo('Are you presently able to take up employment in this jurisdiction?'),
      'applicationPreferences.authorizedToWorkUS',
    ],
    [
      'sponsorship',
      yesNo('Would you need us to support an immigration petition on your behalf?'),
      'applicationPreferences.requiresSponsorshipNow',
    ],
    [
      'gender',
      descriptor({
        label: 'How do you describe yourself?',
        kind: 'select',
        options: [
          { value: '1', label: 'Prefer not to say' },
          { value: '2', label: 'Man' },
          { value: '3', label: 'Woman' },
        ],
      }),
      'demographics.gender',
    ],
    [
      'veteran status',
      descriptor({
        label: 'Have you served in the armed forces?',
        kind: 'select',
        options: [
          { value: '1', label: 'I am not a veteran' },
          { value: '2', label: 'I am a veteran' },
        ],
      }),
      'demographics.veteranStatus',
    ],
  ];

  for (const [name, field, path] of sensitive) {
    it(`still requires a click for ${name}, even with a verified answer stored`, async () => {
      const outcome = await decideViaSemanticRoute(field, path);

      expect(outcome.path).toBe(path);
      // The value is available, user-verified, and correctly matched, and it is
      // STILL not filled.
      //
      // WHICH GUARD IS DOING THE WORK HERE, because it is not the obvious one.
      // `requiresVerifiedValue` deliberately permits a sensitive answer the
      // user typed themselves to autofill - that is the whole point of storing
      // one. So on this route the binding constraint is the CONFIDENCE CAP:
      // `sourceScores.semantic` sits below `autofillThreshold`, so a concept
      // this route proposed cannot reach a fill no matter how good the value
      // behind it is. Raising that number turns all four of these into
      // autofills, which is why the test below pins it directly.
      expect(outcome.decision).toBe('suggest');
      expect(outcome.decision).not.toBe('autofill');
    });
  }

  it('still requires a click for salary, which is sensitive by confidence rather than by path', async () => {
    // Salary is deliberately NOT in SENSITIVE_PATHS - it is not a spec 21.3
    // category - so the confidence cap is the only thing gating it, as it is
    // for the four above. Asserted separately because the brief names salary
    // alongside the legal questions.
    const field = descriptor({
      label: 'What compensation are you targeting?',
      kind: 'text',
    });
    const outcome = await decideViaSemanticRoute(field, 'applicationPreferences.desiredSalary');

    expect(outcome.path).toBe('applicationPreferences.desiredSalary');
    expect(outcome.decision).toBe('suggest');
  });

  it('cannot autofill even an ordinary field on first sight', async () => {
    // The general form of the rule above. A question we have never seen is a
    // suggestion, and becomes a fill only after the user accepts it and the
    // existing correction path records a learned mapping.
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const outcome = await decideViaSemanticRoute(field, 'contact.city');

    expect(outcome.path).toBe('contact.city');
    expect(outcome.value).toBe('Trenton');
    expect(outcome.decision).toBe('suggest');
  });

  it('scores every semantic concept below the autofill threshold, by construction', () => {
    // The guard the seven tests above actually depend on. Kept as its own
    // assertion so a change to this number fails with a message that says what
    // was changed, rather than as seven confusing failures elsewhere.
    expect(DEFAULT_CONFIDENCE_POLICY.sourceScores.semantic).toBeLessThan(
      DEFAULT_CONFIDENCE_POLICY.autofillThreshold,
    );
    expect(DEFAULT_CONFIDENCE_POLICY.sourceScores.semantic).toBeGreaterThanOrEqual(
      DEFAULT_CONFIDENCE_POLICY.suggestThreshold,
    );
  });

  it('still refuses when the stored value was never verified by the user', async () => {
    const profile = fullProfile();
    profile.applicationPreferences.authorizedToWorkUS = resumeValue(true, { confidence: 0.99 });

    const outcome = await decideViaSemanticRoute(
      yesNo('Are you presently able to take up employment in this jurisdiction?'),
      'applicationPreferences.authorizedToWorkUS',
      profile,
    );
    expect(outcome.decision).toBe('suggest');
  });
});

describe('with the network unavailable, behaviour is exactly what it is today', () => {
  const errors = [
    new AppError('BACKEND_UNREACHABLE', 'offline'),
    new AppError('RATE_LIMITED', 'out of quota', { context: { retryAfterMs: 60_000 } }),
    new AppError('BACKEND_REJECTED', 'unexpected shape'),
    new AppError('BACKEND_NOT_CONFIGURED', 'no origin compiled in'),
    new AppError('BACKEND_UNAUTHENTICATED', 'this install is not registered'),
  ];

  for (const error of errors) {
    it(`leaves the field untouched on ${error.code}`, async () => {
      const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
      const port = new FakeSemanticPort({ conceptError: error });

      const outcome = await resolveConcepts({
        fields: collectRefusals([{ descriptor: field, mapping: unknownMapping(field.localId) }]),
        port,
        cache: new SemanticConceptCache(new InMemoryStore()),
      });

      // No concept, therefore no path, therefore `decideFill` returns 'skip' -
      // which is a blank field and an honest panel entry. Today's behaviour.
      expect(outcome.resolutions).toEqual([]);
      expect(
        decideFill({
          mappingConfidence: 0,
          valueConfidence: 0,
          valueVerifiedByUser: false,
          profilePath: null,
          valueMissing: true,
          controlHasValue: false,
        }),
      ).toBe('skip');
    });
  }

  it('keeps a stage-1 concept when stage 2 fails, because it is valuable on its own', async () => {
    // §5 of the brief. The concept is what the cache is for and what the next
    // application reuses; discarding it because a second, separate call failed
    // would make the user pay for it twice.
    const field = descriptor({
      label: 'Which campus did you attend?',
      kind: 'select',
      options: [
        { value: '1', label: 'Rutgers University - New Brunswick' },
        { value: '2', label: 'Rutgers University - Newark' },
      ],
    });
    const cache = new SemanticConceptCache(new InMemoryStore());

    const stage1 = await resolveConcepts({
      fields: collectRefusals([{ descriptor: field, mapping: unknownMapping(field.localId) }]),
      port: new FakeSemanticPort({ concepts: { [field.localId]: 'education[0].institution' } }),
      cache,
    });
    expect(stage1.resolutions).toHaveLength(1);

    const stage2 = await chooseOption({
      fieldId: field.localId,
      value: 'Rutgers University',
      options: field.options ?? [],
      port: new FakeSemanticPort({ optionError: new AppError('RATE_LIMITED', 'no quota') }),
    });

    // The field is not filled...
    expect(stage2.option).toBeNull();
    // ...and the concept survived, so the next application starts from a hit.
    expect(await cache.size()).toBe(1);
  });
});

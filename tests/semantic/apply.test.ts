/**
 * The semantic pass as one function, over the outcomes of a whole scan.
 *
 * WHY THIS MODULE EXISTS AT ALL, since the sequencing it does is four calls
 * long: it used to live in `background.ts`, where nothing could test it, and
 * the fixture test had its own copy of the same four calls. Two
 * implementations of "what order do these run in" is one more than the number
 * that can be right, and the copy in the test would have gone on passing while
 * the one that ships drifted.
 *
 * So the entrypoint now calls this, the fixture test calls this, and the
 * ordering is asserted once, here.
 */
import { describe, expect, it } from 'vitest';
import { applySemanticFallback, summariseRun } from '@semantic/apply';
import { SemanticConceptCache } from '@semantic/cache';
import { unknownMapping, type FieldMappingResult } from '@form-engine/mapper/types';
import { computeFingerprints } from '@form-engine/fingerprints/fingerprint';
import { DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import { createEmptyProfile, userValue, type ApplicantProfile } from '@profile/schema';
import { InMemoryStore } from '@storage/key-value-store';
import { AppError } from '@shared/errors';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { FieldOutcome } from '@semantic/queue';
import { descriptor } from '../helpers/descriptors';
import { FakeSemanticPort, ForbiddenSemanticPort } from './fakes';

function applicant(): ApplicantProfile {
  const profile = createEmptyProfile('p1');
  profile.contact.city = userValue('Trenton');
  profile.applicationPreferences.authorizedToWorkUS = userValue(true);
  profile.education.push({
    id: 'e1',
    institution: userValue('Rutgers University'),
    fieldOfStudy: userValue('Computer Engineering'),
  } as ApplicantProfile['education'][number]);
  return profile;
}

const newCache = () => new SemanticConceptCache(new InMemoryStore());

/** A field the mapper refused. */
const refused = (field: FieldDescriptor): FieldOutcome => ({
  descriptor: field,
  mapping: unknownMapping(field.localId),
});

/** A field the mapper named and the resolver could not match to an option. */
function unmatched(field: FieldDescriptor, path: string): FieldOutcome {
  const mapping: FieldMappingResult = {
    fieldId: field.localId,
    profilePath: path as FieldMappingResult['profilePath'],
    confidence: 0.96,
    knowledgeState: 'known',
    reasons: [{ signal: 'label_exact' }],
    source: 'alias',
  };
  return { descriptor: field, mapping, resolution: { ok: false, reason: 'no_matching_option' } };
}

const run = (outcomes: FieldOutcome[], port: FakeSemanticPort | ForbiddenSemanticPort, cache = newCache()) =>
  applySemanticFallback({ profile: applicant(), outcomes, port, cache });

describe('applySemanticFallback - what it changes', () => {
  it('turns a refused field into a suggestion when stage 1 names its concept', async () => {
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const port = new FakeSemanticPort({ concepts: { [field.localId]: 'contact.city' } });

    const outcome = await run([refused(field)], port);

    expect(outcome.updates).toHaveLength(1);
    expect(outcome.updates[0]).toMatchObject({
      localId: field.localId,
      action: 'suggest',
      profilePath: 'contact.city',
      value: 'Trenton',
      origin: 'stage1',
    });
  });

  it('marks a cache hit as previously_seen, which is the state the spec defines for it', async () => {
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const cache = newCache();
    await cache.record(computeFingerprints(field), 'contact.city');

    const outcome = await run([refused(field)], new ForbiddenSemanticPort(), cache);

    expect(outcome.updates[0]?.knowledgeState).toBe('previously_seen');
    expect(outcome.modelCalls).toBe(0);
  });

  it('resolves a stage-2 option match and reports it as such', async () => {
    const field = descriptor({
      label: 'Field of study',
      kind: 'select',
      options: [
        { value: '1', label: 'Engineering, Civil' },
        { value: '2', label: 'Engineering, Computer' },
      ],
    });

    const outcome = await run(
      [unmatched(field, 'education[0].fieldOfStudy')],
      new FakeSemanticPort(),
    );

    expect(outcome.updates[0]).toMatchObject({
      action: 'suggest',
      profilePath: 'education[0].fieldOfStudy',
      optionValue: '2',
      origin: 'stage2',
    });
  });
});

describe('applySemanticFallback - what it refuses to change', () => {
  it('produces no update at all for an empty queue, and touches nothing', async () => {
    const resolvedField = descriptor({ label: 'Email', kind: 'email' });
    const port = new FakeSemanticPort();

    const outcome = await applySemanticFallback({
      profile: applicant(),
      outcomes: [
        {
          descriptor: resolvedField,
          mapping: {
            fieldId: resolvedField.localId,
            profilePath: 'contact.email',
            confidence: 0.99,
            knowledgeState: 'known',
            reasons: [],
            source: 'html',
          },
          resolution: {
            ok: true,
            resolved: { value: 'a@b.com', confidence: 1, verifiedByUser: true, formatting: 'string:raw' },
          },
        },
      ],
      port,
      cache: newCache(),
    });

    expect(outcome.updates).toEqual([]);
    expect(outcome.modelCalls).toBe(0);
    expect(port.callCount).toBe(0);
  });

  it('produces no update when we understand the question but have no answer', async () => {
    // A profile gap is still a profile gap. The existing skip explains it
    // better than anything this pass could say.
    const field = descriptor({ label: 'What is your GitHub?', kind: 'url' });
    const port = new FakeSemanticPort({ concepts: { [field.localId]: 'links.github' } });

    const outcome = await run([refused(field)], port);
    expect(outcome.updates).toEqual([]);
  });

  it('never produces a fill for a sensitive path, only a suggestion', async () => {
    const field = descriptor({
      label: 'Are you presently able to take up employment here?',
      kind: 'select',
      options: [
        { value: 'y', label: 'Yes' },
        { value: 'n', label: 'No' },
      ],
    });
    const port = new FakeSemanticPort({
      concepts: { [field.localId]: 'applicationPreferences.authorizedToWorkUS' },
    });

    const outcome = await run([refused(field)], port);

    expect(outcome.updates[0]?.action).toBe('suggest');
    expect(outcome.updates.every((update) => update.action !== 'fill')).toBe(true);
  });

  it('produces no update when the port fails, whatever the failure was', async () => {
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });

    for (const code of [
      'BACKEND_UNREACHABLE',
      'RATE_LIMITED',
      'BACKEND_REJECTED',
      'BACKEND_UNAUTHENTICATED',
    ] as const) {
      const outcome = await run(
        [refused(field)],
        new FakeSemanticPort({ conceptError: new AppError(code, 'nope') }),
      );
      expect(outcome.updates).toEqual([]);
    }
  });

  it('survives a port that throws, rather than taking the whole scan down with it', async () => {
    // Every module below returns a Result, so this is unreachable by design -
    // which is exactly why it is worth a test. A semantic pass that broke a
    // scan would be far worse than one that did nothing.
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });

    const outcome = await run([refused(field)], new ForbiddenSemanticPort());

    expect(outcome.updates).toEqual([]);
    expect(outcome.error).toBeDefined();
  });
});

describe('applySemanticFallback - what it reports back', () => {
  it('reports the calls it made, so "the second application is free" is observable', async () => {
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const cache = newCache();

    const first = await run([refused(field)], new FakeSemanticPort({ concepts: { [field.localId]: 'contact.city' } }), cache);
    expect(first.modelCalls).toBe(1);

    const second = await run([refused(field)], new FakeSemanticPort(), cache);
    expect(second.modelCalls).toBe(0);
  });

  it('surfaces the failure rather than swallowing it', async () => {
    // §5 of the brief is explicit: a rate limit carries `retryAfterMs` and the
    // panel has to be able to say what is left. A pass that returned only
    // "nothing changed" would make "you are out of AI answers until tomorrow"
    // indistinguishable from "nothing matched".
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const port = new FakeSemanticPort({
      conceptError: new AppError('RATE_LIMITED', "That is today's limit", {
        context: { retryAfterMs: 3_600_000 },
      }),
    });

    const outcome = await run([refused(field)], port);

    expect(outcome.error?.code).toBe('RATE_LIMITED');
    expect(outcome.error?.context).toMatchObject({ retryAfterMs: 3_600_000 });
  });

  it('keeps a stage-1 concept when stage 2 fails', async () => {
    const unmapped = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const options = descriptor({
      label: 'Field of study',
      kind: 'select',
      options: [
        { value: '1', label: 'Rutgers University - New Brunswick' },
        { value: '2', label: 'Rutgers University - Newark' },
      ],
    });
    const port = new FakeSemanticPort({
      concepts: { [unmapped.localId]: 'contact.city' },
      optionError: new AppError('RATE_LIMITED', 'no quota'),
    });

    const outcome = await run(
      [refused(unmapped), unmatched(options, 'education[0].institution')],
      port,
    );

    // The stage-1 answer survives the stage-2 failure.
    expect(outcome.updates.map((update) => update.profilePath)).toEqual(['contact.city']);
    expect(outcome.error?.code).toBe('RATE_LIMITED');
  });

  it('never proposes a mapping at or above the autofill threshold', async () => {
    const field = descriptor({ label: 'Which town do you live in?', kind: 'text' });
    const port = new FakeSemanticPort({ concepts: { [field.localId]: 'contact.city' } });

    const outcome = await run([refused(field)], port);

    expect(outcome.updates[0]?.mappingConfidence).toBeLessThan(
      DEFAULT_CONFIDENCE_POLICY.autofillThreshold,
    );
  });
});

describe('summariseRun - what the panel is told', () => {
  it('reports a clean run with no error and no quota fuss', () => {
    expect(summariseRun({ updates: [], modelCalls: 0 })).toEqual({ modelCalls: 0 });
  });

  it('carries retryAfterMs out of a rate limit, because it is the actionable part', () => {
    // "You are out of AI answers until tomorrow" is a sentence the user can do
    // something about. "Nothing matched" is not, and they are the same event
    // without this.
    const summary = summariseRun({
      updates: [],
      modelCalls: 1,
      error: new AppError('RATE_LIMITED', "That is today's limit for AI answers", {
        context: { retryAfterMs: 3_600_000 },
      }),
    });

    expect(summary).toEqual({
      modelCalls: 1,
      error: { kind: 'rate_limited', retryAfterMs: 3_600_000 },
    });
  });

  it('includes the remaining quota when the caller could read it', () => {
    const summary = summariseRun(
      { updates: [], modelCalls: 2 },
      { used: 42, limit: 200, resetsInMs: 7_200_000 },
    );

    expect(summary.quota).toEqual({ used: 42, limit: 200, resetsInMs: 7_200_000 });
  });

  it('reports being offline as its own kind, distinct from a rate limit', () => {
    const summary = summariseRun({
      updates: [],
      modelCalls: 1,
      error: new AppError('BACKEND_UNREACHABLE', 'Could not reach the service'),
    });

    expect(summary.error).toEqual({ kind: 'offline' });
  });

  it('collapses every other failure into one situation the user can understand', () => {
    // A misconfigured origin, an unregistered install and a malformed reply are
    // three different bugs for us and exactly one situation for the applicant.
    for (const code of [
      'BACKEND_REJECTED',
      'BACKEND_UNAUTHENTICATED',
      'BACKEND_NOT_CONFIGURED',
      'RESPONSE_TOO_LARGE',
    ] as const) {
      const summary = summariseRun({
        updates: [],
        modelCalls: 1,
        error: new AppError(code, 'internal detail'),
      });
      expect(summary.error).toEqual({ kind: 'unavailable' });
    }
  });

  it('never lets a raw error code or message reach the panel', () => {
    const summary = summariseRun({
      updates: [],
      modelCalls: 1,
      error: new AppError('BACKEND_REJECTED', 'The service sent an unexpected shape'),
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('BACKEND_REJECTED');
    expect(serialized).not.toContain('unexpected shape');
  });

  it('never carries the applicant\'s own words into the summary', () => {
    // The summary crosses to the side panel and into a log line. An error
    // context can hold a field label or a filled value, so only the two keys
    // that are known-safe are copied out - never the whole bag.
    const summary = summariseRun({
      updates: [],
      modelCalls: 1,
      error: new AppError('BACKEND_REJECTED', 'The service sent an unexpected shape', {
        context: { retryAfterMs: 500, label: 'Your home address', value: '12 Elm Street' },
      }),
    });

    expect(JSON.stringify(summary)).not.toContain('Elm Street');
    expect(JSON.stringify(summary)).not.toContain('home address');
    // Not even the retryAfterMs, which is only meaningful on a rate limit.
    expect(JSON.stringify(summary)).not.toContain('500');
  });
});

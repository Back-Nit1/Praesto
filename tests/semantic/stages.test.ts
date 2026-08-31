/**
 * Stage 1 and stage 2 tests, entirely against fakes.
 *
 * Nothing here touches the network, and that is not an incidental property of
 * the tests - it is the design of `port.ts` being exercised. The assertions that
 * matter most are the counting ones (how many calls were made) and the
 * refusing ones (what a bad answer is allowed to do), because those are the two
 * promises the brief makes that no type can enforce on its own.
 */
import { describe, expect, it } from 'vitest';
import { resolveConcepts } from '@semantic/concept';
import { chooseOption, matchOption } from '@semantic/option-match';
import { SemanticConceptCache } from '@semantic/cache';
import { collectRefusals } from '@semantic/queue';
import { unknownMapping } from '@form-engine/mapper/types';
import { computeFingerprints } from '@form-engine/fingerprints/fingerprint';
import { DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import { InMemoryStore } from '@storage/key-value-store';
import { AppError } from '@shared/errors';
import type { FieldDescriptor, FieldOption } from '@form-engine/descriptor/types';
import { descriptor } from '../helpers/descriptors';
import { FakeSemanticPort, ForbiddenSemanticPort } from './fakes';

/** A field the cascade would refuse: a novel question with novel options. */
function novel(label: string, options: string[] = ['Yes', 'No']): FieldDescriptor {
  return descriptor({
    label,
    kind: 'select',
    options: options.map((text, index) => ({ value: `v${index}`, label: text })),
  });
}

/** Push descriptors through the real queue, as the pipeline would. */
const queueOf = (...fields: FieldDescriptor[]) =>
  collectRefusals(fields.map((field) => ({ descriptor: field, mapping: unknownMapping(field.localId) })));

const newCache = () => new SemanticConceptCache(new InMemoryStore());

const opts = (...labels: string[]): FieldOption[] =>
  labels.map((label, index) => ({ value: `v${index}`, label }));

describe('stage 1 - identifying a concept', () => {
  it('batches every unmapped field into EXACTLY ONE call', async () => {
    const fields = [
      novel('Which campus did you attend?'),
      novel('What did you major in?'),
      novel('Where are you based?'),
      novel('How many years have you been writing software?'),
      novel('What is your highest degree?'),
      novel('When can you start?'),
    ];
    const port = new FakeSemanticPort();

    await resolveConcepts({ fields: queueOf(...fields), port, cache: newCache() });

    expect(port.conceptCalls).toHaveLength(1);
    expect(port.conceptCalls[0]).toHaveLength(6);
  });

  it('accepts an answer naming a real profile path', async () => {
    const field = novel('Which campus did you attend?');
    const port = new FakeSemanticPort({
      concepts: { [field.localId]: 'education[0].institution' },
    });

    const outcome = await resolveConcepts({ fields: queueOf(field), port, cache: newCache() });

    expect(outcome.resolutions).toHaveLength(1);
    expect(outcome.resolutions[0]?.profilePath).toBe('education[0].institution');
    expect(outcome.resolutions[0]?.origin).toBe('model');
  });

  it('produces NO fill for an answer naming a path we do not have', async () => {
    // A model naming a path we never defined is a refusal, not a fill. Without
    // this check the string would travel to `resolveValue`, come back
    // `unknown_path`, and the only evidence would be a blank field.
    const field = novel('What is your blood type?');
    const port = new FakeSemanticPort({ concepts: { [field.localId]: 'contact.bloodType' } });

    const outcome = await resolveConcepts({ fields: queueOf(field), port, cache: newCache() });

    expect(outcome.resolutions).toEqual([]);
  });

  it('produces no fill for an answer that is not a string at all', async () => {
    const field = novel('Which campus did you attend?');
    const port = new FakeSemanticPort({
      concepts: { [field.localId]: { evil: true } as unknown as string },
    });

    const outcome = await resolveConcepts({ fields: queueOf(field), port, cache: newCache() });
    expect(outcome.resolutions).toEqual([]);
  });

  it('never proposes a mapping that could autofill on its own', async () => {
    // A novel question must surface as a suggestion the user reads, never as a
    // silent fill. The cap lives in the confidence policy, and this asserts the
    // stage actually uses it.
    const field = novel('Which campus did you attend?');
    const port = new FakeSemanticPort({
      concepts: { [field.localId]: 'education[0].institution' },
    });

    const outcome = await resolveConcepts({ fields: queueOf(field), port, cache: newCache() });

    expect(outcome.resolutions[0]?.confidence).toBeLessThan(
      DEFAULT_CONFIDENCE_POLICY.autofillThreshold,
    );
    expect(outcome.resolutions[0]?.confidence).toBeGreaterThanOrEqual(
      DEFAULT_CONFIDENCE_POLICY.suggestThreshold,
    );
  });

  it('sends NO PROFILE DATA - the request carries only what the page wrote', async () => {
    // Decision #4 of the brief, and the test that protects it. Serialising the
    // request and searching it for the applicant's own values is the only form
    // of this assertion that cannot be satisfied by a comment.
    const field = novel('Which campus did you attend?', ['Rutgers', 'Princeton']);
    const port = new FakeSemanticPort();

    await resolveConcepts({ fields: queueOf(field), port, cache: newCache() });

    const sent = JSON.stringify(port.conceptCalls);
    for (const secret of [
      'Nitu',
      'Maramreddy',
      'nitu@example.com',
      '6095551234',
      '(609) 555-1234',
      '12 Elm Street',
      'authorizedToWorkUS',
      'demographics',
    ]) {
      expect(sent).not.toContain(secret);
    }
    // ...and it does carry the page's own words, so the test is not vacuous.
    // Normalized, which is the same text the fingerprint is computed from.
    expect(sent).toContain('which campus did you attend');
    expect(sent).toContain('Rutgers');
  });
});

describe('stage 1 - the cache', () => {
  it('performs ZERO calls when every question is already known', async () => {
    const field = novel('Which campus did you attend?');
    const cache = newCache();
    await cache.record(computeFingerprints(field), 'education[0].institution');

    const port = new FakeSemanticPort();
    const outcome = await resolveConcepts({ fields: queueOf(field), port, cache });

    expect(port.callCount).toBe(0);
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.resolutions[0]?.origin).toBe('cache');
  });

  it('does not even construct a request when the cache answers - a forbidden port is never touched', async () => {
    const field = novel('Which campus did you attend?');
    const cache = newCache();
    await cache.record(computeFingerprints(field), 'education[0].institution');

    // Throws if reached. `resolveConcepts` returns a value rather than
    // rejecting, so an accidental call would surface as a failed test here.
    const outcome = await resolveConcepts({
      fields: queueOf(field),
      port: new ForbiddenSemanticPort(),
      cache,
    });
    expect(outcome.resolutions).toHaveLength(1);
  });

  it('asks a question at most once, even when the answer was "no path fits"', async () => {
    const field = novel('How did you hear about this role?');
    const cache = newCache();
    const first = new FakeSemanticPort({ concepts: { [field.localId]: null } });

    await resolveConcepts({ fields: queueOf(field), port: first, cache });
    expect(first.conceptCalls).toHaveLength(1);

    const second = new FakeSemanticPort();
    await resolveConcepts({ fields: queueOf(field), port: second, cache });
    expect(second.callCount).toBe(0);
  });

  it('does not re-ask a question a model answered with an unusable path', async () => {
    const field = novel('What is your blood type?');
    const cache = newCache();

    const first = new FakeSemanticPort({ concepts: { [field.localId]: 'contact.bloodType' } });
    await resolveConcepts({ fields: queueOf(field), port: first, cache });

    const second = new FakeSemanticPort();
    await resolveConcepts({ fields: queueOf(field), port: second, cache });
    expect(second.callCount).toBe(0);
  });

  it('only asks about the questions the cache could not answer', async () => {
    const known = novel('Which campus did you attend?');
    const unknownQuestion = novel('What did you major in?');
    const cache = newCache();
    await cache.record(computeFingerprints(known), 'education[0].institution');

    const port = new FakeSemanticPort();
    await resolveConcepts({ fields: queueOf(known, unknownQuestion), port, cache });

    expect(port.conceptCalls[0]).toHaveLength(1);
    expect(port.conceptCalls[0]?.[0]?.fieldId).toBe(unknownQuestion.localId);
  });
});

describe('stage 1 - failure leaves the field exactly as it was', () => {
  const failures: Array<[string, AppError]> = [
    ['the network is unreachable', new AppError('BACKEND_UNREACHABLE', 'offline')],
    ['the burst or daily budget refuses', new AppError('RATE_LIMITED', 'slow down', { context: { retryAfterMs: 5000 } })],
    ['the reply fails schema validation', new AppError('BACKEND_REJECTED', 'unexpected shape')],
    ['this install is not registered', new AppError('BACKEND_UNAUTHENTICATED', 'no token')],
    ['the backend origin was never configured', new AppError('BACKEND_NOT_CONFIGURED', 'no origin')],
  ];

  for (const [name, error] of failures) {
    it(`refuses rather than guessing when ${name}`, async () => {
      const field = novel('Which campus did you attend?');
      const port = new FakeSemanticPort({ conceptError: error });

      const outcome = await resolveConcepts({ fields: queueOf(field), port, cache: newCache() });

      expect(outcome.resolutions).toEqual([]);
      expect(outcome.error?.code).toBe(error.code);
    });
  }

  it('caches nothing when the call failed, so a retry is still possible later', async () => {
    const field = novel('Which campus did you attend?');
    const cache = newCache();

    await resolveConcepts({
      fields: queueOf(field),
      port: new FakeSemanticPort({ conceptError: new AppError('BACKEND_UNREACHABLE', 'offline') }),
      cache,
    });

    expect(await cache.size()).toBe(0);
  });

  it('does nothing at all, and makes no call, for an empty queue', async () => {
    const port = new FakeSemanticPort();
    const outcome = await resolveConcepts({ fields: [], port, cache: newCache() });

    expect(port.callCount).toBe(0);
    expect(outcome.resolutions).toEqual([]);
  });
});

describe('stage 2 - choosing an option', () => {
  it('settles an obvious match with no call at all', async () => {
    const port = new FakeSemanticPort();
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: 'Computer Engineering',
      options: opts('Engineering, Computer', 'Engineering, Civil'),
      port,
    });

    expect(port.callCount).toBe(0);
    expect(outcome.option?.label).toBe('Engineering, Computer');
    expect(outcome.modelCalls).toBe(0);
  });

  it('escalates when the scorer finds nothing, sending one value and that field\'s options', async () => {
    // The commonest real shape: a stored number against a dropdown of ranges.
    // No amount of string matching bridges "4" and "3-5 years".
    const port = new FakeSemanticPort({ options: { f1: '3-5 years' } });
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: '4',
      options: opts('Less than 1 year', '1-3 years', '3-5 years', '5+ years'),
      port,
    });

    expect(port.optionCalls).toHaveLength(1);
    expect(port.optionCalls[0]?.value).toBe('4');
    expect(outcome.option?.label).toBe('3-5 years');
    expect(outcome.strategy).toBe('model');
  });

  it('escalates a deterministic tie rather than picking by array order', async () => {
    const port = new FakeSemanticPort({ options: { f1: 'Rutgers University - Newark' } });
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: 'Rutgers University',
      options: opts('Rutgers University - New Brunswick', 'Rutgers University - Newark'),
      port,
    });

    expect(port.optionCalls).toHaveLength(1);
    expect(outcome.option?.label).toBe('Rutgers University - Newark');
  });

  it('produces NO fill for a reply that is not one of the offered options', async () => {
    // The snap-back. A model returning free text that got filled verbatim is the
    // failure this whole architecture exists to make impossible.
    const port = new FakeSemanticPort({ options: { f1: '4 years' } });
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: '4',
      options: opts('Less than 1 year', '1-3 years', '3-5 years', '5+ years'),
      port,
    });

    expect(outcome.option).toBeNull();
    expect(outcome.strategy).toBeNull();
  });

  it('produces no fill when the reply is "none of these"', async () => {
    const port = new FakeSemanticPort({ options: { f1: null } });
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: '4',
      options: opts('Less than 1 year', '1-3 years'),
      port,
    });

    expect(outcome.option).toBeNull();
  });

  it('returns the option object from the list it was given, never a new one', async () => {
    const options = opts('Less than 1 year', '1-3 years', '3-5 years');
    const port = new FakeSemanticPort({ options: { f1: '3-5 years' } });
    const outcome = await chooseOption({ fieldId: 'f1', value: '4', options, port });

    expect(options.includes(outcome.option as FieldOption)).toBe(true);
  });

  it('refuses when the reply matches two options equally', async () => {
    const port = new FakeSemanticPort({ options: { f1: 'Computer Science' } });
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: 'Comp Sci',
      options: opts('Computer Science', 'Computer  Science'),
      port,
    });

    expect(outcome.option).toBeNull();
  });

  it('refuses rather than guessing when the call fails', async () => {
    const port = new FakeSemanticPort({
      optionError: new AppError('RATE_LIMITED', "that is today's limit"),
    });
    const outcome = await chooseOption({
      fieldId: 'f1',
      value: '4',
      options: opts('Less than 1 year', '1-3 years', '3-5 years'),
      port,
    });

    expect(outcome.option).toBeNull();
    expect(outcome.error?.code).toBe('RATE_LIMITED');
  });

  it('sends the one value and that field\'s options, and nothing else at all', async () => {
    const port = new FakeSemanticPort({ options: { f1: null } });
    await chooseOption({
      fieldId: 'f1',
      value: '4',
      options: opts('Less than 1 year', '1-3 years', '3-5 years'),
      port,
    });

    const sent = port.optionCalls[0];
    expect(sent?.options).toEqual(['Less than 1 year', '1-3 years', '3-5 years']);
    // No profile, no other field, no page URL. The whole request is three keys.
    expect(Object.keys(sent ?? {}).sort()).toEqual(['fieldId', 'options', 'value']);
  });

  it('makes no call for an empty option list', async () => {
    const port = new FakeSemanticPort();
    const outcome = await chooseOption({ fieldId: 'f1', value: 'anything', options: [], port });

    expect(port.callCount).toBe(0);
    expect(outcome.option).toBeNull();
  });

  it('keeps the pure scorer usable on its own, with no port in sight', () => {
    expect(matchOption('Remote', opts('Remote', 'Hybrid')).kind).toBe('matched');
  });
});

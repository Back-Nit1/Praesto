/**
 * Refusal-queue tests.
 *
 * The queue is the gate on everything the semantic fallback is ever allowed to
 * look at, which makes it the cheapest place in the subsystem to be wrong and
 * the cheapest place to be right. Almost every test here asserts a DROP.
 *
 * Two properties are being protected:
 *
 *   PRIVACY   Whatever reaches the queue may later be described to a remote
 *             model. A field that gets dropped here can never leak, no matter
 *             what a later stage does.
 *   COST      Every admitted field is a question we may pay to have answered.
 *             Admitting a field that could not be filled even with a perfect
 *             answer is money spent on nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { collect, MAX_QUEUED_FIELDS } from '@semantic/queue';
import type { FieldOutcome } from '@semantic/types';
import { mapField } from '@form-engine/mapper/mapper';
import { unknownMapping } from '@form-engine/mapper/types';
import type { FieldMappingResult } from '@form-engine/mapper/types';
import type { ResolutionResult } from '@form-engine/resolver/resolver';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import { descriptor, resetDescriptorIds } from '../helpers/descriptors';

beforeEach(() => resetDescriptorIds());

/** A select the mapper genuinely does not recognise. */
const unrecognisedSelect = (label: string): FieldDescriptor =>
  descriptor({
    label,
    kind: 'select',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
  });

/** A mapping result that succeeded, for the fields we expect to be dropped. */
const mapped = (field: FieldDescriptor): FieldMappingResult => ({
  fieldId: field.localId,
  profilePath: 'education[0].institution',
  confidence: 0.96,
  knowledgeState: 'known',
  reasons: [],
  source: 'alias',
});

const failed = (reason: Extract<ResolutionResult, { ok: false }>['reason']): ResolutionResult => ({
  ok: false,
  reason,
});

/** One entry of the queue's input, assembled the way the worker would. */
const outcome = (overrides: Partial<FieldOutcome> & { descriptor: FieldDescriptor }): FieldOutcome => ({
  mapping: unknownMapping(overrides.descriptor.localId),
  ...overrides,
});

describe('collect - what it admits', () => {
  it('admits a field the cascade did not recognise', () => {
    const field = unrecognisedSelect('Which cohort are you applying to');
    const queued = collect([outcome({ descriptor: field, mapping: mapField(field) })]);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe('no_mapping');
    expect(queued[0]?.fieldId).toBe(field.localId);
    // No path is claimed: we do not know what the question means yet.
    expect(queued[0]?.profilePath).toBeNull();
  });

  it('admits a mapped field whose value matched none of the offered options', () => {
    // The interesting half of the problem: we know the question, we know the
    // answer, and the dropdown spells it differently.
    const field = descriptor({
      label: 'School',
      kind: 'select',
      options: [{ value: 'x', label: 'Rutgers University - New Brunswick' }],
    });
    const queued = collect([
      outcome({
        descriptor: field,
        mapping: mapped(field),
        resolution: failed('no_matching_option'),
      }),
    ]);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe('no_matching_option');
    // The path travels with it. Stage two needs the value, not the question.
    expect(queued[0]?.profilePath).toBe('education[0].institution');
  });

  it('carries the normalized question text, which is what a second opinion needs', () => {
    const field = unrecognisedSelect('Which Cohort Are You Applying To? *');
    const queued = collect([outcome({ descriptor: field, mapping: mapField(field) })]);
    expect(queued[0]?.question).toBe('which cohort are you applying to');
  });
});

describe('collect - what it refuses', () => {
  it('drops a resolution failure of no_value: the profile is incomplete, not the match', () => {
    // Spec-level distinction. Nothing a model could say would fill a field the
    // user has no answer for, and asking would be spending money to learn that.
    const field = unrecognisedSelect('School');
    const queued = collect([
      outcome({ descriptor: field, mapping: mapped(field), resolution: failed('no_value') }),
    ]);
    expect(queued).toEqual([]);
  });

  it('drops no_entry: the user has not added that school yet', () => {
    const field = unrecognisedSelect('Second school');
    const queued = collect([
      outcome({ descriptor: field, mapping: mapped(field), resolution: failed('no_entry') }),
    ]);
    expect(queued).toEqual([]);
  });

  it('drops unknown_path: a bug or a stale learned rule, not a matching problem', () => {
    const field = unrecognisedSelect('Anything');
    const queued = collect([
      outcome({ descriptor: field, mapping: mapped(field), resolution: failed('unknown_path') }),
    ]);
    expect(queued).toEqual([]);
  });

  it('drops no_representation: we have the value and cannot render it here', () => {
    const field = unrecognisedSelect('Anything');
    const queued = collect([
      outcome({
        descriptor: field,
        mapping: mapped(field),
        resolution: failed('no_representation'),
      }),
    ]);
    expect(queued).toEqual([]);
  });

  it('drops a field the pipeline already resolved', () => {
    const field = descriptor({ label: 'Email' });
    const queued = collect([
      outcome({
        descriptor: field,
        mapping: mapped(field),
        resolution: {
          ok: true,
          resolved: {
            value: 'nitu@example.com',
            confidence: 1,
            verifiedByUser: true,
            formatting: 'string:raw',
          },
        },
      }),
    ]);
    expect(queued).toEqual([]);
  });

  it('drops a control we could not drive even with a perfect answer', () => {
    const field = descriptor({ label: 'Signature', kind: 'unsupported' });
    const queued = collect([outcome({ descriptor: field, mapping: mapField(field) })]);
    expect(queued).toEqual([]);
  });

  it('drops a disabled control', () => {
    const field = descriptor({ label: 'Which cohort', kind: 'select', disabled: true });
    const queued = collect([outcome({ descriptor: field, mapping: mapField(field) })]);
    expect(queued).toEqual([]);
  });

  it('NEVER reopens a field the user told us to leave alone', () => {
    // The most important refusal in this file. `user_suppressed` is the user's
    // own answer to this question. A subsystem that treats "unmapped" as an
    // invitation to go and find out would silently overrule them.
    const field = unrecognisedSelect('Preferred hub');
    const suppressed = unknownMapping(field.localId, [], 'user_suppressed');
    const queued = collect([outcome({ descriptor: field, mapping: suppressed })]);
    expect(queued).toEqual([]);
  });

  it('drops a field with no question text, because there is nothing to ask about', () => {
    const field = descriptor({ name: 'q_4821', id: 'input-93b2', kind: 'select' });
    const queued = collect([outcome({ descriptor: field, mapping: mapField(field) })]);
    expect(queued).toEqual([]);
  });

  it('drops a control that already holds a value', () => {
    // `decideFill` refuses to overwrite at any confidence, so resolving this
    // field could not change the outcome. Sending its label anywhere would be
    // pure cost - and pure exposure.
    const field = unrecognisedSelect('Which cohort are you applying to');
    const queued = collect([
      outcome({
        descriptor: { ...field, currentValue: 'Beta' },
        mapping: mapField(field),
      }),
    ]);
    expect(queued).toEqual([]);
  });

  it('drops an option question that offers no options', () => {
    // A malformed caller, not a real form. Refusing here keeps every downstream
    // stage able to assume a non-empty option list.
    const field = descriptor({ label: 'School', kind: 'select', options: [] });
    const queued = collect([
      outcome({
        descriptor: field,
        mapping: mapped(field),
        resolution: failed('no_matching_option'),
      }),
    ]);
    expect(queued).toEqual([]);
  });
});

describe('collect - batching', () => {
  it('returns nothing for a page the pipeline fully understood', () => {
    // The property that makes this subsystem free on a form we already handle.
    const field = descriptor({ label: 'Email' });
    expect(collect([outcome({ descriptor: field, mapping: mapped(field) })])).toEqual([]);
  });

  it('keeps six unrecognised fields as six entries, for one batched call', () => {
    const outcomes = Array.from({ length: 6 }, (_, i) => {
      const field = unrecognisedSelect(`Custom question number ${i}`);
      return outcome({ descriptor: field, mapping: mapField(field) });
    });
    expect(collect(outcomes)).toHaveLength(6);
  });

  it('caps the queue, because its size is the size of an outbound payload', () => {
    const outcomes = Array.from({ length: MAX_QUEUED_FIELDS + 10 }, (_, i) => {
      const field = unrecognisedSelect(`Custom question number ${i}`);
      return outcome({ descriptor: field, mapping: mapField(field) });
    });
    expect(collect(outcomes)).toHaveLength(MAX_QUEUED_FIELDS);
  });

  it('honours a caller-supplied cap below the default', () => {
    const outcomes = Array.from({ length: 5 }, (_, i) => {
      const field = unrecognisedSelect(`Custom question number ${i}`);
      return outcome({ descriptor: field, mapping: mapField(field) });
    });
    expect(collect(outcomes, { maxFields: 2 })).toHaveLength(2);
  });
});

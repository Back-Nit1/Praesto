/**
 * Refusal queue tests.
 * ---------------------------------------------------------------------------
 * This is the gate on the whole semantic subsystem, so the tests that matter
 * are the ones asserting what never reaches it. Every field admitted here may
 * cost a model call and may end up proposed to the user; every field wrongly
 * admitted is either wasted money or - in the `user_declined` case below - the
 * extension quietly overruling an instruction the user gave it.
 *
 * The negative cases outnumber the positive ones on purpose (engineering.md
 * practice #2).
 */
import { describe, expect, it } from 'vitest';
import { collectRefusals } from '@semantic/queue';
import { mapField } from '@form-engine/mapper/mapper';
import { unknownMapping, type FieldMappingResult } from '@form-engine/mapper/types';
import type { ResolutionResult } from '@form-engine/resolver/resolver';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import { descriptor } from '../helpers/descriptors';

/** A mapping result that names a path, as the cascade would produce. */
function mapped(field: FieldDescriptor, path: string): FieldMappingResult {
  return {
    fieldId: field.localId,
    profilePath: path as FieldMappingResult['profilePath'],
    confidence: 0.97,
    knowledgeState: 'known',
    reasons: [{ signal: 'label_exact' }],
    source: 'alias',
  };
}

/** A resolution failure of the given reason. */
const failed = (reason: Exclude<ResolutionResult, { ok: true }>['reason']): ResolutionResult => ({
  ok: false,
  reason,
});

const resolved: ResolutionResult = {
  ok: true,
  resolved: { value: 'x', confidence: 1, verifiedByUser: true, formatting: 'string:raw' },
};

/** A select whose options match nothing we store. */
function selectField(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return descriptor({
    label: 'Which of our campuses is closest to you?',
    kind: 'select',
    options: [
      { value: 'a', label: 'Cambridge' },
      { value: 'b', label: 'Shoreditch' },
    ],
    ...overrides,
  });
}

describe('collectRefusals - what it admits', () => {
  it('admits a field the mapping cascade could not name', () => {
    const field = selectField();
    const queued = collectRefusals([{ descriptor: field, mapping: unknownMapping(field.localId) }]);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe('no_mapping');
    expect(queued[0]?.fieldId).toBe(field.localId);
    expect(queued[0]?.profilePath).toBeNull();
  });

  it('admits a mapped field whose value matched none of the offered options', () => {
    const field = selectField();
    const queued = collectRefusals([
      {
        descriptor: field,
        mapping: mapped(field, 'contact.city'),
        resolution: failed('no_matching_option'),
      },
    ]);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe('no_matching_option');
  });

  it('carries the path the mapper already found, so stage 2 knows what to match', () => {
    const field = selectField();
    const queued = collectRefusals([
      {
        descriptor: field,
        mapping: mapped(field, 'contact.city'),
        resolution: failed('no_matching_option'),
      },
    ]);

    expect(queued[0]?.profilePath).toBe('contact.city');
  });

  it('agrees with the real mapper about what an unrecognised question looks like', () => {
    // Runs the actual cascade rather than a hand-built result, so the queue and
    // the mapper cannot drift apart about what a refusal is.
    const field = selectField({ label: 'Which sorting hat house would you pick?' });
    const queued = collectRefusals([{ descriptor: field, mapping: mapField(field) }]);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe('no_mapping');
  });
});

describe('collectRefusals - what it refuses to admit', () => {
  it('drops no_value: the profile is incomplete, which no model can fix', () => {
    const field = selectField();
    expect(
      collectRefusals([
        { descriptor: field, mapping: mapped(field, 'contact.city'), resolution: failed('no_value') },
      ]),
    ).toHaveLength(0);
  });

  it('drops no_entry: the user has not added that school, not a matching problem', () => {
    const field = selectField();
    expect(
      collectRefusals([
        { descriptor: field, mapping: mapped(field, 'education[1].institution'), resolution: failed('no_entry') },
      ]),
    ).toHaveLength(0);
  });

  it('drops unknown_path: a stale learned rule is a bug, not a question to ask', () => {
    const field = selectField();
    expect(
      collectRefusals([
        { descriptor: field, mapping: mapped(field, 'contact.nope'), resolution: failed('unknown_path') },
      ]),
    ).toHaveLength(0);
  });

  it('drops no_representation: we have the value and cannot render it', () => {
    const field = selectField();
    expect(
      collectRefusals([
        { descriptor: field, mapping: mapped(field, 'contact.city'), resolution: failed('no_representation') },
      ]),
    ).toHaveLength(0);
  });

  it('drops a field that resolved successfully', () => {
    const field = selectField();
    expect(
      collectRefusals([{ descriptor: field, mapping: mapped(field, 'contact.city'), resolution: resolved }]),
    ).toHaveLength(0);
  });

  it('NEVER admits a field the user told us to leave alone', () => {
    // A user-confirmed empty learned mapping is an explicit instruction. Sending
    // that question to a model would be the extension overruling its user, which
    // is the single worst thing this subsystem could do.
    const field = selectField();
    const declined = unknownMapping(field.localId, [], 'user_declined');

    expect(collectRefusals([{ descriptor: field, mapping: declined }])).toHaveLength(0);
  });

  it('drops a disabled or unsupported control - a perfect answer could not be filled', () => {
    const field = selectField({ disabled: true });
    const unfillable = unknownMapping(field.localId, [], 'unfillable_control');

    expect(collectRefusals([{ descriptor: field, mapping: unfillable }])).toHaveLength(0);
  });

  it('drops a field with no question text, because there is nothing to ask', () => {
    const field = descriptor({ kind: 'select', options: [{ value: 'a', label: 'Cambridge' }] });
    expect(collectRefusals([{ descriptor: field, mapping: unknownMapping(field.localId) }])).toHaveLength(0);
  });

  it('drops a control the user has already filled - we never overwrite, so never ask', () => {
    const field = selectField({ currentValue: 'Shoreditch' });
    expect(collectRefusals([{ descriptor: field, mapping: unknownMapping(field.localId) }])).toHaveLength(0);
  });

  it('returns an empty queue for a form the pipeline fully understood', () => {
    const field = selectField();
    expect(
      collectRefusals([{ descriptor: field, mapping: mapped(field, 'contact.city'), resolution: resolved }]),
    ).toEqual([]);
  });
});

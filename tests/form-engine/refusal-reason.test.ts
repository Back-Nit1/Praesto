/**
 * Mapper refusal-reason tests.
 *
 * `mapField` has always been able to say "I do not know". It could not say WHY,
 * and the three whys are not interchangeable:
 *
 *     no_signal            nothing matched. A second opinion might help.
 *     unsupported_control  we could not drive this control if we did know.
 *     user_suppressed      the user told us to leave this field alone.
 *
 * Only the first is a question worth asking anyone else. These tests exist
 * because the semantic fallback queue reads this field to decide what to spend
 * a model call on, and collapsing the three would spend one on a disabled
 * control - or, far worse, re-open a field the user personally closed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mapField } from '@form-engine/mapper/mapper';
import { unknownMapping } from '@form-engine/mapper/types';
import type { LearnedMapping, LearnedMappingLookup } from '@learning/types';
import { descriptor, resetDescriptorIds } from '../helpers/descriptors';

beforeEach(() => resetDescriptorIds());

/** A lookup that answers every fingerprint with the same rule. */
const alwaysFinds = (mapping: LearnedMapping): LearnedMappingLookup => ({
  find: () => mapping,
});

const suppressionRule: LearnedMapping = {
  id: 'lm-suppress',
  scope: 'global',
  semanticFingerprint: 'whatever',
  profilePath: '', // "this question means nothing"
  userConfirmed: true,
  successfulUses: 0,
  correctedUses: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('unknownMapping', () => {
  it('defaults to no_signal, the only refusal a second opinion could fix', () => {
    const result = unknownMapping('field-1');
    expect(result.profilePath).toBeNull();
    expect(result.refusalReason).toBe('no_signal');
  });

  it('leaves the rest of the result exactly as it was', () => {
    // The field is additive. Nothing downstream that already reads a refusal
    // may start seeing a different shape.
    const result = unknownMapping('field-1');
    expect(result.confidence).toBe(0);
    expect(result.knowledgeState).toBe('unknown');
    expect(result.source).toBe('none');
    expect(result.reasons).toEqual([]);
  });
});

describe('mapField - why it refused', () => {
  it('reports no_signal when nothing in the cascade matched', () => {
    const result = mapField(descriptor({ name: 'q_4821', id: 'input-93b2' }));
    expect(result.profilePath).toBeNull();
    expect(result.refusalReason).toBe('no_signal');
  });

  it('reports unsupported_control for a disabled field', () => {
    // A perfect mapping would still be unfillable, so this is not a question
    // about meaning and must never reach a paid second opinion.
    const result = mapField(descriptor({ label: 'Email', disabled: true }));
    expect(result.refusalReason).toBe('unsupported_control');
  });

  it('reports unsupported_control for a control kind we cannot drive', () => {
    const result = mapField(descriptor({ label: 'Email', kind: 'unsupported' }));
    expect(result.refusalReason).toBe('unsupported_control');
  });

  it('reports user_suppressed when the user told us to leave the field alone', () => {
    // The single most important distinction here. "I do not know what this is"
    // invites help; "the user closed this field" forbids it.
    const result = mapField(descriptor({ label: 'Preferred hub' }), {
      learned: alwaysFinds(suppressionRule),
    });
    expect(result.profilePath).toBeNull();
    expect(result.refusalReason).toBe('user_suppressed');
  });

  it('leaves refusalReason absent on a successful mapping', () => {
    // A reason for a refusal that did not happen would be a lie the panel
    // could render.
    const result = mapField(descriptor({ label: 'Email' }));
    expect(result.profilePath).toBe('contact.email');
    expect(result.refusalReason).toBeUndefined();
  });
});

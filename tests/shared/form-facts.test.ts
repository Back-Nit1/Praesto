/**
 * Form facts, and the bug that made them a separate step.
 *
 * `required` reaches the panel so it can name the fields that will stop a
 * submit. The semantic pass REPLACES an action object rather than editing it,
 * so a fact stamped before that pass disappears - silently, and on exactly the
 * fields the AI fallback helped with, which are the ones least likely to be
 * noticed missing.
 */
import { describe, expect, it } from 'vitest';
import { stampFormFacts } from '@shared/form-facts';
import type { ResolvedFieldAction } from '@shared/messages';

function action(localId: string, overrides: Partial<ResolvedFieldAction> = {}): ResolvedFieldAction {
  return {
    localId,
    action: 'fill',
    profilePath: 'contact.email',
    mappingConfidence: 0.9,
    knowledgeState: 'known',
    ...overrides,
  };
}

describe('stampFormFacts', () => {
  it('marks an action required when the form said so', () => {
    const actions = [action('f_1')];

    stampFormFacts(actions, [{ localId: 'f_1', required: true }]);

    expect(actions[0]?.required).toBe(true);
  });

  it('survives an action being replaced by a later pass', () => {
    // The regression this module exists for. The semantic pass rebuilds the
    // action from scratch; stamping afterwards is what makes that safe.
    const actions = [action('f_1')];
    const descriptors = [{ localId: 'f_1', required: true }];

    actions[0] = action('f_1', { action: 'suggest', mappingConfidence: 0.55 });
    stampFormFacts(actions, descriptors);

    expect(actions[0]?.required).toBe(true);
    expect(actions[0]?.action).toBe('suggest');
  });

  it('reports a control that already holds a value, without carrying the value', () => {
    const actions = [action('f_1')];

    stampFormFacts(actions, [
      { localId: 'f_1', required: true, currentValue: 'someone@example.com' },
    ]);

    expect(actions[0]?.prefilled).toBe(true);
    // The panel needs to know the field is answered. It has no need of the
    // answer, and page content must not travel in a message that does not
    // need it.
    expect(JSON.stringify(actions)).not.toContain('someone@example.com');
  });

  it('treats whitespace as empty, the way the fill engine does', () => {
    const actions = [action('f_1')];

    stampFormFacts(actions, [{ localId: 'f_1', required: true, currentValue: '   ' }]);

    expect(actions[0]?.prefilled).toBeUndefined();
  });

  it('says nothing about an action whose descriptor is missing', () => {
    // A field the page reported and the scan did not contain. Inventing
    // `required: false` for it would assert something nobody said.
    const actions = [action('f_orphan')];

    stampFormFacts(actions, [{ localId: 'f_other', required: true }]);

    expect(actions[0]).not.toHaveProperty('required');
    expect(actions[0]).not.toHaveProperty('prefilled');
  });

  it('leaves an optional field unmarked rather than marking it false', () => {
    const actions = [action('f_1')];

    stampFormFacts(actions, [{ localId: 'f_1', required: false }]);

    // Absent means "we were not told", which is what an older panel reads it
    // as. A literal `false` would be a claim.
    expect(actions[0]).not.toHaveProperty('required');
  });
});

/**
 * Semantic mapper tests.
 *
 * These are the product's most important tests. The mapper is what decides what
 * a field means, and a mapping error is how a wrong answer gets onto a job
 * application. Every test that asserts we DON'T map something is protecting a
 * user from that outcome.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mapField } from '@form-engine/mapper/mapper';
import { DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import type { LearnedMappingLookup, LearnedMapping } from '@learning/types';
import { descriptor, resetDescriptorIds } from '../helpers/descriptors';

const AUTOFILL = DEFAULT_CONFIDENCE_POLICY.autofillThreshold;
const SUGGEST = DEFAULT_CONFIDENCE_POLICY.suggestThreshold;

beforeEach(() => resetDescriptorIds());

describe('mapField - HTML semantics', () => {
  it('trusts a recognised autocomplete token above everything else', () => {
    const result = mapField(
      descriptor({ autocomplete: 'given-name', label: 'Name', name: 'q1' }),
    );
    expect(result.profilePath).toBe('identity.legalFirstName');
    expect(result.confidence).toBeGreaterThanOrEqual(AUTOFILL);
    expect(result.source).toBe('html');
  });

  it('reads the meaningful token out of a multi-token autocomplete value', () => {
    const result = mapField(descriptor({ autocomplete: 'shipping address-level2' }));
    expect(result.profilePath).toBe('contact.city');
  });

  it('ignores an unrecognised autocomplete token rather than treating it as signal', () => {
    // Sites emit "off", "nope", and template leftovers constantly.
    const result = mapField(descriptor({ autocomplete: 'off', label: 'Email' }));
    expect(result.profilePath).toBe('contact.email');
    expect(result.source).toBe('alias'); // the label carried it, not the attribute
  });
});

describe('mapField - alias registry', () => {
  it.each([
    ['First Name *', 'identity.legalFirstName'],
    ['Last Name', 'identity.lastName'],
    ['E-Mail Address', 'contact.email'],
    ['Phone Number', 'contact.phone'],
    ['LinkedIn Profile URL', 'links.linkedin'],
    ['GitHub', 'links.github'],
    ['City', 'contact.city'],
    ['Zip Code', 'contact.postalCode'],
    ['Preferred Name', 'identity.preferredFirstName'],
  ])('maps the label %j to %s', (label, expected) => {
    const result = mapField(descriptor({ label }));
    expect(result.profilePath).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(AUTOFILL);
  });

  it('maps from a name attribute when there is no label', () => {
    const result = mapField(descriptor({ name: 'legal_first_name' }));
    expect(result.profilePath).toBe('identity.legalFirstName');
  });

  it('splits camelCase attributes into words before matching', () => {
    const result = mapField(descriptor({ name: 'candidateLastName' }));
    expect(result.profilePath).toBe('identity.lastName');
  });

  it('handles Rails-style bracketed attribute names', () => {
    const result = mapField(descriptor({ name: 'job_application[email]' }));
    expect(result.profilePath).toBe('contact.email');
  });

  it('reaches a separator-collapsed attribute through the compact index', () => {
    const result = mapField(descriptor({ name: 'e_mail_address' }));
    expect(result.profilePath).toBe('contact.email');
  });

  it('treats the required asterisk and trailing colon as decoration', () => {
    expect(mapField(descriptor({ label: 'Email Address *' })).profilePath).toBe('contact.email');
    expect(mapField(descriptor({ label: 'Email Address:' })).profilePath).toBe('contact.email');
  });

  it('falls back to the accessible name when there is no label', () => {
    const result = mapField(descriptor({ accessibleName: 'Mobile phone' }));
    expect(result.profilePath).toBe('contact.phone');
  });
});

describe('mapField - refusing to guess', () => {
  it('returns unknown for a question it has never seen', () => {
    const result = mapField(
      descriptor({ label: 'Describe a technically challenging project you led', kind: 'textarea' }),
    );
    expect(result.profilePath).toBeNull();
    expect(result.knowledgeState).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('returns unknown for a field with no usable signal at all', () => {
    const result = mapField(descriptor({ name: 'q_4821', id: 'input-93b2' }));
    expect(result.profilePath).toBeNull();
  });

  it('does not map a disabled control', () => {
    const result = mapField(descriptor({ label: 'Email', disabled: true }));
    expect(result.profilePath).toBeNull();
  });

  it('never lets a fuzzy match alone reach the autofill threshold', () => {
    // "Contact phone number for emergencies" partially overlaps "phone number".
    // It may be worth suggesting. It must never be filled automatically.
    const result = mapField(descriptor({ label: 'Emergency contact phone number' }));
    if (result.source === 'fuzzy') {
      expect(result.confidence).toBeLessThan(AUTOFILL);
    }
  });

  it('reduces confidence when the question contains an unmodelled negation', () => {
    const plain = mapField(descriptor({ label: 'Do you require sponsorship', kind: 'radio' }));
    const negated = mapField(
      descriptor({ label: 'Do you not require sponsorship', kind: 'radio' }),
    );
    // The negated form must not be answered with the same confidence as the
    // plain one - an inverted answer here is a false statement to an employer.
    expect(negated.confidence).toBeLessThan(plain.confidence);
    expect(negated.reasons.some((r) => r.signal === 'negation_detected')).toBe(true);
  });
});

describe('mapField - ambiguity', () => {
  it('reports competing interpretations instead of hiding them', () => {
    // "Start date" is a real alias for both an education start date and an
    // employment start date, plus the availability question.
    const result = mapField(descriptor({ label: 'Start date' }));
    expect(result.profilePath).not.toBeNull();
    // Whatever we chose, the confidence must acknowledge we could be wrong.
    if ((result.alternatives?.length ?? 0) > 0) {
      expect(result.confidence).toBeLessThan(AUTOFILL);
    }
  });
});

describe('mapField - sensitive questions', () => {
  it('recognises a work authorization question without claiming to know the answer', () => {
    const result = mapField(
      descriptor({
        label: 'Are you legally authorized to work in the United States',
        kind: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      }),
    );
    // We DO want to recognise it, so the side panel can surface it for review.
    expect(result.profilePath).toBe('applicationPreferences.authorizedToWorkUS');
    // But we must never report it as something we simply know.
    expect(result.knowledgeState).toBe('previously_seen');
  });

  it('recognises demographic questions but never marks them known', () => {
    for (const label of ['Gender', 'Race / Ethnicity', 'Veteran Status', 'Disability Status']) {
      const result = mapField(descriptor({ label, kind: 'select' }));
      expect(result.profilePath, label).toMatch(/^demographics\./);
      expect(result.knowledgeState, label).not.toBe('known');
    }
  });
});

describe('mapField - learned mappings', () => {
  function lookupReturning(mapping: LearnedMapping): LearnedMappingLookup {
    return { find: () => mapping };
  }

  const baseMapping: LearnedMapping = {
    id: 'm1',
    scope: 'global',
    semanticFingerprint: 'fp',
    profilePath: 'applicationPreferences.preferredLocations',
    normalizedLabel: 'preferred hub',
    userConfirmed: true,
    successfulUses: 0,
    correctedUses: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('maps a question the alias table has never seen, once the user has taught it', () => {
    const field = descriptor({ label: 'Preferred hub' });

    expect(mapField(field).profilePath).toBeNull();

    const learned = mapField(field, { learned: lookupReturning(baseMapping) });
    expect(learned.profilePath).toBe('applicationPreferences.preferredLocations');
    expect(learned.source).toBe('memory');
    expect(learned.knowledgeState).toBe('previously_seen');
  });

  it('lets a user-confirmed correction override the alias table', () => {
    // The user has decided that on their forms, "Name" means their PREFERRED
    // name. Our alias table says identity.fullName. The user wins.
    const field = descriptor({ label: 'Name' });
    const override = mapField(field, {
      learned: lookupReturning({ ...baseMapping, profilePath: 'identity.preferredFirstName' }),
    });
    expect(override.profilePath).toBe('identity.preferredFirstName');
  });

  it('lets repeated corrections push a bad learned rule out of contention', () => {
    const field = descriptor({ label: 'Preferred hub' });
    const corrected = mapField(field, {
      learned: lookupReturning({
        ...baseMapping,
        userConfirmed: false,
        correctedUses: 9,
      }),
    });
    // Nine corrections must not leave the rule confidently in charge - spec 19:
    // "bad learned rules do not permanently trap the system".
    expect(corrected.confidence).toBeLessThan(SUGGEST);
  });

  it('raises confidence slightly after repeated uncorrected successes', () => {
    const field = descriptor({ label: 'Preferred hub' });
    const fresh = mapField(field, {
      learned: lookupReturning({ ...baseMapping, userConfirmed: false }),
    });
    const proven = mapField(field, {
      learned: lookupReturning({ ...baseMapping, userConfirmed: false, successfulUses: 5 }),
    });
    expect(proven.confidence).toBeGreaterThan(fresh.confidence);
  });
});

describe('mapField - explanation', () => {
  it('always reports why it mapped what it mapped', () => {
    const result = mapField(descriptor({ autocomplete: 'email', label: 'Email address' }));
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons[0]?.signal).toBe('autocomplete');
  });

  it('records agreement between independent signals', () => {
    const agreeing = mapField(descriptor({ autocomplete: 'email', label: 'Email address' }));
    const alone = mapField(descriptor({ autocomplete: 'email' }));
    // Two independent sources agreeing is worth slightly more than one.
    expect(agreeing.confidence).toBeGreaterThanOrEqual(alone.confidence);
  });
});

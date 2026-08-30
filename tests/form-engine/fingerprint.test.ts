/**
 * Fingerprint tests.
 *
 * These encode the property the entire learning system rests on: the same
 * QUESTION produces the same fingerprint across pages whose markup has nothing
 * in common, and different questions never collide.
 *
 * A regression here would not fail loudly. It would quietly stop learned
 * corrections from carrying over, and the product would just feel like it
 * forgets - which is why the invariants are asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { computeFingerprints, computeSignature, selectQuestionText } from '@form-engine/fingerprints/fingerprint';
import { descriptor } from '../helpers/descriptors';

describe('selectQuestionText', () => {
  it('prefers the label a human would read', () => {
    const field = descriptor({
      label: 'First Name',
      accessibleName: 'Given name',
      placeholder: 'e.g. Jane',
    });
    expect(selectQuestionText(field)).toBe('first name');
  });

  it('falls back through accessible name, nearby text, then placeholder', () => {
    expect(selectQuestionText(descriptor({ accessibleName: 'Email Address' }))).toBe('email address');
    expect(selectQuestionText(descriptor({ nearbyText: 'What is your phone?' }))).toBe(
      'what is your phone',
    );
    // A placeholder is often an EXAMPLE rather than a question, so it is last.
    expect(selectQuestionText(descriptor({ placeholder: 'LinkedIn' }))).toBe('linkedin');
  });

  it('returns empty when the field says nothing about itself', () => {
    expect(selectQuestionText(descriptor({ name: 'q_4821' }))).toBe('');
  });
});

describe('computeFingerprints', () => {
  it('gives the same global fingerprint to the same question on different sites', () => {
    // The whole point: a correction learned at one company must apply at the
    // next one, where the markup is entirely different.
    const greenhouse = descriptor({
      label: 'Preferred hub',
      hostname: 'boards.greenhouse.io',
      id: 'job_application_answers_attributes_3_text_value',
      name: 'job_application[answers_attributes][3][text_value]',
      ats: 'greenhouse',
    });
    const lever = descriptor({
      label: 'Preferred hub',
      hostname: 'jobs.lever.co',
      id: 'cards-abc123-field0',
      name: 'cards[abc123][field0]',
      ats: 'lever',
    });

    expect(computeFingerprints(greenhouse).global).toBe(computeFingerprints(lever).global);
  });

  it('is stable across renders that regenerate DOM ids', () => {
    const first = descriptor({ label: 'First name', id: 'input-2941' });
    const second = descriptor({ label: 'First name', id: 'input-8317' });
    expect(computeFingerprints(first).global).toBe(computeFingerprints(second).global);
  });

  it('distinguishes different questions', () => {
    const a = computeFingerprints(descriptor({ label: 'First name' })).global;
    const b = computeFingerprints(descriptor({ label: 'Last name' })).global;
    expect(a).not.toBe(b);
  });

  it('distinguishes the same words asked through a different control', () => {
    // "Country" as free text and "Country" as a 250-option dropdown are
    // different asks with different answer shapes.
    const text = computeFingerprints(descriptor({ label: 'Country', kind: 'text' })).global;
    const select = computeFingerprints(
      descriptor({
        label: 'Country',
        kind: 'select',
        options: [{ value: 'US', label: 'United States' }],
      }),
    ).global;
    expect(text).not.toBe(select);
  });

  it('ignores the order a form happens to render its options in', () => {
    // An ATS may render ["Yes","No"] or ["No","Yes"] by locale or A/B test. It
    // is the same question, and must not have to be taught twice.
    const forward = computeFingerprints(
      descriptor({
        label: 'Authorized to work',
        kind: 'radio',
        options: [
          { value: 'y', label: 'Yes' },
          { value: 'n', label: 'No' },
        ],
      }),
    ).global;
    const reversed = computeFingerprints(
      descriptor({
        label: 'Authorized to work',
        kind: 'radio',
        options: [
          { value: 'n', label: 'No' },
          { value: 'y', label: 'Yes' },
        ],
      }),
    ).global;
    expect(forward).toBe(reversed);
  });

  it('separates the four scopes so they can never collide', () => {
    const field = descriptor({ label: 'Preferred hub' });
    const { global, ats, company, exact } = computeFingerprints(field);
    expect(new Set([global, ats, company, exact]).size).toBe(4);
  });

  it('makes the company scope differ between hostnames while global stays equal', () => {
    const here = computeFingerprints(descriptor({ label: 'Preferred hub', hostname: 'a.example' }));
    const there = computeFingerprints(descriptor({ label: 'Preferred hub', hostname: 'b.example' }));
    expect(here.company).not.toBe(there.company);
    expect(here.global).toBe(there.global);
  });
});

describe('computeSignature', () => {
  it('caps the options it fingerprints', () => {
    // A country dropdown has ~250 entries. Hashing all of them costs time on
    // every field of every scan and adds no discriminating power.
    const manyOptions = Array.from({ length: 250 }, (_, index) => ({
      value: String(index),
      label: `Option ${index}`,
    }));
    const signature = computeSignature(descriptor({ label: 'Country', options: manyOptions }));
    expect(signature.options.length).toBeLessThanOrEqual(12);
  });

  it('exposes the inputs to the hash so a mismatch can be debugged', () => {
    const signature = computeSignature(descriptor({ label: 'First Name *', kind: 'text' }));
    expect(signature).toEqual({ question: 'first name', kind: 'text', options: [] });
  });
});

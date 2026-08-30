/**
 * Confidence policy tests.
 *
 * The policy is the product's safety mechanism, so these tests read as a list
 * of guarantees rather than as coverage of a function. Each one names a way the
 * extension could put a wrong answer on an application, and asserts that it
 * cannot.
 */
import { describe, expect, it } from 'vitest';
import {
  combineConfidence,
  decideFill,
  DEFAULT_CONFIDENCE_POLICY,
  type FillDecisionInput,
} from '@form-engine/confidence/policy';

/** A field the system is certain about, with a value the user verified. */
const IDEAL: FillDecisionInput = {
  mappingConfidence: 0.99,
  valueConfidence: 1,
  valueVerifiedByUser: true,
  profilePath: 'contact.email',
  valueMissing: false,
  controlHasValue: false,
};

describe('decideFill', () => {
  it('fills when both the mapping and the value are trustworthy', () => {
    expect(decideFill(IDEAL)).toBe('autofill');
  });

  it('never fills an unmapped field', () => {
    expect(decideFill({ ...IDEAL, profilePath: null })).toBe('skip');
  });

  it('never fills when there is no value to offer', () => {
    expect(decideFill({ ...IDEAL, valueMissing: true })).toBe('skip');
  });

  it('never overwrites a control that already holds something', () => {
    // The user may have typed it, or the ATS may have pre-filled it. Either
    // way, replacing a correct value with our own is a wrong fill.
    expect(decideFill({ ...IDEAL, controlHasValue: true })).toBe('skip');
  });

  it('suggests rather than fills when the mapping is merely probable', () => {
    expect(decideFill({ ...IDEAL, mappingConfidence: 0.85 })).toBe('suggest');
  });

  it('stays silent below the suggestion floor rather than showing a weak guess', () => {
    // A noisy suggestion list trains the user to click through without reading,
    // which destroys the value of the review step.
    expect(decideFill({ ...IDEAL, mappingConfidence: 0.5 })).toBe('skip');
  });

  it('will not fill a trusted mapping from an untrusted value', () => {
    // Being certain the field asks for a phone number does not license filling
    // it with a number the user has never looked at.
    expect(
      decideFill({ ...IDEAL, valueVerifiedByUser: false, valueConfidence: 0.5 }),
    ).toBe('suggest');
  });

  it('accepts a strong unverified value for an ordinary field', () => {
    expect(
      decideFill({ ...IDEAL, valueVerifiedByUser: false, valueConfidence: 0.9 }),
    ).toBe('autofill');
  });

  describe('the sensitive-path gate', () => {
    const SENSITIVE = [
      'applicationPreferences.authorizedToWorkUS',
      'applicationPreferences.requiresSponsorshipNow',
      'applicationPreferences.requiresSponsorshipFuture',
      'demographics.gender',
      'demographics.raceEthnicity',
      'demographics.veteranStatus',
      'demographics.disabilityStatus',
    ];

    it('refuses to autofill a legal or demographic answer the user did not verify', () => {
      for (const path of SENSITIVE) {
        // Note the inputs: a PERFECT mapping and a high-confidence value. The
        // gate still holds, because knowing what is being asked is not the same
        // as being entitled to answer it.
        const decision = decideFill({
          ...IDEAL,
          profilePath: path,
          valueVerifiedByUser: false,
          valueConfidence: 0.99,
          mappingConfidence: 0.99,
        });
        expect(decision, path).toBe('suggest');
      }
    });

    it('allows autofill once the user has explicitly verified the answer', () => {
      for (const path of SENSITIVE) {
        const decision = decideFill({ ...IDEAL, profilePath: path, valueVerifiedByUser: true });
        expect(decision, path).toBe('autofill');
      }
    });
  });
});

describe('combineConfidence', () => {
  const { sourceScores, autofillThreshold, suggestThreshold } = DEFAULT_CONFIDENCE_POLICY;

  it('keeps a fuzzy match below the autofill line no matter how many signals agree', () => {
    // The structural guarantee: fuzzy matching can suggest, never fill.
    const generous = combineConfidence(sourceScores.fuzzy, { agreeingSignals: 10 });
    expect(generous).toBeLessThan(autofillThreshold);
  });

  it('caps the multi-signal bonus so agreements cannot manufacture certainty', () => {
    // Signals from one form are correlated (same developer, same template), so
    // stacking them must not be able to lift a mediocre match over the line.
    const twenty = combineConfidence(0.9, { agreeingSignals: 20 });
    expect(twenty - 0.9).toBeCloseTo(DEFAULT_CONFIDENCE_POLICY.maxMultiSignalBonus, 9);
  });

  it('pushes an unmodelled negation below the autofill line', () => {
    const negated = combineConfidence(sourceScores.exactAlias, { hasUnmodelledNegation: true });
    expect(negated).toBeLessThan(autofillThreshold);
  });

  it('lets repeated corrections drive a learned rule out of contention', () => {
    // Spec section 19: bad learned rules must not permanently trap the system,
    // so the correction penalty is deliberately uncapped.
    const corrected = combineConfidence(sourceScores.learnedMapping, { correctedUses: 5 });
    expect(corrected).toBeLessThan(suggestThreshold);
  });

  it('caps the success bonus, so a lucky streak cannot outrank a declaration', () => {
    const proven = combineConfidence(sourceScores.learnedMapping, { successfulUses: 1000 });
    expect(proven - sourceScores.learnedMapping).toBeLessThanOrEqual(
      DEFAULT_CONFIDENCE_POLICY.maxLearnedBonus + 1e-9,
    );
  });

  it('never reports absolute certainty', () => {
    // 1.0 is reserved. Nothing the system infers is ever beyond doubt.
    expect(combineConfidence(1, { agreeingSignals: 10, successfulUses: 100 })).toBeLessThan(1);
  });

  it('never goes negative', () => {
    expect(combineConfidence(0.1, { correctedUses: 50 })).toBe(0);
  });
});

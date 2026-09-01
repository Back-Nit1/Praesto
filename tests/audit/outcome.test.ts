/**
 * What a correction MEANS, as a pure function.
 * ---------------------------------------------------------------------------
 * These cases are the whole reason `userCorrected: boolean` was split. The
 * boolean answered "did the user touch this row"; the numerator of the most
 * important metric in spec section 26 needs "did we get it WRONG", and those
 * are different questions with opposite answers on the same row.
 */
import { describe, expect, it } from 'vitest';
import { deriveCorrectionOutcome } from '@audit/types';

describe('deriveCorrectionOutcome', () => {
  it('does not count a user teaching us a blank field as an incorrect fill', () => {
    // We refused this field. The user is telling us what it means. That is the
    // learning loop working exactly as designed, and the old boolean recorded
    // it identically to a wrong fill.
    expect(deriveCorrectionOutcome('skip', 'workAuthorization.requiresSponsorship')).toBe(
      'assigned_unmapped',
    );
  });

  it('counts a changed mapping on a field we wrote as a wrong fill', () => {
    expect(deriveCorrectionOutcome('fill', 'contact.phone')).toBe('corrected_wrong_fill');
  });

  it('separates a wrong suggestion from a wrong fill', () => {
    // Both are mapping errors; only one of them put a value on the page without
    // a person reading it, and the metric that matters is about the second.
    expect(deriveCorrectionOutcome('suggest', 'contact.phone')).toBe('corrected_wrong_suggestion');
  });

  it('treats "this field means nothing" as us having touched what we should not have', () => {
    expect(deriveCorrectionOutcome('fill', null)).toBe('rejected_to_none');
    expect(deriveCorrectionOutcome('suggest', null)).toBe('rejected_to_none');
  });

  it('still reads a refusal as the loop working even when the user clears it', () => {
    // `skip` plus null is the user confirming we were right to leave it alone.
    // It is emphatically not an incorrect fill: we filled nothing.
    expect(deriveCorrectionOutcome('skip', null)).toBe('assigned_unmapped');
  });

  it('folds an attached resume in with the fills, because attaching is writing', () => {
    expect(deriveCorrectionOutcome('attach_resume', 'documents.resume')).toBe(
      'corrected_wrong_fill',
    );
    expect(deriveCorrectionOutcome('attach_resume', null)).toBe('rejected_to_none');
  });
});

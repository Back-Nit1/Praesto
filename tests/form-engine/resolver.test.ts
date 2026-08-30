/**
 * Value resolver tests.
 *
 * Same discipline as the mapper tests: the cases where the resolver REFUSES are
 * as important as the ones where it produces a value. A resolver that always
 * returns something would nullify every careful refusal upstream of it.
 */
import { describe, expect, it } from 'vitest';
import { resolveValue } from '@form-engine/resolver/resolver';
import { createEmptyProfile, userValue, type ApplicantProfile } from '@profile/schema';
import { parseDate } from '@profile/normalizers/date';
import { parsePhone } from '@profile/normalizers/phone';
import { descriptor } from '../helpers/descriptors';

function profileWith(mutate: (p: ApplicantProfile) => void): ApplicantProfile {
  const profile = createEmptyProfile('p1');
  mutate(profile);
  return profile;
}

describe('resolveValue - refusals', () => {
  it('refuses when the profile has no value', () => {
    const result = resolveValue(createEmptyProfile('p1'), 'contact.email', descriptor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_value');
  });

  it('refuses an unknown path rather than resolving something nearby', () => {
    const result = resolveValue(createEmptyProfile('p1'), 'contact.emailAddress', descriptor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_path');
  });

  it('refuses to write a value longer than the control accepts', () => {
    const profile = profileWith((p) => {
      p.contact.addressLine1 = userValue('123 Extremely Long Street Name Boulevard');
    });
    const result = resolveValue(profile, 'contact.addressLine1', descriptor({ maxLength: 10 }));
    // Half an address is worse than an empty field the user completes.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_representation');
  });

  it('refuses to write a boolean into a text field', () => {
    const profile = profileWith((p) => {
      p.applicationPreferences.willingToRelocate = userValue(true);
    });
    const result = resolveValue(
      profile,
      'applicationPreferences.willingToRelocate',
      descriptor({ kind: 'text' }),
    );
    // "true" in a text field is nearly always wrong.
    expect(result.ok).toBe(false);
  });
});

describe('resolveValue - phone formatting', () => {
  const profile = profileWith((p) => {
    const phone = parsePhone('(609) 555-1234');
    if (phone !== null) p.contact.phone = userValue(phone);
  });

  it('defaults to the national format for a tel input', () => {
    const result = resolveValue(profile, 'contact.phone', descriptor({ kind: 'tel' }));
    expect(result.ok && result.resolved.value).toBe('(609) 555-1234');
  });

  it('follows a placeholder that demonstrates the expected shape', () => {
    expect(
      resolveValue(profile, 'contact.phone', descriptor({ kind: 'tel', placeholder: '+1 555 000 0000' })),
    ).toMatchObject({ ok: true, resolved: { value: '+16095551234' } });

    expect(
      resolveValue(profile, 'contact.phone', descriptor({ kind: 'tel', placeholder: '555-000-0000' })),
    ).toMatchObject({ ok: true, resolved: { value: '609-555-1234' } });
  });

  it('sends bare digits to a numeric input, which cannot hold punctuation', () => {
    const result = resolveValue(profile, 'contact.phone', descriptor({ kind: 'number' }));
    expect(result.ok && result.resolved.value).toBe('6095551234');
  });

  it('honours a country-code sub-field', () => {
    const result = resolveValue(
      profile,
      'contact.phone',
      descriptor({ kind: 'text', label: 'Country code' }),
    );
    expect(result.ok && result.resolved.value).toBe('1');
  });
});

describe('resolveValue - date formatting', () => {
  const profile = profileWith((p) => {
    const date = parseDate('May 2027');
    if (date !== null) p.applicationPreferences.availableStartDate = userValue(date);
  });

  const PATH = 'applicationPreferences.availableStartDate';

  it('splits a month-year date across separate month and year controls', () => {
    // The case that matters: sending "May 2027" to a month dropdown fills
    // nothing while appearing to have worked.
    const month = resolveValue(profile, PATH, descriptor({ label: 'Month', kind: 'select' }));
    const year = resolveValue(profile, PATH, descriptor({ label: 'Year', kind: 'select' }));
    expect(month.ok && month.resolved.value).toBe('May');
    expect(year.ok && year.resolved.value).toBe('2027');
  });

  it('refuses a native date input when the day is unknown', () => {
    // A native date input requires a full ISO date. We know May 2027, not a day,
    // and picking the 1st would be a fabricated start date.
    const result = resolveValue(profile, PATH, descriptor({ kind: 'date' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_representation');
  });

  it('follows a placeholder that spells out the format', () => {
    const result = resolveValue(
      profile,
      PATH,
      descriptor({ kind: 'text', placeholder: 'MM/YYYY' }),
    );
    expect(result.ok && result.resolved.value).toBe('05/2027');
  });
});

describe('resolveValue - option matching', () => {
  it('matches a country against a long dropdown', () => {
    const profile = profileWith((p) => {
      p.contact.country = userValue('United States');
    });
    const result = resolveValue(
      profile,
      'contact.country',
      descriptor({
        kind: 'select',
        options: [
          { value: 'CA', label: 'Canada' },
          { value: 'US', label: 'United States' },
          { value: 'MX', label: 'Mexico' },
        ],
      }),
    );
    expect(result.ok && result.resolved.value).toBe('US');
  });

  it('matches a longer official option by prefix', () => {
    const profile = profileWith((p) => {
      p.contact.country = userValue('United States');
    });
    const result = resolveValue(
      profile,
      'contact.country',
      descriptor({
        kind: 'select',
        options: [
          { value: 'CA', label: 'Canada' },
          { value: 'US', label: 'United States of America' },
        ],
      }),
    );
    expect(result.ok && result.resolved.value).toBe('US');
  });

  it('refuses when two options both match, rather than taking the first', () => {
    const profile = profileWith((p) => {
      p.contact.state = userValue('Virginia');
    });
    const result = resolveValue(
      profile,
      'contact.state',
      descriptor({
        kind: 'select',
        options: [
          { value: 'VA', label: 'Virginia' },
          { value: 'VA2', label: 'Virginia' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_matching_option');
  });

  it('does not match a state as a substring of a different state', () => {
    // "Virginia" must not select "West Virginia". Prefix matching, not
    // substring matching, is what prevents this.
    const profile = profileWith((p) => {
      p.contact.state = userValue('Virginia');
    });
    const result = resolveValue(
      profile,
      'contact.state',
      descriptor({
        kind: 'select',
        options: [
          { value: 'WV', label: 'West Virginia' },
          { value: 'MD', label: 'Maryland' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('maps a stored boolean onto a yes/no radio group', () => {
    const profile = profileWith((p) => {
      p.applicationPreferences.willingToRelocate = userValue(true);
    });
    const result = resolveValue(
      profile,
      'applicationPreferences.willingToRelocate',
      descriptor({
        kind: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      }),
    );
    expect(result.ok && result.resolved.value).toBe('yes');
  });

  it('refuses when a yes/no control offers a qualified variant too', () => {
    const profile = profileWith((p) => {
      p.applicationPreferences.willingToRelocate = userValue(true);
    });
    const result = resolveValue(
      profile,
      'applicationPreferences.willingToRelocate',
      descriptor({
        kind: 'select',
        options: [
          { value: 'y', label: 'Yes' },
          { value: 'yc', label: 'Yes' },
          { value: 'n', label: 'No' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('matches a month dropdown that lists numbers rather than names', () => {
    const profile = profileWith((p) => {
      const date = parseDate('May 2027');
      if (date !== null) p.applicationPreferences.availableStartDate = userValue(date);
    });
    const result = resolveValue(
      profile,
      'applicationPreferences.availableStartDate',
      descriptor({
        label: 'Month',
        kind: 'select',
        options: [
          { value: '4', label: '04' },
          { value: '5', label: '05' },
          { value: '6', label: '06' },
        ],
      }),
    );
    expect(result.ok && result.resolved.value).toBe('5');
  });
});

describe('resolveValue - provenance', () => {
  it('carries the value confidence and verification state through', () => {
    const profile = profileWith((p) => {
      p.contact.email = userValue('applicant@example.com');
    });
    const result = resolveValue(profile, 'contact.email', descriptor({ kind: 'email' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.verifiedByUser).toBe(true);
      expect(result.resolved.confidence).toBe(1);
      // Recorded so the audit log can say HOW the value was rendered.
      expect(result.resolved.formatting).toBe('string:raw');
    }
  });
});

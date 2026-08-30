// @vitest-environment jsdom
/**
 * Profile editor behaviour.
 *
 * This screen had no tests, and it is the only place in the product that can
 * produce a VERIFIED value - the thing the whole confidence architecture is
 * built to protect. It is also where the newly exposed half of the schema
 * (education, employment, projects, lists, demographics) is entered.
 *
 * No chrome API is needed: the editor takes a profile and an `edit` callback,
 * which is what makes it testable at all.
 */
import { describe, expect, it } from 'vitest';
import { useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProfileEditor } from '@/entrypoints/options/ProfileEditor';
import { createEmptyProfile, isVerified, type ApplicantProfile } from '@profile/schema';

/**
 * Renders the editor over real state, the way the options page does.
 *
 * `latest` is a handle on the current profile so a test can assert what was
 * actually stored rather than what the DOM happens to show.
 */
function Harness({ onChange }: { onChange: (profile: ApplicantProfile) => void }): ReactNode {
  const [profile, setProfile] = useState<ApplicantProfile>(() =>
    createEmptyProfile('test', '2026-01-01T00:00:00.000Z'),
  );
  return (
    <ProfileEditor
      profile={profile}
      edit={(mutate) =>
        setProfile((current) => {
          const next = mutate(current);
          onChange(next);
          return next;
        })
      }
    />
  );
}

function renderEditor(): { latest: () => ApplicantProfile } {
  cleanup();
  let current = createEmptyProfile('test', '2026-01-01T00:00:00.000Z');
  render(<Harness onChange={(profile) => (current = profile)} />);
  return { latest: () => current };
}

/**
 * Type into a field by its visible label.
 *
 * Matched loosely because `Field` puts a state badge inside the label, and the
 * badge contributes its accessible name ("Not provided") to the label text -
 * so an anchored match never succeeds.
 */
const type = (label: RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('profile editor - typing is verification', () => {
  it('marks a typed value as verified by the user', () => {
    const { latest } = renderEditor();
    type(/legal first name/i, 'Nityanth');

    expect(latest().identity.legalFirstName.value).toBe('Nityanth');
    // The whole trust model in one assertion: nothing else in the product can
    // produce this flag, and it is what unlocks a legal question being filled.
    expect(isVerified(latest().identity.legalFirstName)).toBe(true);
  });

  it('keeps an unparseable phone number instead of discarding it', () => {
    const { latest } = renderEditor();
    type(/phone/i, 'call me maybe');

    expect(latest().contact.phone.value).toBeNull();
    expect(latest().contact.phone.raw).toBe('call me maybe');
  });
});

describe('profile editor - comma lists', () => {
  it('does not eat the separator while the user is still typing', () => {
    // The regression: the stored value is a parsed array, so rendering it back
    // as `join(', ')` on each keystroke deleted the comma the user had just
    // typed, and a second item could not be started at all.
    const { latest } = renderEditor();
    const field = screen.getByLabelText(/skills/i) as HTMLInputElement;

    fireEvent.change(field, { target: { value: 'react,' } });
    expect(field.value).toBe('react,');

    fireEvent.change(field, { target: { value: 'react, typescript' } });
    expect(field.value).toBe('react, typescript');
    expect(latest().skills.value).toEqual(['react', 'typescript']);
  });

  it('stores the parsed list, not the raw line', () => {
    const { latest } = renderEditor();
    type(/preferred locations/i, 'New York,  Remote ,');

    expect(latest().applicationPreferences.preferredLocations.value).toEqual([
      'New York',
      'Remote',
    ]);
  });
});

describe('profile editor - repeated entries', () => {
  it('adds, edits and removes a school', () => {
    const { latest } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /add a school/i }));
    expect(latest().education).toHaveLength(1);
    // A stable id, because array position is not identity - a learned mapping
    // pointing at a reordered list would otherwise retarget a different entry.
    expect(latest().education[0]?.id).toMatch(/^edu_/);

    type(/school/i, 'Rutgers University');
    expect(latest().education[0]?.institution.value).toBe('Rutgers University');

    fireEvent.click(screen.getByRole('button', { name: /remove this school/i }));
    expect(latest().education).toHaveLength(0);
  });

  it('parses a date and shows the reading back to the user', () => {
    const { latest } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /add a school/i }));

    type(/graduated/i, 'May 2027');

    expect(latest().education[0]?.graduationDate.value).toMatchObject({ year: 2027, month: 5 });
    // The read-back is the point: a misparsed graduation date is otherwise
    // invisible until an employer reads it.
    expect(screen.getByText(/read as: may 2027/i)).toBeTruthy();
  });

  it('keeps a date it could not parse instead of inventing one', () => {
    const { latest } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /add a job/i }));

    type(/started/i, 'whenever');

    expect(latest().employment[0]?.startDate.value).toBeNull();
    expect(latest().employment[0]?.startDate.raw).toBe('whenever');
  });
});

describe('profile editor - answers that must stay unanswered', () => {
  it('starts every work-authorization question unanswered', () => {
    const { latest } = renderEditor();
    const preferences = latest().applicationPreferences;

    // Not `false`. "I have not answered this" and "no" are different answers to
    // a sponsorship question, and only one of them is a statement to an
    // employer.
    expect(preferences.authorizedToWorkUS.value).toBeNull();
    expect(preferences.requiresSponsorshipNow.value).toBeNull();
  });

  it('lets an answered legal question be cleared again', () => {
    const { latest } = renderEditor();
    // Scoped to the one question: there are four tri-state rows, each with its
    // own Yes / No / Not answered.
    const row = screen.getByText(/^authorized to work in the us$/i).closest('div');
    if (row === null) throw new Error('question row not found');
    // The row itself, not its parent: the parent is the whole section and
    // holds all four questions' Yes buttons.
    const question = within(row);

    fireEvent.click(question.getByRole('button', { name: /^yes$/i }));
    expect(latest().applicationPreferences.authorizedToWorkUS.value).toBe(true);

    fireEvent.click(question.getByRole('button', { name: /not answered/i }));
    expect(latest().applicationPreferences.authorizedToWorkUS.value).toBeNull();
  });

  it('clears a demographic answer rather than storing an empty string', () => {
    const { latest } = renderEditor();
    type(/gender/i, 'Woman');
    expect(latest().demographics.gender.value).toBe('Woman');

    type(/gender/i, '   ');
    // Stored as absent, so "I have not answered" survives a typo-and-delete
    // and the extension leaves the question blank on an application.
    expect(latest().demographics.gender.value).toBeNull();
    expect(latest().demographics.gender.evidence).toHaveLength(0);
  });
});

// @vitest-environment jsdom
/**
 * The repeated-entry half of the resume review screen.
 *
 * Education, employment and project entries used to bypass review entirely:
 * they were appended wholesale, so a re-uploaded resume silently duplicated
 * every job, and a mis-parsed title could only be found and fixed later in the
 * Profile tab. These tests pin the three things that changed:
 *
 *   - every entry is individually acceptable
 *   - an entry the profile already holds is RECOGNISED, and skipped by default
 *   - a wrong value can be corrected before it is committed, not after
 */
import { describe, expect, it } from 'vitest';
import { useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  EmploymentReview,
  NO_ENTRIES,
  applyReviews,
  reviewEntries,
  type EntryReview,
} from '@/entrypoints/options/ResumeEntryReview';
import {
  createEmptyProfile,
  emptyValue,
  resumeValue,
  type ApplicantProfile,
  type Employment,
  type ProfileValue,
} from '@profile/schema';
import type { NormalizedDate } from '@profile/normalizers/date';

const rv = <T,>(value: T, confidence = 0.9): ProfileValue<T> => resumeValue(value, { confidence });

const date = (year: number, month: number): ProfileValue<NormalizedDate> => rv({ year, month });

function job(overrides: Partial<Employment> = {}): Employment {
  return {
    id: 'j1',
    company: rv('Acme Corp'),
    title: rv('Software Engineer'),
    location: emptyValue<string>(),
    startDate: date(2021, 6),
    endDate: date(2023, 8),
    currentlyEmployed: emptyValue<boolean>(),
    description: emptyValue<string>(),
    bullets: emptyValue<string[]>(),
    ...overrides,
  };
}

/** Renders the section over real state, the way the import screen does. */
function Harness({
  parsed,
  existing,
  onChange,
}: {
  parsed: Employment[];
  existing: Employment[];
  onChange: (reviews: EntryReview<Employment>[]) => void;
}): ReactNode {
  const [reviews, setReviews] = useState<EntryReview<Employment>[]>(() =>
    reviewEntries('employment', parsed, existing),
  );
  return (
    <EmploymentReview
      reviews={reviews}
      onChange={(index, next) =>
        setReviews((current) => {
          const updated = current.map((review, at) => (at === index ? next : review));
          onChange(updated);
          return updated;
        })
      }
    />
  );
}

function renderReview(
  parsed: Employment[],
  existing: Employment[] = [],
): { latest: () => EntryReview<Employment>[] } {
  cleanup();
  let current = reviewEntries('employment', parsed, existing);
  render(<Harness parsed={parsed} existing={existing} onChange={(next) => (current = next)} />);
  return { latest: () => current };
}

describe('reviewEntries', () => {
  it('defaults a new entry to being added', () => {
    expect(reviewEntries('employment', [job()], [])[0]).toMatchObject({
      decision: 'add',
      match: null,
    });
  });

  it('defaults an entry the profile already holds to being skipped', () => {
    // Skip, not update, and certainly not add. The user re-uploaded a resume;
    // the safe reading of that is "I want my profile current", not "duplicate
    // everything" - and skipping is the only choice that changes nothing.
    const review = reviewEntries('employment', [job({ id: 'parsed' })], [job({ id: 'held' })])[0];
    expect(review?.decision).toBe('skip');
    expect(review?.match?.index).toBe(0);
  });

  it('reports how many blank fields an update would fill in', () => {
    const held = job({ id: 'held', location: emptyValue<string>() });
    const parsed = job({ id: 'parsed', location: rv('Remote') });
    expect(reviewEntries('employment', [parsed], [held])[0]?.gain).toBe(1);
  });
});

describe('EmploymentReview', () => {
  it('gives every entry its own checkbox', () => {
    renderReview([
      job({ id: 'a', company: rv('Acme') }),
      job({ id: 'b', company: rv('Globex') }),
    ]);
    expect(screen.getAllByRole('checkbox', { name: /include/i })).toHaveLength(2);
  });

  it('unchecking one entry leaves the other alone', () => {
    const { latest } = renderReview([
      job({ id: 'a', company: rv('Acme') }),
      job({ id: 'b', company: rv('Globex') }),
    ]);

    fireEvent.click(screen.getAllByRole('checkbox', { name: /include/i })[1] as HTMLElement);

    expect(latest().map((review) => review.decision)).toEqual(['add', 'skip']);
  });

  it('says which entry is already in the profile, and why we think so', () => {
    renderReview([job({ id: 'parsed' })], [job({ id: 'held' })]);
    expect(screen.getByText(/already in your profile/i)).toBeTruthy();
    expect(screen.getByText(/same company and title/i)).toBeTruthy();
  });

  it('offers update as a choice on a duplicate, and applies it', () => {
    const { latest } = renderReview(
      [job({ id: 'parsed', location: rv('Remote') })],
      [job({ id: 'held' })],
    );

    fireEvent.click(screen.getByRole('radio', { name: /update/i }));

    expect(latest()[0]).toMatchObject({ decision: 'update' });
  });

  it('offers adding a duplicate anyway, for the two-stints case', () => {
    const { latest } = renderReview([job({ id: 'parsed' })], [job({ id: 'held' })]);
    fireEvent.click(screen.getByRole('radio', { name: /separate/i }));
    expect(latest()[0]).toMatchObject({ decision: 'add' });
  });

  it('does not offer an update that would change nothing', () => {
    // The parsed entry has no field the profile lacks, so "update existing"
    // would be a button that does nothing. Offering it would teach the user
    // that the choice does not matter.
    renderReview([job({ id: 'parsed' })], [job({ id: 'held' })]);
    expect(screen.queryByRole('radio', { name: /update/i })).toBeNull();
  });

  it('lets a mis-parsed value be corrected before it is committed', () => {
    const { latest } = renderReview([job({ id: 'parsed', title: rv('Sofware Enginer') })]);

    fireEvent.change(screen.getByLabelText(/job title/i), {
      target: { value: 'Software Engineer' },
    });

    expect(latest()[0]?.entry.title.value).toBe('Software Engineer');
  });

  it('marks a corrected value as verified by the user', () => {
    // Typing into the review screen is the same act as typing into the profile
    // editor, and must carry the same authority - otherwise a value the user
    // personally fixed would still be overwritable by the next parse.
    const { latest } = renderReview([job({ id: 'parsed', title: rv('Sofware Enginer') })]);

    fireEvent.change(screen.getByLabelText(/job title/i), {
      target: { value: 'Software Engineer' },
    });

    expect(latest()[0]?.entry.title.evidence[0]?.verifiedByUser).toBe(true);
  });

  it('renders nothing at all when the resume had no jobs in it', () => {
    const { container } = render(<EmploymentReview reviews={[]} onChange={() => undefined} />);
    expect(container.textContent).toBe('');
  });
});

describe('applyReviews', () => {
  const held = job({ id: 'held', location: emptyValue<string>() });

  function profileWith(employment: Employment[]): ApplicantProfile {
    return { ...createEmptyProfile('test', '2026-01-01T00:00:00.000Z'), employment };
  }

  it('never lets an unchecked entry reach the profile', () => {
    const reviews = {
      ...NO_ENTRIES,
      employment: [{ ...(reviewEntries('employment', [job({ id: 'parsed' })], [])[0] as EntryReview<Employment>), decision: 'skip' as const }],
    };

    const result = applyReviews(profileWith([]), reviews);
    expect(result.profile.employment).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('merges an update into the entry the profile already holds', () => {
    const reviews = {
      ...NO_ENTRIES,
      employment: [
        {
          ...(reviewEntries('employment', [job({ id: 'parsed', location: rv('Remote') })], [held])[0] as EntryReview<Employment>),
          decision: 'update' as const,
        },
      ],
    };

    const result = applyReviews(profileWith([held]), reviews);
    expect(result.profile.employment).toHaveLength(1);
    expect(result.profile.employment[0]?.id).toBe('held');
    expect(result.profile.employment[0]?.location.value).toBe('Remote');
    expect(result.updated).toBe(1);
  });

  it('counts across all three collections at once', () => {
    const reviews = {
      ...NO_ENTRIES,
      employment: reviewEntries('employment', [job({ id: 'a' }), job({ id: 'b', company: rv('Globex') })], []),
    };
    expect(applyReviews(profileWith([]), reviews)).toMatchObject({ added: 2, updated: 0, skipped: 0 });
  });

  it('leaves the rest of the profile alone', () => {
    const before = profileWith([]);
    const after = applyReviews(before, NO_ENTRIES).profile;
    expect(after.identity).toBe(before.identity);
    expect(after.employment).toEqual([]);
  });
});

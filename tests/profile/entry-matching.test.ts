/**
 * Duplicate detection and field-wise merging for repeated profile entries.
 *
 * These tests encode the two rules the resume re-import path depends on:
 *
 *   1. Re-uploading the same resume must RECOGNISE the jobs and schools it
 *      already put in the profile, rather than appending a second copy.
 *   2. Merging an existing entry with a freshly parsed one must never overwrite
 *      something the user personally verified - the same guarantee
 *      `mergeCandidates` makes for scalar fields, extended to list entries.
 */
import { describe, expect, it } from 'vitest';
import { applyEntryDecisions, findDuplicate, mergeEntry } from '@profile/entry-matching';
import {
  emptyValue,
  resumeValue,
  userValue,
  type Education,
  type Employment,
  type Project,
  type ProfileValue,
} from '@profile/schema';
import type { NormalizedDate } from '@profile/normalizers/date';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const rv = <T,>(value: T, confidence = 0.9): ProfileValue<T> =>
  resumeValue(value, { confidence });

const date = (year: number, month?: number): ProfileValue<NormalizedDate> =>
  rv({ year, ...(month === undefined ? {} : { month }) }, 0.9);

const present = (): ProfileValue<NormalizedDate> => rv({ isPresent: true }, 0.9);

function job(overrides: Partial<Employment> = {}): Employment {
  return {
    id: 'e1',
    company: rv('Acme Corp', 0.9),
    title: rv('Software Engineer', 0.9),
    location: emptyValue<string>(),
    startDate: date(2021, 6),
    endDate: date(2023, 8),
    currentlyEmployed: emptyValue<boolean>(),
    description: emptyValue<string>(),
    bullets: emptyValue<string[]>(),
    ...overrides,
  };
}

function school(overrides: Partial<Education> = {}): Education {
  return {
    id: 's1',
    institution: rv('Rutgers University', 0.9),
    degree: rv('Bachelor of Science', 0.9),
    fieldOfStudy: rv('Computer Science', 0.9),
    startDate: date(2017, 9),
    graduationDate: date(2021, 5),
    gpa: emptyValue<string>(),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: rv('ShiftFlow', 0.9),
    description: emptyValue<string>(),
    technologies: emptyValue<string[]>(),
    url: emptyValue<string>(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findDuplicate - employment
// ---------------------------------------------------------------------------

describe('findDuplicate: employment', () => {
  it('matches the same job re-parsed from the same resume', () => {
    const match = findDuplicate('employment', job({ id: 'new' }), [job()]);
    expect(match?.index).toBe(0);
  });

  it('ignores legal suffixes, case and punctuation on the company name', () => {
    const incoming = job({ id: 'new', company: rv('ACME CORPORATION, INC.', 0.9) });
    expect(findDuplicate('employment', incoming, [job()])?.index).toBe(0);
  });

  it('treats "&" and "and" as the same company', () => {
    const existing = job({ company: userValue('Johnson & Johnson') });
    const incoming = job({ id: 'new', company: rv('Johnson and Johnson', 0.9) });
    expect(findDuplicate('employment', incoming, [existing])?.index).toBe(0);
  });

  it('matches a promotion at the same company by overlapping dates', () => {
    // Title differs, but the date ranges are the same stint. This is the
    // "Software Engineer" -> "Software Engineer II" re-parse, which must not
    // silently become two jobs.
    const incoming = job({ id: 'new', title: rv('Senior Platform Engineer', 0.9) });
    expect(findDuplicate('employment', incoming, [job()])?.index).toBe(0);
  });

  it('matches a longer title that contains the shorter one', () => {
    const incoming = job({
      id: 'new',
      title: rv('Software Engineer II', 0.9),
      startDate: date(2024, 1),
      endDate: present(),
    });
    expect(findDuplicate('employment', incoming, [job()])?.index).toBe(0);
  });

  it('does NOT match two separate stints at the same company', () => {
    // Same company, different title, no date overlap: an intern who came back
    // years later has genuinely two entries, and collapsing them loses a job.
    const incoming = job({
      id: 'new',
      title: rv('Product Manager', 0.9),
      startDate: date(2016, 6),
      endDate: date(2016, 9),
    });
    expect(findDuplicate('employment', incoming, [job()])).toBeNull();
  });

  it('does NOT match a different company with the same title', () => {
    const incoming = job({ id: 'new', company: rv('Globex', 0.9) });
    expect(findDuplicate('employment', incoming, [job()])).toBeNull();
  });

  it('treats an open-ended "Present" end date as overlapping later dates', () => {
    const existing = job({ endDate: present() });
    const incoming = job({
      id: 'new',
      title: rv('Staff Engineer', 0.9),
      startDate: date(2024, 3),
      endDate: date(2025, 1),
    });
    expect(findDuplicate('employment', incoming, [existing])?.index).toBe(0);
  });

  it('returns the index of the matching entry, not the first entry', () => {
    const other = job({ id: 'other', company: rv('Globex', 0.9) });
    expect(findDuplicate('employment', job({ id: 'new' }), [other, job()])?.index).toBe(1);
  });

  it('finds nothing in an empty profile', () => {
    expect(findDuplicate('employment', job(), [])).toBeNull();
  });

  it('never matches an entry whose company was never read', () => {
    // Two entries that both failed to parse a company are not thereby the same
    // job. A blank key must match nothing.
    const blank = job({ company: emptyValue<string>() });
    expect(findDuplicate('employment', blank, [blank])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findDuplicate - education
// ---------------------------------------------------------------------------

describe('findDuplicate: education', () => {
  it('matches the same degree at the same school', () => {
    expect(findDuplicate('education', school({ id: 'new' }), [school()])?.index).toBe(0);
  });

  it('matches on graduation year when the degree is worded differently', () => {
    const incoming = school({ id: 'new', degree: rv('BS', 0.9) });
    expect(findDuplicate('education', incoming, [school()])?.index).toBe(0);
  });

  it('does NOT match a masters and a bachelors at the same school', () => {
    const incoming = school({
      id: 'new',
      degree: rv('Master of Science', 0.9),
      graduationDate: date(2023, 5),
    });
    expect(findDuplicate('education', incoming, [school()])).toBeNull();
  });

  it('does NOT match the same degree at a different school', () => {
    const incoming = school({ id: 'new', institution: rv('Princeton', 0.9) });
    expect(findDuplicate('education', incoming, [school()])).toBeNull();
  });

  it('never matches an entry whose institution was never read', () => {
    const blank = school({ institution: emptyValue<string>() });
    expect(findDuplicate('education', blank, [blank])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findDuplicate - projects
// ---------------------------------------------------------------------------

describe('findDuplicate: projects', () => {
  it('matches the same project name ignoring case and punctuation', () => {
    const incoming = project({ id: 'new', name: rv('shift-flow', 0.9) });
    expect(findDuplicate('projects', incoming, [project()])?.index).toBe(0);
  });

  it('does NOT match a name that merely contains another', () => {
    // "Chat" and "Chat App" are plausibly two different projects, and unlike
    // job titles there is no company or date range to corroborate a merge.
    const existing = project({ name: rv('Chat', 0.9) });
    const incoming = project({ id: 'new', name: rv('Chat App', 0.9) });
    expect(findDuplicate('projects', incoming, [existing])).toBeNull();
  });

  it('never matches an entry whose name was never read', () => {
    const blank = project({ name: emptyValue<string>() });
    expect(findDuplicate('projects', blank, [blank])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeEntry
// ---------------------------------------------------------------------------

describe('mergeEntry', () => {
  it('keeps the existing id so learned mappings keep pointing at the same job', () => {
    const merged = mergeEntry(job({ id: 'kept' }), job({ id: 'incoming' }));
    expect(merged.id).toBe('kept');
  });

  it('fills a field the existing entry never had', () => {
    const existing = job({ location: emptyValue<string>() });
    const incoming = job({ location: rv('New Brunswick, NJ', 0.9) });
    expect(mergeEntry(existing, incoming).location.value).toBe('New Brunswick, NJ');
  });

  it('refuses to overwrite a value the user verified', () => {
    const existing = job({ title: userValue('Software Engineer II') });
    const incoming = job({ title: rv('Software Engineer', 0.95) });
    expect(mergeEntry(existing, incoming).title.value).toBe('Software Engineer II');
  });

  it('refuses to overwrite an unverified value that is merely older', () => {
    // The existing value came from a previous parse, not from the user, but it
    // is still a value. Silently swapping it would make re-uploading a resume
    // a destructive act.
    const existing = job({ title: rv('Software Engineer', 0.6) });
    const incoming = job({ title: rv('Engineer', 0.95) });
    expect(mergeEntry(existing, incoming).title.value).toBe('Software Engineer');
  });

  it('treats an empty string as absent, not as a value worth keeping', () => {
    const existing = job({ location: rv('   ', 0.4) });
    const incoming = job({ location: rv('Remote', 0.9) });
    expect(mergeEntry(existing, incoming).location.value).toBe('Remote');
  });

  it('treats an empty list as absent', () => {
    const existing = job({ bullets: rv<string[]>([], 0.4) });
    const incoming = job({ bullets: rv(['Shipped the thing'], 0.9) });
    expect(mergeEntry(existing, incoming).bullets.value).toEqual(['Shipped the thing']);
  });

  it('treats a date with nothing in it as absent', () => {
    const existing = job({ endDate: rv<NormalizedDate>({}, 0.3) });
    const incoming = job({ endDate: date(2023, 8) });
    expect(mergeEntry(existing, incoming).endDate.value?.year).toBe(2023);
  });

  it('carries the incoming evidence when the incoming value wins', () => {
    const existing = job({ location: emptyValue<string>() });
    const incoming = job({ location: rv('Remote', 0.9) });
    expect(mergeEntry(existing, incoming).location.evidence.length).toBeGreaterThan(0);
  });

  it('leaves both entries untouched', () => {
    const existing = job({ location: emptyValue<string>() });
    const incoming = job({ location: rv('Remote', 0.9) });
    mergeEntry(existing, incoming);
    expect(existing.location.value).toBeNull();
    expect(incoming.location.value).toBe('Remote');
  });

  it('merges education and projects by the same rule', () => {
    const mergedSchool = mergeEntry(school({ gpa: emptyValue<string>() }), school({ gpa: rv('3.8', 0.9) }));
    expect(mergedSchool.gpa.value).toBe('3.8');

    const mergedProject = mergeEntry(
      project({ url: userValue('https://kept.example') }),
      project({ url: rv('https://parsed.example', 0.9) }),
    );
    expect(mergedProject.url.value).toBe('https://kept.example');
  });
});

// ---------------------------------------------------------------------------
// applyEntryDecisions
// ---------------------------------------------------------------------------

describe('applyEntryDecisions', () => {
  it('appends the entries marked add, in order', () => {
    const a = job({ id: 'a', company: rv('Globex') });
    const b = job({ id: 'b', company: rv('Initech') });
    const result = applyEntryDecisions([], [
      { entry: a, decision: 'add' },
      { entry: b, decision: 'add' },
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(result.added).toBe(2);
  });

  it('drops the entries marked skip without touching the rest', () => {
    const existing = [job({ id: 'held' })];
    const result = applyEntryDecisions(existing, [
      { entry: job({ id: 'new' }), decision: 'skip', matchIndex: 0 },
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(['held']);
    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
  });

  it('merges an update into the matched entry rather than appending it', () => {
    const existing = [job({ id: 'held', location: emptyValue<string>() })];
    const result = applyEntryDecisions(existing, [
      { entry: job({ id: 'parsed', location: rv('Remote') }), decision: 'update', matchIndex: 0 },
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe('held');
    expect(result.entries[0]?.location.value).toBe('Remote');
    expect(result.updated).toBe(1);
  });

  it('updates the matched entry, not the first one', () => {
    const existing = [
      job({ id: 'other', company: rv('Globex') }),
      job({ id: 'held', location: emptyValue<string>() }),
    ];
    const result = applyEntryDecisions(existing, [
      { entry: job({ id: 'parsed', location: rv('Remote') }), decision: 'update', matchIndex: 1 },
    ]);

    expect(result.entries[0]?.location.value).toBeNull();
    expect(result.entries[1]?.location.value).toBe('Remote');
  });

  it('appends rather than losing an update whose match index is gone', () => {
    // Defensive: the profile could have changed between the parse and the
    // click. Appending shows the user a duplicate they can delete; dropping
    // the entry silently loses data they asked to keep.
    const result = applyEntryDecisions([job({ id: 'held' })], [
      { entry: job({ id: 'parsed' }), decision: 'update', matchIndex: 7 },
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(['held', 'parsed']);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('leaves the existing array untouched', () => {
    const existing = [job({ id: 'held', location: emptyValue<string>() })];
    applyEntryDecisions(existing, [
      { entry: job({ id: 'parsed', location: rv('Remote') }), decision: 'update', matchIndex: 0 },
    ]);
    expect(existing[0]?.location.value).toBeNull();
  });

  it('reports nothing happening when every entry was skipped', () => {
    const result = applyEntryDecisions([], [{ entry: job(), decision: 'skip' }]);
    expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(result.entries).toEqual([]);
  });
});

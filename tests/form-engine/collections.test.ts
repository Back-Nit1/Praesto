/**
 * Mapping into the repeated collections.
 *
 * These are the fields that make a resume worth importing. Before this path
 * existed, the education/employment/project alias tables were dead code: a
 * fully populated profile still could not answer "School", "Degree",
 * "Employer" or "Job title", because nothing turned those words into an
 * indexed path.
 *
 * The two properties under test are the two halves of the design:
 *   1. an alias that only ONE collection claims is enough on its own;
 *   2. an alias that several claim needs the section heading, and without it
 *      must not be filled on our own authority.
 */
import { describe, expect, it } from 'vitest';
import { mapField } from '@form-engine/mapper/mapper';
import { DEFAULT_CONFIDENCE_POLICY } from '@form-engine/confidence/policy';
import { descriptor } from '../helpers/descriptors';

const AUTOFILL = DEFAULT_CONFIDENCE_POLICY.autofillThreshold;

describe('mapField - unambiguous repeated-entity fields', () => {
  const cases: Array<[string, string]> = [
    ['School', 'education[0].institution'],
    ['University name', 'education[0].institution'],
    ['Degree', 'education[0].degree'],
    ['Major', 'education[0].fieldOfStudy'],
    ['GPA', 'education[0].gpa'],
    ['Employer', 'employment[0].company'],
    ['Job title', 'employment[0].title'],
    ['Project name', 'projects[0].name'],
  ];

  it.each(cases)('maps "%s" to %s and is willing to fill it', (label, expected) => {
    const result = mapField(descriptor({ label }));
    expect(result.profilePath).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(AUTOFILL);
  });

  it('maps a namespaced name attribute the same way', () => {
    // Real Greenhouse markup namespaces its inputs. The attribute path has to
    // reach the collection tables too, or the mapping works only on forms that
    // happen to carry a readable <label>.
    const result = mapField(descriptor({ name: 'job_application[school]' }));
    expect(result.profilePath).toBe('education[0].institution');
  });
});

describe('mapField - the entry an unqualified question means', () => {
  it('addresses the entry index the caller supplies', () => {
    // The mapper does not read a profile - it is handed "which school" by the
    // service worker, which computes it from profile/selectors.ts. This is what
    // keeps the whole mapping cascade testable without a profile at all.
    const result = mapField(descriptor({ label: 'School' }), {
      entryIndexes: { education: 2, employment: 1, projects: 0 },
    });
    expect(result.profilePath).toBe('education[2].institution');
  });

  it('defaults to the first entry when the caller says nothing', () => {
    const result = mapField(descriptor({ label: 'Employer' }));
    expect(result.profilePath).toBe('employment[0].company');
  });
});

describe('mapField - section context resolves the collisions', () => {
  it('reads "Start date" under an Education heading as the education start date', () => {
    const result = mapField(
      descriptor({ label: 'Start date', sectionHeading: 'Education' }),
    );
    expect(result.profilePath).toBe('education[0].startDate');
    // The heading is a structural fact about the form, not a rival reading of
    // the label, so it is allowed to be filled.
    expect(result.confidence).toBeGreaterThanOrEqual(AUTOFILL);
  });

  it('reads the same words under a Work Experience heading as the job start date', () => {
    const result = mapField(
      descriptor({ label: 'Start date', sectionHeading: 'Work experience' }),
    );
    expect(result.profilePath).toBe('employment[0].startDate');
  });

  it('reads an unqualified "Start date" as the availability question', () => {
    // No section says otherwise, so the question is about the applicant rather
    // than about one entry in a list - and the alternatives are still reported.
    const result = mapField(descriptor({ label: 'Start date' }));
    expect(result.profilePath).toBe('applicationPreferences.availableStartDate');
    expect((result.alternatives ?? []).length).toBeGreaterThan(0);
  });

  it('does not let a repeated-entity reading demote an ordinary contact field', () => {
    // "City" is also an alias for an employment location. Left unqualified it
    // is where the applicant lives, and treating the two readings as evenly
    // matched would send every address block to "needs review".
    const result = mapField(descriptor({ label: 'City' }));
    expect(result.profilePath).toBe('contact.city');
    expect(result.confidence).toBeGreaterThanOrEqual(AUTOFILL);
  });

  it('reads "City" inside an employment block as that job\'s location', () => {
    const result = mapField(
      descriptor({ label: 'City', sectionHeading: 'Employment history' }),
    );
    expect(result.profilePath).toBe('employment[0].location');
  });

  it('ignores a heading that names two collections at once', () => {
    // "Education and work history" tells us the page groups them, which tells
    // us nothing about which one this field belongs to. Guessing from a
    // heading like that is worse than not using it.
    const result = mapField(
      descriptor({ label: 'End date', sectionHeading: 'Education and work history' }),
    );
    expect(result.confidence).toBeLessThan(AUTOFILL);
  });
});

describe('mapField - repeated-entity fields still refuse to guess', () => {
  it('scores a match on a truncated attribute below the autofill line', () => {
    // "previous_employer_company" truncating to "company" must not be able to
    // fill on its own: dropping a prefix can invert what a field means.
    const result = mapField(descriptor({ name: 'previous_employer_company' }));
    expect(result.profilePath).toBe('employment[0].company');
    expect(result.confidence).toBeLessThan(AUTOFILL);
  });

  it('leaves a repeated-entity field alone when the user said to', () => {
    const learned = {
      find: () => ({
        id: 'rule-1',
        scope: 'global' as const,
        semanticFingerprint: 'x',
        profilePath: '',
        userConfirmed: true,
        successfulUses: 0,
        correctedUses: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const result = mapField(descriptor({ label: 'School' }), { learned });
    expect(result.profilePath).toBeNull();
  });
});

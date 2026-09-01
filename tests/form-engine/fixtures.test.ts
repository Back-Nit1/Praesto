// @vitest-environment jsdom
/**
 * Fixture integration tests.
 * ---------------------------------------------------------------------------
 * The only tests in the suite that need a DOM. They run the FULL pipeline -
 * scan, map, resolve, decide - over real HTML, which is what catches the class
 * of bug the unit tests cannot: a descriptor the scanner builds differently
 * from how the hand-written test helper builds it.
 *
 * Spec section 25.3 defines the loop these fixtures serve:
 *
 *     real failure -> reproduce as fixture -> failing test -> fix the generic
 *     engine -> keep the regression forever
 *
 * When a real application misbehaves, the fix starts by adding its markup to
 * fixtures/forms/ and a case here. Nothing is fixed by special-casing a site.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { scanPage } from '@form-engine/detector/scanner';
import { mapField } from '@form-engine/mapper/mapper';
import { resolveValue } from '@form-engine/resolver/resolver';
import { decideFill } from '@form-engine/confidence/policy';
import { __setRuntimeBudgetForTesting, budgetFor } from '@shared/runtime-budget';
import {
  createEmptyProfile,
  emptyValue,
  userValue,
  type ApplicantProfile,
  type Education,
  type Employment,
} from '@profile/schema';
import { parsePhone } from '@profile/normalizers/phone';
import { parseDate } from '@profile/normalizers/date';
import type { FieldDescriptor } from '@form-engine/descriptor/types';

/**
 * Load a fixture into the jsdom document.
 *
 * Resolved from `process.cwd()` rather than `import.meta.url`: under the jsdom
 * environment, `import.meta.url` is rebased onto the fake document origin
 * (`http://localhost/`), so a relative URL resolves to a path that does not
 * exist on disk. Vitest always runs from the project root, which makes cwd the
 * stable anchor here.
 */
function loadFixture(name: string): Document {
  const path = resolve(process.cwd(), 'fixtures/forms', name);
  document.documentElement.innerHTML = readFileSync(path, 'utf-8');
  return document;
}

/**
 * jsdom reports every element as zero-size and with a null offsetParent,
 * because it does no layout. The scanner's visibility check would therefore
 * reject everything. Stubbing these two is the minimum needed to make layout-
 * dependent code testable, and it is honest about what it fakes.
 */
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      // Mirror the real rule: a `display:none` element has no offsetParent.
      return window.getComputedStyle(this as HTMLElement).display === 'none'
        ? null
        : (this as HTMLElement).parentElement;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 } as DOMRect;
  };
}

/** A fully verified profile, so value confidence never masks a mapping bug. */
function verifiedProfile(): ApplicantProfile {
  const profile = createEmptyProfile('fixture-profile');
  profile.identity.legalFirstName = userValue('Nityanth');
  profile.identity.lastName = userValue('Maramreddy');
  profile.contact.email = userValue('applicant@example.com');

  const phone = parsePhone('(609) 555-1234');
  if (phone !== null) profile.contact.phone = userValue(phone, '(609) 555-1234');

  profile.links.linkedin = userValue('https://www.linkedin.com/in/example');
  profile.links.github = userValue('https://github.com/example');
  profile.contact.country = userValue('United States');
  profile.contact.state = userValue('Virginia');

  const grad = parseDate('May 2027');
  if (grad !== null) profile.applicationPreferences.availableStartDate = userValue(grad);

  return profile;
}

/**
 * A profile with a history, for the fixtures that ask about one.
 *
 * Two degrees and two jobs, most-recent LAST, because that is the order people
 * type them in and the order a resume lists them - which is exactly what makes
 * "which one does an unqualified 'School' mean" a real question rather than an
 * academic one.
 */
function profileWithHistory(): ApplicantProfile {
  const profile = verifiedProfile();

  profile.education = [
    education({ institution: 'Rutgers University', degree: "Bachelor's Degree", field: 'Computer Science', graduation: 'May 2025', gpa: '3.7' }),
    education({ institution: 'Georgia Institute of Technology', degree: "Master's Degree", field: 'Computer Science', graduation: 'May 2027', gpa: '3.9' }),
  ];

  profile.employment = [
    employment({ company: 'Northwind Systems', title: 'Software Engineer Intern', location: 'Newark, NJ', start: 'June 2024', end: 'August 2024' }),
    employment({ company: 'Acme Robotics', title: 'Software Engineer', location: 'Remote', start: 'January 2026', current: true }),
  ];

  return profile;
}

function education(fields: {
  institution: string;
  degree: string;
  field: string;
  graduation: string;
  gpa: string;
}): Education {
  const graduation = parseDate(fields.graduation);
  return {
    id: `edu-${fields.institution.toLowerCase().replace(/\W+/g, '-')}`,
    institution: userValue(fields.institution),
    degree: userValue(fields.degree),
    fieldOfStudy: userValue(fields.field),
    startDate: emptyValue(),
    graduationDate: graduation === null ? emptyValue() : userValue(graduation, fields.graduation),
    gpa: userValue(fields.gpa),
  };
}

function employment(fields: {
  company: string;
  title: string;
  location: string;
  start: string;
  end?: string;
  current?: boolean;
}): Employment {
  const start = parseDate(fields.start);
  const end = fields.end === undefined ? null : parseDate(fields.end);
  return {
    id: `job-${fields.company.toLowerCase().replace(/\W+/g, '-')}`,
    company: userValue(fields.company),
    title: userValue(fields.title),
    location: userValue(fields.location),
    startDate: start === null ? emptyValue() : userValue(start, fields.start),
    endDate: end === null ? emptyValue() : userValue(end, fields.end),
    currentlyEmployed: userValue(fields.current === true),
    description: emptyValue(),
    bullets: emptyValue(),
  };
}

/** Run the whole pipeline over a fixture, as the service worker would. */
async function analyse(fixture: string, withProfile: ApplicantProfile = verifiedProfile()) {
  const doc = loadFixture(fixture);
  const { result } = await scanPage(doc, { ats: 'unknown' });
  const profile = withProfile;

  return result.fields.map((field: FieldDescriptor) => {
    const mapping = mapField(field);
    const resolution =
      mapping.profilePath === null ? undefined : resolveValue(profile, mapping.profilePath, field);

    const decision =
      mapping.profilePath === null
        ? ('skip' as const)
        : decideFill({
            mappingConfidence: mapping.confidence,
            valueConfidence: resolution?.ok === true ? resolution.resolved.confidence : 0,
            valueVerifiedByUser: resolution?.ok === true ? resolution.resolved.verifiedByUser : false,
            profilePath: mapping.profilePath,
            valueMissing: resolution?.ok !== true,
            controlHasValue: (field.currentValue ?? '').length > 0,
          });

    return {
      label: field.label ?? field.name ?? field.localId,
      name: field.name,
      required: field.required,
      path: mapping.profilePath,
      confidence: mapping.confidence,
      decision,
      value: resolution?.ok === true ? resolution.resolved.value : undefined,
    };
  });
}

beforeEach(() => {
  stubLayout();
  // Pin the budget so a scan's chunking is identical regardless of the machine
  // the test runs on. Without this, CI and a laptop could scan differently.
  __setRuntimeBudgetForTesting(budgetFor(8, 8));
});

describe('fixture: basic-contact.html', () => {
  it('fills every well-marked-up contact field', async () => {
    const results = await analyse('basic-contact.html');
    const byPath = new Map(results.map((r) => [r.path as string | null, r]));

    for (const path of [
      'identity.legalFirstName',
      'identity.lastName',
      'contact.email',
      'contact.phone',
      'links.linkedin',
      'links.github',
    ]) {
      const result = byPath.get(path);
      expect(result, `expected a field mapped to ${path}`).toBeDefined();
      // 'autofill' is the POLICY's verb. The service worker translates it to
      // the wire action 'fill' when it builds the response; the two
      // vocabularies are kept distinct so a change to one does not silently
      // redefine the other.
      expect(result?.decision, path).toBe('autofill');
    }
  });

  it('formats the phone number to match the placeholder the form showed', async () => {
    const results = await analyse('basic-contact.html');
    const phone = results.find((r) => r.path === 'contact.phone');
    expect(phone?.value).toBe('(609) 555-1234');
  });

  it('never describes the hidden CSRF token or the submit button as a field', async () => {
    const doc = loadFixture('basic-contact.html');
    const { result } = await scanPage(doc, { ats: 'unknown' });
    const names = result.fields.map((field) => field.name);
    expect(names).not.toContain('authenticity_token');
    expect(result.fields.some((f) => f.tag === 'button')).toBe(false);
  });
});

describe('fixture: radio-authorization.html', () => {
  it('recognises the legal questions as one field each, not one per option', async () => {
    const doc = loadFixture('radio-authorization.html');
    const { result } = await scanPage(doc, { ats: 'unknown' });
    // Three fieldsets, two radios each. Six inputs, three QUESTIONS.
    expect(result.fields).toHaveLength(3);
    for (const field of result.fields) {
      expect(field.options).toHaveLength(2);
    }
  });

  it('refuses to answer a work-authorization question the user has not answered', async () => {
    const results = await analyse('radio-authorization.html');
    for (const result of results) {
      // The profile deliberately leaves these unanswered. Recognising the
      // question is good; answering it from nothing would be a false statement.
      expect(result.decision, result.label).not.toBe('autofill');
    }
  });

  it('does not treat the negated phrasing as the same question', async () => {
    const doc = loadFixture('radio-authorization.html');
    const { result } = await scanPage(doc, { ats: 'unknown' });

    const negated = result.fields.find((field) => field.name === 'no_sponsorship');
    expect(negated).toBeDefined();
    if (negated === undefined) return;

    const plain = result.fields.find((field) => field.name === 'sponsorship');
    expect(plain).toBeDefined();
    if (plain === undefined) return;

    const negatedMapping = mapField(negated);
    const plainMapping = mapField(plain);

    // The plain phrasing is recognised, so the panel can surface it.
    expect(plainMapping.profilePath).toMatch(/requiresSponsorship/);

    // The negated phrasing must NOT end up confidently mapped to the same
    // concept - answering it with the plain question's answer would state the
    // exact opposite of the truth to an employer.
    //
    // Two acceptable outcomes, and the assertion allows either: the engine maps
    // it and flags the negation, or it declines to map it at all. As written
    // today the wording matches no alias and it maps to nothing, which is the
    // safer of the two.
    expect(negatedMapping.confidence).toBeLessThan(0.95);
    if (negatedMapping.profilePath !== null) {
      expect(negatedMapping.reasons.some((r) => r.signal === 'negation_detected')).toBe(true);
    }
  });
});

describe('fixture: ambiguous-fields.html', () => {
  it('does not fill any of the near-miss fields', async () => {
    const results = await analyse('ambiguous-fields.html');

    const emergency = results.find((r) => r.label?.toLowerCase().includes('emergency'));
    const reference = results.find((r) => r.label?.toLowerCase().includes('reference'));
    const essay = results.find((r) => r.label?.toLowerCase().includes('technically challenging'));

    // Each of these contains a phrase that a naive matcher would map, and each
    // would be a wrong answer on a real application.
    expect(emergency?.decision).not.toBe('autofill');
    expect(reference?.decision).not.toBe('autofill');
    expect(essay?.path).toBeNull();
  });

  it('never overwrites a field the user already filled', async () => {
    const results = await analyse('ambiguous-fields.html');
    const prefilled = results.find((r) => r.value === 'already@typed.example');
    // The engine may well recognise it as an email field. It must still not
    // touch it - the existing value may be exactly what the user wanted.
    expect(prefilled === undefined || prefilled.decision !== 'autofill').toBe(true);
  });
});

describe('fixture: native-select.html', () => {
  it('matches a country whose official option name is longer than our value', async () => {
    const results = await analyse('native-select.html');
    const country = results.find((r) => r.path === 'contact.country');
    expect(country?.value).toBe('US');
  });

  it('does not select West Virginia when the applicant lives in Virginia', async () => {
    const results = await analyse('native-select.html');
    const state = results.find((r) => r.path === 'contact.state');
    // Either it matches "Virginia" exactly, or it refuses. It must never
    // resolve to the West Virginia option.
    expect(state?.value).not.toBe('WV');
  });

  it('splits a month-year date across separate month and year dropdowns', async () => {
    const doc = loadFixture('native-select.html');
    const { result } = await scanPage(doc, { ats: 'unknown' });
    const profile = verifiedProfile();

    const monthField = result.fields.find((f) => f.name === 'grad_month');
    const yearField = result.fields.find((f) => f.name === 'grad_year');
    expect(monthField).toBeDefined();
    expect(yearField).toBeDefined();
    if (monthField === undefined || yearField === undefined) return;

    const path = 'applicationPreferences.availableStartDate';
    const month = resolveValue(profile, path, monthField);
    const year = resolveValue(profile, path, yearField);

    expect(month.ok && month.resolved.value).toBe('5');
    expect(year.ok && year.resolved.value).toBe('2027');
  });
});

describe('fixture: education.html', () => {
  it('answers a plainly labelled degree block from the profile', async () => {
    const results = await analyse('education.html', profileWithHistory());
    const bySchool = results.find((r) => r.name === 'school');

    expect(bySchool?.path).toBe('education[0].institution');
    expect(bySchool?.decision).toBe('autofill');
  });

  it('reads the GPA as the string the institution issued, not as a number', async () => {
    const results = await analyse('education.html', profileWithHistory());
    const gpa = results.find((r) => r.name === 'gpa');

    expect(gpa?.value).toBe('3.7');
  });

  it('marks the school field required, because the form did', async () => {
    const results = await analyse('education.html', profileWithHistory());

    expect(results.find((r) => r.name === 'school')?.required).toBe(true);
    expect(results.find((r) => r.name === 'gpa')?.required).toBe(false);
  });

  it('answers a SECOND school block from the first degree - the known limitation', async () => {
    // Recorded rather than asserted as correct. Nothing in the markup of the
    // second block says "second"; only the legend does, and the mapper is not
    // given an entry index here. Limitation 3 in IMPLEMENTATION_STATUS.md, and
    // the fixture that will fail the day it is fixed.
    const results = await analyse('education.html', profileWithHistory());
    const second = results.find((r) => r.name === 'school_2');

    expect(second?.path).toBe('education[0].institution');
  });
});

describe('fixture: employment.html', () => {
  it('answers employer and job title from the profile', async () => {
    const results = await analyse('employment.html', profileWithHistory());

    expect(results.find((r) => r.name === 'company')?.path).toBe('employment[0].company');
    expect(results.find((r) => r.name === 'title')?.path).toBe('employment[0].title');
  });

  it('leaves the free-text responsibilities box alone', async () => {
    // There is an `employment[].description` in the profile, and nothing says
    // this box wants the same prose. Composing one is out of scope; writing the
    // wrong one into an application is worse than leaving it blank.
    const results = await analyse('employment.html', profileWithHistory());
    const duties = results.find((r) => r.name === 'description');

    expect(duties?.decision).toBe('skip');
  });

  it('answers "I currently work here" only from a value the user stated', async () => {
    // The checkbox changes what the end date MEANS. Getting it wrong does not
    // leave a blank - it states something false about the applicant. So it is
    // filled when the profile says so and refused when it does not, rather than
    // inferred from an absent end date.
    const stated = await analyse('employment.html', profileWithHistory());
    expect(stated.find((r) => r.name === 'currently_employed')?.decision).toBe('autofill');

    const unstated = profileWithHistory();
    const firstJob = unstated.employment[0];
    if (firstJob !== undefined) firstJob.currentlyEmployed = emptyValue();

    const refused = await analyse('employment.html', unstated);
    expect(refused.find((r) => r.name === 'currently_employed')?.decision).not.toBe('autofill');
  });
});

describe('fixture: dynamic-dependent-question.html', () => {
  it('does not describe a question the page is still hiding', async () => {
    const doc = loadFixture('dynamic-dependent-question.html');
    const { result } = await scanPage(doc, { ats: 'unknown' });

    // A row in the panel for a question the user cannot see is a row they
    // cannot act on, and a fill into a box nobody is looking at.
    expect(result.fields.map((field) => field.name)).not.toContain('visa_type');
    expect(result.fields.map((field) => field.name)).toContain('requires_sponsorship');
  });

  it('describes it once the answer reveals it', async () => {
    const doc = loadFixture('dynamic-dependent-question.html');
    doc.getElementById('visa-details')?.removeAttribute('hidden');

    const { result } = await scanPage(doc, { ats: 'unknown' });

    expect(result.fields.map((field) => field.name)).toContain('visa_type');
  });

  it('refuses the sponsorship question rather than answering it from a guess', async () => {
    // Spec 21.3: work authorization needs an explicit user statement, and this
    // profile has not made one. A confident MAPPING is not permission.
    const results = await analyse('dynamic-dependent-question.html');
    const sponsorship = results.find((r) => r.name === 'requires_sponsorship');

    expect(sponsorship?.decision).not.toBe('autofill');
  });
});

describe('scanner behaviour', () => {
  it('reports a truncated scan rather than silently processing part of a page', async () => {
    const doc = loadFixture('basic-contact.html');
    const { result } = await scanPage(doc, { ats: 'unknown', maxFields: 2 });
    expect(result.truncated).toBe(true);
    expect(result.fields).toHaveLength(2);
  });

  it('returns element references that are not part of the serializable result', async () => {
    const doc = loadFixture('basic-contact.html');
    const { result, elements } = await scanPage(doc, { ats: 'unknown' });

    // Every described field has a live element behind it...
    for (const field of result.fields) {
      expect(elements.get(field.localId), field.localId).toBeInstanceOf(HTMLElement);
    }
    // ...and the part that crosses the message boundary carries no DOM node.
    expect(() => structuredClone(result)).not.toThrow();
  });
});

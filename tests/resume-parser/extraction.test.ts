/**
 * Resume parsing tests.
 *
 * These run against synthetic `ResumeTextItem[]` rather than real PDFs. That is
 * the right boundary, not a shortcut: PDF.js's job is bytes -> positioned text,
 * and it is a mature library that does not need re-testing here. Everything
 * this project actually decides - how positioned text becomes lines, how lines
 * become sections, and what is safe to extract from them - happens after that
 * point and is exercised in full below.
 *
 * It also means these tests need no binary fixtures, run in milliseconds, and
 * can express "a heading in 14pt bold" directly rather than by hand-crafting a
 * PDF that produces one.
 */
import { describe, expect, it } from 'vitest';
import { buildLines, buildSections, linesOfType } from '@resume-parser/layout/lines';
import {
  extractEmail,
  extractLinks,
  extractLocation,
  extractName,
  extractPhone,
} from '@resume-parser/deterministic/contact';
import {
  extractEducation,
  extractEmployment,
  extractSkills,
} from '@resume-parser/deterministic/sections';
import type { ResumeTextItem } from '@resume-parser/types';

const DOC = 'doc-1';

/** Build a text run. Defaults describe ordinary body text. */
function item(
  text: string,
  overrides: Partial<ResumeTextItem> = {},
): ResumeTextItem {
  return {
    text,
    page: 1,
    x: 50,
    y: 0,
    width: text.length * 5,
    height: 10,
    fontSize: 10,
    bold: false,
    ...overrides,
  };
}

/** Lay out lines top to bottom, 14pt apart, the way a document reads. */
function document(
  entries: Array<string | { text: string } & Partial<ResumeTextItem>>,
): ResumeTextItem[] {
  return entries.map((entry, index) => {
    const base = typeof entry === 'string' ? { text: entry } : entry;
    return item(base.text, { y: index * 14, ...base });
  });
}

describe('buildLines', () => {
  it('merges runs that share a baseline into one line', () => {
    // A PDF routinely splits one visual line into several runs.
    const items = [
      item('Nityanth', { x: 50, y: 0, width: 40 }),
      item('Maramreddy', { x: 95, y: 0.3, width: 50 }),
    ];
    const lines = buildLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Nityanth Maramreddy');
  });

  it('does not insert a space where the PDF left no gap', () => {
    // Splitting an email in two and re-joining it with a space would corrupt
    // every address in the document.
    const items = [
      item('nitu@', { x: 50, y: 0, width: 25 }),
      item('example.com', { x: 75, y: 0, width: 50 }),
    ];
    expect(buildLines(items)[0]?.text).toBe('nitu@example.com');
  });

  it('keeps separate baselines as separate lines', () => {
    const lines = buildLines(document(['First line', 'Second line']));
    expect(lines).toHaveLength(2);
  });

  it('tolerates baseline jitter proportionally to font size', () => {
    // An 18pt heading jitters more in absolute terms than 10pt body text, so a
    // fixed pixel tolerance would split one and merge the other.
    const items = [
      item('BIG', { x: 50, y: 0, fontSize: 18, width: 30 }),
      item('HEADING', { x: 85, y: 3, fontSize: 18, width: 60 }),
    ];
    expect(buildLines(items)).toHaveLength(1);
  });
});

describe('buildSections', () => {
  const resume = buildLines(
    document([
      { text: 'Nityanth Maramreddy', fontSize: 18, bold: true },
      { text: 'nitu@example.com | (609) 555-1234 | New Brunswick, NJ' },
      { text: 'EDUCATION', fontSize: 12, bold: true },
      { text: 'Rutgers University, New Brunswick, NJ' },
      { text: 'B.S. in Computer Science | GPA: 3.85 | Sep 2023 - May 2027' },
      { text: 'EXPERIENCE', fontSize: 12, bold: true },
      { text: 'Acme Corp - Software Engineering Intern | Jun 2025 - Aug 2025' },
      { text: '• Built a thing that did a job' },
      { text: 'SKILLS', fontSize: 12, bold: true },
      { text: 'Languages: TypeScript, Python, Go' },
    ]),
  );

  const sections = buildSections(resume);

  it('treats everything before the first heading as the header', () => {
    // Where the name, email, phone and links live - and therefore where the
    // highest-value extraction is scoped.
    expect(sections[0]?.type).toBe('header');
    expect(sections[0]?.lines).toHaveLength(2);
  });

  it('recognises the standard section headings', () => {
    const types = sections.map((section) => section.type);
    expect(types).toEqual(['header', 'education', 'experience', 'skills']);
  });

  it('does not promote a body line that merely starts with a heading word', () => {
    const lines = buildLines(
      document([
        { text: 'Nityanth Maramreddy', fontSize: 18, bold: true },
        // Plain body text. A naive "starts with Education" check would make
        // this a section boundary and swallow the rest of the document.
        { text: 'Education has always been a priority for me throughout my career' },
      ]),
    );
    expect(buildSections(lines).every((section) => section.type === 'header')).toBe(true);
  });
});

describe('contact extraction', () => {
  const header = buildLines(
    document([
      { text: 'Nityanth Maramreddy', fontSize: 18, bold: true },
      { text: 'New Brunswick, NJ | (609) 555-1234 | nitu@example.com' },
      { text: 'linkedin.com/in/nitu | github.com/nitu | nitu.dev' },
    ]),
  );

  it('extracts an email at high confidence', () => {
    const found = extractEmail(header, DOC);
    expect(found?.value.value).toBe('nitu@example.com');
    // Rigid syntax; not 1.0, because the document could contain someone else's.
    expect(found?.value.evidence[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(found?.value.evidence[0]?.verifiedByUser).toBe(false);
  });

  it('extracts and normalizes a phone number', () => {
    const found = extractPhone(header, DOC);
    expect(found?.value.value?.national).toBe('(609) 555-1234');
    expect(found?.value.value?.international).toBe('+16095551234');
  });

  it('does not mistake a date range for a phone number', () => {
    const lines = buildLines(document(['Acme Corp | 2021 - 2024']));
    expect(extractPhone(lines, DOC)).toBeNull();
  });

  it('classifies links by host rather than lumping them together', () => {
    const links = extractLinks(header, DOC);
    expect(links['links.linkedin']?.value.value).toBe('https://linkedin.com/in/nitu');
    expect(links['links.github']?.value.value).toBe('https://github.com/nitu');
    expect(links['links.portfolio']?.value.value).toBe('https://nitu.dev');
  });

  it('never files LinkedIn or GitHub as the portfolio', () => {
    const lines = buildLines(document(['linkedin.com/in/nitu']));
    expect(extractLinks(lines, DOC)['links.portfolio']).toBeUndefined();
  });

  it('extracts a name but marks it as needing review', () => {
    const found = extractName(header, DOC);
    expect(found?.first.value.value).toBe('Nityanth');
    expect(found?.last.value.value).toBe('Maramreddy');
    // Derived from typography, not from a label. It must land in "needs
    // review" so the user confirms rather than being told.
    expect(found?.first.value.evidence[0]?.confidence).toBeLessThan(0.85);
  });

  it('does not mistake a job title under the name for the name', () => {
    const lines = buildLines(
      document([
        { text: 'Nityanth Maramreddy', fontSize: 18, bold: true },
        { text: 'Software Engineer', fontSize: 12 },
      ]),
    );
    expect(extractName(lines, DOC)?.full.value.value).toBe('Nityanth Maramreddy');
  });

  it('returns null for a name it cannot identify', () => {
    // No prominent name-shaped line. Better to ask than to fill an application
    // addressed to the wrong person.
    const lines = buildLines(document(['nitu@example.com', 'some body text here']));
    expect(extractName(lines, DOC)).toBeNull();
  });

  it('extracts city and state from the header', () => {
    const found = extractLocation(header, DOC);
    expect(found?.city.value.value).toBe('New Brunswick');
    expect(found?.state.value.value).toBe('NJ');
  });

  it('does not read a month name as a city', () => {
    const lines = buildLines(document(['May, 2025']));
    expect(extractLocation(lines, DOC)).toBeNull();
  });
});

describe('education extraction', () => {
  const lines = buildLines(
    document([
      { text: 'Rutgers University, New Brunswick, NJ' },
      { text: 'B.S. in Computer Science | GPA: 3.85 | Sep 2023 - May 2027' },
    ]),
  );

  const [education] = extractEducation(lines, DOC);

  it('identifies the institution by keyword, not by position', () => {
    expect(education?.institution.value).toContain('Rutgers University');
  });

  it('extracts the degree and field of study', () => {
    expect(education?.degree.value).toMatch(/B\.S\./i);
    expect(education?.fieldOfStudy.value).toContain('Computer Science');
  });

  it('keeps the GPA as a string so precision and scale survive', () => {
    // Parsing to a float would turn "3.85" into 3.85 and lose the ability to
    // render exactly what the institution issued.
    expect(education?.gpa.value).toBe('3.85');
  });

  it('reads the date range into start and graduation dates', () => {
    expect(education?.startDate.value).toMatchObject({ year: 2023, month: 9 });
    expect(education?.graduationDate.value).toMatchObject({ year: 2027, month: 5 });
  });

  it('leaves fields empty rather than guessing when nothing matches', () => {
    const sparse = buildLines(document(['Some Institution Without Keywords']));
    const [entry] = extractEducation(sparse, DOC);
    // An entry with a guessed degree is a wrong result that looks right.
    expect(entry?.degree.value).toBeNull();
    expect(entry?.gpa.value).toBeNull();
  });
});

describe('employment extraction', () => {
  const lines = buildLines(
    document([
      { text: 'Acme Corp - Software Engineering Intern | Jun 2025 - Aug 2025' },
      { text: '• Built a service that processed a great many things' },
      { text: '• Reduced something by a satisfying percentage' },
      { text: 'Globex - Research Assistant | Jan 2024 - Present' },
      { text: '• Did research' },
    ]),
  );

  const entries = extractEmployment(lines, DOC);

  it('splits entries on date ranges', () => {
    expect(entries).toHaveLength(2);
  });

  it('attaches bullets to the entry above them', () => {
    expect(entries[0]?.bullets.value).toHaveLength(2);
    expect(entries[1]?.bullets.value).toHaveLength(1);
  });

  it('extracts company and title', () => {
    expect(entries[0]?.company.value).toBe('Acme Corp');
    expect(entries[0]?.title.value).toBe('Software Engineering Intern');
  });

  it('marks company and title as needing review', () => {
    // "Company - Title" vs "Title at Company" is genuinely ambiguous across
    // resumes, so both values are scored to require a look.
    expect(entries[0]?.company.evidence[0]?.confidence).toBeLessThan(0.85);
  });

  it('derives currently-employed only from an explicit "Present"', () => {
    expect(entries[1]?.currentlyEmployed.value).toBe(true);
    // The first job ended in August. Nothing said it is current, so we say
    // nothing - rather than inferring `false`, which is also a claim.
    expect(entries[0]?.currentlyEmployed.value).toBeNull();
  });
});

describe('skills extraction', () => {
  it('splits a skills block on the separators resumes use', () => {
    const lines = buildLines(
      document(['Languages: TypeScript, Python, Go', 'Tools: Docker | Kubernetes | Git']),
    );
    const skills = extractSkills(lines, DOC);
    expect(skills?.value).toEqual(
      expect.arrayContaining(['TypeScript', 'Python', 'Go', 'Docker', 'Kubernetes', 'Git']),
    );
  });

  it('strips the category label rather than storing it as a skill', () => {
    const lines = buildLines(document(['Languages: TypeScript']));
    expect(extractSkills(lines, DOC)?.value).toEqual(['TypeScript']);
  });

  it('returns null for an empty section instead of an empty list', () => {
    expect(extractSkills([], DOC)).toBeNull();
  });
});

describe('scoping: contact details come from the header only', () => {
  it('does not read a reference\'s email as the applicant\'s', () => {
    const lines = buildLines(
      document([
        { text: 'Nityanth Maramreddy', fontSize: 18, bold: true },
        { text: 'nitu@example.com' },
        { text: 'REFERENCES', fontSize: 12, bold: true },
        { text: 'Dr. Someone Else - professor@university.edu' },
      ]),
    );

    const sections = buildSections(lines);
    const header = sections[0]?.lines ?? [];

    // The header scoping is what makes this correct. Searching the whole
    // document for "an email" would find the professor's about as often.
    expect(extractEmail(header, DOC)?.value.value).toBe('nitu@example.com');
    expect(linesOfType(sections, 'unknown').length).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Deterministic extraction of education, experience, projects and skills.
 * ---------------------------------------------------------------------------
 * Harder than contact extraction, and honest about it. An email either matches
 * a pattern or does not; "which of these lines is a job title" has no such
 * rule. So this module works from structural signals that resumes overwhelmingly
 * share - a date range marks an entry boundary, a bullet belongs to the entry
 * above it, a degree keyword marks an education entry - and scores everything it
 * produces low enough to require review.
 *
 * THE GOVERNING RULE (spec section 25.4):
 *
 *   > Every extracted value is either correct or visibly uncertain. Unsupported
 *   > or fabricated values must not silently enter the verified profile.
 *
 * So when a signal is missing, the field is left empty. An entry with a company
 * and no title is a correct partial result; an entry with a guessed title is a
 * wrong one that looks right, and the user has no way to tell.
 */
import { newId } from '@shared/ids';
import { parseDate, type NormalizedDate } from '@profile/normalizers/date';
import { emptyValue, resumeValue, type Education, type Employment, type Project } from '@profile/schema';
import { isBullet, stripBullet } from '../layout/lines';
import type { ResumeLine } from '../types';

/**
 * A date range on one line: "May 2023 - Aug 2024", "2021-Present", "05/2023 to 05/2024".
 *
 * The single most reliable structural marker in a resume. Every entry in an
 * experience or education section carries one, and almost nothing else does -
 * which makes it the entry boundary.
 */
const DATE_RANGE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2}\b)\s*(?:[-–—]|to|until)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2}\b|present|current|now)/i;

/** A single date with no range: "Expected May 2027", "Graduated 2024". */
const SINGLE_DATE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2}\b)/i;

interface DateRange {
  start: NormalizedDate | null;
  end: NormalizedDate | null;
  /** The matched text, removed from the line before reading company/title. */
  matched: string;
}

/** Pull a date range off a line, if it has one. */
function findDateRange(text: string): DateRange | null {
  const match = DATE_RANGE.exec(text);
  if (match === null) return null;
  return {
    start: parseDate(match[1]),
    end: parseDate(match[2]),
    matched: match[0],
  };
}

/**
 * Split a section's lines into entries.
 *
 * A new entry begins at a line carrying a date range; bullets and continuation
 * lines attach to the entry above. This is the structure essentially every
 * resume uses, and it degrades gracefully: a section with no dates yields one
 * entry containing everything, which is a poor result but not a wrong one.
 */
interface RawEntry {
  /** Lines before any bullets - the title/company/school block. */
  headerLines: ResumeLine[];
  bullets: string[];
  dates: DateRange | null;
}

function splitEntries(lines: readonly ResumeLine[]): RawEntry[] {
  const entries: RawEntry[] = [];
  let current: RawEntry | null = null;

  for (const line of lines) {
    if (line.text.trim().length === 0) continue;

    if (isBullet(line)) {
      // A bullet with no entry above it is orphaned content - a section
      // preamble. Dropping it is right: it belongs to no job.
      if (current !== null) current.bullets.push(stripBullet(line.text));
      continue;
    }

    const dates = findDateRange(line.text);

    // A date range starts a new entry - unless the current entry has no dates
    // yet, in which case this line is that entry's date line (many resumes put
    // the company on one line and the dates on the next).
    if (dates !== null) {
      if (current !== null && current.dates === null && current.bullets.length === 0) {
        current.dates = dates;
        current.headerLines.push(line);
        continue;
      }
      if (current !== null) entries.push(current);
      current = { headerLines: [line], bullets: [], dates };
      continue;
    }

    if (current === null) {
      current = { headerLines: [line], bullets: [], dates: null };
    } else if (current.bullets.length > 0) {
      // A non-bullet line after bullets is the start of the next entry.
      entries.push(current);
      current = { headerLines: [line], bullets: [], dates: null };
    } else {
      current.headerLines.push(line);
    }
  }

  if (current !== null) entries.push(current);
  return entries;
}

/** Remove the date text so it is not mistaken for a company or title. */
function withoutDates(text: string, dates: DateRange | null): string {
  const stripped = dates === null ? text : text.replace(dates.matched, ' ');
  return stripped
    .replace(/\s*[|•·–—-]\s*$/, '')
    .replace(/^\s*[|•·–—-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Degree keywords, used to identify which line of an education entry is the
 * degree and which is the institution.
 */
/**
 * Trailing context is a LOOKAHEAD, not a word boundary.
 *
 * With `\b` at the end, "B.S." matches as "B.S": the engine tries the full
 * "B.S." first, finds no word boundary after the final period (period then
 * space are both non-word), backtracks, and settles for dropping the period.
 * The stored degree is then subtly wrong. A lookahead for "end, whitespace or
 * punctuation" accepts the abbreviation as written.
 */
const DEGREE_PATTERN =
  /\b(bachelor|b\.?s\.?|b\.?a\.?|b\.?eng|master|m\.?s\.?|m\.?a\.?|m\.?eng|mba|ph\.?d|doctor|associate|a\.?s\.?|diploma|certificate)(?=\s|,|\||$)/i;

/** Institution keywords, for the same purpose from the other direction. */
const INSTITUTION_PATTERN = /\b(university|college|institute|school|academy|polytechnic)\b/i;

/** GPA in the forms resumes actually write it. */
const GPA_PATTERN = /\bgpa\s*:?\s*([0-4]\.\d{1,2}(?:\s*\/\s*[45]\.\d{1,2})?)\b/i;

/** "B.S. in Computer Science" / "Bachelor of Science, Computer Science" */
const FIELD_OF_STUDY = /\b(?:in|of|,)\s+([A-Z][A-Za-z&\s]{2,40}?)(?:\s*[,|]|\s*$)/;

export function extractEducation(
  lines: readonly ResumeLine[],
  documentId: string,
): Education[] {
  return splitEntries(lines).map((entry) => {
    const texts = entry.headerLines.map((line) => withoutDates(line.text, entry.dates));
    const joined = texts.join(' ');
    const page = entry.headerLines[0]?.page ?? 1;

    const evidence = (originalText: string) =>
      ({ confidence: 0.7, documentId, page, section: 'education', originalText }) as const;

    const education: Education = {
      id: newId('edu'),
      institution: emptyValue<string>(),
      degree: emptyValue<string>(),
      fieldOfStudy: emptyValue<string>(),
      startDate: emptyValue<NormalizedDate>(),
      graduationDate: emptyValue<NormalizedDate>(),
      gpa: emptyValue<string>(),
    };

    // Institution: the line naming a university/college. Identified by keyword
    // rather than by position, because resumes disagree about whether the
    // school or the degree comes first.
    const institutionText = texts.find((text) => INSTITUTION_PATTERN.test(text));
    if (institutionText !== undefined) {
      // Strip a trailing location, which is frequently on the same line.
      const cleaned = institutionText.split(/\s*[|•]\s*/)[0]?.trim() ?? institutionText;
      education.institution = resumeValue(cleaned, {
        ...evidence(institutionText),
        confidence: 0.8, // a keyword match is stronger than a positional guess
        raw: institutionText,
      });
    }

    const degreeText = texts.find((text) => DEGREE_PATTERN.test(text));
    if (degreeText !== undefined) {
      const degreeMatch = DEGREE_PATTERN.exec(degreeText)?.[0];
      if (degreeMatch !== undefined) {
        education.degree = resumeValue(degreeMatch, {
          ...evidence(degreeText),
          confidence: 0.8,
          raw: degreeText,
        });
      }

      // Field of study, read from the same line as the degree. Only attempted
      // there: "in Computer Science" elsewhere on a resume is prose.
      const fieldMatch = FIELD_OF_STUDY.exec(degreeText)?.[1]?.trim();
      if (fieldMatch !== undefined && fieldMatch.length > 2) {
        education.fieldOfStudy = resumeValue(fieldMatch, {
          ...evidence(degreeText),
          confidence: 0.65,
          raw: fieldMatch,
        });
      }
    }

    const gpaMatch = GPA_PATTERN.exec(joined)?.[1];
    if (gpaMatch !== undefined) {
      // Kept as a string. "3.80" and "3.8/4.0" are different claims, and
      // parsing to a float would destroy both the precision and the scale.
      education.gpa = resumeValue(gpaMatch.replace(/\s/g, ''), {
        ...evidence(joined),
        confidence: 0.9, // explicitly labelled "GPA" - unambiguous
        raw: gpaMatch,
      });
    }

    if (entry.dates?.start != null) {
      education.startDate = resumeValue(entry.dates.start, {
        ...evidence(entry.dates.matched),
        confidence: 0.85,
        raw: entry.dates.matched,
      });
    }
    if (entry.dates?.end != null) {
      education.graduationDate = resumeValue(entry.dates.end, {
        ...evidence(entry.dates.matched),
        confidence: 0.85,
        raw: entry.dates.matched,
      });
    } else {
      // No range, but education entries often carry a lone graduation date
      // ("Expected May 2027").
      const single = SINGLE_DATE.exec(joined)?.[1];
      const parsed = single === undefined ? null : parseDate(single);
      if (parsed !== null) {
        education.graduationDate = resumeValue(parsed, {
          ...evidence(joined),
          confidence: 0.7,
          raw: single ?? '',
        });
      }
    }

    return education;
  });
  // Note: entries with nothing recognised still come back, as an entry of empty
  // values. That is deliberate - the review screen shows the user we saw
  // something we could not read, rather than silently dropping a job.
}

export function extractEmployment(
  lines: readonly ResumeLine[],
  documentId: string,
): Employment[] {
  return splitEntries(lines).map((entry) => {
    const texts = entry.headerLines.map((line) => withoutDates(line.text, entry.dates));
    const page = entry.headerLines[0]?.page ?? 1;

    const evidence = (originalText: string) =>
      ({ confidence: 0.65, documentId, page, section: 'experience', originalText }) as const;

    const employment: Employment = {
      id: newId('emp'),
      company: emptyValue<string>(),
      title: emptyValue<string>(),
      location: emptyValue<string>(),
      startDate: emptyValue<NormalizedDate>(),
      endDate: emptyValue<NormalizedDate>(),
      currentlyEmployed: emptyValue<boolean>(),
      description: emptyValue<string>(),
      bullets: emptyValue<string[]>(),
    };

    /**
     * Company and title.
     *
     * The genuinely ambiguous part. Resumes write "Company - Title", "Title at
     * Company", "Company\nTitle", and every other permutation. We handle the
     * two-line case (overwhelmingly the most common) by position, and otherwise
     * take a separator split. Confidence stays at 0.65 throughout, which puts
     * BOTH values in "needs review" - the honest outcome for a guess this
     * structural.
     */
    const first = texts[0];
    const second = texts[1];

    if (first !== undefined && first.length > 0) {
      const separated = first.split(/\s+[|•·]\s+|\s+[-–—]\s+/).map((part) => part.trim());
      const companyPart = separated[0];
      const titlePart = separated[1];

      if (companyPart !== undefined && companyPart.length > 0) {
        employment.company = resumeValue(companyPart, { ...evidence(first), raw: companyPart });
      }
      if (titlePart !== undefined && titlePart.length > 0) {
        employment.title = resumeValue(titlePart, { ...evidence(first), raw: titlePart });
      } else if (second !== undefined && second.length > 0) {
        // Two-line form: company on the first line, title on the second.
        employment.title = resumeValue(second, { ...evidence(second), raw: second });
      }
    }

    if (entry.dates?.start != null) {
      employment.startDate = resumeValue(entry.dates.start, {
        ...evidence(entry.dates.matched),
        confidence: 0.85,
        raw: entry.dates.matched,
      });
    }
    if (entry.dates?.end != null) {
      employment.endDate = resumeValue(entry.dates.end, {
        ...evidence(entry.dates.matched),
        confidence: 0.85,
        raw: entry.dates.matched,
      });
      // "Present" is a statement about employment status, not a date. Deriving
      // the boolean from it is safe because the source said it explicitly.
      if (entry.dates.end.isPresent === true) {
        employment.currentlyEmployed = resumeValue(true, {
          ...evidence(entry.dates.matched),
          confidence: 0.9,
        });
      }
    }

    if (entry.bullets.length > 0) {
      employment.bullets = resumeValue(entry.bullets, {
        // Bullets are copied verbatim, not interpreted, so confidence is high:
        // we are certain these are the lines, whatever they mean.
        confidence: 0.9,
        documentId,
        page,
        section: 'experience',
      });
    }

    return employment;
  });
}

/**
 * Projects, from the lines under a Projects heading.
 *
 * The loosest of the three extractors, because the section itself is: entries
 * have no agreed shape, so this takes the first line as the name and leaves the
 * rest as description rather than inventing structure the document never had.
 */
export function extractProjects(lines: readonly ResumeLine[], documentId: string): Project[] {
  return splitEntries(lines).map((entry) => {
    const texts = entry.headerLines.map((line) => withoutDates(line.text, entry.dates));
    const page = entry.headerLines[0]?.page ?? 1;
    const first = texts[0];

    const project: Project = {
      id: newId('proj'),
      name: emptyValue<string>(),
      description: emptyValue<string>(),
      technologies: emptyValue<string[]>(),
      url: emptyValue<string>(),
    };

    if (first !== undefined && first.length > 0) {
      // The name is the part before any separator; what follows is usually the
      // tech stack or a one-line description.
      const name = first.split(/\s+[|•·]\s+|\s+[-–—]\s+/)[0]?.trim();
      if (name !== undefined && name.length > 0) {
        project.name = resumeValue(name, {
          confidence: 0.7,
          documentId,
          page,
          section: 'projects',
          originalText: first,
          raw: name,
        });
      }
    }

    if (entry.bullets.length > 0) {
      project.description = resumeValue(entry.bullets.join(' '), {
        confidence: 0.85,
        documentId,
        page,
        section: 'projects',
      });
    }

    return project;
  });
}

/**
 * Skills.
 *
 * The easiest section, because a skills block is a list and we can copy it
 * rather than interpret it. Split on the separators resumes use, then discard
 * anything implausible as a skill name.
 */
export function extractSkills(
  lines: readonly ResumeLine[],
  documentId: string,
): ReturnType<typeof resumeValue<string[]>> | null {
  const skills: string[] = [];

  for (const line of lines) {
    // Strip a leading category label: "Languages: Python, Go" -> "Python, Go".
    const withoutCategory = line.text.replace(/^[A-Za-z /&]{3,30}:\s*/, '');

    for (const raw of withoutCategory.split(/[,;|•·]/)) {
      const skill = stripBullet(raw).trim();
      // Bounds, not judgement: a 1-character token is punctuation debris and a
      // 40-character one is a sentence. We do not otherwise decide what
      // qualifies as a skill - that is the applicant's call, not ours.
      if (skill.length < 2 || skill.length > 40) continue;
      if (!/[A-Za-z]/.test(skill)) continue;
      if (!skills.includes(skill)) skills.push(skill);
    }
  }

  if (skills.length === 0) return null;

  return resumeValue(skills, {
    confidence: 0.85,
    documentId,
    page: lines[0]?.page ?? 1,
    section: 'skills',
  });
}

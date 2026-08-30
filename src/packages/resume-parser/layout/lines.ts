/**
 * Layout reconstruction: text runs -> lines -> sections.
 * ---------------------------------------------------------------------------
 * PDF.js hands back text in the order the file happens to draw it, which is
 * roughly reading order and not reliably so. This module rebuilds the visual
 * structure a human sees, using the signals spec section 8.2 lists: shared y
 * coordinates, horizontal alignment, font size, whitespace gaps, common section
 * headings, bullet patterns, and date positioning.
 *
 * Everything here is pure and DOM-free, so the whole layout engine is testable
 * from arrays of plain objects.
 *
 * WHAT THIS MODULE DOES NOT ATTEMPT
 * Two-column resumes. Spec section 3.2 excludes them from the first build, and
 * doing them properly means column detection and per-column reading order -
 * real work that would be wrong to fake. A two-column resume will produce
 * interleaved lines here, which is why the deterministic extractors are written
 * to pick out what they recognise rather than to assume a clean document.
 */
import type { ResumeLine, ResumeSection, ResumeSectionType, ResumeTextItem } from '../types';

/**
 * Two runs belong to the same line when their vertical centres are within this
 * fraction of the larger font size.
 *
 * Proportional rather than absolute because a heading at 18pt and body text at
 * 10pt have very different baseline jitter. A fixed pixel tolerance either
 * splits headings or merges adjacent body lines, depending which size you tune
 * it for.
 */
const LINE_TOLERANCE_RATIO = 0.5;

/**
 * Gap between two runs, as a multiple of font size, above which we insert a
 * space. Below it, the runs are parts of one word that the PDF split.
 */
const SPACE_GAP_RATIO = 0.15;

/** Group text runs into visual lines. */
export function buildLines(items: readonly ResumeTextItem[]): ResumeLine[] {
  // Sort by page, then vertically, then horizontally: reading order.
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
    return a.x - b.x;
  });

  const lines: ResumeLine[] = [];
  let current: ResumeTextItem[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    lines.push(assembleLine(current));
    current = [];
  };

  for (const item of sorted) {
    const previous = current[current.length - 1];

    if (previous === undefined) {
      current.push(item);
      continue;
    }

    const sameLine =
      previous.page === item.page &&
      Math.abs(item.y - previous.y) <= Math.max(previous.fontSize, item.fontSize) * LINE_TOLERANCE_RATIO;

    if (sameLine) current.push(item);
    else {
      flush();
      current.push(item);
    }
  }
  flush();

  return lines;
}

/** Join one line's runs into text, inserting spaces where the PDF implies them. */
function assembleLine(items: readonly ResumeTextItem[]): ResumeLine {
  const ordered = [...items].sort((a, b) => a.x - b.x);

  let text = '';
  let previous: ResumeTextItem | undefined;

  for (const item of ordered) {
    if (previous !== undefined) {
      const gap = item.x - (previous.x + previous.width);
      // A PDF frequently splits a word into several runs with no gap at all.
      // Inserting a space between those would break every email address and
      // every hyphenated name in the document.
      if (gap > previous.fontSize * SPACE_GAP_RATIO) text += ' ';
    }
    text += item.text;
    previous = item;
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const x = first?.x ?? 0;

  return {
    page: first?.page ?? 1,
    text: text.replace(/\s+/g, ' ').trim(),
    x,
    y: first?.y ?? 0,
    width: last === undefined ? 0 : last.x + last.width - x,
    height: Math.max(...ordered.map((item) => item.height), 0),
    maxFontSize: Math.max(...ordered.map((item) => item.fontSize), 0),
    bold: ordered.every((item) => item.bold),
    items: ordered,
  };
}

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

/**
 * Section heading vocabulary.
 *
 * Matched against a normalized, lowercased line. Kept as data so adding a
 * spelling seen on a real resume is a one-line change rather than a code change.
 */
const SECTION_HEADINGS: ReadonlyArray<{ type: ResumeSectionType; patterns: readonly RegExp[] }> = [
  {
    type: 'experience',
    patterns: [
      /^(work|professional|employment|relevant)?\s*experience$/,
      /^work history$/,
      /^employment( history)?$/,
      /^professional background$/,
      /^internships?$/,
    ],
  },
  {
    type: 'education',
    patterns: [/^education$/, /^academic background$/, /^academics$/, /^education & training$/],
  },
  {
    type: 'projects',
    patterns: [/^(personal |technical |selected )?projects$/, /^project experience$/],
  },
  {
    type: 'skills',
    patterns: [
      /^(technical |core |key )?skills$/,
      /^skills? (&|and) (abilities|interests|tools)$/,
      /^technologies$/,
      /^technical proficiencies$/,
    ],
  },
  {
    type: 'summary',
    patterns: [/^(professional )?summary$/, /^objective$/, /^profile$/, /^about( me)?$/],
  },
  {
    type: 'certifications',
    patterns: [/^certifications?$/, /^licenses? (&|and) certifications?$/, /^awards?$/, /^honors$/],
  },
];

/**
 * Longest plausible heading, in characters.
 *
 * A heading is a label, not a sentence. Without this, a body line that happens
 * to begin with "Education" ("Education has always been...") would be promoted
 * to a section boundary and take the rest of the document with it.
 */
const MAX_HEADING_LENGTH = 40;

/** Match a line against the heading vocabulary. */
function headingType(line: ResumeLine): ResumeSectionType | null {
  const normalized = line.text
    .toLowerCase()
    .replace(/[^a-z& ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length === 0 || normalized.length > MAX_HEADING_LENGTH) return null;

  for (const { type, patterns } of SECTION_HEADINGS) {
    if (patterns.some((pattern) => pattern.test(normalized))) return type;
  }
  return null;
}

/**
 * Split lines into sections.
 *
 * Everything before the first recognised heading is the `header` - which is
 * where the name, email, phone and links live on essentially every resume, and
 * therefore where the highest-value deterministic extraction happens.
 *
 * TYPOGRAPHY IS A SECOND, INDEPENDENT SIGNAL
 * A heading is usually also bold or larger than body text. We use that as
 * CORROBORATION rather than as a requirement: plenty of resumes set headings in
 * plain small caps at body size, and requiring the typographic signal would
 * silently fail on those. Requiring the word match and merely noting the
 * typography fails safe - at worst we miss a section and its lines stay in the
 * previous one, where the extractors can still find things.
 */
export function buildSections(lines: readonly ResumeLine[]): ResumeSection[] {
  const sections: ResumeSection[] = [];

  // The body's typical font size, used to judge whether a line is "large".
  const bodyFontSize = medianFontSize(lines);

  let current: ResumeSection = { type: 'header', lines: [] };

  for (const line of lines) {
    const type = headingType(line);

    const looksLikeHeading =
      type !== null &&
      // Corroboration: bold, larger than body, or all-caps. Any one is enough.
      (line.bold || line.maxFontSize > bodyFontSize * 1.05 || line.text === line.text.toUpperCase());

    if (looksLikeHeading && type !== null) {
      // Emit the previous section, but only if it actually held content -
      // otherwise two adjacent headings produce an empty section.
      if (current.lines.length > 0) sections.push(current);
      current = { type, heading: line.text, lines: [] };
      continue;
    }

    current.lines.push(line);
  }

  if (current.lines.length > 0) sections.push(current);
  return sections;
}

/** Median font size across all lines. Robust to a few oversized headings. */
function medianFontSize(lines: readonly ResumeLine[]): number {
  const sizes = lines.map((line) => line.maxFontSize).sort((a, b) => a - b);
  if (sizes.length === 0) return 10;
  const middle = Math.floor(sizes.length / 2);
  return sizes[middle] ?? 10;
}

/** All lines belonging to a section type, across every occurrence of it. */
export function linesOfType(
  sections: readonly ResumeSection[],
  type: ResumeSectionType,
): ResumeLine[] {
  return sections.filter((section) => section.type === type).flatMap((section) => section.lines);
}

/**
 * Is this line a bullet?
 *
 * Used to attach achievement lines to the entry above them rather than treating
 * each as a new job. Covers the glyphs resumes actually use, plus the ASCII
 * fallbacks that survive a PDF export.
 */
export function isBullet(line: ResumeLine): boolean {
  return /^\s*[•●▪◦⁃∙*\-–—]\s+/.test(line.text);
}

/** Strip a leading bullet glyph. */
export function stripBullet(text: string): string {
  return text.replace(/^\s*[•●▪◦⁃∙*\-–—]\s+/, '').trim();
}

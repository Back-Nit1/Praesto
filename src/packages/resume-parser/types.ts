/**
 * Resume ingestion types.
 * ---------------------------------------------------------------------------
 * Spec section 8.2: "Do not immediately flatten a PDF into one giant string."
 *
 * WHY LAYOUT IS PRESERVED
 * A resume's meaning is carried substantially by its geometry, and flattening
 * destroys it irrecoverably:
 *
 *   - a date sitting at the far right of the same line as a job title is that
 *     job's date, not a separate field;
 *   - a line in a larger font with nothing above it is a section heading;
 *   - two columns read as interleaved gibberish once flattened;
 *   - a bullet's indentation is what marks it as belonging to the entry above.
 *
 * Text extraction that throws coordinates away makes every one of those a guess
 * from word order alone. Keeping them costs a few hundred KB of transient
 * memory and turns most of the guessing into arithmetic.
 */

/** One text run as PDF.js reports it, with its position on the page. */
export interface ResumeTextItem {
  text: string;
  /** 1-based. */
  page: number;
  /** Page coordinates, origin at the TOP-LEFT (see pdf/extract.ts). */
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  /** Rendered font size in points. The main signal for heading detection. */
  fontSize: number;
  /** True when the font name suggests a bold weight. */
  bold: boolean;
}

/** Text items merged into a visual line. */
export interface ResumeLine {
  page: number;
  /** Items joined left-to-right with sensible spacing. */
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Largest font size on the line - a heading is larger than body text. */
  maxFontSize: number;
  /** True when every item on the line is bold. */
  bold: boolean;
  items: ResumeTextItem[];
}

/** The section kinds we recognise. `unknown` is expected, not a failure. */
export type ResumeSectionType =
  | 'header'
  | 'summary'
  | 'experience'
  | 'education'
  | 'projects'
  | 'skills'
  | 'certifications'
  | 'unknown';

export interface ResumeSection {
  type: ResumeSectionType;
  /** The heading text as written, when there was one. */
  heading?: string;
  lines: ResumeLine[];
}

/** The structured form the parsers consume. */
export interface StructuredResume {
  /** IndexedDB id of the stored original, for evidence links. */
  documentId: string;
  pageCount: number;
  lines: ResumeLine[];
  sections: ResumeSection[];
  /**
   * True when the PDF had little or no extractable text.
   *
   * A scanned resume is an image; there is nothing to parse. Reported rather
   * than silently returning an empty profile, so the UI can say "this looks
   * like a scan" instead of "we found nothing in your resume".
   */
  looksScanned: boolean;
}

/**
 * Semantic parser interface (spec section 8.4).
 *
 * Declared now, deliberately unimplemented. Its existence is what keeps the
 * deterministic parser from growing an implicit assumption that it is the only
 * parser - and it documents the constraints any future LLM-backed
 * implementation must obey, in the place a developer will actually read them.
 *
 * REQUIREMENTS ON ANY IMPLEMENTATION (spec 8.4):
 *   - output must validate against a Zod schema;
 *   - an unsupported value must be `null`, never a plausible guess;
 *   - every value carries evidence, and that evidence must be verifiable
 *     against the source text (spec 8.5) - a value whose quoted evidence does
 *     not appear in the document loses confidence or is rejected;
 *   - never infer citizenship, work authorization, sponsorship need, or
 *     demographics;
 *   - never invent a date;
 *   - never silently upgrade a degree type or an employment type.
 */
export interface SemanticResumeParser {
  parse(input: StructuredResume): Promise<SemanticResumeResult>;
}

export interface SemanticResumeResult {
  /** Candidate values keyed by canonical profile path. */
  candidates: Record<string, unknown>;
  /** Model/provider identifier, recorded in evidence for auditability. */
  producedBy: string;
}

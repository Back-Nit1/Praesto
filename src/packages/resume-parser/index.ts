/**
 * Resume ingestion pipeline.
 * ---------------------------------------------------------------------------
 * The public face of the resume parser. Spec section 2:
 *
 *     PDF -> extraction -> layout reconstruction -> deterministic parsing
 *         -> candidate values -> user verification -> profile
 *
 * THE RESUME IS NOT THE SOURCE OF TRUTH.
 * Everything here produces CANDIDATES. A candidate becomes profile data only
 * after `ProfileRepository.mergeCandidates`, which refuses to overwrite anything
 * the user has verified, and only becomes verified when the user says so on the
 * review screen. Nothing in this pipeline can write to the profile directly,
 * and that is enforced by it having no access to the repository at all.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { err, ok, type Result } from '@shared/result';
import type { Education, Employment, Project, ProfileValue } from '@profile/schema';
import { extractPdf, looksScanned } from './pdf/extract';
import { buildLines, buildSections, linesOfType } from './layout/lines';
import {
  extractEmail,
  extractLinks,
  extractLocation,
  extractName,
  extractPhone,
} from './deterministic/contact';
import {
  extractEducation,
  extractEmployment,
  extractProjects,
  extractSkills,
} from './deterministic/sections';
import type { StructuredResume } from './types';

const log = createLogger('resume:parse');

/**
 * Everything a resume yielded, ready for review.
 *
 * Scalar candidates are keyed by canonical profile path so they can go straight
 * into `mergeCandidates`. Repeated entities are separate because merging them
 * needs different rules - you cannot merge "a job" into "a job slot" without
 * first deciding which slot.
 */
export interface ResumeParseResult {
  documentId: string;
  /** Path -> proposed value. */
  scalars: Record<string, ProfileValue<unknown>>;
  education: Education[];
  employment: Employment[];
  projects: Project[];
  /** The reconstructed document, for the review screen's evidence display. */
  structured: StructuredResume;
  /**
   * Set when the PDF has no usable text layer.
   *
   * Reported rather than returning an empty result, so the UI can say "this
   * looks like a scan" instead of "we found nothing in your resume" - which
   * would read as the parser being bad rather than the input being an image.
   */
  scanned: boolean;
}

/**
 * Parse a resume PDF into candidate profile values.
 *
 * @param data       the raw file bytes
 * @param documentId IndexedDB id of the stored original, recorded in evidence
 *                   so the review screen can say which document a value came
 *                   from once the user has several
 */
export async function parseResume(
  data: ArrayBuffer,
  documentId: string,
): Promise<Result<ResumeParseResult, AppError>> {
  const extracted = await extractPdf(data);
  if (!extracted.ok) return err(extracted.error);

  const { items, pageCount } = extracted.value;

  const lines = buildLines(items);
  const sections = buildSections(lines);
  const scanned = looksScanned(items);

  const structured: StructuredResume = { documentId, pageCount, lines, sections, looksScanned: scanned };

  if (scanned) {
    log.warn('PDF has no usable text layer; it is probably a scan');
    return ok({
      documentId,
      scalars: {},
      education: [],
      employment: [],
      projects: [],
      structured,
      scanned: true,
    });
  }

  const scalars: Record<string, ProfileValue<unknown>> = {};

  /**
   * Contact details are searched in the HEADER section only.
   *
   * This is the single most important scoping decision in the parser. A resume
   * routinely contains other people's emails (a reference), other cities (a
   * previous employer's office), and other phone numbers. Searching the whole
   * document for "an email" would find one of those about as often as the
   * applicant's own - and would fill it into an application with no way for the
   * user to notice.
   */
  const headerLines = sections[0]?.type === 'header' ? sections[0].lines : lines.slice(0, 10);

  const email = extractEmail(headerLines, documentId);
  if (email !== null) scalars['contact.email'] = email.value;

  const phone = extractPhone(headerLines, documentId);
  if (phone !== null) scalars['contact.phone'] = phone.value as ProfileValue<unknown>;

  const name = extractName(headerLines, documentId);
  if (name !== null) {
    scalars['identity.legalFirstName'] = name.first.value;
    scalars['identity.lastName'] = name.last.value;
    scalars['identity.fullName'] = name.full.value;
  }

  const location = extractLocation(headerLines, documentId);
  if (location !== null) {
    scalars['contact.city'] = location.city.value;
    scalars['contact.state'] = location.state.value;
  }

  // Links may appear in the header or in a footer, so these search everything.
  // A URL is self-identifying in a way an email is not - a linkedin.com/in/
  // URL is somebody's profile, and on a resume that somebody is the applicant.
  for (const [path, candidate] of Object.entries(extractLinks(lines, documentId))) {
    if (candidate !== undefined) scalars[path] = candidate.value;
  }

  const education = extractEducation(linesOfType(sections, 'education'), documentId);
  const employment = extractEmployment(linesOfType(sections, 'experience'), documentId);
  const projects = extractProjects(linesOfType(sections, 'projects'), documentId);

  const skills = extractSkills(linesOfType(sections, 'skills'), documentId);
  if (skills !== null) scalars['skills'] = skills as ProfileValue<unknown>;

  log.info(
    `Parsed resume: ${Object.keys(scalars).length} fields, ${education.length} education, ` +
      `${employment.length} employment, ${projects.length} project entries`,
  );

  return ok({ documentId, scalars, education, employment, projects, structured, scanned: false });
}

export type { StructuredResume, SemanticResumeParser } from './types';

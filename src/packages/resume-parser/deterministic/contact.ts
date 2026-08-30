/**
 * Deterministic contact extraction.
 * ---------------------------------------------------------------------------
 * Spec section 8.3: deterministic parsing FIRST. Email, phone and profile URLs
 * have rigid, checkable syntax - a regex either matches an email or it does
 * not. There is nothing for a language model to add here, and plenty for it to
 * hallucinate.
 *
 * CONFIDENCE REFLECTS THE STRENGTH OF THE EVIDENCE, NOT OUR ENTHUSIASM
 * An email matched by a strict pattern in the header block is near-certain. A
 * name guessed from "the largest text near the top" is a heuristic, and is
 * scored to land in "needs review" so the user is asked rather than told. Those
 * two things must not carry the same number.
 *
 * NOTHING HERE MAY GUESS A SENSITIVE VALUE. There is no code path in this file
 * that can produce a work-authorization, citizenship, or demographic candidate,
 * and none may be added (spec 21.3).
 */
import { resumeValue, type ProfileValue } from '@profile/schema';
import { parsePhone } from '@profile/normalizers/phone';
import type { ResumeLine } from '../types';

/** A proposed value plus the text it came from. */
export interface Candidate<T> {
  value: ProfileValue<T>;
  /** For the review UI: which line this came from. */
  sourceLine?: string;
}

/**
 * Email.
 *
 * Intentionally stricter than the RFC: the RFC permits addresses no resume has
 * ever contained, and a permissive pattern matches things like "v1.2@2x" out of
 * a graphics artefact. Requiring a 2+ character TLD and no consecutive dots
 * rejects those without excluding any real address.
 */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;

export function extractEmail(lines: readonly ResumeLine[], documentId: string): Candidate<string> | null {
  for (const line of lines) {
    const match = EMAIL_PATTERN.exec(line.text);
    const found = match?.[0];
    if (found === undefined) continue;

    return {
      value: resumeValue(found.toLowerCase(), {
        // Rigid syntax, unambiguous match. Not 1.0: the document could contain
        // someone else's address (a reference, a previous employer's contact),
        // and only the user can rule that out.
        confidence: 0.95,
        documentId,
        page: line.page,
        section: 'header',
        originalText: line.text,
        raw: found,
      }),
      sourceLine: line.text,
    };
  }
  return null;
}

/**
 * Phone.
 *
 * Candidate substrings are found loosely and then validated by `parsePhone`,
 * which is the same function the profile editor uses. That shared validation is
 * the point: a number that would not survive being typed into the profile must
 * not survive being read out of a resume either.
 */
const PHONE_CANDIDATE = /(\+?\d[\d\s().-]{7,}\d)/g;

export function extractPhone(
  lines: readonly ResumeLine[],
  documentId: string,
): Candidate<ReturnType<typeof parsePhone>> | null {
  for (const line of lines) {
    // Dates and ranges produce digit runs that look phone-shaped. Skipping a
    // line that is mostly a date range is cheaper and safer than trying to
    // exclude them inside the pattern.
    if (/\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|present)\b/i.test(line.text)) continue;

    for (const match of line.text.matchAll(PHONE_CANDIDATE)) {
      const raw = match[1];
      if (raw === undefined) continue;

      const parsed = parsePhone(raw);
      // parsePhone returns null for anything that is not plausibly a phone
      // number, which filters out zip+4, years, and student ids for free.
      if (parsed === null) continue;

      return {
        value: resumeValue(parsed, {
          confidence: 0.9,
          documentId,
          page: line.page,
          section: 'header',
          originalText: line.text,
          raw,
        }),
        sourceLine: line.text,
      };
    }
  }
  return null;
}

/**
 * Profile links.
 *
 * Matched per-host rather than by a generic URL pattern, because the useful
 * output is "this is the LinkedIn one", not "here is a URL". A generic matcher
 * would find the same links and then need this table anyway to classify them.
 */
const LINK_PATTERNS: ReadonlyArray<{
  path: 'links.linkedin' | 'links.github' | 'links.portfolio';
  pattern: RegExp;
  confidence: number;
}> = [
  {
    path: 'links.linkedin',
    pattern: /\b(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/i,
    confidence: 0.95,
  },
  {
    path: 'links.github',
    pattern: /\b(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+\/?/i,
    confidence: 0.95,
  },
  {
    // Anything else that looks like a personal site. Lower confidence, because
    // "a URL on a resume" is often a company's site or a project link rather
    // than the applicant's own portfolio.
    path: 'links.portfolio',
    pattern: /\b(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+\.(?:com|dev|io|me|net|org|xyz|app)(?:\/[^\s]*)?/i,
    confidence: 0.6,
  },
];

/** Hosts that are never a portfolio, so they do not fall through to that rule. */
const NOT_A_PORTFOLIO = /linkedin\.com|github\.com|gmail\.com|outlook\.com|yahoo\.|hotmail\./i;

export function extractLinks(
  lines: readonly ResumeLine[],
  documentId: string,
): Partial<Record<'links.linkedin' | 'links.github' | 'links.portfolio', Candidate<string>>> {
  const found: Partial<
    Record<'links.linkedin' | 'links.github' | 'links.portfolio', Candidate<string>>
  > = {};

  for (const line of lines) {
    /**
     * Remove email addresses before looking for URLs.
     *
     * Without this, the portfolio pattern matches the DOMAIN of an email:
     * "nitu@example.com" yields "example.com", which is then stored as the
     * applicant's personal website. A perfect false positive - well-formed,
     * plausible, and wrong, which is exactly the class of error this project
     * exists to avoid.
     */
    const searchable = line.text.replace(new RegExp(EMAIL_PATTERN.source, 'g'), ' ');

    for (const { path, pattern, confidence } of LINK_PATTERNS) {
      if (found[path] !== undefined) continue; // first match wins

      /**
       * Scan EVERY match on the line, not just the first.
       *
       * A links line reads "linkedin.com/in/x | github.com/x | x.dev". The
       * generic portfolio pattern matches the LinkedIn URL first; that match is
       * disqualified, and stopping there would mean the actual portfolio URL,
       * two separators to the right, is never seen. Returning to the loop is
       * the whole point - a rejected match disqualifies itself, not the line.
       */
      const scanner = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);

      for (const match of searchable.matchAll(scanner)) {
        const url = match[0];
        if (url === undefined) continue;
        if (path === 'links.portfolio' && NOT_A_PORTFOLIO.test(url)) continue;

        // Normalize to a full URL. An application's URL field usually
        // validates, and "github.com/nitu" fails that check while the https
        // form passes.
        const normalized = url.startsWith('http') ? url : `https://${url}`;

        found[path] = {
          value: resumeValue(normalized.replace(/\/$/, ''), {
            confidence,
            documentId,
            page: line.page,
            section: 'header',
            originalText: line.text,
            raw: url,
          }),
          sourceLine: line.text,
        };
        break;
      }
    }
  }

  return found;
}

/**
 * Name.
 *
 * The weakest extraction in this file, and scored accordingly. A resume does
 * not label its name field; we infer it from "large text near the top that
 * looks like a name". That is a heuristic, so it lands in "needs review" and
 * the user confirms it - which costs them one glance and removes the chance of
 * an application addressed to the wrong person.
 *
 * Deliberately NOT attempted: splitting a name into legal/preferred, or
 * inferring a middle name from an initial. Those are guesses about identity,
 * and identity is exactly where a confident error is least forgivable.
 */
export function extractName(
  lines: readonly ResumeLine[],
  documentId: string,
): { first: Candidate<string>; last: Candidate<string>; full: Candidate<string> } | null {
  // Only the top of the first page. A "name-shaped" line further down is a
  // reference, a previous manager, or a project collaborator.
  const headerLines = lines.filter((line) => line.page === 1).slice(0, 6);

  const bodyFontSize = median(lines.map((line) => line.maxFontSize));

  for (const line of headerLines) {
    const text = line.text.trim();

    // Reject anything carrying contact syntax - that is the contact line, not
    // the name line, even though it sits in the same block.
    if (/[@|/]|\d/.test(text)) continue;

    const words = text.split(/\s+/).filter((word) => word.length > 0);
    // Two to four words: "Ada Lovelace", "Ada B. Lovelace", "Ada de la Cruz".
    if (words.length < 2 || words.length > 4) continue;

    // Every word starts with a capital. Rejects "software engineer" set in
    // large type under the name, which is otherwise a perfect false positive.
    if (!words.every((word) => /^[A-Z]/.test(word))) continue;

    // Larger than body text, or bold. A name is typographically prominent on
    // essentially every resume; without this we would match a title line.
    const prominent = line.maxFontSize > bodyFontSize * 1.15 || line.bold;
    if (!prominent) continue;

    const first = words[0];
    const last = words[words.length - 1];
    if (first === undefined || last === undefined) continue;

    // 0.7 puts this in "needs review" rather than "high confidence". That is
    // the correct place for a value derived from typography.
    const evidence = {
      confidence: 0.7,
      documentId,
      page: line.page,
      section: 'header',
      originalText: text,
    } as const;

    return {
      first: { value: resumeValue(first, { ...evidence, raw: first }), sourceLine: text },
      last: { value: resumeValue(last, { ...evidence, raw: last }), sourceLine: text },
      full: { value: resumeValue(text, { ...evidence, raw: text }), sourceLine: text },
    };
  }

  return null;
}

/**
 * Location.
 *
 * Matches "City, ST" and "City, State" in the header. Restricted to the header
 * because a "City, ST" elsewhere is a previous employer's office, and filling
 * that as the applicant's address would be a confident, plausible, wrong answer.
 */
const US_LOCATION = /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)*),\s*([A-Z]{2}|[A-Z][a-z]+)\b/;

export function extractLocation(
  lines: readonly ResumeLine[],
  documentId: string,
): { city: Candidate<string>; state: Candidate<string> } | null {
  for (const line of lines.slice(0, 8)) {
    const match = US_LOCATION.exec(line.text);
    const city = match?.[1];
    const state = match?.[2];
    if (city === undefined || state === undefined) continue;

    // A month name before a comma is a date, not a city.
    if (/^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(city)) {
      continue;
    }

    const evidence = {
      confidence: 0.75,
      documentId,
      page: line.page,
      section: 'header',
      originalText: line.text,
    } as const;

    return {
      city: { value: resumeValue(city, { ...evidence, raw: city }), sourceLine: line.text },
      state: { value: resumeValue(state, { ...evidence, raw: state }), sourceLine: line.text },
    };
  }
  return null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 10;
  return sorted[Math.floor(sorted.length / 2)] ?? 10;
}

/**
 * PDF text extraction with coordinates.
 * ---------------------------------------------------------------------------
 * The only module that knows PDF.js exists. Everything downstream consumes
 * `ResumeTextItem[]`, so swapping the extractor (or adding a DOCX one, or an
 * OCR fallback) touches this file and nothing else.
 *
 * PDF.JS IS LOADED DYNAMICALLY, AND THAT MATTERS
 * The library is roughly a megabyte of parsed JavaScript. It is imported inside
 * `extractPdf` rather than at module scope so it is fetched only when the user
 * actually uploads a resume - which for most sessions is never. Nothing in the
 * service worker or the content script ever pays for it. On the low-memory
 * machines this extension targets, that difference is the whole reason resume
 * parsing does not make the extension feel heavy.
 *
 * COORDINATE SYSTEM
 * PDF's origin is the BOTTOM-left; every layout intuition (and every reader)
 * works top-down. We flip y here, once, so no downstream code has to remember
 * which way is up. After this module, larger y means further down the page.
 */
import { AppError } from '@shared/errors';
import { createLogger } from '@shared/logging';
import { getRuntimeBudget } from '@shared/runtime-budget';
import { err, ok, type Result } from '@shared/result';
import type { ResumeTextItem } from '../types';

const log = createLogger('resume:pdf');

/**
 * Positioned text from a PDF, and how many pages it was actually read from.
 *
 * The count is reported rather than assumed because a document may DECLARE any
 * number of pages and we read at most `MAX_PAGES` of them - a resume that was
 * truncated must be able to say so.
 */
export interface ExtractionResult {
  items: ResumeTextItem[];
  pageCount: number;
}

/**
 * Below this many characters across the whole document, we conclude the PDF has
 * no usable text layer - it is a scan or an image export.
 *
 * Set low deliberately. A one-page resume has well over a thousand characters,
 * so anything under 100 is not a sparse resume, it is a document with a stray
 * text watermark on top of a picture.
 */
const MIN_TEXT_CHARS = 100;

/**
 * SECURITY / MEMORY: hard caps on what one document may cost us.
 *
 * A PDF is an untrusted, attacker-authorable format being parsed by a large
 * library INSIDE AN EXTENSION PAGE - the most privileged JavaScript context
 * this codebase has. The file normally comes from the user's own disk, but
 * "the user downloaded a resume template from a job board" is an ordinary
 * thing that happens, so the parse is treated as hostile input.
 *
 * These caps bound the cheap attack, which is not code execution but resource
 * exhaustion: a PDF declaring 50,000 pages, or one page emitting millions of
 * one-character text runs, exhausts memory on a 4 GB machine long before it
 * finishes. A resume is one to three pages; 50 is generous for a CV with a
 * publication list, and 200,000 text runs is ~100x what a dense academic CV
 * produces.
 */
const MAX_PAGES = 50;
const MAX_TEXT_ITEMS = 200_000;

/** True when a PDF font name indicates a bold weight. */
function isBoldFont(fontName: string | undefined): boolean {
  if (fontName === undefined) return false;
  return /bold|black|heavy|semib|demib/i.test(fontName);
}

/**
 * Extract every text run from a PDF, with position and font information.
 *
 * @param data the raw file bytes
 */
export async function extractPdf(data: ArrayBuffer): Promise<Result<ExtractionResult, AppError>> {
  const budget = getRuntimeBudget();

  try {
    /**
     * Load PDF.js and its worker module together.
     *
     * BOTH IMPORTS ARE DYNAMIC - see the module header. Together they are ~1 MB
     * of parsed JavaScript, fetched only when the user actually uploads a
     * resume. The service worker and the content script never pay for it.
     *
     * WHY THE `legacy` BUILD
     * pdfjs-dist v6's default build uses APIs that only very recent runtimes
     * have - `Promise.try` (Chrome 128+) and `Uint8Array.prototype.toHex`
     * (Chrome 133+). Using it would mean the extension silently fails to read
     * resumes on any older Chrome, with no way for the user to tell why. The
     * `legacy` build is transpiled and self-contained, which costs a little
     * size and buys a far lower browser floor - the right trade for an
     * extension meant to be installable by anyone. It is also the reason this
     * path is testable in Node at all.
     */
    const [pdfjs, pdfWorker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]);

    /**
     * Run PDF.js on the main thread, by handing it the worker module directly.
     *
     * PDF.js resolves its worker in this order: it uses
     * `globalThis.pdfjsWorker.WorkerMessageHandler` if present, and otherwise
     * dynamically imports whatever URL `GlobalWorkerOptions.workerSrc` names.
     * Assigning the already-imported module to `globalThis.pdfjsWorker` takes
     * the first branch, so nothing is ever fetched by URL at runtime. That
     * matters under the extension's `script-src 'self'` CSP, and it keeps the
     * worker inside the normal bundle graph instead of needing a separately
     * emitted asset.
     *
     * A real Worker would be faster for rendering large documents. We extract
     * text from a one- or two-page resume, once, on an explicit user action, so
     * the parallelism buys nothing perceptible and the simplicity is worth more.
     *
     * NOTE FOR ANYONE TEMPTED TO SIMPLIFY THIS: setting `workerSrc = ''` does
     * NOT mean "no worker". It means "load the worker from the empty URL", and
     * PDF.js rejects with `Setting up fake worker failed: "No
     * GlobalWorkerOptions.workerSrc specified."` - which surfaced to users as
     * "This PDF could not be read".
     */
    (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

    const document = await pdfjs.getDocument({
      data: new Uint8Array(data),
      // A resume needs no external resources. Disabling these removes both a
      // network dependency and a class of malformed-font failures. Text
      // extraction does not need font programs - only glyph positions.
      disableFontFace: true,
      useSystemFonts: false,
      /**
       * SECURITY: PDF.js compiles some font programs with `new Function` when
       * it is allowed to. Our extension CSP is `script-src 'self'` with no
       * `unsafe-eval`, so those calls THROW and PDF.js falls back - but only
       * because it happens to catch them. Saying `false` here makes the
       * guarantee explicit and deterministic rather than dependent on a
       * library's internal error handling, and it removes a code path that
       * turns document content into executable code.
       *
       * The cast is needed because `isEvalSupported` is a real, documented
       * runtime option that pdfjs-dist v6 omits from its published
       * `DocumentInitParameters` type. Passing an unknown key is harmless - the
       * library reads what it recognises - and the alternative is relying on
       * an exception being swallowed.
       */
      isEvalSupported: false,
    } as Parameters<typeof pdfjs.getDocument>[0]).promise;

    const items: ResumeTextItem[] = [];

    // Pages are processed sequentially, `pdfPageConcurrency` at a time. Peak
    // memory is roughly page size times concurrency, and on a 2 GB device the
    // budget drops that to 1 - which is the difference between parsing a resume
    // and having the tab killed.
    //
    // SECURITY: a document may DECLARE any page count. Read at most MAX_PAGES
    // of them, whatever it claims.
    const pageCount = Math.min(document.numPages, MAX_PAGES);
    if (document.numPages > MAX_PAGES) {
      log.warn(`PDF declares ${document.numPages} pages; reading the first ${MAX_PAGES}`);
    }

    outer: for (
      let pageNumber = 1;
      pageNumber <= pageCount;
      pageNumber += budget.pdfPageConcurrency
    ) {
      const batch: number[] = [];
      for (
        let offset = 0;
        offset < budget.pdfPageConcurrency && pageNumber + offset <= pageCount;
        offset++
      ) {
        batch.push(pageNumber + offset);
      }

      const pages = await Promise.all(batch.map((n) => extractPage(document, n)));
      for (const pageItems of pages) {
        // Appended one at a time rather than with `push(...pageItems)`: a page
        // emitting a million runs would blow the argument limit outright, and
        // the cap has to be checked as we go rather than after the fact.
        for (const item of pageItems) {
          if (items.length >= MAX_TEXT_ITEMS) {
            log.warn('PDF text-run cap reached; the rest of the document is ignored');
            break outer;
          }
          items.push(item);
        }
      }
    }

    // Release the document's internal buffers rather than waiting for GC. A
    // parsed PDF holds on to a surprising amount, and the user is about to look
    // at a review screen for a while.
    await document.cleanup();

    log.info(`Extracted ${items.length} text runs from ${pageCount} page(s)`);
    return ok({ items, pageCount });
  } catch (error) {
    // Say WHY. "This PDF could not be read" was true of every failure and
    // useful for none of them: a password-protected resume, a truncated
    // download and a bug in our own worker wiring all produced the same
    // sentence, so neither the user nor a developer could tell them apart.
    return err(describePdfFailure(error));
  }
}

/**
 * Turn a PDF.js exception into something the user can act on.
 *
 * PDF.js throws typed errors with stable `name` values, which is a far better
 * signal than matching on message text. Each one below has a genuinely
 * different remedy, and the point of separating them is that the remedy differs
 * - not tidiness.
 *
 * The underlying message is appended to the unrecognised case. It comes from
 * PDF.js, describes the FILE STRUCTURE rather than its contents, and contains
 * no applicant data - so surfacing it costs no privacy and is frequently the
 * only thing that makes a novel failure diagnosable at all.
 */
function describePdfFailure(error: unknown): AppError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  switch (name) {
    case 'PasswordException':
      return new AppError(
        'SCHEMA_VALIDATION_FAILED',
        'This PDF is password-protected. Save an unlocked copy and upload that.',
        { cause: error },
      );

    case 'InvalidPDFException':
      return new AppError(
        'SCHEMA_VALIDATION_FAILED',
        'This file is not a readable PDF - it may have been truncated or corrupted while downloading. Try exporting it again.',
        { cause: error },
      );

    case 'MissingPDFException':
    case 'UnexpectedResponseException':
      return new AppError('STORAGE_READ_FAILED', 'The file could not be read from disk.', {
        cause: error,
      });

    default:
      // Unrecognised. Name the underlying reason rather than hiding it - this
      // is the branch a bug in OUR wiring lands in, and the last time one did,
      // the real reason ("Setting up fake worker failed") was visible only at
      // debug log level while the user was told nothing.
      return new AppError('UNKNOWN', `This PDF could not be read: ${message}`, { cause: error });
  }
}

/** One page's text runs, converted to top-left coordinates. */
async function extractPage(
  document: Awaited<ReturnType<typeof import('pdfjs-dist').getDocument>['promise']>,
  pageNumber: number,
): Promise<ResumeTextItem[]> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items: ResumeTextItem[] = [];

  for (const raw of content.items) {
    // PDF.js emits marked-content markers alongside text items; only the latter
    // carry a `str`.
    if (!('str' in raw)) continue;
    if (raw.str.trim().length === 0) continue;

    /**
     * `transform` is a 2D affine matrix [a, b, c, d, e, f]:
     *   e, f  - translation, i.e. the run's origin
     *   d     - vertical scale, which for unrotated text IS the font size
     *
     * Reading the font size off the matrix rather than from `fontName` is what
     * makes heading detection work: PDF font names carry no size.
     */
    const [, , , scaleY, translateX, translateY] = raw.transform as number[];

    const fontSize = Math.abs(scaleY ?? 0);
    const x = translateX ?? 0;
    const baselineY = translateY ?? 0;

    items.push({
      text: raw.str,
      page: pageNumber,
      x,
      // Flip to a top-down origin, and shift from the baseline to the top of
      // the glyph box so that items on one visual line share a y.
      y: viewport.height - baselineY - fontSize,
      width: raw.width ?? 0,
      height: raw.height ?? fontSize,
      fontSize,
      bold: isBoldFont(raw.fontName),
      ...(raw.fontName !== undefined ? { fontName: raw.fontName } : {}),
    });
  }

  // Free the page immediately; without this a multi-page document holds every
  // page's operator list until the whole extraction finishes.
  page.cleanup();

  return items;
}

/**
 * Does this document have a usable text layer?
 *
 * Spec section 8.6: do not OCR a text-native PDF, and do not pretend to have
 * parsed a scanned one. A `true` here is what lets the UI say "this looks like
 * a scan - type your details in instead" rather than presenting an empty
 * extraction as a result.
 */
export function looksScanned(items: readonly ResumeTextItem[]): boolean {
  const characters = items.reduce((total, item) => total + item.text.trim().length, 0);
  return characters < MIN_TEXT_CHARS;
}

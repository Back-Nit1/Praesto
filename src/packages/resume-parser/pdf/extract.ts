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
    // Dynamic import - see the module header. The `.mjs` build is the modern
    // ESM entry point and is what Vite can tree-shake and code-split.
    const pdfjs = await import('pdfjs-dist');

    /**
     * Run PDF.js on the main thread rather than in a worker.
     *
     * A worker is faster for rendering large documents, but it needs a
     * separately-hosted worker script, which under the extension's
     * `script-src 'self'` CSP means bundling and shipping a second megabyte
     * artefact. We are extracting text from a one- or two-page resume, once,
     * on an explicit user action - so the parallelism buys nothing we can
     * perceive, and the simplicity is worth more than the milliseconds.
     */
    pdfjs.GlobalWorkerOptions.workerSrc = '';

    const document = await pdfjs.getDocument({
      data: new Uint8Array(data),
      // A resume needs no external resources. Disabling these removes both a
      // network dependency and a class of malformed-font failures.
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;

    const items: ResumeTextItem[] = [];

    // Pages are processed sequentially, `pdfPageConcurrency` at a time. Peak
    // memory is roughly page size times concurrency, and on a 2 GB device the
    // budget drops that to 1 - which is the difference between parsing a resume
    // and having the tab killed.
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += budget.pdfPageConcurrency) {
      const batch: number[] = [];
      for (
        let offset = 0;
        offset < budget.pdfPageConcurrency && pageNumber + offset <= document.numPages;
        offset++
      ) {
        batch.push(pageNumber + offset);
      }

      const pages = await Promise.all(batch.map((n) => extractPage(document, n)));
      for (const pageItems of pages) items.push(...pageItems);
    }

    // Release the document's internal buffers rather than waiting for GC. A
    // parsed PDF holds on to a surprising amount, and the user is about to look
    // at a review screen for a while.
    await document.cleanup();

    log.info(`Extracted ${items.length} text runs from ${document.numPages} page(s)`);
    return ok({ items, pageCount: document.numPages });
  } catch (error) {
    return err(
      new AppError('UNKNOWN', 'This PDF could not be read', {
        cause: error,
        // The filename and contents are the applicant's; only the failure fact
        // is safe to log.
        redactable: true,
      }),
    );
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

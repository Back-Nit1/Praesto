/**
 * End-to-end PDF parsing tests.
 * ---------------------------------------------------------------------------
 * THIS FILE EXISTS BECAUSE ITS ABSENCE SHIPPED A BUG.
 *
 * `extraction.test.ts` tests the layout engine and the extractors against
 * synthetic `ResumeTextItem[]`, which is the right boundary for THOSE units and
 * is why they are fast and readable. But it meant nothing exercised
 * `extractPdf` itself, and `extractPdf` contained a one-line mistake:
 *
 *     pdfjs.GlobalWorkerOptions.workerSrc = '';
 *
 * intended as "do not use a worker". It actually means "load the worker from
 * the empty URL", so PDF.js rejected with `Setting up fake worker failed`, and
 * every single upload surfaced as "This PDF could not be read". A hundred
 * passing unit tests could not see it, because none of them opened a PDF.
 *
 * So these tests run the REAL pipeline over a REAL PDF file. They are slower
 * than the unit tests by an order of magnitude, and that is the correct price
 * for covering the seam where our code meets a third-party library.
 *
 * The fixture is a hand-written 1.2 KB PDF (fixtures/resumes/) rather than a
 * generated one, so the repo needs no PDF-authoring dependency and the bytes
 * that produce the expected text are readable in the file itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdf, looksScanned } from '@resume-parser/pdf/extract';
import { parseResume } from '@resume-parser/index';

function fixtureBytes(name: string): ArrayBuffer {
  const path = resolve(process.cwd(), 'fixtures/resumes', name);
  const buffer = readFileSync(path);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

describe('extractPdf', () => {
  it('reads a text-native PDF instead of failing to set up a worker', async () => {
    // The regression assertion. Before the fix this returned an error, and the
    // user saw "This PDF could not be read" for every resume they owned.
    const result = await extractPdf(fixtureBytes('sample-resume.pdf'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pageCount).toBe(1);
    expect(result.value.items.length).toBeGreaterThan(5);
  });

  it('preserves the position and size of every text run', async () => {
    const result = await extractPdf(fixtureBytes('sample-resume.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const name = result.value.items.find((item) => item.text.includes('Ada Lovelace'));
    expect(name).toBeDefined();
    if (name === undefined) return;

    // The name is set at 18pt in the fixture; body text is 10pt. That
    // difference is what heading and name detection depend on, so losing it
    // would silently degrade extraction rather than fail loudly.
    expect(name.fontSize).toBeCloseTo(18, 0);
    expect(name.x).toBeGreaterThan(0);

    // Coordinates are flipped to a top-down origin in extractPdf. The name sits
    // near the top of the page, so its y must be SMALL - if this ever reads
    // ~720 the flip has been lost and every layout heuristic inverts.
    expect(name.y).toBeLessThan(200);
  });

  it('reports a corrupt file as a failure rather than throwing', async () => {
    const notAPdf = new TextEncoder().encode('this is not a PDF at all');
    const result = await extractPdf(notAPdf.buffer as ArrayBuffer);
    expect(result.ok).toBe(false);
  });

  it('recognises a document with no usable text layer', async () => {
    // What a scanned resume looks like to us: essentially no extractable text.
    // Detecting it is what lets the UI say "this looks like a scan" instead of
    // presenting an empty extraction as a result.
    expect(looksScanned([])).toBe(true);
  });
});

describe('parseResume', () => {
  it('turns a real PDF into reviewable candidate values', async () => {
    const result = await parseResume(fixtureBytes('sample-resume.pdf'), 'doc-fixture');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { scalars, education, employment, scanned } = result.value;
    expect(scanned).toBe(false);

    // Contact details, read from the header block.
    expect(scalars['contact.email']?.value).toBe('ada@example.com');
    expect(scalars['identity.legalFirstName']?.value).toBe('Ada');
    expect(scalars['identity.lastName']?.value).toBe('Lovelace');
    expect(scalars['contact.city']?.value).toBe('New Brunswick');
    expect(scalars['contact.state']?.value).toBe('NJ');
    expect(scalars['links.linkedin']?.value).toBe('https://linkedin.com/in/ada');
    expect(scalars['links.github']?.value).toBe('https://github.com/ada');

    // Section parsing survived the round trip through real PDF geometry.
    expect(education.length).toBeGreaterThanOrEqual(1);
    expect(education[0]?.institution.value).toContain('Rutgers');
    expect(education[0]?.gpa.value).toBe('3.85');

    expect(employment.length).toBeGreaterThanOrEqual(1);
    expect(employment[0]?.company.value).toBe('Acme Corp');
  });

  it('carries evidence back to the source line for every value', async () => {
    const result = await parseResume(fixtureBytes('sample-resume.pdf'), 'doc-fixture');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const [path, value] of Object.entries(result.value.scalars)) {
      const evidence = value.evidence[0];
      expect(evidence, path).toBeDefined();
      // The review screen shows the source line next to the value. Without it
      // the user is asked to confirm a value they have no way to check.
      expect(evidence?.documentId, path).toBe('doc-fixture');
      // Nothing a parser produces may arrive pre-verified.
      expect(evidence?.verifiedByUser, path).toBe(false);
    }
  });

  it('never proposes a sensitive answer, whatever the resume contains', async () => {
    const result = await parseResume(fixtureBytes('sample-resume.pdf'), 'doc-fixture');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Spec 21.3. There is no code path from a resume to any of these, and this
    // asserts it end to end rather than trusting the extractors individually.
    for (const path of Object.keys(result.value.scalars)) {
      expect(path.startsWith('demographics.'), path).toBe(false);
      expect(path.includes('authorizedToWork'), path).toBe(false);
      expect(path.includes('Sponsorship'), path).toBe(false);
    }
  });
});

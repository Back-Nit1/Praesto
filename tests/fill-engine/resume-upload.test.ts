// @vitest-environment jsdom
/**
 * Resume attachment tests.
 *
 * Two halves, and the first is the one that matters more:
 *
 *   1. RECOGNITION - is this file input the resume field? A form usually has
 *      several file inputs. Attaching a resume to the cover-letter field sends
 *      an application whose cover letter is a resume, and the applicant never
 *      finds out.
 *   2. ATTACHMENT - does the file actually land, and does the form notice?
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isResumeField } from '@form-engine/mapper/resume-field';
import {
  FileUploadAdapter,
  clearPendingResume,
  setPendingResume,
} from '@fill-engine/adapters/file-upload';
import { descriptor, resetDescriptorIds } from '../helpers/descriptors';

/**
 * Stand-ins for two browser APIs jsdom does not implement.
 *
 * jsdom has no `DataTransfer`, and its `HTMLInputElement.files` has no setter -
 * so the exact mechanism the adapter relies on cannot run here at all. Rather
 * than deleting the tests, we provide the smallest shims that behave like the
 * real APIs for this use, and are explicit about what that does and does not
 * prove.
 *
 * WHAT THESE TESTS THEN VERIFY: our logic - the accept-filter check, the refusal
 * to overwrite an existing file, the event dispatch, and the verify read-back.
 * WHAT THEY DO NOT VERIFY: that Chrome's real FileList plumbing accepts the
 * assignment. That is browser behaviour, it is specified, and it is checked by
 * loading the extension against a real form (see the fixture instructions in
 * the README).
 */
function installFileApiShims(): void {
  class FakeDataTransfer {
    private readonly collected: File[] = [];
    readonly items = {
      add: (file: File): void => {
        this.collected.push(file);
      },
    };
    get files(): FileList {
      const list = this.collected;
      return Object.assign([...list], {
        item: (index: number) => list[index] ?? null,
        length: list.length,
      }) as unknown as FileList;
    }
  }

  (globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer;

  // jsdom defines `files` as a getter only. Redefine it with a backing field so
  // the assignment the adapter performs is observable.
  const store = new WeakMap<HTMLInputElement, FileList | null>();
  Object.defineProperty(HTMLInputElement.prototype, 'files', {
    configurable: true,
    get(this: HTMLInputElement) {
      return store.get(this) ?? null;
    },
    set(this: HTMLInputElement, value: FileList | null) {
      store.set(this, value);
    },
  });
}

installFileApiShims();

beforeEach(() => {
  resetDescriptorIds();
  document.body.innerHTML = '';
  clearPendingResume();
});

const resumeFile = (): File =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'resume.pdf', { type: 'application/pdf' });

describe('isResumeField', () => {
  it.each([
    'Resume',
    'Resume/CV',
    'Upload your resume',
    'CV',
    'Curriculum Vitae',
    'Attach resume (PDF)',
  ])('recognises a field labelled %j', (label) => {
    expect(isResumeField(descriptor({ kind: 'file', label }))).toBe(true);
  });

  it('recognises it from the name attribute when there is no label', () => {
    expect(isResumeField(descriptor({ kind: 'file', name: 'resume_file' }))).toBe(true);
    expect(isResumeField(descriptor({ kind: 'file', name: 'candidate[cv]' }))).toBe(true);
  });

  it.each([
    'Cover letter',
    'Cover Letter (optional)',
    'Transcript',
    'Portfolio',
    'Writing sample',
    'Photo',
    'Passport',
    'Letter of recommendation',
  ])('refuses a field labelled %j', (label) => {
    // Each of these is a different document. Attaching a resume here is not a
    // near-miss, it is a misfiled application.
    expect(isResumeField(descriptor({ kind: 'file', label }))).toBe(false);
  });

  it('treats a field naming BOTH documents as not the resume field', () => {
    // "Cover letter (or resume)" is a cover-letter field. When both signals are
    // present we have positive evidence of ambiguity, and the safe reading of
    // an ambiguous document field is "not the resume".
    expect(isResumeField(descriptor({ kind: 'file', label: 'Cover letter (or resume)' }))).toBe(
      false,
    );
  });

  it('refuses an unlabelled file input rather than assuming', () => {
    expect(isResumeField(descriptor({ kind: 'file', name: 'file_1' }))).toBe(false);
  });

  it('never claims a control that is not a file input', () => {
    expect(isResumeField(descriptor({ kind: 'text', label: 'Resume' }))).toBe(false);
  });
});

describe('FileUploadAdapter', () => {
  function fileInput(attributes = ''): HTMLInputElement {
    document.body.innerHTML = `<input type="file" ${attributes} />`;
    const input = document.body.firstElementChild;
    if (!(input instanceof HTMLInputElement)) throw new Error('no input');
    return input;
  }

  it('attaches the resume and reports success', async () => {
    const input = fileInput();
    setPendingResume(resumeFile());

    const result = await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');
    expect(result.ok).toBe(true);
    expect(input.files?.[0]?.name).toBe('resume.pdf');
    expect(await FileUploadAdapter.verify({ element: input, kind: 'file' }, '')).toBe(true);
  });

  it('fires change, which is half the operation', async () => {
    // Assigning `files` fires nothing. Without the event the file is genuinely
    // attached but the form still shows its "resume required" error and
    // refuses to submit.
    const input = fileInput();
    setPendingResume(resumeFile());

    const events: string[] = [];
    document.addEventListener('change', () => events.push('change'));
    document.addEventListener('input', () => events.push('input'));

    await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');
    expect(events).toContain('change');
  });

  it('never replaces a file the user already attached', async () => {
    const input = fileInput();
    const transfer = new DataTransfer();
    transfer.items.add(new File(['x'], 'tailored-for-this-job.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;

    setPendingResume(resumeFile());
    const result = await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');

    // They may have picked a resume tailored to this specific application.
    // Silently swapping it for the default is the worst kind of "helpful".
    expect(result.ok).toBe(false);
    expect(input.files?.[0]?.name).toBe('tailored-for-this-job.pdf');
  });

  it('respects an accept filter that excludes our file', async () => {
    // A PDF in a .doc-only field is silently dropped on submit - an application
    // sent with no resume, and nothing to indicate it went wrong.
    const input = fileInput('accept=".doc,.docx"');
    setPendingResume(resumeFile());

    const result = await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');
    expect(result.ok).toBe(false);
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('accepts a matching filter in either extension or MIME form', async () => {
    for (const accept of ['accept=".pdf"', 'accept="application/pdf"', 'accept="application/*"']) {
      const input = fileInput(accept);
      setPendingResume(resumeFile());
      const result = await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');
      expect(result.ok, accept).toBe(true);
    }
  });

  it('declines when no resume is stored', async () => {
    const input = fileInput();
    clearPendingResume();
    // Not an error state - it means "nothing to attach", and the field is left
    // for the user to fill by hand.
    const result = await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');
    expect(result.ok).toBe(false);
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('declines a disabled input', async () => {
    const input = fileInput('disabled');
    setPendingResume(resumeFile());
    const result = await FileUploadAdapter.fill({ element: input, kind: 'file' }, '');
    expect(result).toMatchObject({ ok: false, reason: 'not_editable' });
  });

  it('claims file inputs and nothing else', () => {
    const file = fileInput();
    expect(FileUploadAdapter.canHandle({ element: file, kind: 'file' })).toBe(true);

    document.body.innerHTML = '<input type="text" />';
    const text = document.body.firstElementChild as HTMLElement;
    expect(FileUploadAdapter.canHandle({ element: text, kind: 'text' })).toBe(false);
  });
});

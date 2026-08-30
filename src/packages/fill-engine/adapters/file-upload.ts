/**
 * File upload adapter - attaching the stored resume to an application.
 * ---------------------------------------------------------------------------
 * This is the single biggest time saving in the product. Every application asks
 * for a resume, and the manual alternative is a file picker and a walk through
 * Downloads, twenty times a day.
 *
 * HOW IT IS POSSIBLE AT ALL
 * `input.files` is read-only for security reasons - a page must not be able to
 * hand itself a file the user did not choose. But `input.files` accepts a
 * `FileList`, and a `DataTransfer` object can build one:
 *
 *     const transfer = new DataTransfer();
 *     transfer.items.add(file);
 *     input.files = transfer.files;
 *
 * That is a standard, documented API, not a workaround. The security property
 * still holds: only privileged code can construct the `File`, and here that
 * code is the extension acting on a file THE USER uploaded to it and on a fill
 * THE USER asked for. A webpage cannot do this to itself.
 *
 * WHY THE EVENT MATTERS AS MUCH AS THE ASSIGNMENT
 * Assigning `files` does not fire anything. Every modern application form
 * listens for `change` to run validation and to render "resume.pdf ✓". Without
 * the event the file is genuinely attached but the form believes nothing was
 * selected, still shows its "required" error, and refuses to submit. So the
 * event is not cosmetic - it is half the operation.
 *
 * DRAG-AND-DROP UPLOADERS
 * Many ATS platforms hide the real `<input type="file">` behind a styled
 * drop zone. The input is still in the DOM and still works; the scanner finds
 * it even when it is visually hidden, which is why `describeElement` exempts
 * zero-size inputs from its visibility check for choice-like controls. Where a
 * platform has no real input at all, this adapter declines rather than
 * synthesising a drop event, because a fabricated drop cannot be verified.
 */
import { createLogger } from '@shared/logging';
import type { ControlAdapter, FillFailureReason, FillResult } from '../types';

const log = createLogger('fill:file');

const success = (adapter: string): FillResult => ({ ok: true, adapter });
const failure = (adapter: string, reason: FillFailureReason): FillResult => ({
  ok: false,
  adapter,
  reason,
});

/**
 * The file to attach for the current fill run.
 *
 * Set by the content script immediately before a fill, and cleared afterwards.
 * Module-scoped rather than passed through `ControlContext` because the context
 * is built per control from serializable descriptor data, and a `File` is not
 * serializable - threading it through would mean widening a type used
 * everywhere for the benefit of one adapter.
 *
 * It holds the applicant's resume, so it is deliberately transient: the page
 * context should not retain their document any longer than the operation needs.
 */
let pendingResume: File | null = null;

/** Provide the resume for the fills about to run. */
export function setPendingResume(file: File | null): void {
  pendingResume = file;
}

/** Clear it. Always called after a fill run, including on the failure path. */
export function clearPendingResume(): void {
  pendingResume = null;
}

export const FileUploadAdapter: ControlAdapter = {
  name: 'FileUpload',

  canHandle: (context) =>
    context.element instanceof HTMLInputElement && context.element.type === 'file',

  read: (context) => {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return undefined;
    return input.files?.[0]?.name;
  },

  async fill(context, _value) {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return failure(this.name, 'no_adapter');

    if (pendingResume === null) {
      // No resume stored, or the user did not pick one for this run. Not an
      // error - it means "we have nothing to attach", and the field is left for
      // them to fill by hand.
      return failure(this.name, 'rejected');
    }

    if (input.disabled) return failure(this.name, 'not_editable');

    // Never replace a file the user already attached. They may have chosen a
    // tailored resume for this specific application, and silently swapping it
    // for the default would be the worst possible kind of "helpful".
    if ((input.files?.length ?? 0) > 0) return failure(this.name, 'rejected');

    /**
     * Respect the form's `accept` filter.
     *
     * Attaching a PDF to a field that only accepts .doc produces a file the
     * form silently drops on submit - an application sent with no resume, and
     * no indication anything went wrong.
     */
    if (!acceptsFile(input, pendingResume)) {
      log.info(`Skipping a file input that does not accept ${pendingResume.type}`);
      return failure(this.name, 'rejected');
    }

    try {
      const transfer = new DataTransfer();
      transfer.items.add(pendingResume);
      input.files = transfer.files;
    } catch (error) {
      // DataTransfer is unavailable in a few embedded contexts.
      log.warn('Could not construct a FileList for this input', error);
      return failure(this.name, 'rejected');
    }

    // The event IS half the operation - see the module header.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    return input.files?.length === 1 ? success(this.name) : failure(this.name, 'rejected');
  },

  async verify(context, _expected) {
    const input = context.element;
    if (!(input instanceof HTMLInputElement)) return false;
    if (pendingResume === null) return false;
    // Verified by NAME, not by identity: some frameworks re-wrap the FileList,
    // so the object may not be the one we handed over even on success.
    return input.files?.[0]?.name === pendingResume.name;
  },
};

/**
 * Does this input's `accept` attribute permit our file?
 *
 * Handles both forms the attribute takes - extensions (".pdf") and MIME types
 * ("application/pdf", "application/*"). An absent or empty attribute means the
 * input accepts anything.
 */
function acceptsFile(input: HTMLInputElement, file: File): boolean {
  const accept = input.getAttribute('accept')?.trim();
  if (accept === undefined || accept.length === 0) return true;

  const tokens = accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
  const mimeType = file.type.toLowerCase();

  return tokens.some((token) => {
    if (token.startsWith('.')) return token === extension;
    if (token.endsWith('/*')) return mimeType.startsWith(token.slice(0, -1));
    return token === mimeType;
  });
}

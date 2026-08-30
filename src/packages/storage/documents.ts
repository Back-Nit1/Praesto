/**
 * Resume document store.
 * ---------------------------------------------------------------------------
 * Holds the original resume file, bytes and all, so the extension can:
 *
 *   1. re-parse it later without asking the user to find the file again, and
 *   2. ATTACH IT to a job application's file-upload field.
 *
 * Point 2 is the one users actually feel. Every application asks for the
 * resume, and the alternative is opening a file picker and navigating to
 * Downloads twenty times a day.
 *
 * WHY INDEXEDDB AND NOT chrome.storage.local
 * A resume is 100 KB - 2 MB. `chrome.storage.local` allows ~10 MB total without
 * the `unlimitedStorage` permission, which we do not request because it enlarges
 * the install-time permission warning. Two or three resume versions would
 * consume half that quota and take the profile down with them when it filled.
 * IndexedDB also lets us read one document by key instead of deserialising
 * every stored resume to find one - which on a low-memory machine is the
 * difference between working and being killed.
 *
 * WHERE THE BYTES GO
 * Nowhere. The file is read in the options page, stored in the browser's own
 * IndexedDB on this machine, and read back only to attach it to a form the user
 * is filling. It is never sent to a server, because there is no server.
 */
import { AppError } from '@shared/errors';
import { newId } from '@shared/ids';
import { err, ok, type Result } from '@shared/result';
import { IndexedDbCollection, STORES } from './indexed-db';

/**
 * A stored resume.
 *
 * The bytes are an ArrayBuffer: IndexedDB stores it via structured clone, with
 * no base64 round-trip. Base64 would inflate the payload by a third and cost a
 * full encode/decode on every read and write.
 */
export interface ResumeDocument {
  id: string;
  /** Original filename, shown in the UI and reused when attaching to a form. */
  fileName: string;
  mimeType: string;
  /** Bytes, for re-parsing and for file upload. */
  bytes: ArrayBuffer;
  sizeBytes: number;
  addedAt: string;
  /** User-facing label, e.g. "Software engineering". */
  label?: string;
}

/** Metadata without the bytes. */
export type ResumeDocumentSummary = Omit<ResumeDocument, 'bytes'>;

/**
 * Largest resume accepted.
 *
 * 10 MB is far above any real resume - a text-native PDF resume is well under
 * 1 MB - and the cap exists so that a mis-selected video or disk image is
 * rejected with a clear message rather than filling the user's browser storage.
 */
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * Accepted types.
 *
 * PDF only for now, matching what the parser can actually read (spec 8.1).
 * DOCX is listed in the spec as a later addition via Mammoth.js; accepting it
 * here before the parser handles it would mean storing a file we then cannot
 * read, which is worse than refusing it.
 */
const ACCEPTED_MIME_TYPES = new Set(['application/pdf']);

export class ResumeDocumentStore {
  private readonly collection = new IndexedDbCollection<ResumeDocument>(STORES.resumes);

  /**
   * Store a file the user selected.
   *
   * Validates before writing. A rejected file must leave storage exactly as it
   * was - the user still has whatever resume they had before.
   */
  async add(file: File, label?: string): Promise<Result<ResumeDocumentSummary, AppError>> {
    if (!ACCEPTED_MIME_TYPES.has(file.type)) {
      return err(
        new AppError('SCHEMA_VALIDATION_FAILED', 'Only PDF resumes are supported right now', {
          context: { mimeType: file.type },
        }),
      );
    }

    if (file.size > MAX_RESUME_BYTES) {
      return err(
        new AppError('STORAGE_QUOTA_EXCEEDED', 'That file is too large to be a resume', {
          context: { sizeBytes: file.size },
        }),
      );
    }

    const bytes = await file.arrayBuffer();
    const document: ResumeDocument = {
      id: newId('resume'),
      fileName: file.name,
      mimeType: file.type,
      bytes,
      sizeBytes: file.size,
      addedAt: new Date().toISOString(),
      ...(label !== undefined ? { label } : {}),
    };

    const written = await this.collection.put(document);
    if (!written.ok) return err(written.error);

    return ok(toSummary(document));
  }

  /** One document, bytes included. Used for re-parsing and for file upload. */
  async get(id: string): Promise<Result<ResumeDocument | undefined, AppError>> {
    return this.collection.get(id);
  }

  /**
   * List stored resumes WITHOUT their bytes.
   *
   * The distinction matters: rendering a list of three resumes should not pull
   * 6 MB of PDF into memory to display three filenames. Callers that need the
   * bytes ask for one document by id.
   */
  async list(limit = 20): Promise<Result<ResumeDocumentSummary[], AppError>> {
    const all = await this.collection.list(limit);
    if (!all.ok) return err(all.error);
    return ok(all.value.map(toSummary));
  }

  async remove(id: string): Promise<Result<void, AppError>> {
    return this.collection.delete(id);
  }

  /**
   * Rebuild a `File` from a stored document.
   *
   * This is what makes automatic resume attachment possible: an `<input
   * type="file">` cannot be given a path, but it CAN be given a `File` through
   * a `DataTransfer`. See `fill-engine/adapters/file-upload.ts`.
   */
  async toFile(id: string): Promise<Result<File, AppError>> {
    const found = await this.get(id);
    if (!found.ok) return err(found.error);
    if (found.value === undefined) {
      return err(new AppError('PROFILE_NOT_FOUND', 'That resume is no longer stored'));
    }

    const { bytes, fileName, mimeType } = found.value;
    return ok(new File([bytes], fileName, { type: mimeType }));
  }
}

function toSummary(document: ResumeDocument): ResumeDocumentSummary {
  const { bytes: _bytes, ...summary } = document;
  return summary;
}

/**
 * Resume import and review.
 * ---------------------------------------------------------------------------
 * Spec section 2's onboarding path, and spec section 9's verification UX:
 *
 *     upload -> parse -> REVIEW EVERY VALUE -> merge into the profile
 *
 * THE REVIEW STEP IS NOT A FORMALITY.
 * Nothing a parser extracts reaches the profile without passing through this
 * screen. Every proposed value is shown next to the exact source text it came
 * from, with its confidence, and the user can uncheck any of them. That is what
 * makes the acceptance criterion in spec 25.4 achievable:
 *
 *   > Every extracted value is either correct or visibly uncertain. Unsupported
 *   > or fabricated values must not silently enter the verified profile.
 *
 * WHAT ACCEPTING MEANS
 * Accepting a value routes it through `ProfileRepository.mergeCandidates`, which
 * still refuses to overwrite anything already verified and reports a conflict
 * rather than silently replacing a disagreement. So even an over-eager click on
 * this screen cannot destroy a value the user previously confirmed.
 *
 * The stored PDF is separate from the parsed values: it stays in IndexedDB so
 * it can be attached to application forms, whether or not any extracted value
 * was accepted.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, StateBadge, StatusLine } from '@/components/ui';
import { ChromeLocalStore } from '@storage/key-value-store';
import { ResumeDocumentStore, type ResumeDocumentSummary } from '@storage/documents';
import { StoredProfileRepository } from '@profile/repository';
import { labelForPath } from '@profile/paths';
import { bestConfidence, type ProfileValue } from '@profile/schema';
import { parseResume, type ResumeParseResult } from '@resume-parser/index';
import { createLogger } from '@shared/logging';

const log = createLogger('options:resume');

const documents = new ResumeDocumentStore();
const profiles = new StoredProfileRepository(new ChromeLocalStore());

/** Storage key for "which resume to attach to applications by default". */
const DEFAULT_RESUME_KEY = 'aa:resume:defaultId';
const store = new ChromeLocalStore();

export function ResumeImport(): ReactNode {
  const [stored, setStored] = useState<ResumeDocumentSummary[]>([]);
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined);
  const [parsed, setParsed] = useState<ResumeParseResult | undefined>(undefined);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  const load = useCallback(async () => {
    const [list, saved] = await Promise.all([
      documents.list(),
      store.get<string>(DEFAULT_RESUME_KEY),
    ]);
    if (list.ok) setStored(list.value);
    if (saved.ok) setDefaultId(saved.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Store the file, then parse it.
   *
   * Store FIRST, deliberately. If parsing fails - a scanned PDF, an unusual
   * layout - the user still has their resume saved and attachable to
   * applications, which is most of the value. Parsing first and storing only on
   * success would throw away the useful half on the failure path.
   */
  async function handleUpload(file: File): Promise<void> {
    setBusy(true);
    setStatus({ kind: 'idle' });
    setParsed(undefined);

    /**
     * Read the file ONCE.
     *
     * Both the store and the parser need the bytes, and `file.arrayBuffer()`
     * hands back a fresh copy each call - so reading in both places meant two
     * full buffers and two disk reads for every upload. For a 10 MB resume on
     * a 4 GB Chromebook that is the largest avoidable allocation in the whole
     * extension.
     */
    const bytes = await file.arrayBuffer();

    const saved = await documents.add(file, undefined, bytes);
    if (!saved.ok) {
      setStatus({ kind: 'error', message: saved.error.message });
      setBusy(false);
      return;
    }

    await load();

    // First resume uploaded becomes the default to attach. One less step for
    // the overwhelmingly common case of having exactly one resume.
    if (defaultId === undefined) {
      await store.set(DEFAULT_RESUME_KEY, saved.value.id);
      setDefaultId(saved.value.id);
    }

    const result = await parseResume(bytes, saved.value.id);

    if (!result.ok) {
      setStatus({
        kind: 'error',
        message: `${result.error.message}. Your resume is still saved and can be attached to applications.`,
      });
      setBusy(false);
      return;
    }

    if (result.value.scanned) {
      setStatus({
        kind: 'error',
        message:
          'This PDF has no text layer - it looks like a scan or an image. It is saved and can still be attached to applications, but nothing could be read from it. Fill in the Profile tab by hand.',
      });
      setBusy(false);
      return;
    }

    setParsed(result.value);
    // Pre-check everything so accepting a good parse is one click. Unchecking
    // is the exception, and the user is looking at every row regardless.
    setAccepted(new Set(Object.keys(result.value.scalars)));
    setBusy(false);
  }

  /** Merge the checked values into the profile. */
  async function handleAccept(): Promise<void> {
    if (parsed === undefined) return;
    setBusy(true);

    const candidates: Record<string, ProfileValue<unknown>> = {};
    for (const [path, value] of Object.entries(parsed.scalars)) {
      if (accepted.has(path)) candidates[path] = value;
    }

    // Repeated entities are appended wholesale. They have no existing slot to
    // conflict with, and `mergeCandidates` only handles paths into slots that
    // already exist - see its `out_of_range` case.
    const appended = await profiles.update((profile) => ({
      ...profile,
      education: [...profile.education, ...parsed.education],
      employment: [...profile.employment, ...parsed.employment],
      projects: [...profile.projects, ...parsed.projects],
    }));

    if (!appended.ok) {
      setStatus({ kind: 'error', message: appended.error.message });
      setBusy(false);
      return;
    }

    const merged = await profiles.mergeCandidates(candidates);
    setBusy(false);

    if (!merged.ok) {
      setStatus({ kind: 'error', message: merged.error.message });
      return;
    }

    const { applied, skippedVerified, conflicts } = merged.value;
    setParsed(undefined);

    // Report what actually happened, including what was declined and why. A
    // bare "imported!" would hide that some values were left out.
    const parts = [`${applied.length} field${applied.length === 1 ? '' : 's'} imported`];
    if (skippedVerified.length > 0) {
      parts.push(`${skippedVerified.length} left alone because you had already verified them`);
    }
    if (conflicts.length > 0) {
      parts.push(`${conflicts.length} disagreed with existing values - check the Profile tab`);
    }
    setStatus({ kind: 'ok', message: `${parts.join('. ')}.` });
  }

  async function handleSetDefault(id: string): Promise<void> {
    await store.set(DEFAULT_RESUME_KEY, id);
    setDefaultId(id);
    setStatus({ kind: 'ok', message: 'This resume will be attached to applications.' });
  }

  async function handleDelete(id: string): Promise<void> {
    const removed = await documents.remove(id);
    if (!removed.ok) {
      setStatus({ kind: 'error', message: removed.error.message });
      return;
    }
    if (defaultId === id) {
      await store.remove(DEFAULT_RESUME_KEY);
      setDefaultId(undefined);
    }
    await load();
    setStatus({ kind: 'ok', message: 'Resume deleted' });
  }

  return (
    <div className="max-w-4xl space-y-6">
      <section className="surface-card relative overflow-hidden p-6 sm:p-8">
        <div className="relative z-10 max-w-2xl">
          <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-indigo-500/20 bg-[var(--app-accent-soft)] text-[--app-accent]">
            <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 3.5h7l3 3V20H7z" /><path d="M14 3.5V7h3M9.5 11h5M9.5 14h5M9.5 17h3" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold tracking-[-0.025em] text-[--app-text]">Bring your resume into the vault</h2>
          <p className="mb-5 mt-2 text-sm leading-relaxed text-[--app-muted]">
            Upload a PDF once. It stays in this browser, helps build your profile, and is ready to attach when an application asks for it.
          </p>

          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_22px_rgba(81,65,210,0.2)] transition hover:-translate-y-px hover:bg-[var(--app-accent-strong)]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V5m0 0 4 4m-4-4L8 9M5 19h14" /></svg>
          {busy ? 'Reading your resume…' : 'Upload PDF resume'}
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void handleUpload(file);
              // Reset, so re-selecting the same file fires `change` again.
              event.target.value = '';
            }}
          />
        </label>
        </div>
        <div className="pointer-events-none absolute -bottom-24 -right-20 h-72 w-72 rounded-full border border-indigo-500/10 bg-indigo-500/5 shadow-[0_0_0_28px_rgba(99,81,220,0.025),0_0_0_58px_rgba(99,81,220,0.018)]" />
      </section>

      <StatusLine status={status} />

      {stored.length > 0 && (
        <section className="surface-card p-5">
          <h3 className="mb-3 text-sm font-semibold text-[--app-text]">
            Saved resumes <span className="ml-1 text-[--app-muted]">{stored.length}</span>
          </h3>
          <ul className="space-y-2">
            {stored.map((document) => (
              <li
                key={document.id}
                className="flex items-center justify-between rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3.5 py-3 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {document.fileName}
                  <span className="ml-2 text-xs text-[--app-muted]">
                    {Math.round(document.sizeBytes / 1024)} KB ·{' '}
                    {new Date(document.addedAt).toLocaleDateString()}
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-3">
                  {defaultId === document.id ? (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-[--app-success]">Default</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(document.id)}
                      className="text-xs font-semibold text-[--app-accent] hover:underline"
                    >
                      Use this one
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDelete(document.id)}
                    className="text-xs font-semibold text-[--app-danger] hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {parsed !== undefined && (
        <ReviewExtraction
          parsed={parsed}
          accepted={accepted}
          busy={busy}
          onToggle={(path) =>
            setAccepted((current) => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            })
          }
          onAccept={() => void handleAccept()}
          onDiscard={() => {
            setParsed(undefined);
            log.info('Extraction discarded by the user');
          }}
        />
      )}
    </div>
  );
}

/**
 * The review table.
 *
 * Every row shows the proposed value AND the source text it was read from. The
 * source text is what makes review possible rather than nominal: "New Brunswick"
 * on its own is unverifiable at a glance, but "New Brunswick, NJ · (609)
 * 555-1234 · nitu@example.com" makes it instantly obvious whether we read the
 * right thing.
 */
function ReviewExtraction({
  parsed,
  accepted,
  busy,
  onToggle,
  onAccept,
  onDiscard,
}: {
  parsed: ResumeParseResult;
  accepted: Set<string>;
  busy: boolean;
  onToggle: (path: string) => void;
  onAccept: () => void;
  onDiscard: () => void;
}): ReactNode {
  const entries = Object.entries(parsed.scalars);

  return (
    <section className="surface-card space-y-4 border-indigo-500/20 p-5">
      <div>
        <h3 className="text-base font-semibold text-[--app-text]">Check what we read</h3>
        <p className="mt-1 text-sm text-[--app-muted]">
          Nothing is saved until you accept it. Uncheck anything that is wrong — a blank field is
          always better than a wrong one.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--app-border)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--app-panel-soft)] text-[10px] uppercase tracking-[0.12em] text-[--app-muted]">
          <tr>
            <th className="w-8 py-1" />
            <th className="py-1">Field</th>
            <th className="py-1">We read</th>
            <th className="py-1">From this line</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([path, value]) => {
            const confidence = bestConfidence(value);
            return (
              <tr key={path} className="border-t border-[var(--app-border)]">
                <td className="py-2">
                  <input
                    type="checkbox"
                    checked={accepted.has(path)}
                    onChange={() => onToggle(path)}
                    aria-label={`Accept ${labelForPath(path)}`}
                  />
                </td>
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    {/* Anything under 0.85 is shown as "needs review" rather
                        than "high confidence" - the same thresholds the profile
                        editor uses, so the two screens never disagree. */}
                    <StateBadge state={confidence >= 0.85 ? 'high_confidence' : 'needs_review'} />
                    {labelForPath(path)}
                  </span>
                </td>
                <td className="py-2 pr-3 font-medium">{renderValue(value.value)}</td>
                <td className="py-2 text-xs text-[--app-muted]">
                  {value.evidence[0]?.originalText ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {(parsed.education.length > 0 ||
        parsed.employment.length > 0 ||
        parsed.projects.length > 0) && (
        <p className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3 text-sm leading-relaxed text-[--app-muted]">
          Also found {parsed.education.length} education, {parsed.employment.length} experience and{' '}
          {parsed.projects.length} project entries. These are added as-is — review them in the
          Profile tab, where you can correct anything that was read wrong.
        </p>
      )}

      <div className="flex gap-2">
        <Button onClick={onAccept} disabled={busy}>
          Add {accepted.size} field{accepted.size === 1 ? '' : 's'} to my profile
        </Button>
        <Button variant="secondary" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </div>
    </section>
  );
}

/** Render a candidate value for display, whatever shape it is. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // Skills lists get long; showing forty of them makes the table unreadable.
    const shown = value.slice(0, 8).join(', ');
    return value.length > 8 ? `${shown}, +${value.length - 8} more` : shown;
  }
  if (typeof value === 'object') {
    // NormalizedPhone and NormalizedDate both keep the source text in `raw`,
    // which is the most faithful thing to show for review.
    const record = value as { raw?: string; national?: string };
    return record.national ?? record.raw ?? JSON.stringify(value);
  }
  return String(value);
}

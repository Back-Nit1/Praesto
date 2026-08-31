/**
 * Application history screen.
 * ---------------------------------------------------------------------------
 * Spec section 24 asks for audit records so that "why did it fill that?" has an
 * answer. This screen is where the user reads them.
 *
 * WHAT THIS SCREEN IS FOR, IN ORDER
 *   1. "Did I already apply here?" - the question a person actually asks, and
 *      the reason runs are listed by employer and time rather than by field.
 *   2. "What did it fail to fill?" - the fields worth going back for.
 *   3. "What did it not understand?" - the questions the user had to answer by
 *      hand, which are exactly what a correction would fix.
 *
 * WHY IT IS HERE AND NOT IN THE SIDE PANEL
 * Spec section 22 is explicit that the panel must not bury the user in mapping
 * metadata during an application. History is retrospective by nature: it is
 * read between applications, on a full-width screen, and it belongs beside the
 * learned rules it explains.
 *
 * WHAT IS NOT ON THIS SCREEN
 * Any value the extension typed. History records the QUESTION and the OUTCOME,
 * never the answer - see audit/types.ts. A user looking for what was actually
 * submitted has the form itself, which is the only honest source for it.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, StatusLine } from '@/components/ui';
import { AuditRepository } from '@audit/repository';
import { DEFAULT_RETENTION } from '@audit/retention';
import type { ApplicationRun, FillAuditRecord } from '@audit/types';
import { labelForPath } from '@profile/paths';

/**
 * The default repository, over IndexedDB.
 *
 * Injectable below rather than reached for directly, so this screen can be
 * tested against `InMemoryAuditCollection` in a Node process. jsdom has no
 * IndexedDB, and a screen that can only be exercised in a real browser is a
 * screen whose empty, loaded and error states never get tested at all.
 */
const defaultRepository = new AuditRepository();

export function History({
  repository = defaultRepository,
}: {
  repository?: AuditRepository;
} = {}): ReactNode {
  const [runs, setRuns] = useState<ApplicationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  const load = useCallback(async () => {
    setLoading(true);
    const result = await repository.recentRuns();
    if (result.ok) setRuns(result.value);
    else setStatus({ kind: 'error', message: result.error.message });
    setLoading(false);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleClear(): Promise<void> {
    const result = await repository.clear();
    setConfirmingClear(false);
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.error.message });
      return;
    }
    setStatus({ kind: 'ok', message: 'History deleted' });
    await load();
  }

  if (loading) {
    return (
      <div className="surface-card grid min-h-48 place-items-center p-8 text-center">
        <div>
          <div className="scan-lines" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <p className="text-sm text-[var(--ink-2)]">Loading your history…</p>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="surface-card grid min-h-64 max-w-3xl place-items-center p-8 text-center">
        <div className="max-w-md">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-[var(--rule)] bg-[var(--paper-2)] text-[var(--ink)]">
            <HistoryGlyph size={22} />
          </span>
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--ink)]">
            No applications yet
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--ink-2)]">
            Once you fill an application from the side panel, it is listed here with what was
            filled, what failed and what the extension did not understand.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface-card flex items-center justify-between gap-5 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-[var(--rule)] bg-[var(--paper-2)] text-[var(--ink)]">
            <HistoryGlyph size={19} />
          </span>
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--ink-2)]">
            {runs.length} application{runs.length === 1 ? '' : 's'}, kept on this machine for{' '}
            {DEFAULT_RETENTION.maxAgeDays} days. The questions each form asked are recorded, and
            whether each one was filled — never the answers themselves.
          </p>
        </div>

        {/* Two clicks, because it cannot be undone and there is nothing to
            restore from. The confirming state says what will be lost rather
            than asking "are you sure?", which is a question nobody reads. */}
        {confirmingClear ? (
          <div className="flex flex-none items-center gap-2">
            <Button variant="danger" onClick={handleClear}>
              Delete all history
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmingClear(true)}>
            Clear history
          </Button>
        )}
      </div>

      <StatusLine status={status} />

      <div className="space-y-3">
        {runs.map((run) => (
          <RunCard key={run.runId} run={run} />
        ))}
      </div>
    </div>
  );
}

/**
 * One application.
 *
 * Collapsed by default and summarised by its counts. Someone scanning this
 * screen is looking for one employer, not reading forty field rows - and the
 * counts are the part that answers "did that one go through?".
 */
function RunCard({ run }: { run: ApplicationRun }): ReactNode {
  const [open, setOpen] = useState(false);

  // Only the buckets that happened. A row of zeroes is noise, and "0 failed"
  // beside a run where nothing failed is a sentence about nothing.
  const stats = [
    { label: 'filled', count: run.counts.filled, colour: 'var(--s-verified)' },
    { label: 'failed', count: run.counts.failed, colour: 'var(--danger)' },
    { label: 'left blank', count: run.counts.skipped, colour: 'var(--s-unknown)' },
    { label: 'corrected', count: run.counts.corrected, colour: 'var(--ink-2)' },
  ].filter((stat) => stat.count > 0);

  return (
    <section className="surface-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-[var(--paper-2)]"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
            {run.hostname}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-[var(--ink-2)]">
            {formatWhen(run.startedAt)} · {pathOf(run.pageUrl)}
          </div>
        </div>

        <div className="flex flex-none items-center gap-3">
          {stats.map((stat) => (
            <span key={stat.label} className="flex items-center gap-1.5 text-[11.5px]">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: stat.colour }}
                aria-hidden="true"
              />
              <span className="data">{stat.count}</span>
              <span className="text-[var(--ink-2)]">{stat.label}</span>
            </span>
          ))}
          <Chevron open={open} />
        </div>
      </button>

      {open && (
        <div className="border-t border-[var(--rule)]">
          <ul className="divide-y divide-[var(--rule)]">
            {run.fields.map((field) => (
              <FieldRow key={field.id} field={field} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * One question, and what happened to it.
 *
 * The label is the form's own wording, which is what makes a row recognisable
 * to someone who filled that form ten minutes ago. Where there is none - a
 * control with no label, accessible name or nearby text, which is itself worth
 * seeing - the row says so rather than showing an empty line.
 */
function FieldRow({ field }: { field: FillAuditRecord }): ReactNode {
  const outcome = describeOutcome(field);

  return (
    <li className="flex items-start justify-between gap-4 px-4 py-2.5 text-[12.5px]">
      <div className="min-w-0">
        <div className="truncate text-[var(--ink)]">
          {field.detectedLabel ?? <span className="text-[var(--ink-3)]">Unlabelled field</span>}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--ink-2)]">
          {field.mappedProfilePath === undefined
            ? 'Not recognised'
            : `${labelForPath(field.mappedProfilePath)} · ${describeSource(field)}`}
          {field.userCorrected && ' · you corrected this'}
        </div>
      </div>

      <span className="flex-none text-[11.5px]" style={{ color: outcome.colour }}>
        {outcome.label}
      </span>
    </li>
  );
}

/**
 * What happened, in the user's terms.
 *
 * "Attempted but not verified" is stated as *failed*, never softened. A history
 * that rounds an unverified fill up to a success recreates the exact bug the
 * side panel was built to stop: a user who trusts a count and finds empty
 * fields has to check every field forever afterwards.
 */
function describeOutcome(field: FillAuditRecord): { label: string; colour: string } {
  if (!field.fillAttempted) {
    return {
      label: field.decidedAction === 'suggest' ? 'Left for you' : 'Left blank',
      colour: 'var(--ink-2)',
    };
  }
  if (field.fillVerified) return { label: 'Filled', colour: 'var(--s-verified)' };
  return { label: field.failureReason ?? 'Failed', colour: 'var(--danger)' };
}

/** Which part of the system produced the mapping, in plain language. */
function describeSource(field: FillAuditRecord): string {
  switch (field.mappingSource) {
    case 'html':
      return 'from the form’s own markup';
    case 'alias':
      return 'recognised wording';
    case 'ats':
      return 'a rule for this platform';
    case 'memory':
      return 'something you taught it';
    case 'fuzzy':
      return 'a close wording match';
    case 'semantic':
      return 'a semantic match';
    case 'none':
      return 'no mapping';
  }
}

/**
 * Date and time, as a person would say it.
 *
 * Today and yesterday are named rather than dated: a run from this morning
 * being labelled "31/08/2026" makes the reader do arithmetic to answer "was
 * that today?", which is the only question they had.
 */
function formatWhen(iso: string): string {
  const when = new Date(iso);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // Measured from the START of today, not from now, so "yesterday" means the
  // calendar day and not "more than 24 hours ago" - a fill at 11pm last night
  // is yesterday at 9am this morning, and would not be by the other reading.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const daysBeforeToday = Math.floor(
    (startOfToday.getTime() - when.getTime()) / (24 * 60 * 60 * 1000),
  );

  // Negative means the run is after midnight today.
  if (daysBeforeToday < 0) return `Today, ${time}`;
  if (daysBeforeToday === 0) return `Yesterday, ${time}`;
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The path, which is what distinguishes two postings on one careers site. */
function pathOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).pathname;
  } catch {
    return pageUrl;
  }
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none text-[var(--ink-2)] transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function HistoryGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12a8 8 0 1 0 2.5-5.8M4 5.5V10h4.5" />
      <path d="M12 8v4.5l3 1.8" />
    </svg>
  );
}

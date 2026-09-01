/**
 * Development metrics screen.
 * ---------------------------------------------------------------------------
 * Spec section 26, and nothing more than section 26: these numbers are FOR
 * DEVELOPMENT. The screen lives behind the developer toggle, is off by default,
 * and is never shown to somebody in the middle of an application.
 *
 * THE RENDERING RULE
 * No bare percentage, ever. Every rate is printed with the number of rows that
 * produced evidence and the number that did not, and below a floor of reviewed
 * rows it prints the words "not enough evidence" and NO figure at all. The `≥`
 * is load-bearing: unreviewed rows can only push a rate up, never down, so the
 * figure is a floor rather than an estimate.
 *
 * A metrics screen that guessed would be the one subsystem making every other
 * refusal in this product a lie.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StatusLine } from '@/components/ui';
import {
  computeMetrics,
  formatRate,
  MIN_REVIEWED_FOR_A_NUMBER,
  type DevelopmentMetrics,
  type ObservedRate,
} from '@audit/metrics';
import { AuditRepository } from '@audit/repository';

/** Over IndexedDB by default; injected in tests. Same pattern as History. */
const defaultRepository = new AuditRepository();

export function Metrics({
  repository = defaultRepository,
}: {
  repository?: AuditRepository;
} = {}): ReactNode {
  const [metrics, setMetrics] = useState<DevelopmentMetrics | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  const load = useCallback(async () => {
    setLoading(true);
    const result = await repository.recentRuns();
    if (result.ok) setMetrics(computeMetrics(result.value));
    else setStatus({ kind: 'error', message: result.error.message });
    setLoading(false);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="surface-card grid min-h-48 place-items-center p-8 text-center">
        <p className="text-sm text-[var(--ink-2)]">Reading your history…</p>
      </div>
    );
  }

  if (metrics === undefined || metrics.countedFields === 0) {
    return (
      <div className="surface-card grid min-h-48 max-w-3xl place-items-center p-8 text-center">
        <p className="max-w-md text-sm leading-relaxed text-[var(--ink-2)]">
          Nothing to measure yet. These numbers are computed from your own application history,
          on this machine, and nothing is sent anywhere.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface-card p-5">
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--ink-2)]">
          Computed from {metrics.countedFields} field
          {metrics.countedFields === 1 ? '' : 's'} across {metrics.runs} application
          {metrics.runs === 1 ? '' : 's'}. Most fields are never reviewed, and an unreviewed field
          is not evidence that it was right — so each rate shows what it is based on, and shows
          nothing at all below {MIN_REVIEWED_FOR_A_NUMBER} reviewed fields.
        </p>
      </div>

      <StatusLine status={status} />

      <div className="space-y-3">
        <RateCard
          label="Incorrect-fill rate"
          detail="Fields we wrote or offered that the user had to undo. The metric section 26 names as the most important."
          rate={metrics.incorrectFill}
        />
        <RateCard
          label="User correction rate"
          detail="Every field the user changed, in any direction — including teaching us one we had refused."
          rate={metrics.userCorrection}
        />
        <RateCard
          label="Unknown-field rate"
          detail="Fields we had nothing to say about and have not since been taught."
          rate={metrics.unknownField}
        />
        <RateCard
          label="Repeated-question reuse rate"
          detail="Mapped from memory or the semantic cache. An upper bound: a first-ever question answered by the model is recorded the same way as a cache hit."
          rate={metrics.repeatedQuestionReuse}
        />

        {/* The one fully observed number here, and it gets a different shape so
            it cannot be read as one of the inferred rates. Every attempt was
            either read back or not; nobody had to review anything. */}
        <section className="surface-card p-4">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="text-[13.5px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
              Fill execution success rate
            </h3>
            <span className="data text-[13.5px] text-[var(--ink)]">
              {metrics.fillExecutionSuccess.denominator === 0
                ? 'no attempts'
                : `${((metrics.fillExecutionSuccess.numerator / metrics.fillExecutionSuccess.denominator) * 100).toFixed(1)}%`}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-2)]">
            {metrics.fillExecutionSuccess.numerator} of{' '}
            {metrics.fillExecutionSuccess.denominator} attempted fills were read back from the
            page. Fully observed — there is nothing hidden behind this one.
          </p>
        </section>
      </div>

      <p className="max-w-2xl text-[11.5px] leading-relaxed text-[var(--ink-3)]">
        Two of the seven metrics in section 26 are absent rather than estimated. Field-mapping
        precision and verified-fill precision need ground truth about what each field SHOULD have
        mapped to, and your history has never contained that. They belong to the fixture corpus,
        where the expected mapping is known.
      </p>
    </div>
  );
}

/**
 * One rate, with everything needed to distrust it.
 *
 * The order is deliberate: the figure is stated, and immediately beside it the
 * sample it rests on. A card that showed "2.1%" and hid "310 unreviewed" behind
 * a tooltip would be the same lie with an extra click.
 */
function RateCard({
  label,
  detail,
  rate,
}: {
  label: string;
  detail: string;
  rate: ObservedRate;
}): ReactNode {
  const formatted = formatRate(rate);

  return (
    <section className="surface-card p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
          {label}
        </h3>
        {formatted === null ? (
          <span className="text-[12.5px] text-[var(--ink-3)]">not enough evidence</span>
        ) : (
          <span className="data text-[13.5px] text-[var(--ink)]">{formatted}</span>
        )}
      </div>

      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-2)]">
        {rate.numerator} of {rate.reviewed} reviewed
        {rate.unreviewed > 0 ? ` · ${rate.unreviewed} unreviewed` : ''}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-3)]">{detail}</p>
    </section>
  );
}

/**
 * Settings.
 * ---------------------------------------------------------------------------
 * Three things live here, and they are here rather than in the side panel for
 * the reason the panel already documents: a panel that reports its own
 * internals on every scan is one the user stops reading. These are read between
 * applications, not during one.
 *
 *   Developer mode   spec section 22's toggle for debug surfaces.
 *   AI usage         what today's forms have cost, and what the last few scans
 *                    cost individually (limitation 14 - the panel is silent
 *                    unless the fallback failed, so this was unanswerable).
 *   Concept cache    what the model has been asked, and a way to forget it.
 *                    `clear()` has existed since the cache was written and
 *                    nothing called it, so a wrong cached concept could only be
 *                    escaped by wiping all extension data.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, StatusLine } from '@/components/ui';
import { readModelUsage } from '@backend/gateway';
import { ScanCostLog, type ScanCost } from '@backend/usage-log';
import { SemanticConceptCache } from '@semantic/cache';
import { ChromeLocalStore } from '@storage/key-value-store';

export interface SettingsDeps {
  cache: SemanticConceptCache;
  scanCosts: ScanCostLog;
  usage: () => Promise<{ used: number; limit: number; resetsInMs: number }>;
}

/**
 * The real, chrome-backed dependencies.
 *
 * Built on first render rather than at module scope: `ChromeLocalStore` reaches
 * for `chrome.storage.local` in its default argument, and a module-scope
 * instance would make this file unimportable in a Node test process - which is
 * how a screen ends up with no tests for its empty and error states.
 */
function defaultDeps(): SettingsDeps {
  const store = new ChromeLocalStore();
  return {
    cache: new SemanticConceptCache(store),
    scanCosts: new ScanCostLog(store),
    usage: () => readModelUsage(store),
  };
}

export function Settings({
  developerMode,
  onDeveloperMode,
  deps,
}: {
  developerMode: boolean;
  onDeveloperMode: (enabled: boolean) => void;
  deps?: SettingsDeps;
}): ReactNode {
  const [resolved] = useState<SettingsDeps>(() => deps ?? defaultDeps());
  const [usage, setUsage] = useState<{ used: number; limit: number; resetsInMs: number }>();
  const [costs, setCosts] = useState<ScanCost[]>([]);
  const [cacheSize, setCacheSize] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  const load = useCallback(async () => {
    setUsage(await resolved.usage());
    setCosts(await resolved.scanCosts.recent());
    setCacheSize(await resolved.cache.size());
  }, [resolved]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleClearCache(): Promise<void> {
    const result = await resolved.cache.clear();
    setConfirmingClear(false);
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.error.message });
      return;
    }
    setStatus({
      kind: 'ok',
      // Says what it costs, because it is not free: the next application pays
      // for these questions again.
      message: 'Remembered questions cleared. They will be asked again once.',
    });
    await load();
  }

  return (
    <div className="max-w-3xl space-y-4">
      <section className="surface-card p-5">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
          Developer mode
        </h2>
        <label className="mt-3 flex cursor-pointer items-start gap-3 text-[12.5px] text-[var(--ink-2)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={developerMode}
            onChange={(event) => onDeveloperMode(event.target.checked)}
          />
          <span>
            Show the metrics screen. Off by default — those numbers are for
            developing the extension, and a fill-rate number on screen is a number
            somebody starts optimising.
          </span>
        </label>
      </section>

      <section className="surface-card p-5">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
          AI usage
        </h2>

        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          {usage === undefined
            ? 'Reading…'
            : `${usage.used} of ${usage.limit} model calls used today${
                usage.used > 0 ? ` · resets in ${formatDuration(usage.resetsInMs)}` : ''
              }.`}
        </p>

        {/* Only questions the deterministic engine could not answer ever reach
            a model. Saying so next to the number is what makes a large one
            legible rather than alarming. */}
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          Only questions the extension could not answer on its own are sent, and each
          distinct question costs at most one call ever.
        </p>

        {costs.length > 0 && (
          <ul className="mt-3 space-y-1">
            {costs.map((cost) => (
              <li
                key={cost.at}
                className="flex items-baseline justify-between gap-4 text-[11.5px] text-[var(--ink-2)]"
              >
                <span>{formatClock(cost.at)}</span>
                <span className="data">
                  {cost.modelCalls} call{cost.modelCalls === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {costs.length === 0 && (
          <p className="mt-3 text-[11.5px] text-[var(--ink-3)]">
            No scan has needed a model call yet.
          </p>
        )}
      </section>

      <section className="surface-card p-5">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
          Remembered questions
        </h2>

        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          {cacheSize === 0
            ? 'Nothing remembered yet.'
            : `${cacheSize} question${cacheSize === 1 ? '' : 's'} the extension has already worked out, so they cost nothing on the next application.`}
        </p>

        {/* What this is NOT is stated, because the two stores are easy to
            confuse and only one of them holds anything the user said. */}
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          These are the model's readings of form questions — not your corrections,
          which live under Learned rules and are not touched by this button.
        </p>

        <div className="mt-3">
          {confirmingClear ? (
            <div className="flex items-center gap-2">
              <Button variant="danger" onClick={handleClearCache}>
                Forget all of them
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
                Keep them
              </Button>
            </div>
          ) : (
            <Button
              variant="danger"
              onClick={() => setConfirmingClear(true)}
              disabled={cacheSize === 0}
            >
              Clear remembered questions
            </Button>
          )}
        </div>
      </section>

      <StatusLine status={status} />
    </div>
  );
}

/** "3 hours", "18 minutes". Coarse on purpose - it is a budget, not a timer. */
function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

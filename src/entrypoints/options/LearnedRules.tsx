/**
 * Learned rules settings screen.
 * ---------------------------------------------------------------------------
 * Spec section 19's definition of done requires two things this screen provides:
 *
 *   - "learned rules can be inspected/deleted from settings"
 *   - "bad learned rules do not permanently trap the system"
 *
 * The second is the reason this screen is not optional. A learning system the
 * user cannot see into is a system they cannot debug when it starts being
 * confidently wrong, and the only remedy left would be uninstalling. Every rule
 * the extension has inferred about you is listed here, in plain language, with
 * a delete button.
 *
 * The rules are also the clearest possible answer to "why did it fill that?" -
 * which is a question the user WILL eventually ask.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, StatusLine } from '@/components/ui';
import { ChromeLocalStore } from '@storage/key-value-store';
import { LearnedMappingStore, isRetired } from '@learning/mapping-memory';
import type { LearnedMapping, MappingScope } from '@learning/types';
import { labelForPath } from '@profile/paths';

const store = new LearnedMappingStore(new ChromeLocalStore());

/** Plain-language scope names. The stored identifiers mean nothing to a user. */
const SCOPE_LABELS: Record<MappingScope, string> = {
  global: 'Everywhere',
  ats: 'This platform',
  company: 'This company',
  exact_field: 'Just this field',
};

export function LearnedRules(): ReactNode {
  const [rules, setRules] = useState<LearnedMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  const load = useCallback(async () => {
    setLoading(true);
    const result = await store.all();
    if (result.ok) {
      // Newest first: a rule you just taught it is the one you are most likely
      // to be looking for, whether to confirm it or to undo it.
      setRules([...result.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } else {
      setStatus({ kind: 'error', message: result.error.message });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(id: string): Promise<void> {
    const result = await store.remove(id);
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.error.message });
      return;
    }
    setStatus({ kind: 'ok', message: 'Rule deleted' });
    await load();
  }

  async function handleClear(): Promise<void> {
    const result = await store.clear();
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.error.message });
      return;
    }
    setStatus({ kind: 'ok', message: 'All learned rules deleted' });
    await load();
  }

  if (loading) {
    return (
      <div className="surface-card grid min-h-48 place-items-center p-8 text-center">
        <div>
          <div className="scan-orbit !my-0 !mb-3 !h-12 !w-12" aria-hidden="true" />
          <p className="text-sm text-[var(--ink-2)]">Opening personal memory…</p>
        </div>
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="surface-card grid min-h-64 max-w-3xl place-items-center p-8 text-center">
        <div className="max-w-md">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-[var(--rule)] bg-[var(--paper-2)] text-[var(--ink)]">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5a6 6 0 0 0-3.8 10.6c.8.7 1.3 1.5 1.3 2.4h5c0-.9.5-1.7 1.3-2.4A6 6 0 0 0 12 3.5Z" /><path d="M9.7 20h4.6M10 17h4" /></svg>
          </span>
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--ink)]">No corrections yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--ink-2)]">
            When you correct a field in the side panel, the agent records it here and uses it on future applications.
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
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5a6 6 0 0 0-3.8 10.6c.8.7 1.3 1.5 1.3 2.4h5c0-.9.5-1.7 1.3-2.4A6 6 0 0 0 12 3.5Z" /><path d="M9.7 20h4.6M10 17h4" /></svg>
          </span>
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--ink-2)]">
          {rules.length} rule{rules.length === 1 ? '' : 's'} learned from your corrections. Delete
          any that are wrong — the extension will fall back to its normal behaviour for that field.
          </p>
        </div>
        <Button variant="danger" onClick={handleClear}>
          Delete all
        </Button>
      </div>

      <StatusLine status={status} />

      <div className="surface-card overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-[var(--paper-2)] text-[10px] uppercase tracking-[0.12em] text-[var(--ink-2)]">
          <tr>
            <th className="px-4 py-3">Question</th>
            <th className="px-4 py-3">Means</th>
            <th className="px-4 py-3">Applies</th>
            <th className="px-4 py-3 text-right">Track record</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} className="border-t border-[var(--rule)] transition hover:bg-[var(--paper-2)]">
              <td className="px-4 py-3.5">
                <span className={isRetired(rule) ? 'text-[var(--ink-3)] line-through' : 'font-medium text-[var(--ink)]'}>
                  {rule.normalizedLabel ?? <span className="font-mono text-xs">{rule.semanticFingerprint}</span>}
                </span>
                {isRetired(rule) && (
                  // A retired rule is kept and shown rather than deleted, so the
                  // user can see the system noticed it was wrong and stopped
                  // using it. Silently dropping it would look like amnesia.
                  <span className="ml-2 rounded-full bg-[var(--paper-2)] px-2 py-1 text-[10px] text-[var(--ink-2)]">
                    stopped using
                  </span>
                )}
              </td>
              <td className="px-4 py-3.5 text-[var(--ink)]">
                {rule.profilePath.length === 0 ? (
                  <span className="text-[var(--ink-2)]">nothing (leave alone)</span>
                ) : (
                  labelForPath(rule.profilePath)
                )}
              </td>
              <td className="px-4 py-3.5 text-[var(--ink-2)]">
                {SCOPE_LABELS[rule.scope]}
                {rule.hostname !== undefined && (
                  <span className="block text-xs">{rule.hostname}</span>
                )}
              </td>
              <td className="px-4 py-3.5 text-right text-[var(--ink-2)]">
                {/* Both counts, always. Showing only successes would flatter the
                    system; the corrections are what tell the user whether a rule
                    is actually working for them. */}
                <span className="text-[var(--s-verified)]">{rule.successfulUses} used</span>
                {rule.correctedUses > 0 && (
                  <span className="ml-2 text-[var(--s-review)]">{rule.correctedUses} corrected</span>
                )}
              </td>
              <td className="px-4 py-3.5 text-right">
                <button
                  type="button"
                  onClick={() => void handleDelete(rule.id)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-[var(--danger)] transition hover:bg-[var(--danger-wash)]"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

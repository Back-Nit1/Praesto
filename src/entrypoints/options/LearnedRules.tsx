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

  if (loading) return <p className="text-sm text-zinc-500">Loading...</p>;

  if (rules.length === 0) {
    return (
      <div className="max-w-2xl space-y-2">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Nothing learned yet. When you correct a field in the side panel, the correction is
          recorded here and used on future applications.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {rules.length} rule{rules.length === 1 ? '' : 's'} learned from your corrections. Delete
          any that are wrong — the extension will fall back to its normal behaviour for that field.
        </p>
        <Button variant="danger" onClick={handleClear}>
          Delete all
        </Button>
      </div>

      <StatusLine status={status} />

      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="py-2">Question</th>
            <th className="py-2">Means</th>
            <th className="py-2">Applies</th>
            <th className="py-2 text-right">Track record</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} className="border-t border-zinc-200 dark:border-zinc-700">
              <td className="py-2 pr-3">
                <span className={isRetired(rule) ? 'text-zinc-400 line-through' : ''}>
                  {rule.normalizedLabel ?? <span className="font-mono text-xs">{rule.semanticFingerprint}</span>}
                </span>
                {isRetired(rule) && (
                  // A retired rule is kept and shown rather than deleted, so the
                  // user can see the system noticed it was wrong and stopped
                  // using it. Silently dropping it would look like amnesia.
                  <span className="ml-2 rounded bg-zinc-200 px-1 text-xs dark:bg-zinc-700">
                    stopped using
                  </span>
                )}
              </td>
              <td className="py-2 pr-3">
                {rule.profilePath.length === 0 ? (
                  <span className="text-zinc-500">nothing (leave alone)</span>
                ) : (
                  labelForPath(rule.profilePath)
                )}
              </td>
              <td className="py-2 pr-3 text-zinc-500">
                {SCOPE_LABELS[rule.scope]}
                {rule.hostname !== undefined && (
                  <span className="block text-xs">{rule.hostname}</span>
                )}
              </td>
              <td className="py-2 pr-3 text-right text-zinc-500">
                {/* Both counts, always. Showing only successes would flatter the
                    system; the corrections are what tell the user whether a rule
                    is actually working for them. */}
                <span className="text-green-600">{rule.successfulUses} used</span>
                {rule.correctedUses > 0 && (
                  <span className="ml-2 text-amber-600">{rule.correctedUses} corrected</span>
                )}
              </td>
              <td className="py-2 text-right">
                <button
                  type="button"
                  onClick={() => void handleDelete(rule.id)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

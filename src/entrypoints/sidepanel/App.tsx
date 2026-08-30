/**
 * Side panel - the surface the user actually works in.
 * ---------------------------------------------------------------------------
 * Spec section 22. The panel's job is to make the system's uncertainty legible:
 *
 *     Application detected
 *     ATS: Greenhouse
 *
 *     18 fields detected
 *     13 ready to fill
 *      3 need review
 *      2 unknown
 *
 *     [Fill safe fields]
 *
 * THE DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE
 * The product's value is that the user can STOP checking obvious fields. That
 * only works if the panel is honest and quiet: it must show what it did, what
 * it declined to do, and nothing else. Spec section 22 explicitly warns against
 * overwhelming the user with debugging metadata - which is why confidence
 * numbers, mapping reasons and fingerprints live in the options-page playground
 * and not here.
 *
 * NOTHING FILLS WITHOUT A CLICK
 * Scanning happens on request. Filling happens on a separate, explicit click.
 * There is no auto-fill-on-load path, and spec section 21.4 forbids submitting
 * the form under any circumstances.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Button, StateBadge, StatusLine } from '@/components/ui';
import type { ResolvedFieldAction } from '@shared/messages';
import { createLogger } from '@shared/logging';

const log = createLogger('sidepanel');

type PanelState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'scanned'; actions: ResolvedFieldAction[] }
  | { kind: 'filled'; actions: ResolvedFieldAction[] }
  | { kind: 'error'; message: string };

export function App(): ReactNode {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  /**
   * Send a message to the content script in the active tab.
   *
   * `chrome.tabs.sendMessage` addresses the tab directly rather than going
   * through the service worker. One less hop, and the worker has no reason to
   * be involved in a panel-to-page request that carries no profile data.
   */
  const sendToActiveTab = useCallback(async <T,>(message: unknown): Promise<T | undefined> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return undefined;
    try {
      return (await chrome.tabs.sendMessage(tab.id, message)) as T;
    } catch (error) {
      // Thrown when no content script is listening: a chrome:// page, the web
      // store, a PDF viewer, or a tab loaded before the extension was
      // installed. All are normal, none are bugs.
      log.debugLazy(() => ['No content script in the active tab', error]);
      return undefined;
    }
  }, []);

  async function handleScan(): Promise<void> {
    setBusy(true);
    setState({ kind: 'scanning' });

    const response = await sendToActiveTab<{ ok: boolean; actions?: ResolvedFieldAction[] }>({
      type: 'CONTENT_SCAN',
    });

    setBusy(false);

    if (response === undefined) {
      setState({
        kind: 'error',
        message: 'No application form found on this page. Try reloading it first.',
      });
      return;
    }
    if (!response.ok || response.actions === undefined) {
      setState({ kind: 'error', message: 'This page could not be scanned.' });
      return;
    }

    setState({ kind: 'scanned', actions: response.actions });
  }

  async function handleFill(actions: ResolvedFieldAction[]): Promise<void> {
    setBusy(true);
    await sendToActiveTab({
      type: 'CONTENT_FILL',
      // Only the safe ones cross. Sending `suggest` actions and filtering in the
      // page would put the policy decision in two places, and the page context
      // is the one place it must never live.
      actions: actions.filter((action) => action.action === 'fill'),
    });
    setBusy(false);
    setState({ kind: 'filled', actions });
  }

  return (
    <div className="min-h-screen bg-white p-4 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <h1 className="text-base font-semibold">Job Application Agent</h1>
        <button
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="text-xs text-blue-600 hover:underline"
        >
          Edit your profile
        </button>
      </header>

      {state.kind === 'idle' && (
        <div className="space-y-3">
          <p className="text-zinc-600 dark:text-zinc-400">
            Open a job application, then scan it. Nothing is filled until you ask.
          </p>
          <Button onClick={handleScan} disabled={busy}>
            Scan this page
          </Button>
        </div>
      )}

      {state.kind === 'scanning' && <p className="text-zinc-500">Reading the form...</p>}

      {state.kind === 'error' && (
        <div className="space-y-3">
          <StatusLine status={{ kind: 'error', message: state.message }} />
          <Button variant="secondary" onClick={handleScan} disabled={busy}>
            Try again
          </Button>
        </div>
      )}

      {(state.kind === 'scanned' || state.kind === 'filled') && (
        <ScanReport
          actions={state.actions}
          filled={state.kind === 'filled'}
          busy={busy}
          onFill={() => void handleFill(state.actions)}
          onRescan={handleScan}
        />
      )}
    </div>
  );
}

/**
 * The summary and audit list.
 *
 * Grouped by what the user needs to DO, not by page order: fields that need a
 * decision come first, and the ones that will just work are collapsed into a
 * count. Sorting by page order would bury the three fields that matter among
 * the thirteen that do not.
 */
function ScanReport({
  actions,
  filled,
  busy,
  onFill,
  onRescan,
}: {
  actions: ResolvedFieldAction[];
  filled: boolean;
  busy: boolean;
  onFill: () => void;
  onRescan: () => void;
}): ReactNode {
  const ready = actions.filter((action) => action.action === 'fill');
  const review = actions.filter((action) => action.action === 'suggest');
  const skipped = actions.filter((action) => action.action === 'skip');

  if (actions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-zinc-600 dark:text-zinc-400">No application form detected.</p>
        <Button variant="secondary" onClick={onRescan} disabled={busy}>
          Scan again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <Stat label="Fields detected" value={actions.length} />
        <Stat label="Ready to fill" value={ready.length} />
        <Stat label="Need review" value={review.length} />
        <Stat label="Not recognised" value={skipped.length} />
      </dl>

      <div className="flex gap-2">
        <Button onClick={onFill} disabled={busy || ready.length === 0 || filled}>
          {filled ? 'Filled' : `Fill ${ready.length} safe field${ready.length === 1 ? '' : 's'}`}
        </Button>
        <Button variant="secondary" onClick={onRescan} disabled={busy}>
          Rescan
        </Button>
      </div>

      {/* The form is never submitted for the user. Saying so plainly is part of
          the product: it is why they can let it fill without watching. */}
      <p className="text-xs text-zinc-500">
        This extension never submits an application. Review everything before you do.
      </p>

      {review.length > 0 && (
        <ActionGroup title="Needs your review" actions={review} state="needs_review" />
      )}
      {ready.length > 0 && (
        <ActionGroup title={filled ? 'Filled' : 'Ready'} actions={ready} state="verified" />
      )}
      {skipped.length > 0 && (
        <ActionGroup title="Left alone" actions={skipped} state="missing" collapsed />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </>
  );
}

function ActionGroup({
  title,
  actions,
  state,
  collapsed = false,
}: {
  title: string;
  actions: ResolvedFieldAction[];
  state: 'verified' | 'needs_review' | 'missing';
  collapsed?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(!collapsed);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mb-1 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-zinc-500"
        aria-expanded={open}
      >
        <span>
          {title} ({actions.length})
        </span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <ul className="space-y-1">
          {actions.map((action) => (
            <li key={action.localId} className="flex items-start gap-2 text-xs">
              <StateBadge state={state} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{action.explanation ?? 'Field'}</span>
                {action.value !== undefined && (
                  <span className="block truncate font-mono text-zinc-500">
                    {String(action.value)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

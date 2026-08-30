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
import { labelForPath, SCALAR_PROFILE_PATHS } from '@profile/paths';
import type { MappingScope } from '@learning/types';

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
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  /**
   * Ensure the scanner is present in the active tab, then message it.
   *
   * THE INJECTION IS THE PERMISSION MODEL.
   *
   * The scanner is not a declared content script - see the header of
   * `entrypoints/scanner.ts`. It is injected here, on an explicit user action,
   * which is what lets the extension run under `activeTab` instead of asking
   * for host access to every website at install time. The user's click IS the
   * grant.
   *
   * `executeScript` is safe to call repeatedly: the scanner guards its own
   * re-injection, so a second Scan click re-runs the file and returns
   * immediately rather than installing a duplicate message listener.
   */
  const sendToActiveTab = useCallback(async <T,>(message: unknown): Promise<T | undefined> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return undefined;
    const tabId = tab.id;

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['scanner.js'] });
    } catch (error) {
      // Injection is refused on pages no extension may touch: chrome://, the
      // Web Store, the PDF viewer, and other extensions' pages. Normal, not a
      // bug, and the caller turns it into a readable message.
      log.debugLazy(() => ['Could not inject the scanner into this tab', error]);
      return undefined;
    }

    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    } catch (error) {
      // The tab navigated between injection and the message, or the page tore
      // down the listener. Recoverable - the user can scan again.
      log.debugLazy(() => ['The page did not answer', error]);
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
        message:
          'This page cannot be scanned. Chrome blocks extensions on its own pages, the Web Store, and PDFs.',
      });
      return;
    }
    if (!response.ok || response.actions === undefined) {
      setState({ kind: 'error', message: 'This page could not be scanned.' });
      return;
    }

    setState({ kind: 'scanned', actions: response.actions });
  }

  /**
   * Teach the system what a field means.
   *
   * The panel sends only a `localId` and the user's choice. The scanner owns
   * the descriptor and forwards it to the worker, which does the fingerprinting
   * - so there is exactly one implementation of what makes two questions "the
   * same question".
   */
  async function handleCorrect(
    localId: string,
    profilePath: string | null,
    scope: MappingScope,
  ): Promise<void> {
    const response = await sendToActiveTab<{ ok: boolean }>({
      type: 'CONTENT_CORRECT',
      localId,
      profilePath,
      scope,
    });

    if (response?.ok !== true) {
      setStatus({ kind: 'error', message: 'That correction could not be saved.' });
      return;
    }

    setStatus({
      kind: 'ok',
      message:
        profilePath === null
          ? 'Noted - this field will be left alone from now on.'
          : `Learned: this question means ${labelForPath(profilePath).toLowerCase()}.`,
    });

    // Rescan so the panel reflects the new mapping immediately. Seeing the
    // field move from "needs review" to "ready" is the feedback that tells the
    // user the correction actually took.
    await handleScan();
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

      <StatusLine status={status} />

      {(state.kind === 'scanned' || state.kind === 'filled') && (
        <ScanReport
          actions={state.actions}
          filled={state.kind === 'filled'}
          busy={busy}
          onFill={() => void handleFill(state.actions)}
          onRescan={handleScan}
          onCorrect={(localId, path, scope) => void handleCorrect(localId, path, scope)}
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
  onCorrect,
}: {
  actions: ResolvedFieldAction[];
  filled: boolean;
  busy: boolean;
  onFill: () => void;
  onRescan: () => void;
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
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
        <ActionGroup
          title="Needs your review"
          actions={review}
          state="needs_review"
          onCorrect={onCorrect}
        />
      )}
      {ready.length > 0 && (
        <ActionGroup
          title={filled ? 'Filled' : 'Ready'}
          actions={ready}
          state="verified"
          onCorrect={onCorrect}
        />
      )}
      {skipped.length > 0 && (
        <ActionGroup
          title="Left alone"
          actions={skipped}
          state="missing"
          collapsed
          onCorrect={onCorrect}
        />
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
  onCorrect,
}: {
  title: string;
  actions: ResolvedFieldAction[];
  state: 'verified' | 'needs_review' | 'missing';
  collapsed?: boolean;
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
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
            <ActionRow key={action.localId} action={action} state={state} onCorrect={onCorrect} />
          ))}
        </ul>
      )}
    </section>
  );
}


/**
 * One field in the audit list, with an inline correction control.
 *
 * The correction affordance is present on EVERY row, not only the uncertain
 * ones. A field the system was confident about can still be wrong, and the user
 * finding out they cannot tell it so is exactly how they stop trusting it.
 */
function ActionRow({
  action,
  state,
  onCorrect,
}: {
  action: ResolvedFieldAction;
  state: 'verified' | 'needs_review' | 'missing';
  onCorrect: (localId: string, profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);

  return (
    <li className="text-xs">
      <div className="flex items-start gap-2">
        <StateBadge state={state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{action.explanation ?? 'Field'}</span>
          {action.value !== undefined && (
            <span className="block truncate font-mono text-zinc-500">{String(action.value)}</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setEditing((current) => !current)}
          className="shrink-0 text-blue-600 hover:underline"
          aria-expanded={editing}
        >
          {editing ? 'Cancel' : 'Change'}
        </button>
      </div>

      {editing && (
        <CorrectionPicker
          currentPath={action.profilePath}
          onSubmit={(path, scope) => {
            setEditing(false);
            onCorrect(action.localId, path, scope);
          }}
        />
      )}
    </li>
  );
}

/**
 * Pick what a field means, and how widely to remember it.
 *
 * THE SCOPE CHOICE IS THE USER'S, NOT OURS.
 *
 * We could infer a scope - "this looks company-specific, store it per company"
 * - but the user knows something we do not: whether "Preferred hub" is this
 * employer's private jargon or a phrase they expect to meet again. Guessing
 * wrong is quietly costly in both directions: too narrow and the correction
 * never helps again, too broad and one company's odd wording starts overriding
 * sensible defaults everywhere.
 *
 * The default is `global`, because the common case is a phrasing our alias
 * table simply has not seen yet, and that generalises.
 */
function CorrectionPicker({
  currentPath,
  onSubmit,
}: {
  currentPath: string | null;
  onSubmit: (profilePath: string | null, scope: MappingScope) => void;
}): ReactNode {
  const [path, setPath] = useState<string>(currentPath ?? '');
  const [scope, setScope] = useState<MappingScope>('global');

  const SCOPE_LABELS: Array<{ value: MappingScope; label: string; hint: string }> = [
    { value: 'global', label: 'Everywhere', hint: 'Any site that asks this' },
    { value: 'ats', label: 'This platform', hint: 'Greenhouse, Lever, etc.' },
    { value: 'company', label: 'This company', hint: 'Only on this site' },
    { value: 'exact_field', label: 'Just this field', hint: 'This exact question' },
  ];

  return (
    <div className="mt-2 space-y-2 rounded border border-zinc-200 p-2 dark:border-zinc-700">
      <label className="block">
        <span className="mb-1 block text-zinc-500">This question is asking for</span>
        <select
          value={path}
          onChange={(event) => setPath(event.target.value)}
          className="w-full rounded border border-zinc-300 bg-white px-1 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
        >
          {/* "Nothing" is a real, useful answer: it teaches the extension to
              stop offering this field, which is itself a correction worth
              remembering. */}
          <option value="">Nothing - leave this field alone</option>
          {SCALAR_PROFILE_PATHS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {labelForPath(candidate)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-zinc-500">Remember this</span>
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as MappingScope)}
          className="w-full rounded border border-zinc-300 bg-white px-1 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
        >
          {SCOPE_LABELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} - {option.hint}
            </option>
          ))}
        </select>
      </label>

      <Button onClick={() => onSubmit(path.length === 0 ? null : path, scope)}>Save</Button>
    </div>
  );
}

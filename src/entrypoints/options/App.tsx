/**
 * Options page - the full-screen surface for profile and development tools.
 *
 * Two tabs, serving two different audiences:
 *   Profile     the applicant's own data. The primary user-facing screen.
 *   Playground  the mapping debugger. Kept out of the side panel entirely, per
 *               spec section 22's instruction not to bury the user in mapping
 *               metadata during an actual application.
 */
import { useState, type ReactNode } from 'react';
import { Button, StatusLine } from '@/components/ui';
import { useProfile } from '@/hooks/use-profile';
import { ProfileEditor } from './ProfileEditor';
import { MappingPlayground } from './MappingPlayground';
import { LearnedRules } from './LearnedRules';
import { ResumeImport } from './ResumeImport';

type Tab = 'profile' | 'resume' | 'learned' | 'playground';

const TAB_LABELS: Record<Tab, string> = {
  profile: 'Profile',
  resume: 'Resume',
  learned: 'Learned rules',
  playground: 'Mapping playground',
};

export function App(): ReactNode {
  const { profile, loading, error, edit, save, exportJson, importJson, dirty } = useProfile();
  const [tab, setTab] = useState<Tab>('profile');
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });

  async function handleSave(): Promise<void> {
    const ok = await save();
    setStatus(
      ok
        ? { kind: 'ok', message: 'Profile saved' }
        : { kind: 'error', message: error ?? 'Could not save' },
    );
  }

  /**
   * Export to a downloaded file.
   *
   * A file rather than a copyable text box: the export contains a home address
   * and a phone number, and pasting it through a clipboard makes it available
   * to anything else the user pastes into next.
   */
  async function handleExport(): Promise<void> {
    const json = await exportJson();
    if (json === undefined) {
      setStatus({ kind: 'error', message: error ?? 'Could not export' });
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `applicant-profile-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    /**
     * Revoking matters: the blob holds the profile in memory until released.
     *
     * Deferred by one task rather than revoked inline. `anchor.click()` starts
     * the download asynchronously, and revoking in the same turn is a race
     * Chrome sometimes loses - the user gets a "download failed" for a file
     * that was built correctly. One `setTimeout(0)` is enough to be after the
     * download has taken its reference, and the profile is still released in
     * the same millisecond rather than living until the page closes.
     */
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus({ kind: 'ok', message: 'Profile exported' });
  }

  /**
   * Largest profile export accepted on import.
   *
   * A profile is a few KB. The cap exists because `file.text()` reads the
   * WHOLE file into memory before anything validates it, so a mis-selected
   * disk image would be materialised as a JavaScript string - on a 4 GB
   * machine, that is the tab dying before a single check has run. Refusing by
   * SIZE is the only check that can happen before the read.
   */
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  async function handleImport(file: File): Promise<void> {
    if (file.size > MAX_IMPORT_BYTES) {
      setStatus({
        kind: 'error',
        message: 'That file is far too large to be a profile export.',
      });
      return;
    }

    const text = await file.text();
    const ok = await importJson(text);
    setStatus(
      ok
        ? { kind: 'ok', message: 'Profile imported' }
        : { kind: 'error', message: error ?? 'That file did not match the profile format' },
    );
  }

  if (loading) {
    return <div className="p-8 text-sm text-zinc-500">Loading your profile...</div>;
  }

  return (
    <div className="min-h-screen bg-white p-8 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Personal Job Application Agent</h1>
          <p className="text-sm text-zinc-500">
            Your verified profile. Everything here stays on this computer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={handleExport}>
            Export JSON
          </Button>
          <label className="cursor-pointer rounded bg-zinc-200 px-3 py-1.5 text-sm font-medium hover:bg-zinc-300 dark:bg-zinc-700">
            Import JSON
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void handleImport(file);
              }}
            />
          </label>
          <Button onClick={handleSave} disabled={!dirty}>
            {dirty ? 'Save changes' : 'Saved'}
          </Button>
        </div>
      </header>

      <StatusLine status={status} />
      {error !== undefined && <StatusLine status={{ kind: 'error', message: error }} />}

      <nav className="mb-6 flex gap-1 border-b border-zinc-200 dark:border-zinc-700">
        {(['profile', 'resume', 'learned', 'playground'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setTab(candidate)}
            className={`px-3 py-2 text-sm ${
              tab === candidate
                ? 'border-b-2 border-blue-600 font-medium'
                : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {TAB_LABELS[candidate]}
          </button>
        ))}
      </nav>

      {tab === 'profile' && profile !== undefined && <ProfileEditor profile={profile} edit={edit} />}
      {tab === 'resume' && <ResumeImport />}
      {tab === 'learned' && <LearnedRules />}
      {tab === 'playground' && <MappingPlayground profile={profile} />}
    </div>
  );
}

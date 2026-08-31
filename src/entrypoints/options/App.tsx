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
import { BrandMark, Button, StatusLine } from '@/components/ui';
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

const TAB_META: Record<Tab, { kicker: string; title: string; description: string }> = {
  profile: {
    kicker: 'Profile vault',
    title: 'Your application identity',
    description:
      'The verified facts the agent can use with confidence. Add them once, then keep your attention for the questions that actually need it.',
  },
  resume: {
    kicker: 'Document library',
    title: 'Resumes, ready when needed',
    description:
      'Store the version you want attached and review anything the agent extracts before it reaches your profile.',
  },
  learned: {
    kicker: 'Personal memory',
    title: 'What the agent learned from you',
    description:
      'Every correction becomes a transparent rule. You stay in control of what it remembers and where that rule applies.',
  },
  playground: {
    kicker: 'Mapping lab',
    title: 'See how a field is understood',
    description:
      'A technical workspace for testing labels, form controls and confidence without touching a real application.',
  },
};

export function App(): ReactNode {
  const { profile, loading, error, edit, save, reload, exportJson, importJson, dirty } =
    useProfile();
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
    return (
      <div className="options-shell grid min-h-screen place-items-center">
        <div className="text-center">
          <div className="scan-orbit" aria-hidden="true" />
          <p className="text-sm text-[--app-muted]">Opening your private workspace…</p>
        </div>
      </div>
    );
  }

  const active = TAB_META[tab];

  return (
    <div className="options-shell">
      <div className="options-layout">
        <aside className="options-sidebar">
          <div className="mb-8 flex items-center gap-3 px-1">
            <BrandMark />
            <div>
              <div className="text-[15px] font-bold tracking-[-0.025em] text-[--app-text]">
                Application Agent
              </div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[--app-muted]">
                Your private operator
              </div>
            </div>
          </div>

          <nav className="space-y-1" aria-label="Workspace">
            {(['profile', 'resume', 'learned', 'playground'] as const).map((candidate) => {
              const selected = tab === candidate;
              return (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setTab(candidate)}
                  className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    selected
                      ? 'bg-[var(--app-accent-soft)] font-semibold text-[--app-accent] shadow-[inset_0_0_0_1px_var(--app-border)]'
                      : 'text-[--app-muted] hover:bg-[var(--app-panel-soft)] hover:text-[--app-text]'
                  }`}
                  aria-current={selected ? 'page' : undefined}
                >
                  <NavIcon tab={candidate} active={selected} />
                  <span>{TAB_LABELS[candidate]}</span>
                  {selected && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--app-accent)]" />}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[--app-text]">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-500/10 text-[--app-success]">
                <ShieldIcon />
              </span>
              Private by design
            </div>
            <p className="text-[11px] leading-relaxed text-[--app-muted]">
              Your profile and resumes stay in this browser. Nothing is sent to a cloud service.
            </p>
          </div>
        </aside>

        <main className="options-main">
          <div className="options-workspace">
            <header className="workspace-topbar">
              <div>
                <div className="workspace-kicker">{active.kicker}</div>
                <h1 className="workspace-title">{active.title}</h1>
                <p className="workspace-subtitle">{active.description}</p>
              </div>

              {tab === 'profile' && <div className="workspace-actions">
                <Button variant="ghost" onClick={handleExport}>
                  <DownloadIcon /> Export
                </Button>
                <label className="inline-flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3.5 py-2 text-sm font-semibold text-[--app-text] transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-panel)]">
                  <UploadIcon /> Import
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
                  {dirty ? (
                    <>
                      <SaveIcon /> Save changes
                    </>
                  ) : (
                    <>
                      <CheckIcon /> Saved
                    </>
                  )}
                </Button>
              </div>}
            </header>

            <StatusLine status={status} />
            {error !== undefined && <StatusLine status={{ kind: 'error', message: error }} />}

            <div className="mt-6">
              {tab === 'profile' && profile !== undefined && (
                <ProfileEditor profile={profile} edit={edit} />
              )}
              {/*
        ONE PROFILE STATE, NOT TWO.

        `useProfile` holds the copy the editor is working on; the resume import
        writes to storage. Handing it `dirty` lets it refuse to import over
        unsaved edits, and `reload` makes the editor pick up what the import
        wrote - without which the editor's next Save would overwrite it.
      */}
      {tab === 'resume' && <ResumeImport editsPending={dirty} onImported={reload} />}
              {tab === 'learned' && <LearnedRules />}
              {tab === 'playground' && <MappingPlayground profile={profile} />}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function NavIcon({ tab, active }: { tab: Tab; active: boolean }): ReactNode {
  const paths: Record<Tab, ReactNode> = {
    profile: <><circle cx="12" cy="8" r="3" /><path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" /></>,
    resume: <><path d="M7 3.5h7l3 3V20H7z" /><path d="M14 3.5V7h3M9.5 11h5M9.5 14h5M9.5 17h3" /></>,
    learned: <><path d="M12 3.5a6 6 0 0 0-3.8 10.6c.8.7 1.3 1.5 1.3 2.4h5c0-.9.5-1.7 1.3-2.4A6 6 0 0 0 12 3.5Z" /><path d="M9.7 20h4.6M10 17h4" /></>,
    playground: <><path d="m8 3 1.2 3.2L12.5 7.5 9.2 8.8 8 12 6.8 8.8 3.5 7.5l3.3-1.3z" /><path d="m16.5 11 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" /></>,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 1.9 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[tab]}
    </svg>
  );
}

const ShieldIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 3 5.5 5.7v5.1c0 4.2 2.6 7.8 6.5 9.7 3.9-1.9 6.5-5.5 6.5-9.7V5.7z" />
    <path d="m9.2 12 1.8 1.8 3.9-4" />
  </svg>
);

const DownloadIcon = (): ReactNode => <ActionIcon path="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />;
const UploadIcon = (): ReactNode => <ActionIcon path="M12 15V5m0 0 4 4m-4-4L8 9M5 19h14" />;
const SaveIcon = (): ReactNode => <ActionIcon path="M5 4h12l2 2v14H5zM8 4v5h8V4M8 20v-7h8v7" />;
const CheckIcon = (): ReactNode => <ActionIcon path="m6 12 4 4 8-9" />;

function ActionIcon({ path }: { path: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

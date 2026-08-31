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
import { History } from './History';

type Tab = 'profile' | 'resume' | 'history' | 'learned' | 'playground';

const TAB_LABELS: Record<Tab, string> = {
  profile: 'Profile',
  resume: 'Resume',
  history: 'History',
  learned: 'Learned rules',
  playground: 'Mapping playground',
};

/**
 * The title and one line of orientation for each screen.
 *
 * There is no `kicker` any more. Every screen carried a small uppercase label
 * above its heading - "Profile vault", "Document library", "Personal memory",
 * "Mapping lab" - and none of them said anything the heading did not. An
 * eyebrow that restates its own heading is decoration wearing the costume of
 * structure, and it pushed the actual title a third of the way down the page.
 */
const TAB_META: Record<Tab, { title: string; description: string }> = {
  profile: {
    title: 'Your profile',
    description:
      'The facts the extension is allowed to use. Anything you type here is treated as verified by you, and nothing the extension reads elsewhere can overwrite it.',
  },
  resume: {
    title: 'Your resume',
    description:
      'The file that gets attached to applications, and the fastest way to fill in this profile. You review every value it reads before any of it is kept.',
  },
  history: {
    title: 'Application history',
    description:
      'Every application you have filled, with what was filled, what failed and what the extension did not understand. The questions are recorded; your answers are not.',
  },
  learned: {
    title: 'Learned rules',
    description:
      'Each correction you make becomes a rule, listed here with where it applies and how often it has been right. Delete any of them.',
  },
  playground: {
    title: 'Mapping playground',
    description:
      'Type in a label and a control type to see what the extension would make of it, and why. Nothing here touches a real application.',
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
          <div className="scan-lines" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <p className="text-sm text-[var(--ink-2)]">Loading your profile…</p>
        </div>
      </div>
    );
  }

  const active = TAB_META[tab];

  return (
    <div className="options-shell">
      <div className="options-layout">
        <aside className="options-sidebar">
          <div className="mb-7 flex items-center gap-2.5 px-1">
            <BrandMark />
            <div className="text-[13.5px] font-semibold tracking-[-0.02em]">Application Agent</div>
          </div>

          <nav className="space-y-1" aria-label="Workspace">
            {(['profile', 'resume', 'history', 'learned', 'playground'] as const).map((candidate) => {
              const selected = tab === candidate;
              return (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setTab(candidate)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                    selected
                      ? 'bg-[var(--paper-2)] font-semibold text-[var(--ink)]'
                      : 'text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]'
                  }`}
                  aria-current={selected ? 'page' : undefined}
                >
                  <NavIcon tab={candidate} active={selected} />
                  <span>{TAB_LABELS[candidate]}</span>
                </button>
              );
            })}
          </nav>

          {/* Stated once, quietly, at the bottom of the sidebar. It is the
              single most load-bearing fact about the product and it does not
              need a coloured card to earn attention - it needs to still be
              true, and to be findable when someone wonders. */}
          <p className="mt-auto border-t border-[var(--rule)] pt-4 text-[11px] leading-relaxed text-[var(--ink-2)]">
            Your profile and your resume are stored in this browser only. The extension makes no
            network requests and has no server to send them to.
          </p>
        </aside>

        <main className="options-main">
          <div className="options-workspace">
            <header className="workspace-topbar">
              <div>
                <h1 className="workspace-title">{active.title}</h1>
                <p className="workspace-subtitle">{active.description}</p>
              </div>

              {tab === 'profile' && <div className="workspace-actions">
                <Button variant="ghost" onClick={handleExport}>
                  <DownloadIcon /> Export
                </Button>
                <label className="inline-flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--rule)] bg-[var(--paper)] px-3.5 py-2 text-[13px] font-semibold text-[var(--ink)] transition hover:border-[var(--rule-2)] hover:bg-[var(--paper)]">
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
              {tab === 'history' && <History />}
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
    history: <><path d="M4 12a8 8 0 1 0 2.5-5.8M4 5.5V10h4.5" /><path d="M12 8v4.5l3 1.8" /></>,
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

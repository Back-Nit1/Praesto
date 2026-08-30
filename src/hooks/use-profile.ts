/**
 * useProfile - React access to the canonical applicant profile.
 * ---------------------------------------------------------------------------
 * The single point where React touches persisted data. Components call this
 * hook; nothing in the component tree talks to `chrome.storage` directly.
 *
 * WHY AN EXTENSION PAGE MAY USE THE REPOSITORY DIRECTLY
 * The options page and the side panel are EXTENSION pages: they run on the
 * `chrome-extension://` origin, are not injected into any website, and are as
 * trusted as the service worker. The data-minimisation rule in spec 21.1 is
 * specifically about the CONTENT SCRIPT, which runs inside a webpage - so
 * routing profile edits through the worker would add a message hop and a
 * serialisation round trip for no security gain.
 *
 * OPTIMISTIC LOCAL STATE, AUTHORITATIVE STORAGE
 * Edits update local state immediately (the user is typing) and are persisted
 * on an explicit save. A keystroke-by-keystroke write would produce hundreds of
 * storage writes per field, which on a slow disk is felt as input lag.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChromeLocalStore } from '@storage/key-value-store';
import { StoredProfileRepository } from '@profile/repository';
import type { ApplicantProfile } from '@profile/schema';
import { createLogger } from '@shared/logging';

const log = createLogger('hooks:profile');

/** Constructed once at module scope; both hold only a reference, no data. */
const repository = new StoredProfileRepository(new ChromeLocalStore());

export interface UseProfileResult {
  profile: ApplicantProfile | undefined;
  loading: boolean;
  error: string | undefined;
  /** Update local state without persisting. For every keystroke. */
  edit: (mutate: (profile: ApplicantProfile) => ApplicantProfile) => void;
  /** Persist current local state. Returns false and sets `error` on failure. */
  save: () => Promise<boolean>;
  /** Discard local edits and reload from storage. */
  reload: () => Promise<void>;
  exportJson: () => Promise<string | undefined>;
  importJson: (json: string) => Promise<boolean>;
  /** True when local state differs from what was last loaded or saved. */
  dirty: boolean;
}

export function useProfile(): UseProfileResult {
  const [profile, setProfile] = useState<ApplicantProfile | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await repository.loadOrCreate();
    if (result.ok) {
      setProfile(result.value);
      setError(undefined);
      setDirty(false);
    } else {
      // The message is written to be read by the user, not by a developer -
      // this is the surface where a corrupted profile becomes visible.
      setError(result.error.message);
      log.error('Could not load profile', result.error.code);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = useCallback((mutate: (profile: ApplicantProfile) => ApplicantProfile) => {
    setProfile((current) => (current === undefined ? current : mutate(current)));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (profile === undefined) return false;
    const result = await repository.save(profile);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    setError(undefined);
    setDirty(false);
    return true;
  }, [profile]);

  const exportJson = useCallback(async () => {
    const result = await repository.exportJson();
    if (!result.ok) {
      setError(result.error.message);
      return undefined;
    }
    return result.value;
  }, []);

  const importJson = useCallback(
    async (json: string) => {
      const result = await repository.importJson(json);
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      // Reload rather than trusting the returned object, so what is on screen
      // is provably what is in storage.
      await load();
      return true;
    },
    [load],
  );

  return { profile, loading, error, edit, save, reload: load, exportJson, importJson, dirty };
}

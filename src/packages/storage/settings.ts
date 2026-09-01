/**
 * User settings.
 * ---------------------------------------------------------------------------
 * `STORAGE_KEYS.settings` has been declared since the first commit and nothing
 * ever wrote to it. This is the first thing that needs it: spec section 22 asks
 * for detailed mapping and debug information to live behind a developer toggle
 * rather than in front of an applicant mid-application.
 *
 * DEFAULTS ARE THE ABSENT CASE, NOT A WRITTEN ROW
 * A fresh install has no settings object, and `get` returns the defaults rather
 * than writing them. That keeps "never configured" and "configured to the
 * default" the same state, so a later change to a default reaches every user
 * who never expressed an opinion instead of only new ones.
 *
 * UNKNOWN AND MALFORMED VALUES FALL BACK
 * Read defensively field by field: a settings object written by a later version
 * of the extension, then read by an older one after a downgrade, must not be
 * able to turn a boolean into a crash on the options page.
 */
import { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import { ChromeLocalStore, type KeyValueStore } from './key-value-store';
import { STORAGE_KEYS } from './keys';

export interface Settings {
  /**
   * Show development surfaces: the metrics screen, and mapping detail.
   *
   * OFF by default, and the metrics screen is unreachable without it. Spec
   * section 26 is explicit that these numbers are for development, and section
   * 26 is equally explicit that raw fill rate is the wrong thing to optimise -
   * a number on an applicant's screen is a number someone starts optimising.
   */
  developerMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = { developerMode: false };

export class SettingsRepository {
  constructor(private readonly store: KeyValueStore = new ChromeLocalStore()) {}

  async get(): Promise<Result<Settings, AppError>> {
    const stored = await this.store.get<unknown>(STORAGE_KEYS.settings);
    if (!stored.ok) return stored;
    return ok(normalise(stored.value));
  }

  /**
   * Write one setting, preserving the rest.
   *
   * Merged onto the RAW stored object rather than onto the normalised one. A
   * downgrade - storage written by a newer version, then read and written by an
   * older one - would otherwise silently drop every setting this version cannot
   * name, and the user would find their preferences reset by an update.
   */
  async setDeveloperMode(enabled: boolean): Promise<Result<void, AppError>> {
    const stored = await this.store.get<unknown>(STORAGE_KEYS.settings);
    if (!stored.ok) return stored;

    const existing =
      typeof stored.value === 'object' && stored.value !== null
        ? (stored.value as Record<string, unknown>)
        : {};

    return this.store.set(STORAGE_KEYS.settings, { ...existing, developerMode: enabled });
  }
}

function normalise(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const candidate = raw as Partial<Record<keyof Settings, unknown>>;
  return {
    developerMode:
      typeof candidate.developerMode === 'boolean'
        ? candidate.developerMode
        : DEFAULT_SETTINGS.developerMode,
  };
}

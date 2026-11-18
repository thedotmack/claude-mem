import type { SetupStatus } from './setup-funnel.js';

/** How a caller hands installation decisions to the human; resume is internal. */
export const SETUP_MODES = ['browser', 'defer', 'resume'] as const;
export type SetupMode = (typeof SETUP_MODES)[number];

/** Browser-safe contract for configuring the local installation. */
export interface SetupInstallSelection {
  agents: string[];
  skills: string[];
  installClaudeCode: boolean;
  disableAutoMemory: boolean;
  telemetryEnabled: boolean;
  email?: string;
  note?: string;
  /**
   * Older browser installs could save an email and note. The worker redacts both from localhost reads.
   * The page can send this flag back to keep the previously entered signup on a retry.
   */
  emailProvided?: boolean;
  claudeModel?: string;
  /** At most SETUP_DSH_PROFILE_MAX_CHARACTERS after trimming. */
  dshProfile?: string;
}

/**
 * The longest DeepSeek Harness profile name the install takes: one definition for the worker's install check
 * (WorkViewRoutes.ts `setupInstallSelectionBody`) and the setup page's field. A request-size and abuse cap on a loopback
 * write, like the other install fields' caps there: a profile name is one short word (the default is `web`; the
 * installer allows letters, digits, `.`, `_` and `-`, DeepSeekHarnessInstaller.ts `PROFILE_NAME`), so 200 characters
 * refuses no real name.
 */
export const SETUP_DSH_PROFILE_MAX_CHARACTERS = 200;

/**
 * Maximum length of a note submitted by an older browser installer.
 * A pending install can still carry its original email and note after a worker update.
 * The worker keeps them private during a retry and clears them from setup state
 * once the installer reports success.
 */
export const SETUP_INSTALL_NOTE_MAX_CHARACTERS = 2000;

export interface SetupInstallCatalog {
  agents: Array<{ id: string; label: string; hint: string; detected: boolean }>;
  skills: Array<{ id: string; label: string; description: string; required?: boolean }>;
  defaults: SetupInstallSelection;
  reinstall: boolean;
  telemetryLocked?: boolean;
  skillsLocked?: boolean;
  emailEnabled?: boolean;
  /** Older catalogs indicated that a signup was saved. Fresh catalogs disable email and omit this flag. */
  signupSaved?: boolean;
}

/**
 * WorkViewRoutes accepts the installer's reports and the browser's choices;
 * the setup resumer also records failures when the detached installer exits:
 * waiting → installing → ready | failed; failed → installing on an explicit retry.
 * A new installer starts at waiting and clears the previous selection.
 */
export const SETUP_INSTALL_STATUSES = ['waiting', 'installing', 'ready', 'failed'] as const;
export type SetupInstallStatus = (typeof SETUP_INSTALL_STATUSES)[number];

export interface SetupInstallState {
  status: SetupInstallStatus;
  catalog: SetupInstallCatalog;
  selection: SetupInstallSelection | null;
  error: string | null;
}

/** Explicitly deferred onboarding, unlike the absent state on older installations. */
export function hasPendingInstallSetup(state: { status: SetupStatus; install?: SetupInstallState | null }): boolean {
  return state.status === 'pending' && !!state.install;
}

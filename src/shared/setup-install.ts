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
   * Served views never carry the email or note (the worker's localhost reads are not private).
   * True there when one is stored; the page sends it back to keep that stored email on a retry.
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
 * The longest note ("Anything you'd like us to know?", sent with the product-updates signup) the install takes: one
 * definition for the worker's install check (WorkViewRoutes.ts `setupInstallSelectionBody`) and the setup page's box,
 * which cuts a longer paste to it and says so. A request-size and abuse cap on a loopback write, the same 2,000
 * characters the install route allows its other free text (the installer's error reports).
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
  /** An email signup is already saved in settings; its address is never put in the catalog. */
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

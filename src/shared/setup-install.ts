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
  claudeModel?: string;
  dshProfile?: string;
}

export interface SetupInstallCatalog {
  agents: Array<{ id: string; label: string; hint: string; detected: boolean }>;
  skills: Array<{ id: string; label: string; description: string; required?: boolean }>;
  defaults: SetupInstallSelection;
  reinstall: boolean;
  telemetryLocked?: boolean;
  skillsLocked?: boolean;
  emailEnabled?: boolean;
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

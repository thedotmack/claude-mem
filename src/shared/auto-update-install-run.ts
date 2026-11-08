/**
 * Marks an installer run that the auto-updater started: the supervisor sets it
 * in the environment of the `npx --yes claude-mem@<version> update` it runs
 * (auto-update-launch.ts runAutoUpdateInstaller). Such a run is not a person
 * installing claude-mem, so the installer skips what is meant for one: the
 * optional cmem.ai sign-in offer (install.ts offerDeferredLogin) and the
 * install funnel's install_completed and install_failed events
 * (captureInstallCompleted, captureInstallFailed). The supervisor's own
 * auto_update_applied / auto_update_failed events report the run instead. An environment variable, never a command-line flag: `update`
 * is run with no flags, because an added one could change what it does.
 *
 * Its own leaf module, because both the worker bundle (which sets it) and the
 * npx-cli bundle (which reads it) import it.
 */
export const INSTALL_RUN_BY_AUTO_UPDATE_ENV = 'CLAUDE_MEM_INSTALL_RUN_BY_AUTO_UPDATE';

/** The value the supervisor sets; any other value, or none, is a person's own install. */
export const INSTALL_RUN_BY_AUTO_UPDATE_VALUE = '1';

export function isInstallRunByAutoUpdate(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INSTALL_RUN_BY_AUTO_UPDATE_ENV] === INSTALL_RUN_BY_AUTO_UPDATE_VALUE;
}

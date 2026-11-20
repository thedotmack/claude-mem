/**
 * Marks an installer run that the auto-updater started: the supervisor sets it
 * in the environment of the installer it runs (auto-update-launch.ts
 * claudeMemUpdateInvocation, runAutoUpdateInstaller). Such a run is not a person
 * installing claude-mem, so the installer skips what is meant for one: the
 * optional cmem.ai sign-in offer (install.ts offerDeferredLogin) and the
 * install funnel's install_completed and install_failed events
 * (captureInstallCompleted, captureInstallFailed). The supervisor's own
 * auto_update_applied / auto_update_failed events report the run instead. And
 * the worker it starts does not keep the npm package and yes settings npx set
 * for it from the auto-updater's own flags
 * (withoutNpmSettingsFromAutoUpdateNpxFlags). An environment variable, never a
 * command-line flag: `update` is run with no flags, because an added one could
 * change what it does.
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

/**
 * npm's package and yes settings as environment variables, in any case: npm
 * reads every variable whose name matches /^npm_config_/i (@npmcli/config
 * lib/index.js loadEnv, read in npm 11.14.1), and Windows env names are
 * case-insensitive, so there the two npx sets can sit under whatever spelling
 * the environment already had, as npm-install-helper.ts
 * INHERITED_ALLOW_SCRIPTS_ENV notes for allow-scripts. The whole name is
 * matched: a longer name is another setting, such as npm_config_package_lock,
 * npm's package-lock, which npx does not set here.
 */
const NPM_SETTING_FROM_AUTO_UPDATE_NPX_FLAG_ENV_NAME = /^npm_config_(?:package|yes)$/i;

/**
 * The environment a worker gets from an installer run (ProcessManager.ts
 * spawnDaemon): `env` itself, except that a run marked as the auto-updater's
 * leaves out the two npm settings npx adds there because of the
 * auto-updater's own flags (auto-update-launch.ts claudeMemUpdateInvocation),
 * in any case: npm_config_package and npm_config_yes.
 *
 * npm exports every setting whose value is not its definition's default,
 * unless only the environment set it (@npmcli/config lib/set-envs.js). A
 * worker would keep these two for as long as it runs and pass them to what it
 * starts, the `claude` of every Agent SDK query included (EnvManager.ts
 * buildIsolatedEnv), and each would change the npx runs started under it:
 *  - npm_config_package is claude-mem@<version>, from --package: the packages
 *    for npx to install (@npmcli/config lib/definitions/definitions.js
 *    `package`; only npx reads it, npm lib/commands/exec.js). Every npx
 *    started under it that names no package of its own, such as an MCP server
 *    configured as `npx <package>`, runs its command with claude-mem@<version>
 *    installed instead of <package>. A --package on that npx's own command
 *    line outranks the variable, as the next update's does.
 *  - npm_config_yes is true, from --yes. Every npx started under it installs
 *    a package it does not have without asking: no "Ok to proceed?" on a
 *    terminal, and no warning without one (libnpmexec lib/index.js). And
 *    `npm init` takes every default without asking (init-package-json, from
 *    npm lib/commands/init.js). A --no on that npx's own command line outranks
 *    the variable.
 * The third flag, --no-workspaces, is not exported at all (definitions.js
 * `workspaces`, envExport false). Every other npm_config_* npx exports carries
 * the machine's own values, as for the user's own `npx claude-mem@<version>
 * update`, so it is kept: npm_config_prefix and npm_config_global_prefix are
 * npm's global prefix, where the Bun lookup of whatever starts a worker under
 * this one looks too (ProcessManager.ts resolveWorkerRuntimePathUncached);
 * npm_config_globalconfig and npm_config_userconfig are the machine's npmrc
 * files; and what those files set, such as a proxy, comes through as they set
 * it. npm_config_local_prefix is the run's folder, which npm sets for every
 * command it runs (set-envs.js) and reads as no setting (lib/index.js
 * internalEnv). Checked with npm 11.14.1 (2026-11-08).
 * Every spelling of the two is left out, so one the user had set in the
 * environment goes too; npx had already replaced one spelled
 * npm_config_package or npm_config_yes.
 *
 * The registry variables the supervisor pins for the run (auto-update-launch.ts
 * autoUpdateInstallerEnv) are left in place: an auto-update only runs where
 * registry.npmjs.org is reachable, because gate 7 reads it directly, so
 * pointing later npm and bun runs there changes nothing a user could notice.
 */
export function withoutNpmSettingsFromAutoUpdateNpxFlags(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isInstallRunByAutoUpdate(env)) return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !NPM_SETTING_FROM_AUTO_UPDATE_NPX_FLAG_ENV_NAME.test(name)));
}

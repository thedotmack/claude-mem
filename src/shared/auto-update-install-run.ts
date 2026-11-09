/**
 * Marks an installer run that the auto-updater started: the supervisor sets it
 * in the environment of the installer it runs (auto-update-launch.ts
 * claudeMemUpdateInvocation, runAutoUpdateInstaller). Such a run is not a person
 * installing claude-mem, so the installer skips what is meant for one: the
 * optional cmem.ai sign-in offer (install.ts offerDeferredLogin) and the
 * install funnel's install_completed and install_failed events
 * (captureInstallCompleted, captureInstallFailed). The supervisor's own
 * auto_update_applied / auto_update_failed events report the run instead. And
 * the worker it starts does not keep the npm prefix, package, globalconfig and
 * yes settings npx set for it
 * (withoutNpmSettingsNpxAddsForAutoUpdateInstallerRun). An environment
 * variable, never a command-line flag: `update` is run with no flags, because
 * an added one could change what it does.
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
 * npm's prefix, package, globalconfig and yes settings as environment
 * variables, in any case: npm reads every variable whose name matches
 * /^npm_config_/i (@npmcli/config lib/index.js loadEnv, read in npm 11.14.1),
 * and Windows env names are case-insensitive, so there the four npx sets can
 * sit under whatever spelling the environment already had, as
 * npm-install-helper.ts INHERITED_ALLOW_SCRIPTS_ENV notes for allow-scripts.
 * The whole name is matched: a longer name is another setting, such as
 * npm_config_package_lock, npm's package-lock, which npx does not set here.
 */
const NPM_SETTING_NPX_ADDS_FOR_AUTO_UPDATE_INSTALLER_RUN_ENV_NAME = /^npm_config_(?:prefix|package|globalconfig|yes)$/i;

/**
 * The environment a worker gets from an installer run (ProcessManager.ts
 * spawnDaemon): `env` itself, except that a run marked as the auto-updater's
 * leaves out four npm settings, in any case: npm_config_prefix,
 * npm_config_package, npm_config_globalconfig and npm_config_yes.
 *
 * npx puts all four in the environment of the installer it runs, from the
 * auto-updater's --prefix, --package and --yes (auto-update-launch.ts
 * claudeMemUpdateInvocation): npm exports every setting whose value is not
 * its definition's default, unless only the environment set it
 * (@npmcli/config lib/set-envs.js), globalconfig included, whose value npm
 * works out from the prefix. A worker would keep them for as long as it runs
 * and pass them to what it starts, the `claude` of every Agent SDK query
 * included (EnvManager.ts buildIsolatedEnv), and each would change the npm or
 * npx runs started under it:
 *  - npm_config_prefix is the installer folder, which the supervisor empties
 *    before every run (prepareAutoUpdateInstallerWorkingDirectory). Every npm
 *    started under it takes the folder as its global prefix (@npmcli/config
 *    lib/index.js load), so `npm install -g` installs there. Every node
 *    process under it that has to start a worker looks for Bun in
 *    <folder>/bin/bun too (ProcessManager.ts resolveWorkerRuntimePathUncached),
 *    such as the claude-mem MCP server (mcp-server.ts ensureWorkerStarted) of
 *    the Claude Code the agent runner starts with the plugin loaded
 *    (agent-runner/run.ts).
 *  - npm_config_package is claude-mem@<version>, the packages for npx to
 *    install (@npmcli/config lib/definitions/definitions.js `package`; only
 *    npx reads it, npm lib/commands/exec.js). Every npx started under it that
 *    names no package of its own, such as an MCP server configured as
 *    `npx <package>`, runs its command with claude-mem@<version> installed
 *    instead of <package>. A --package on that npx's own command line
 *    outranks the variable, as the next update's does.
 *  - npm_config_globalconfig is <folder>/etc/npmrc: npm's global npmrc is
 *    etc/npmrc under the prefix (@npmcli/config lib/index.js loadDefaults).
 *    Every npm started under it reads its global settings from that file
 *    (lib/index.js loadGlobalConfig) in place of the user's own global npmrc,
 *    etc/npmrc under npm's own prefix, so what that file sets, such as a
 *    proxy or a CA file, goes unread. Leaving out npm_config_prefix alone
 *    does not bring the user's file back, because the variable names the file
 *    itself (checked with npm 11.14.1).
 *  - npm_config_yes is true, from --yes. Every npx started under it installs
 *    a package it does not have without asking: no "Ok to proceed?" on a
 *    terminal, and no warning without one (libnpmexec lib/index.js). And
 *    `npm init` takes every default without asking (init-package-json, from
 *    npm lib/commands/init.js). A --no on that npx's own command line outranks
 *    the variable.
 * Every spelling is left out, so one of the four the user had set in the
 * environment goes too. npx had already replaced one spelled
 * npm_config_prefix, npm_config_package or npm_config_yes; a user's own
 * npm_config_globalconfig, which npx passes on as it is, is left out with
 * the rest.
 *
 * The registry variables the supervisor pins for the run (auto-update-launch.ts
 * autoUpdateInstallerEnv) are left in place: an auto-update only runs where
 * registry.npmjs.org is reachable, because gate 7 reads it directly, so
 * pointing later npm and bun runs there changes nothing a user could notice.
 */
export function withoutNpmSettingsNpxAddsForAutoUpdateInstallerRun(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isInstallRunByAutoUpdate(env)) return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !NPM_SETTING_NPX_ADDS_FOR_AUTO_UPDATE_INSTALLER_RUN_ENV_NAME.test(name)));
}

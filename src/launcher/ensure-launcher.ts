/**
 * SessionStart self-heal for marketplace-only installs (plan-17 #3605, SPIKE
 * Decision 1). Bundled to plugin/scripts/ensure-launcher.cjs and run as a
 * shell-free, synchronous hook:
 * {"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/ensure-launcher.cjs"]}.
 *
 * Setup never fires on plugin install or update (SPIKE item 8), and the
 * plugin's bin/ is not on the hook PATH (item 4), so this is the earliest
 * reliable point to (re)place the on-PATH launcher after a marketplace update.
 *
 * Contract:
 * - Prints nothing to stdout when the launcher is current, or was just placed
 *   and this process's PATH resolves `claude-mem` to it. Claude Code adds
 *   plain-text stdout of a SessionStart hook to Claude's context
 *   (https://code.claude.com/docs/en/hooks, "Exit code 0": "SessionStart ...
 *   Claude Code adds plain-text stdout as context that Claude can see").
 * - When the memory hooks cannot work (no plugin root, Bun missing, compile
 *   error, a foreign binary at the launcher path, the launcher not on PATH,
 *   shadowed by another `claude-mem`, or plugin dependencies missing), prints exactly ONE JSON object
 *   `{"systemMessage": "..."}` to stdout. Output that starts with `{` and ends
 *   with `}` is parsed as JSON output, and `systemMessage` is a "Warning
 *   message shown to the user" (same page, "JSON output"). It reaches the user
 *   only because this hook is synchronous: an async hook's systemMessage goes
 *   to the model on the next turn instead (see the #3303 test in
 *   tests/infrastructure/plugin-distribution.test.ts).
 * - Also prints that one object when an automatic update may have left the
 *   install not working (plan Decision 7: the one case a session hears about
 *   an update), read from the auto-updater's state file
 *   (auto-update-state-file.ts autoUpdateBrokenInstall): a restore_failed
 *   outcome no ready worker has resolved since, with the fix and when to run
 *   it as the outcome recorded; or an attempt whose supervisor is gone without
 *   an outcome, only while cheap file checks find the install half-written
 *   (auto-update-install-shape.ts), with the target's own installer as the
 *   fix. When the launcher check fails too, this notice is the one printed:
 *   its fix runs the whole installer, which places the launcher again, and the
 *   launcher failure still goes to stderr.
 * - Never exits non-zero. Diagnostics go to stderr, which for an exit-0 hook
 *   "goes to the debug log only, never the transcript" (same page).
 * - Fast when current: one `claude-mem --version` spawn plus the POSIX rc-file
 *   read and a PATH walk (no spawn), one small JSON read for the auto-update
 *   state (the install-shape checks run only for an attempt whose supervisor
 *   is gone), no Bun lookup and no PowerShell spawn.
 * - Runs under plain `node`, so it imports only the light launcher modules,
 *   the installer's Bun discovery (tool-path.ts), the data-dir rule
 *   (data-dir.ts), Claude Code's install locations
 *   (claude-code-plugin-paths.ts), the install-shape checks and the
 *   auto-update state file's reader, never the worker.
 */
import { existsSync, readFileSync, realpathSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import {
  ensureLauncherOnPath,
  findExecutableOnPath,
  isProcessRunning,
  type LauncherEnsureResult,
  type LauncherInstallLogger,
} from './install-launcher.js';
import { findBunExecutablePath } from '../npx-cli/install/tool-path.js';
import { installedPluginsPath, marketplaceDirectory } from '../shared/claude-code-plugin-paths.js';
import { resolveDataDir } from '../shared/data-dir.js';
import { readClaudeMemInstallShape } from '../services/auto-update/auto-update-install-shape.js';
import {
  AUTO_UPDATE_STATE_FILENAME,
  autoUpdateBrokenInstall,
  autoUpdateFixInstruction,
  describeAutoUpdateBrokenInstall,
  describeAutoUpdateStateFileProblem,
  readAutoUpdateStateFile,
  targetVersionOf,
} from '../services/auto-update/auto-update-state-file.js';

// Captured before the ensure step: PATH setup prepends the bin dir to this
// process's PATH, but the other hooks run with the PATH Claude Code started with.
const claudeCodeHookProcessPath = process.env.PATH ?? '';

const REINSTALL_FIX = 'Fix: run `npx claude-mem install`, then restart Claude Code.';
const RESTART_FIX = 'Fix: restart Claude Code from a new terminal so it picks up the updated PATH.';
const MISSING_DEPENDENCIES_LOG_LIMIT = 5;

interface EnsureLauncherFailure {
  reason: string;
  fix: string;
}

function writeStderrLine(message: string): void {
  process.stderr.write(`claude-mem ensure-launcher: ${message}\n`);
}

/** Synchronous write so the line is flushed before process.exit(0). */
function printUserVisibleSystemMessage(systemMessage: string): void {
  writeSync(1, `${JSON.stringify({ systemMessage })}\n`);
}

function launcherFailureMessage(failure: EnsureLauncherFailure): string {
  return `claude-mem: memory hooks are not active: ${failure.reason}. ${failure.fix}`;
}

/**
 * The auto-update notice, or null when there is none. The state file is read
 * from the data dir the worker uses (data-dir.ts), and a file with a problem
 * reads as the defaults, as everywhere; the problem goes to stderr. The
 * install's shape is read from Claude Code's config directory, as the
 * installer writes it; an installed_plugins.json that cannot be read shows no
 * notice, and why goes to stderr.
 */
function readAutoUpdateNotice(): string | null {
  const statePath = join(resolveDataDir(), AUTO_UPDATE_STATE_FILENAME);
  const read = readAutoUpdateStateFile(statePath);
  if (read.problem !== null) writeStderrLine(describeAutoUpdateStateFileProblem(statePath, read.problem));
  const broken = autoUpdateBrokenInstall(read.state, Date.now(), isProcessRunning, () => {
    const shape = readClaudeMemInstallShape({ installedPluginsPath: installedPluginsPath(), marketplaceDirectory: marketplaceDirectory() });
    if (shape.kind === 'registration-unreadable') writeStderrLine(`could not check the install for an interrupted update: ${shape.problem}`);
    return shape;
  });
  if (broken === null) return null;
  return `claude-mem may not work: ${describeAutoUpdateBrokenInstall(broken)}. ${autoUpdateFixInstruction(broken.fix, targetVersionOf(broken))}`;
}

const stderrLogger: LauncherInstallLogger = {
  info: writeStderrLine,
  success: writeStderrLine,
  warn: writeStderrLine,
};

function isSameFileOnDisk(firstPath: string, secondPath: string): boolean {
  const firstRealPath = realpathSync(firstPath);
  const secondRealPath = realpathSync(secondPath);
  return process.platform === 'win32'
    ? firstRealPath.toLowerCase() === secondRealPath.toLowerCase()
    : firstRealPath === secondRealPath;
}

/** Why `claude-mem` on the hook PATH is not the placed launcher, or null when it is. */
function launcherPathLookupFailure(ensureResult: LauncherEnsureResult): EnsureLauncherFailure | null {
  const placedLauncherBinaryPath = ensureResult.binaryPath;
  const resolvedClaudeMemPath = findExecutableOnPath(
    'claude-mem',
    claudeCodeHookProcessPath,
    process.platform,
    process.env.PATHEXT || undefined,
  );
  if (resolvedClaudeMemPath === null) {
    // This run just put the bin dir on the persistent PATH: nothing to
    // reinstall, Claude Code only has to start with the new PATH.
    const pathWasJustUpdated = ensureResult.pathSetupOutcome === 'rc-file-updated'
      || ensureResult.pathSetupOutcome === 'user-path-updated';
    if (pathWasJustUpdated) {
      return {
        reason: `the launcher was just installed at ${placedLauncherBinaryPath} and ${dirname(placedLauncherBinaryPath)} was added to your PATH, which this Claude Code session started without`,
        fix: RESTART_FIX,
      };
    }
    return {
      reason: `the launcher was installed at ${placedLauncherBinaryPath} but Claude Code's PATH does not include ${dirname(placedLauncherBinaryPath)}`,
      fix: REINSTALL_FIX,
    };
  }
  if (!isSameFileOnDisk(resolvedClaudeMemPath, placedLauncherBinaryPath)) {
    return {
      reason: `another claude-mem at ${resolvedClaudeMemPath} shadows the hook launcher at ${placedLauncherBinaryPath}`,
      fix: REINSTALL_FIX,
    };
  }
  return null;
}

function ensureResultFailure(ensureResult: LauncherEnsureResult): EnsureLauncherFailure | null {
  switch (ensureResult.status) {
    case 'bun-not-found':
      return { reason: 'Bun was not found, so the claude-mem launcher could not be compiled', fix: REINSTALL_FIX };
    case 'foreign-binary-kept':
      return { reason: `${ensureResult.binaryPath} is not the claude-mem hook launcher and was left in place`, fix: REINSTALL_FIX };
    case 'already-current':
    case 'newer-protocol-kept':
    case 'installed':
      return launcherPathLookupFailure(ensureResult);
  }
}

/**
 * Declared dependencies with no `<pluginRoot>/node_modules/<dep>/package.json`.
 * Same tree-scoped stat check as plugin/scripts/version-check.js
 * (findMissingDependencies), which only runs on `claude --init`; a
 * marketplace-only install that never ran it would otherwise start every
 * session with a worker that cannot load and no visible warning.
 */
function findMissingPluginDependencies(pluginRoot: string): string[] {
  let declaredDependencies: string[];
  try {
    const packageManifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf-8'));
    declaredDependencies = Object.keys((packageManifest && packageManifest.dependencies) || {});
  } catch {
    return [];
  }
  return declaredDependencies.filter((dependencyName) =>
    !existsSync(join(pluginRoot, 'node_modules', ...dependencyName.split('/'), 'package.json')));
}

function missingDependenciesFailure(pluginRoot: string): EnsureLauncherFailure | null {
  const missingDependencies = findMissingPluginDependencies(pluginRoot);
  if (missingDependencies.length === 0) return null;
  const listedDependencies = missingDependencies.slice(0, MISSING_DEPENDENCIES_LOG_LIMIT).join(', ');
  const remainingCount = missingDependencies.length - MISSING_DEPENDENCIES_LOG_LIMIT;
  return {
    reason: `plugin dependencies are missing (${listedDependencies}${remainingCount > 0 ? `, +${remainingCount} more` : ''})`,
    fix: REINSTALL_FIX,
  };
}

/** Runs the ensure step; returns the user-facing failure, or null when the hooks will work. */
function runEnsureLauncher(): EnsureLauncherFailure | null {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return { reason: 'CLAUDE_PLUGIN_ROOT is not set', fix: REINSTALL_FIX };
  const ensureResult = ensureLauncherOnPath({
    pluginRoot,
    resolveBunPath: findBunExecutablePath,
    logger: stderrLogger,
    invocationContext: 'session-start-self-heal',
  });
  return ensureResultFailure(ensureResult) ?? missingDependenciesFailure(pluginRoot);
}

let failure: EnsureLauncherFailure | null;
try {
  failure = runEnsureLauncher();
} catch (error: unknown) {
  // Fail-open boundary: a compile error or a missing launcher bundle is
  // reported to the user, and session start is never blocked.
  failure = { reason: error instanceof Error ? error.message : String(error), fix: REINSTALL_FIX };
}
let autoUpdateNotice: string | null;
try {
  autoUpdateNotice = readAutoUpdateNotice();
} catch (error: unknown) {
  // Fail-open boundary: a state file that cannot be read says nothing about
  // whether the install works, so session start goes on without a notice, and
  // why goes to the debug log.
  writeStderrLine(`could not read the auto-update state: ${error instanceof Error ? error.message : String(error)}`);
  autoUpdateNotice = null;
}
if (failure !== null) writeStderrLine(failure.reason);
const systemMessage = autoUpdateNotice ?? (failure === null ? null : launcherFailureMessage(failure));
if (systemMessage !== null) printUserVisibleSystemMessage(systemMessage);
process.exit(0);

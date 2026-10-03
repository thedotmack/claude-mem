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
 *   error, a foreign binary at the launcher path, the launcher not on PATH, or
 *   shadowed by another `claude-mem`), prints exactly ONE JSON object
 *   `{"systemMessage": "..."}` to stdout. Output that starts with `{` and ends
 *   with `}` is parsed as JSON output, and `systemMessage` is a "Warning
 *   message shown to the user" (same page, "JSON output"). It reaches the user
 *   only because this hook is synchronous: an async hook's systemMessage goes
 *   to the model on the next turn instead (see the #3303 test in
 *   tests/infrastructure/plugin-distribution.test.ts).
 * - Never exits non-zero. Diagnostics go to stderr, which for an exit-0 hook
 *   "goes to the debug log only, never the transcript" (same page).
 * - Fast when current: one `claude-mem --version` spawn plus the POSIX rc-file
 *   read and a PATH walk (no spawn), no Bun lookup and no PowerShell spawn.
 * - Runs under plain `node`, so it imports only the light launcher modules and
 *   the installer's Bun discovery (tool-path.ts), never the worker.
 */
import { realpathSync, writeSync } from 'fs';
import { dirname } from 'path';
import {
  ensureLauncherOnPath,
  findExecutableOnPath,
  type LauncherEnsureResult,
  type LauncherInstallLogger,
} from './install-launcher.js';
import { findBunExecutablePath } from '../npx-cli/install/tool-path.js';

// Captured before the ensure step: PATH setup prepends the bin dir to this
// process's PATH, but the other hooks run with the PATH Claude Code started with.
const claudeCodeHookProcessPath = process.env.PATH ?? '';

function writeStderrLine(message: string): void {
  process.stderr.write(`claude-mem ensure-launcher: ${message}\n`);
}

/** Synchronous write so the line is flushed before process.exit(0). */
function printUserVisibleSystemMessage(failureReason: string): void {
  const systemMessage = `claude-mem: memory hooks are not active: ${failureReason}. Fix: run \`npx claude-mem install\`, then restart Claude Code.`;
  writeSync(1, `${JSON.stringify({ systemMessage })}\n`);
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
function launcherPathLookupFailureReason(placedLauncherBinaryPath: string): string | null {
  const resolvedClaudeMemPath = findExecutableOnPath('claude-mem', claudeCodeHookProcessPath, process.platform);
  if (resolvedClaudeMemPath === null) {
    return `the launcher was installed at ${placedLauncherBinaryPath} but Claude Code's PATH does not include ${dirname(placedLauncherBinaryPath)}`;
  }
  if (!isSameFileOnDisk(resolvedClaudeMemPath, placedLauncherBinaryPath)) {
    return `another claude-mem at ${resolvedClaudeMemPath} shadows the hook launcher at ${placedLauncherBinaryPath}`;
  }
  return null;
}

function ensureResultFailureReason(ensureResult: LauncherEnsureResult): string | null {
  switch (ensureResult.status) {
    case 'bun-not-found':
      return 'Bun was not found, so the claude-mem launcher could not be compiled';
    case 'foreign-binary-kept':
      return `${ensureResult.binaryPath} is not the claude-mem hook launcher and was left in place`;
    case 'already-current':
    case 'newer-protocol-kept':
    case 'installed':
      return launcherPathLookupFailureReason(ensureResult.binaryPath);
  }
}

/** Runs the ensure step; returns the user-facing failure reason, or null when the hooks will work. */
function runEnsureLauncher(): string | null {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return 'CLAUDE_PLUGIN_ROOT is not set';
  const ensureResult = ensureLauncherOnPath({
    pluginRoot,
    resolveBunPath: findBunExecutablePath,
    logger: stderrLogger,
    invocationContext: 'session-start-self-heal',
  });
  return ensureResultFailureReason(ensureResult);
}

let failureReason: string | null;
try {
  failureReason = runEnsureLauncher();
} catch (error: unknown) {
  // Fail-open boundary: a compile error or a missing launcher bundle is
  // reported to the user, and session start is never blocked.
  failureReason = error instanceof Error ? error.message : String(error);
}
if (failureReason !== null) {
  writeStderrLine(failureReason);
  printUserVisibleSystemMessage(failureReason);
}
process.exit(0);

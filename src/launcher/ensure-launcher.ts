/**
 * SessionStart self-heal for marketplace-only installs (plan-17 #3605, SPIKE
 * Decision 1). Bundled to plugin/scripts/ensure-launcher.cjs and run as a
 * shell-free hook: {"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/ensure-launcher.cjs"]}.
 *
 * Setup never fires on plugin install or update (SPIKE item 8), and the
 * plugin's bin/ is not on the hook PATH (item 4), so this is the earliest
 * reliable point to (re)place the on-PATH launcher after a marketplace update.
 *
 * Contract:
 * - Never prints to stdout. Claude Code adds plain-text stdout of a
 *   SessionStart hook to Claude's context; stderr from a hook that exits 0
 *   "goes to the debug log only, never the transcript"
 *   (https://code.claude.com/docs/en/hooks, "Exit code 0").
 * - Never exits non-zero. Every failure prints one stderr line and exits 0.
 * - Fast when current: one `claude-mem --version` spawn plus the POSIX rc-file
 *   read, no Bun lookup and no PowerShell spawn.
 * - Runs under plain `node`, so it imports only the light launcher modules and
 *   the installer's Bun discovery (tool-path.ts), never the worker.
 */
import { ensureLauncherOnPath, type LauncherInstallLogger } from './install-launcher.js';
import { findBunExecutablePath } from '../npx-cli/install/tool-path.js';

function writeStderrLine(message: string): void {
  process.stderr.write(`claude-mem ensure-launcher: ${message}\n`);
}

const stderrLogger: LauncherInstallLogger = {
  info: writeStderrLine,
  success: writeStderrLine,
  warn: writeStderrLine,
};

function runEnsureLauncher(): void {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    writeStderrLine('CLAUDE_PLUGIN_ROOT is not set, skipping');
    return;
  }
  const ensureResult = ensureLauncherOnPath({
    pluginRoot,
    resolveBunPath: findBunExecutablePath,
    logger: stderrLogger,
    invocationContext: 'session-start-self-heal',
  });
  if (ensureResult.status === 'bun-not-found') {
    writeStderrLine('Bun not found, cannot compile the claude-mem launcher; run `npx claude-mem install`');
  }
}

try {
  runEnsureLauncher();
} catch (error: unknown) {
  // Fail-open boundary: one stderr line, exit 0 (never block session start).
  writeStderrLine(`${error instanceof Error ? error.message : String(error)}; run \`npx claude-mem install\``);
}
process.exit(0);

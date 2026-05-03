/**
 * Shared Claude executable discovery and validation.
 *
 * Used by SDKAgent and KnowledgeAgent to locate a working Claude Code CLI.
 * Validates candidates with `--version` to distinguish the real CLI from
 * the desktop-app .exe (which exists on disk but can't run headless).
 *
 * Closes #2222.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';
import { logger } from '../utils/logger.js';

/** How long to wait for `claude --version` before giving up (ms). */
const VERSION_CHECK_TIMEOUT_MS = 3_000;

/**
 * Returns true if the path looks like a Windows desktop-app installation
 * (AppData or Program Files) rather than a CLI installed via npm/volta/etc.
 */
function looksLikeDesktopAppPath(candidatePath: string): boolean {
  const normalized = candidatePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('appdata') ||
    normalized.includes('program files') ||
    normalized.includes('program files (x86)')
  );
}

/**
 * Run `<candidate> --version` and return the trimmed stdout, or null on failure.
 * Failures include: timeout, non-zero exit, missing binary, etc.
 *
 * Uses execFileSync (not execSync) so the candidate path is passed as a
 * separate argument and never interpreted by a shell. This prevents shell
 * injection if the path contains characters like `"`, `;`, `&` — reachable
 * on Windows via a crafted CLAUDE_CODE_PATH in settings.json.
 */
function verifyClaudeVersion(candidate: string): string | null {
  try {
    const versionOutput = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return versionOutput || null;
  } catch {
    return null;
  }
}

/**
 * Find and validate a Claude Code CLI executable.
 *
 * Discovery order:
 *   1. `CLAUDE_CODE_PATH` from settings.json (explicit user override)
 *   2. `claude.cmd` via PATH on Windows (avoids spawn issues with spaces)
 *   3. `which claude` / `where claude` auto-detection
 *
 * Every candidate is validated with `--version` (3 s timeout) before being
 * accepted. If a candidate exists on disk but fails `--version`, it is
 * skipped with a warning. Desktop-app executables get an actionable error
 * message explaining how to install the CLI.
 *
 * @param logComponent  Logger component tag (e.g. 'SDK', 'WORKER')
 * @throws {Error} when no valid Claude CLI can be found
 */
export function findClaudeExecutable(logComponent: string = 'SDK'): string {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  // --- 1. Explicit configured path ----------------------------------------
  if (settings.CLAUDE_CODE_PATH) {
    if (!existsSync(settings.CLAUDE_CODE_PATH)) {
      throw new Error(
        `CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`
      );
    }

    const version = verifyClaudeVersion(settings.CLAUDE_CODE_PATH);
    if (!version) {
      const isDesktopApp = looksLikeDesktopAppPath(settings.CLAUDE_CODE_PATH);
      if (isDesktopApp) {
        throw new Error(
          `Found desktop app at "${settings.CLAUDE_CODE_PATH}" but it doesn't support headless mode. ` +
          `Install Claude Code CLI: npm install -g @anthropic-ai/claude-code`
        );
      }
      throw new Error(
        `CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but it failed the --version check. ` +
        `Ensure this is a working Claude Code CLI binary.`
      );
    }
    logger.debug(logComponent, `Using configured CLAUDE_CODE_PATH: ${settings.CLAUDE_CODE_PATH} (${version})`);
    return settings.CLAUDE_CODE_PATH;
  }

  // --- 2. Windows: prefer claude.cmd via PATH ------------------------------
  if (process.platform === 'win32') {
    try {
      execSync('where claude.cmd', {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // claude.cmd is a wrapper — verify it can actually produce --version
      const version = verifyClaudeVersion('claude.cmd');
      if (version) {
        logger.debug(logComponent, `Using claude.cmd from PATH (${version})`);
        return 'claude.cmd';
      }
      logger.warn(logComponent, 'claude.cmd found in PATH but failed --version check, trying next candidate');
    } catch {
      // Fall through to generic detection
    }
  }

  // --- 3. Auto-detection via which/where -----------------------------------
  try {
    const rawOutput = execSync(
      process.platform === 'win32' ? 'where claude' : 'which claude',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    // `where` on Windows can return multiple lines; try each candidate
    const candidates = rawOutput.split('\n').map((line) => line.trim()).filter(Boolean);

    for (const candidate of candidates) {
      const version = verifyClaudeVersion(candidate);
      if (version) {
        logger.debug(logComponent, `Auto-detected Claude CLI: ${candidate} (${version})`);
        return candidate;
      }

      // Candidate exists but doesn't respond to --version
      if (looksLikeDesktopAppPath(candidate)) {
        logger.warn(
          logComponent,
          `Skipping desktop app at "${candidate}" — it doesn't support headless mode. ` +
          `Install Claude Code CLI: npm install -g @anthropic-ai/claude-code`
        );
      } else {
        logger.warn(
          logComponent,
          `Skipping "${candidate}" — failed --version check`
        );
      }
    }
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Fallback behavior — which/where failed, continue to throw clear error
    if (error instanceof Error) {
      logger.debug(logComponent, 'Claude executable auto-detection failed', {}, error);
    } else {
      logger.debug(logComponent, 'Claude executable auto-detection failed with non-Error', {}, new Error(String(error)));
    }
  }

  throw new Error(
    'Claude executable not found. Please either:\n' +
    '1. Add "claude" to your system PATH, or\n' +
    '2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json'
  );
}

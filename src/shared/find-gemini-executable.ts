/**
 * Shared Gemini CLI executable discovery and validation.
 *
 * Used by GeminiCliProvider to locate a working `gemini` CLI (the
 * @google/gemini-cli binary). Mirrors {@link findClaudeExecutable}:
 * candidates are validated with `--version` so a stale shim can't be picked.
 *
 * The resolved path is cached module-wide because availability is polled per
 * request (getActiveAgent / getSelectedProvider) — re-running `which` +
 * `--version` (a subprocess) on every observation would be wasteful. Only a
 * successful resolution is cached; failures re-resolve so a freshly installed
 * CLI is picked up without a worker restart.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';
import { logger, type Component } from '../utils/logger.js';

/** How long to wait for `gemini --version` before giving up (ms). */
const VERSION_CHECK_TIMEOUT_MS = 5_000;

/** Cached successful resolution — reset only by a worker restart. */
let cachedPath: string | null = null;

/**
 * Run `<candidate> --version` and return the trimmed stdout, or null on
 * failure. execFileSync (not execSync) so the candidate path is passed as a
 * separate argument and never interpreted by a shell.
 */
function verifyGeminiVersion(candidate: string): string | null {
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
 * Find and validate a Gemini CLI executable.
 *
 * Discovery order:
 *   1. `CLAUDE_MEM_GEMINI_CLI_PATH` from settings.json (explicit override)
 *   2. `where gemini` (Windows) / `which gemini` (POSIX) auto-detection
 *
 * @throws {Error} when no valid `gemini` CLI can be found.
 */
export function findGeminiExecutable(logComponent: Component = 'SDK'): string {
  if (cachedPath) return cachedPath;

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  // --- 1. Explicit configured path ----------------------------------------
  if (settings.CLAUDE_MEM_GEMINI_CLI_PATH) {
    if (!existsSync(settings.CLAUDE_MEM_GEMINI_CLI_PATH)) {
      throw new Error(
        `CLAUDE_MEM_GEMINI_CLI_PATH is set to "${settings.CLAUDE_MEM_GEMINI_CLI_PATH}" but the file does not exist.`
      );
    }
    const version = verifyGeminiVersion(settings.CLAUDE_MEM_GEMINI_CLI_PATH);
    if (!version) {
      throw new Error(
        `CLAUDE_MEM_GEMINI_CLI_PATH is set to "${settings.CLAUDE_MEM_GEMINI_CLI_PATH}" but it failed the --version check. ` +
        `Ensure this is a working @google/gemini-cli binary.`
      );
    }
    logger.debug(logComponent, `Using configured CLAUDE_MEM_GEMINI_CLI_PATH: ${settings.CLAUDE_MEM_GEMINI_CLI_PATH} (${version})`);
    cachedPath = settings.CLAUDE_MEM_GEMINI_CLI_PATH;
    return cachedPath;
  }

  // --- 2. Auto-detection via which/where -----------------------------------
  try {
    const rawOutput = execSync(
      process.platform === 'win32' ? 'where gemini' : 'which gemini',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    const candidates = rawOutput.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const version = verifyGeminiVersion(candidate);
      if (version) {
        logger.debug(logComponent, `Auto-detected Gemini CLI: ${candidate} (${version})`);
        cachedPath = candidate;
        return cachedPath;
      }
      logger.warn(logComponent, `Skipping "${candidate}" — failed --version check`);
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.debug(logComponent, 'Gemini CLI auto-detection failed', {}, error);
    } else {
      logger.debug(logComponent, 'Gemini CLI auto-detection failed with non-Error', {}, new Error(String(error)));
    }
  }

  throw new Error(
    'Gemini CLI executable not found. Please either:\n' +
    '1. Install it: npm install -g @google/gemini-cli, or\n' +
    '2. Set CLAUDE_MEM_GEMINI_CLI_PATH in ~/.claude-mem/settings.json'
  );
}

/**
 * Cheap availability probe used by provider selection. Resolves the executable
 * once (caching success); returns false instead of throwing when missing.
 */
export function hasGeminiExecutable(): boolean {
  if (cachedPath) return true;
  try {
    findGeminiExecutable();
    return true;
  } catch {
    return false;
  }
}

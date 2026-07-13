/**
 * Shared Agy CLI executable discovery and validation.
 *
 * Successful resolutions are cached for the current explicit path setting.
 * Changing CLAUDE_MEM_AGY_CLI_PATH causes the next lookup to re-resolve.
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';
import { logger, type Component } from '../utils/logger.js';

const VERSION_CHECK_TIMEOUT_MS = 5_000;

let cachedPath: string | null = null;
let cachedConfiguredPath: string | null = null;

function verifyAgyVersion(candidate: string): string | null {
  try {
    const output = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function detectedCandidates(): string[] {
  const candidates: string[] = [];
  try {
    const output = execSync(process.platform === 'win32' ? 'where agy' : 'which agy', {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    candidates.push(...output.split('\n').map((line) => line.trim()).filter(Boolean));
  } catch {
    // Fall through to the standard user-local install path.
  }

  if (process.platform !== 'win32') {
    candidates.push(join(homedir(), '.local', 'bin', 'agy'));
  }
  return [...new Set(candidates)];
}

export function findAgyExecutable(logComponent: Component = 'SDK'): string {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const configuredPath = settings.CLAUDE_MEM_AGY_CLI_PATH || '';

  if (cachedPath && cachedConfiguredPath === configuredPath) return cachedPath;

  if (configuredPath) {
    const configuredCandidate = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
    if (!existsSync(configuredCandidate)) {
      throw new Error(`CLAUDE_MEM_AGY_CLI_PATH is set to "${configuredPath}" but the file does not exist.`);
    }
    const version = verifyAgyVersion(configuredCandidate);
    if (!version) {
      throw new Error(
        `CLAUDE_MEM_AGY_CLI_PATH is set to "${configuredPath}" but it failed the --version check. ` +
        'Ensure this is a working Antigravity agy binary.'
      );
    }
    logger.debug(logComponent, `Using configured CLAUDE_MEM_AGY_CLI_PATH: ${configuredCandidate} (${version})`);
    cachedConfiguredPath = configuredPath;
    cachedPath = configuredCandidate;
    return cachedPath;
  }

  for (const candidate of detectedCandidates()) {
    if (!existsSync(candidate)) continue;
    const version = verifyAgyVersion(candidate);
    if (version) {
      logger.debug(logComponent, `Auto-detected Agy CLI: ${candidate} (${version})`);
      cachedConfiguredPath = configuredPath;
      cachedPath = candidate;
      return cachedPath;
    }
    logger.warn(logComponent, `Skipping "${candidate}" — failed agy --version check`);
  }

  throw new Error(
    'Agy CLI executable not found. Install Antigravity CLI or set ' +
    'CLAUDE_MEM_AGY_CLI_PATH in ~/.claude-mem/settings.json.'
  );
}

export function hasAgyExecutable(): boolean {
  try {
    findAgyExecutable();
    return true;
  } catch {
    return false;
  }
}

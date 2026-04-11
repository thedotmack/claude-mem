/**
 * Uvx Path Utility
 *
 * Resolves the uvx executable path for environments where uvx is not in PATH
 * (e.g., launchd, cron, nohup contexts where ~/.local/bin is not included).
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

/**
 * Get the uvx executable path.
 * Tries PATH first, then checks common installation locations.
 * Returns absolute path if found, null otherwise.
 */
export function getUvxPath(): string | null {
  // Try PATH first
  try {
    const result = spawnSync('uvx', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    if (result.status === 0) {
      return 'uvx'; // Available in PATH
    }
  } catch (e) {
    logger.debug('SYSTEM', 'uvx not found in PATH, checking common installation locations', {
      error: e instanceof Error ? e.message : String(e)
    });
  }

  // Check common installation paths
  const uvxPaths = [
    join(homedir(), '.local', 'bin', 'uvx'),   // Default uv/uvx install on Linux/macOS
    join(homedir(), '.cargo', 'bin', 'uvx'),    // Cargo-based install
    '/opt/homebrew/bin/uvx',                    // Homebrew on Apple Silicon
    '/usr/local/bin/uvx',                       // Homebrew on Intel / manual install
    '/usr/bin/uvx',
  ];

  for (const uvxPath of uvxPaths) {
    if (existsSync(uvxPath)) {
      logger.debug('SYSTEM', 'Found uvx at known location', { path: uvxPath });
      return uvxPath;
    }
  }

  return null;
}

/**
 * Get the uvx executable path or throw an error.
 * Use this when uvx is required for operation.
 */
export function getUvxPathOrThrow(): string {
  const uvxPath = getUvxPath();
  if (!uvxPath) {
    const installInstructions = process.platform === 'win32'
      ? 'Install it from https://astral.sh/uv or run: winget install astral-sh.uv\n' +
        'Then ensure the uv installation directory is in your PATH.'
      : 'Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
        'Then ensure ~/.local/bin is in your PATH.';
    throw new Error(
      `uvx is required but not found in PATH or common locations.\n${installInstructions}`
    );
  }
  return uvxPath;
}

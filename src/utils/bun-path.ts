/**
 * Bun Path Utility
 *
 * Resolves the Bun executable path for environments where Bun is not in PATH
 * (e.g., fish shell users where ~/.config/fish/config.fish isn't read by /bin/sh)
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

/**
 * Get the Bun executable path
 * Tries PATH first, then checks common installation locations
 * Returns absolute path if found, null otherwise
 */
export function getBunPath(): string | null {
  const isWindows = process.platform === 'win32';

  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false  // SECURITY: No need for shell, bun is the executable
    });
    if (result.status === 0) {
      logger.debug('BUN_PATH', 'Found in PATH', { path: 'bun' });
      return 'bun'; // Available in PATH
    }
  } catch {
    // Not in PATH, continue to check common locations
  }

  // Check common installation paths
  const bunPaths = isWindows
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun', // Apple Silicon Homebrew
        '/home/linuxbrew/.linuxbrew/bin/bun' // Linux Homebrew
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      // Windows-specific validation: ensure .exe exists
      if (isWindows && !bunPath.endsWith('.exe')) {
        logger.warn('BUN_PATH', 'Invalid Windows path (missing .exe)', { path: bunPath });
        continue;
      }
      logger.info('BUN_PATH', 'Using fallback path', { path: bunPath });
      return bunPath;
    }
  }

  logger.warn('BUN_PATH', 'Bun executable not found', {
    platform: process.platform,
    searchedPaths: bunPaths
  });
  return null;
}

/**
 * Get the Bun executable path or throw an error
 * Use this when Bun is required for operation
 */
export function getBunPathOrThrow(): string {
  const bunPath = getBunPath();
  if (!bunPath) {
    const isWindows = process.platform === 'win32';
    const installCmd = isWindows
      ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
      : 'curl -fsSL https://bun.sh/install | bash';

    const errorMsg = isWindows
      ? `Bun is required but not found in PATH or common installation paths.\n\nInstall Bun:\n  ${installCmd}\n\nThen restart your terminal and PowerShell.\n\nTroubleshooting:\n1. Verify installation: bun --version\n2. Check PATH includes: %USERPROFILE%\\.bun\\bin\n3. See issue #371 for Windows PATH detection issues\n4. Docs: https://docs.claude-mem.ai/troubleshooting/windows-issues`
      : `Bun is required but not found. Install it with:\n  ${installCmd}\nThen restart your terminal.`;

    throw new Error(errorMsg);
  }
  return bunPath;
}

/**
 * Check if Bun is available (in PATH or common locations)
 */
export function isBunAvailable(): boolean {
  return getBunPath() !== null;
}

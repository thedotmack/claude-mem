/**
 * Bun binary resolution — single source of truth.
 *
 * Merged from `npx-cli/utils/bun-resolver.ts` (null-returning) and
 * `CursorHooksInstaller.findBunPath` (fallback-to-'bun'-returning).
 *
 * Pure Node.js — no Bun APIs used.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Well-known locations where Bun might be installed, beyond PATH.
 * Order matches the search priority in bun-runner.js and smart-install.js.
 */
function bunCandidatePaths(): string[] {
  if (IS_WINDOWS) {
    return [
      join(homedir(), '.bun', 'bin', 'bun.exe'),
      join(process.env.USERPROFILE || homedir(), '.bun', 'bin', 'bun.exe'),
      join(process.env.LOCALAPPDATA || '', 'bun', 'bun.exe'),
    ];
  }

  return [
    join(homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    '/opt/homebrew/bin/bun',
    '/home/linuxbrew/.linuxbrew/bin/bun',
  ];
}

/**
 * Attempt to locate the Bun executable.
 *
 * 1. Check PATH via `which` / `where`.
 * 2. Probe well-known installation directories.
 *
 * Returns the absolute path to the binary, `'bun'` if it is in PATH,
 * or `null` if Bun cannot be found.
 */
export function resolveBunBinaryPath(): string | null {
  // Try PATH first
  const whichCommand = IS_WINDOWS ? 'where' : 'which';
  const pathCheck = spawnSync(whichCommand, ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
  });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    return 'bun'; // Available in PATH — use short name
  }

  // Probe known install locations
  for (const candidatePath of bunCandidatePaths()) {
    if (candidatePath && existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Locate the Bun executable, falling back to the literal string 'bun'
 * so callers that must emit a bun invocation always get *something* to run.
 *
 * Use this when writing hook scripts / config files: the installation should
 * succeed even if Bun isn't detected at install time, and the user sees a
 * clear error at hook-run time if bun is still missing.
 */
export function resolveBunBinaryPathOrDefault(): string {
  return resolveBunBinaryPath() ?? 'bun';
}

/**
 * Get the installed Bun version string (e.g. `"1.2.3"`), or `null`
 * if Bun is not available.
 */
export function getBunVersionString(): string | null {
  const bunPath = resolveBunBinaryPath();
  if (!bunPath) return null;

  const result = spawnSync(bunPath, ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

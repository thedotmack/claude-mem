/**
 * Bun / tool discovery shared by the npx installer (setup-runtime.ts) and the
 * plugin's SessionStart self-heal (plugin/scripts/ensure-launcher.cjs). Kept
 * free of heavy imports (no settings, no worker helpers, no bun:sqlite) so it
 * bundles into a script that runs under plain `node`.
 */
import { accessSync, constants, existsSync, statSync } from 'fs';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { buildSpawnSyncInvocation, lookupWindowsCommand } from '../../shared/spawn.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Absolute paths bun's installer can write to, recomputed per call so an
 * installer that set `$BUN_INSTALL` earlier in this process is still found.
 * Honours `$BUN_INSTALL`, both `homedir()` and `%USERPROFILE%` (which differ on
 * redirected Windows profiles), `%LOCALAPPDATA%\bun`, and the platform defaults.
 * The previous `homedir()`-only list missed env-directed installs and aborted
 * with "executable not found" even when the binary was present.
 */
export function bunCommonPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const binName = IS_WINDOWS ? 'bun.exe' : 'bun';
  const homeRoots = [homedir(), env.USERPROFILE].filter((v): v is string => Boolean(v));
  const localAppData = IS_WINDOWS && env.LOCALAPPDATA
    ? [join(env.LOCALAPPDATA, 'bun', binName), join(env.LOCALAPPDATA, 'bun', 'bin', binName)]
    : [];
  const systemPaths = IS_WINDOWS
    ? []
    : ['/usr/local/bin/bun', '/opt/homebrew/bin/bun', '/home/linuxbrew/.linuxbrew/bin/bun', '/usr/bin/bun', '/snap/bin/bun'];
  const candidates = [
    ...(env.BUN_INSTALL ? [join(env.BUN_INSTALL, 'bin', binName)] : []),
    ...homeRoots.map(root => join(root, '.bun', 'bin', binName)),
    ...localAppData,
    ...systemPaths,
  ];
  return [...new Set(candidates)];
}

export function spawnVersionProbe(command: string, args: string[]) {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const invocation = buildSpawnSyncInvocation(command, args, options);
  return spawnSync(invocation.command, invocation.args, invocation.options);
}

export function getToolPath(command: string, commonPaths: string[]): string | null {
  const pathCommand = IS_WINDOWS ? lookupWindowsCommand(command) : command;
  try {
    if (pathCommand) {
      const result = spawnVersionProbe(pathCommand, ['--version']);
      if (result.status === 0) return pathCommand;
    }
  } catch {
    // Not in PATH
  }

  return commonPaths.find(existsSync) || null;
}

/** PATH first (proven by `bun --version`), then the installer's well-known locations. */
export function findBunExecutablePath(): string | null {
  return getToolPath('bun', bunCommonPaths());
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!IS_WINDOWS) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns true when the Codex CLI is directly runnable from PATH. */
export function isCodexOnPath(): boolean {
  const pathCommand = IS_WINDOWS ? lookupWindowsCommand('codex') : 'codex';
  try {
    if (pathCommand) {
      const result = spawnVersionProbe(pathCommand, ['--version']);
      if (result.status === 0) return true;
    }
  } catch {
    // Not in PATH
  }
  return false;
}

/** Common locations for the Codex CLI executable across macOS and Windows. */
export function codexCommonPaths(): string[] {
  if (IS_WINDOWS) {
    return [];
  }
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
}

/**
 * The explicit configured path when it is set, otherwise PATH (proven by
 * `codex --version`), then well-known install locations. A configured path is
 * judged the way CodexProvider will spawn it: `~` is not expanded there, so a
 * `~` path is never reported as available, and a file must be executable.
 */
export function findCodexExecutablePath(configuredPath?: string): string | null {
  const explicit = (configuredPath?.trim() || process.env.CLAUDE_MEM_CODEX_PATH?.trim());
  if (explicit && explicit !== 'codex') {
    if (explicit.startsWith('~')) return null;
    const resolved = IS_WINDOWS ? (lookupWindowsCommand(explicit) ?? explicit) : explicit;
    if (isExecutableFile(resolved)) return resolved;
    try {
      const result = spawnVersionProbe(resolved, ['--version']);
      if (result.status === 0) return resolved;
    } catch {
      // Configured path failed
    }
    return null;
  }
  return getToolPath('codex', codexCommonPaths());
}

// F1 foundation: spawn wrapper that hides child windows on Windows by default. See src/shared/spawn.ts.test.ts for invariant.
import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type ChildProcess,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { extname } from 'node:path';

export type SpawnHiddenOptions = SpawnOptions;

export function spawnHidden(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
): ChildProcess {
  return spawn(command, args ?? [], { windowsHide: true, ...options });
}

export const WINDOWS_CMD_EXTENSIONS = new Set(['.cmd', '.bat']);
export const WINDOWS_NATIVE_EXTENSIONS = new Set(['.exe', '.com']);
export const WINDOWS_COMMAND_EXTENSIONS = new Set([
  ...WINDOWS_NATIVE_EXTENSIONS,
  ...WINDOWS_CMD_EXTENSIONS,
]);

export interface SpawnSyncInvocation {
  command: string;
  args: string[];
  options: SpawnSyncOptionsWithStringEncoding;
}

export function quoteWindowsCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function lookupWindowsCommand(command: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync('where', [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const candidates = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    return candidates.find(candidate => WINDOWS_NATIVE_EXTENSIONS.has(extname(candidate).toLowerCase()))
      ?? candidates.find(candidate => WINDOWS_COMMAND_EXTENSIONS.has(extname(candidate).toLowerCase()))
      ?? candidates[0]
      ?? null;
  } catch {
    // where exits non-zero when absent and can throw if PATH is malformed.
    return null;
  }
}

export function buildSpawnSyncInvocation(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  platform: NodeJS.Platform = process.platform,
): SpawnSyncInvocation {
  const invocationOptions: SpawnSyncOptionsWithStringEncoding = {
    ...(platform === 'win32' ? { windowsHide: true } : {}),
    ...options,
  };

  if (platform === 'win32' && WINDOWS_CMD_EXTENSIONS.has(extname(command).toLowerCase())) {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', [command, ...args].map(quoteWindowsCmdArgument).join(' ')],
      options: invocationOptions,
    };
  }

  return {
    command,
    args: [...args],
    options: invocationOptions,
  };
}

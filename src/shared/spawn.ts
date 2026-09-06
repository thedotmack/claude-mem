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

/** Every PATH hit for `command`, in `where` order (PATH order). */
export function lookupWindowsCommandCandidates(command: string): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const result = spawnSync('where', [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    // where exits non-zero when absent and can throw if PATH is malformed.
    return [];
  }
}

export function lookupWindowsCommand(command: string): string | null {
  const candidates = lookupWindowsCommandCandidates(command);
  return candidates.find(candidate => WINDOWS_NATIVE_EXTENSIONS.has(extname(candidate).toLowerCase()))
    ?? candidates.find(candidate => WINDOWS_COMMAND_EXTENSIONS.has(extname(candidate).toLowerCase()))
    ?? candidates[0]
    ?? null;
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
    const commandLine = [command, ...args].map(quoteWindowsCmdArgument).join(' ');
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      // Wrap the per-arg-quoted command line in ONE outer quote pair: `cmd /s /c`
      // strips the outermost quotes and leaves the inner per-arg quoting intact,
      // so a shim path (or any arg) containing spaces survives. Pairs with
      // windowsVerbatimArguments below, which stops Node re-escaping this payload
      // (without it the leading `"` becomes `\"` and cmd.exe rejects the command).
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      options: { ...invocationOptions, windowsVerbatimArguments: true },
    };
  }

  return {
    command,
    args: [...args],
    options: invocationOptions,
  };
}

// F1 foundation: spawn wrapper that hides child windows on Windows by default. See src/shared/spawn.ts.test.ts for invariant.
import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type ChildProcess,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { dirname, extname, join } from 'node:path';

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

type VoltaWhichRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string };

const VOLTA_SHIM_RESOLUTION_TIMEOUT_MS = 5_000;

const runVoltaWhich: VoltaWhichRunner = (command, args, options) =>
  spawnSync(command, args, options);

export function quoteWindowsCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function selectWindowsCommandCandidate(
  candidates: string[],
  resolveShim?: (shimPath: string) => string | null,
): string | null {
  const native = candidates.find(candidate =>
    WINDOWS_NATIVE_EXTENSIONS.has(extname(candidate).toLowerCase()));
  if (native) return native;

  const shim = candidates.find(candidate =>
    WINDOWS_CMD_EXTENSIONS.has(extname(candidate).toLowerCase()));
  if (shim && resolveShim) {
    const resolved = resolveShim(shim);
    if (resolved && WINDOWS_NATIVE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
      return resolved;
    }
  }

  return shim ?? candidates[0] ?? null;
}

export function resolveVoltaShim(
  command: string,
  shimPath: string,
  run: VoltaWhichRunner = runVoltaWhich,
): string | null {
  if (!/[\\/]volta[\\/]bin[\\/]/i.test(shimPath)) return null;
  try {
    const result = run(join(dirname(shimPath), 'volta.exe'), ['which', command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: VOLTA_SHIM_RESOLUTION_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    return result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
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
    return selectWindowsCommandCandidate(
      candidates,
      shimPath => resolveVoltaShim(command, shimPath),
    );
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

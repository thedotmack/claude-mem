import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const BUN_PATH_LOOKUP_TIMEOUT_MS = 1500;

interface BunLookupOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  exists?: (path: string) => boolean;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}

interface PathLookupResult {
  status: number | null;
  stdout: string;
}

function windowsSystem32Executable(executableName: string, env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows';
  return join(systemRoot, 'System32', executableName);
}

function knownBunPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const bunInstall = typeof env.BUN_INSTALL === 'string' ? env.BUN_INSTALL.trim() : '';
  const bunEnv = typeof env.BUN === 'string' ? env.BUN.trim() : '';
  const bunPathEnv = typeof env.BUN_PATH === 'string' ? env.BUN_PATH.trim() : '';

  return platform === 'win32'
    ? [
        bunEnv,
        bunPathEnv,
        bunInstall ? join(bunInstall, 'bin', 'bun.exe') : '',
        bunInstall ? join(bunInstall, 'bin', 'bun') : '',
        bunInstall ? join(bunInstall, 'bun.exe') : '',
        join(homeDirectory, '.bun', 'bin', 'bun.exe'),
      ]
    : [
        bunEnv,
        bunPathEnv,
        bunInstall ? join(bunInstall, 'bin', 'bun') : '',
        bunInstall ? join(bunInstall, 'bun') : '',
        join(homeDirectory, '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun',
      ];
}

function runPathLookup(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
  timeoutMs: number
): Promise<PathLookupResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(platform === 'win32' ? { windowsHide: true } : {}),
      });
    } catch {
      resolve({ status: null, stdout: '' });
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (result: PathLookupResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The resolver still needs to finish if the process already exited.
      }
      finish({ status: null, stdout: '' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.once('error', () => finish({ status: null, stdout: '' }));
    child.once('close', (status) => finish({ status, stdout }));
  });
}

/** Resolve a Bun executable without allowing Windows PATH discovery to block a hook indefinitely. */
export async function findBun(options: BunLookupOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const exists = options.exists ?? existsSync;
  const knownPaths = knownBunPaths(platform, env, homeDirectory);

  // The Windows launcher runs inside every hook. Check explicit locations first
  // so the usual ~/.bun installation does not synchronously invoke where.exe.
  if (platform === 'win32') {
    for (const bunPath of knownPaths) {
      if (bunPath && exists(bunPath)) return bunPath;
    }

    const pathCheck = await runPathLookup(
      windowsSystem32Executable('where.exe', env),
      ['bun'],
      platform,
      options.spawnProcess ?? spawn,
      options.timeoutMs ?? BUN_PATH_LOOKUP_TIMEOUT_MS
    );
    if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
      // where.exe prints in the console code page, so a non-ASCII profile path
      // can arrive garbled; keep only lines that exist on disk (#4694).
      const bunPaths = pathCheck.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => exists(line));
      const firstBunPath = bunPaths.find((line) => {
        const lowerPath = line.toLowerCase();
        return lowerPath.endsWith('bun.exe') || lowerPath.endsWith('bun.cmd');
      });
      const firstBunDir = firstBunPath ? dirname(firstBunPath).toLowerCase() : null;
      const firstInstallPaths = firstBunDir
        ? bunPaths.filter((line) => dirname(line).toLowerCase() === firstBunDir)
        : [];
      const bunExePath = firstInstallPaths.find((line) => line.toLowerCase().endsWith('bun.exe'));
      if (bunExePath) return bunExePath;
      const bunCmdPath = firstInstallPaths.find((line) => line.toLowerCase().endsWith('bun.cmd'));
      if (bunCmdPath) return bunCmdPath;
      // The official installer ships bun.exe only (no bun.cmd shim). Return
      // the resolved absolute path instead of relying on the child's PATH.
      const firstWherePath = bunPaths.find(Boolean);
      if (firstWherePath) return firstWherePath;
    }
    return null;
  }

  // Keep the existing Unix PATH-before-explicit-path precedence.
  const pathCheck = spawnSync('which', ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (pathCheck.status === 0 && pathCheck.stdout?.trim()) return 'bun';

  for (const bunPath of knownPaths) {
    if (bunPath && exists(bunPath)) return bunPath;
  }
  return null;
}

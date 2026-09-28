/**
 * fix.bun.npm-package — when the official Bun install script fails (no curl,
 * no unzip, a blocked PowerShell policy, a TLS proxy…), install Bun from the
 * npm registry with the npm that is already running npx. Node is always
 * present on this path because npx is running.
 *
 * The npm `bun` package's own bin/bun.exe is a placeholder until its
 * postinstall runs; we install with --ignore-scripts (no third-party install
 * scripts) and take the native binary from the platform package
 * (@oven/bun-<platform>-<arch>[-musl|-baseline]) instead, probing each until
 * one answers `--version` (glibc vs musl is decided by the probe, not guessed).
 *
 * The working binary is copied to ~/.bun/bin — the official installer's
 * location, which the hooks' bun-runner and the worker spawner already search.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { buildSpawnSyncInvocation, lookupWindowsCommand } from '../../shared/spawn.js';
import { resolveDataDir } from '../../shared/paths.js';

export const BUN_NPM_FIX_ID = 'fix.bun.npm-package';
// Major-pinned so a future bun 2 cannot arrive through the fallback unannounced.
const BUN_NPM_SPEC = 'bun@1';

export interface BunNpmFallbackDeps {
  platform: NodeJS.Platform;
  arch: string;
  homeDir: string;
  /** Where the npm package is installed (`<dataDir>/runtime`). */
  prefix: string;
  /** Runs `npm install` into `prefix`; throws on failure. */
  runNpmInstall: (prefix: string, spec: string) => void;
  /** `<bin> --version` output, or null when it does not run. */
  probeVersion: (binPath: string) => string | null;
  listDir: (dir: string) => string[];
  fileExists: (path: string) => boolean;
  installBinary: (from: string, to: string) => void;
}

export interface BunNpmFallbackResult {
  bunPath: string;
  version: string;
}

function npmPlatformName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'windows' : platform;
}

/** Native-binary candidates in probe order: exact platform package first. */
export function bunNpmCandidates(prefix: string, platform: NodeJS.Platform, arch: string, entries: string[]): string[] {
  const exeName = platform === 'win32' ? 'bun.exe' : 'bun';
  const base = `bun-${npmPlatformName(platform)}-${arch}`;
  const matching = entries
    .filter((name) => name === base || name.startsWith(`${base}-`))
    .sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  return matching.map((name) => join(prefix, 'node_modules', '@oven', name, 'bin', exeName));
}

export function officialBunTarget(homeDir: string, platform: NodeJS.Platform): string {
  return join(homeDir, '.bun', 'bin', platform === 'win32' ? 'bun.exe' : 'bun');
}

/**
 * Returns the installed Bun, or null when the fallback could not produce a
 * working binary. Never throws: the caller already holds the original
 * failure and reports that one.
 */
export function installBunFromNpmPackage(deps: BunNpmFallbackDeps = defaultBunNpmDeps()): BunNpmFallbackResult | null {
  try {
    deps.runNpmInstall(deps.prefix, BUN_NPM_SPEC);
  } catch {
    // [ANTI-PATTERN IGNORED]: the fallback failing leaves the original bun failure as the reported ABORT.
    return null;
  }
  const ovenDir = join(deps.prefix, 'node_modules', '@oven');
  let entries: string[] = [];
  try {
    entries = deps.listDir(ovenDir);
  } catch {
    // [ANTI-PATTERN IGNORED]: no platform package was installed; handled as "no candidate" below.
    return null;
  }
  const working = bunNpmCandidates(deps.prefix, deps.platform, deps.arch, entries)
    .find((candidate) => deps.fileExists(candidate) && deps.probeVersion(candidate) !== null);
  if (!working) return null;

  const target = officialBunTarget(deps.homeDir, deps.platform);
  if (!deps.fileExists(target)) {
    try {
      deps.installBinary(working, target);
    } catch {
      // [ANTI-PATTERN IGNORED]: ~/.bun/bin not writable; the runtime copy still works for this install.
      const version = deps.probeVersion(working);
      return version ? { bunPath: working, version } : null;
    }
  }
  const finalPath = deps.fileExists(target) ? target : working;
  const version = deps.probeVersion(finalPath);
  return version ? { bunPath: finalPath, version } : null;
}

function defaultRunNpmInstall(prefix: string, spec: string): void {
  mkdirSync(prefix, { recursive: true });
  const args = ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', spec];
  // npx exports npm_execpath (npm-cli.js); running it with this Node avoids
  // depending on `npm` being on PATH.
  const npmCli = process.env.npm_execpath;
  const [command, commandArgs] = npmCli && /npm-cli\.[cm]?js$/.test(npmCli)
    ? [process.execPath, [npmCli, ...args]]
    : [process.platform === 'win32' ? (lookupWindowsCommand('npm') ?? 'npm.cmd') : 'npm', args];
  const invocation = buildSpawnSyncInvocation(command, commandArgs, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });
  const result = spawnSync(invocation.command, invocation.args, invocation.options);
  if (result.status !== 0) {
    throw new Error(`npm install ${spec} exited ${result.status ?? result.signal}`);
  }
}

function defaultProbeVersion(binPath: string): string | null {
  const result = spawnSync(binPath, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  const out = (result.stdout ?? '').trim();
  return result.status === 0 && out ? out : null;
}

function defaultInstallBinary(from: string, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}

export function defaultBunNpmDeps(): BunNpmFallbackDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    prefix: join(resolveDataDir(), 'runtime'),
    runNpmInstall: defaultRunNpmInstall,
    probeVersion: defaultProbeVersion,
    listDir: (dir) => readdirSync(dir),
    fileExists: existsSync,
    installBinary: defaultInstallBinary,
  };
}

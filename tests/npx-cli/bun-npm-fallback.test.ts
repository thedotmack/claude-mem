import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import {
  bunNpmCandidates,
  installBunFromNpmPackage,
  officialBunTarget,
  type BunNpmFallbackDeps,
} from '../../src/npx-cli/install/bun-npm-fallback';
import { ensureBun, lastBunSetupReport, type EnsureBunDeps } from '../../src/npx-cli/install/setup-runtime';
import { InstallAbortError } from '../../src/npx-cli/install/error-reporter';

const prefix = '/data/runtime';
const oven = join(prefix, 'node_modules', '@oven');

function fakeDeps(overrides: Partial<BunNpmFallbackDeps> & { working?: string[] } = {}) {
  const files = new Set<string>();
  const calls = { npm: [] as string[], copied: [] as string[] };
  const working = new Set(overrides.working ?? [join(oven, 'bun-linux-x64', 'bin', 'bun')]);
  const deps: BunNpmFallbackDeps = {
    platform: 'linux',
    arch: 'x64',
    homeDir: '/home/u',
    prefix,
    runNpmInstall: (p, spec) => {
      calls.npm.push(`${p} ${spec}`);
      for (const name of ['bun-linux-x64', 'bun-linux-x64-musl']) files.add(join(oven, name, 'bin', 'bun'));
    },
    probeVersion: (bin) => (working.has(bin) || (bin === officialBunTarget('/home/u', 'linux') && files.has(bin)) ? '1.4.2' : null),
    listDir: () => ['bun-linux-x64', 'bun-linux-x64-musl'],
    fileExists: (p) => files.has(p),
    installBinary: (from, to) => {
      calls.copied.push(`${from} -> ${to}`);
      files.add(to);
    },
    ...overrides,
  };
  return { deps, calls, files };
}

describe('fix.bun.npm-package', () => {
  it('orders the exact platform package before musl/baseline variants', () => {
    expect(bunNpmCandidates(prefix, 'linux', 'x64', ['bun-linux-x64-musl', 'bun-darwin-arm64', 'bun-linux-x64', 'bun-linux-x64-baseline'])).toEqual([
      join(oven, 'bun-linux-x64', 'bin', 'bun'),
      join(oven, 'bun-linux-x64-baseline', 'bin', 'bun'),
      join(oven, 'bun-linux-x64-musl', 'bin', 'bun'),
    ]);
    expect(bunNpmCandidates(prefix, 'win32', 'x64', ['bun-windows-x64'])).toEqual([
      join(oven, 'bun-windows-x64', 'bin', 'bun.exe'),
    ]);
  });

  it('installs bun@1 with npm, probes, and copies the working binary to ~/.bun/bin', () => {
    const { deps, calls } = fakeDeps();
    const result = installBunFromNpmPackage(deps);
    expect(calls.npm).toEqual([`${prefix} bun@1`]);
    expect(calls.copied).toEqual([`${join(oven, 'bun-linux-x64', 'bin', 'bun')} -> /home/u/.bun/bin/bun`]);
    expect(result).toEqual({ bunPath: '/home/u/.bun/bin/bun', version: '1.4.2' });
  });

  it('falls through to the musl build when the glibc build does not run', () => {
    const musl = join(oven, 'bun-linux-x64-musl', 'bin', 'bun');
    const { deps, calls } = fakeDeps({ working: [musl] });
    expect(installBunFromNpmPackage(deps)?.version).toBe('1.4.2');
    expect(calls.copied[0]).toStartWith(musl);
  });

  it('returns null (never throws) when npm fails or nothing runs', () => {
    expect(installBunFromNpmPackage(fakeDeps({ runNpmInstall: () => { throw new Error('npm exited 1'); } }).deps)).toBeNull();
    expect(installBunFromNpmPackage(fakeDeps({ working: [] }).deps)).toBeNull();
  });
});

describe('ensureBun with a failing official script', () => {
  const failingScript = () => {
    throw new Error('Failed to install Bun. Please install manually:\nUnderlying error: Command failed\nstderr: error: unzip is required to install bun');
  };

  it('tries the npm fallback and returns its bun when it works', async () => {
    let fallbackCalls = 0;
    const deps: EnsureBunDeps = {
      isInstalled: () => false,
      runOfficialInstaller: failingScript,
      runNpmFallback: () => { fallbackCalls++; return { bunPath: '/home/u/.bun/bin/bun', version: '1.4.2' }; },
      repeatedFailure: () => false,
    };
    expect(await ensureBun(undefined, deps)).toEqual({ bunPath: '/home/u/.bun/bin/bun', version: '1.4.2' });
    expect(fallbackCalls).toBe(1);
    expect(lastBunSetupReport()).toEqual({ failReason: 'unzip-missing', fixId: 'fix.bun.npm-package', fixOutcome: 'ok', skippedRepeat: false });
  });

  it('aborts as bun-missing-after-install when the fallback also fails', async () => {
    const deps: EnsureBunDeps = {
      isInstalled: () => false,
      runOfficialInstaller: failingScript,
      runNpmFallback: () => null,
      repeatedFailure: () => false,
    };
    const err = await ensureBun(undefined, deps).catch((e) => e);
    expect(err).toBeInstanceOf(InstallAbortError);
    expect((err as InstallAbortError).category.id).toBe('bun-missing-after-install');
    expect(lastBunSetupReport().fixOutcome).toBe('error');
  });

  it('skips the official script entirely after a failure in the last 24h', async () => {
    let officialCalls = 0;
    const deps: EnsureBunDeps = {
      isInstalled: () => false,
      runOfficialInstaller: () => { officialCalls++; },
      runNpmFallback: () => ({ bunPath: '/b', version: '1.4.2' }),
      repeatedFailure: () => true,
    };
    await ensureBun(undefined, deps);
    expect(officialCalls).toBe(0);
    expect(lastBunSetupReport().skippedRepeat).toBe(true);
  });
});

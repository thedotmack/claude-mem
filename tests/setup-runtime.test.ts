import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readInstallMarker,
  writeInstallMarker,
  isInstallCurrent,
  platformBunRemediation,
  platformUvRemediation,
  bunCommonPaths,
  uvCommonPaths,
  installPluginDependencies,
  ensureTreeSitterCliBinary,
  provisionTreeSitterCli,
  treeSitterCliBinaryPath,
} from '../src/npx-cli/install/setup-runtime';
import { createInstallSummary, InstallAbortError } from '../src/npx-cli/install/error-reporter';
import { ErrorSeverity } from '../src/npx-cli/install/error-taxonomy';
import { IS_WINDOWS } from '../src/npx-cli/utils/paths';

const SETUP_RUNTIME_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'npx-cli', 'install', 'setup-runtime.ts');
const TOOL_PATH_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'npx-cli', 'install', 'tool-path.ts');
const SHARED_SPAWN_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'shared', 'spawn.ts');
const DOCTOR_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'npx-cli', 'commands', 'doctor.ts');

function probeBunVersion(): string | null {
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

describe('setup-runtime install marker', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `setup-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('readInstallMarker', () => {
    it('returns null when marker file is missing', () => {
      expect(readInstallMarker(tempDir)).toBeNull();
    });

    it('returns null when marker file is invalid JSON', () => {
      writeFileSync(join(tempDir, '.install-version'), 'not valid json');
      expect(readInstallMarker(tempDir)).toBeNull();
    });

    it('returns parsed marker when file is valid', () => {
      writeInstallMarker(tempDir, '1.2.3', '1.0.0', '0.5.0');
      const marker = readInstallMarker(tempDir);
      expect(marker).not.toBeNull();
      expect(marker?.version).toBe('1.2.3');
      expect(marker?.bun).toBe('1.0.0');
      expect(marker?.uv).toBe('0.5.0');
    });

    it('returns parsed marker when file is a legacy plain-text version', () => {
      writeFileSync(join(tempDir, '.install-version'), '12.4.4\n');
      const marker = readInstallMarker(tempDir);
      expect(marker).toEqual({ version: '12.4.4' });
    });

    it('normalizes a leading v in legacy plain-text versions', () => {
      writeFileSync(join(tempDir, '.install-version'), 'v12.4.4\n');
      const marker = readInstallMarker(tempDir);
      expect(marker).toEqual({ version: '12.4.4' });
    });
  });

  describe('writeInstallMarker', () => {
    it('writes a JSON file with the canonical schema { version, bun, uv, installedAt }', () => {
      writeInstallMarker(tempDir, '12.4.7', '1.2.0', '0.4.18');

      const path = join(tempDir, '.install-version');
      expect(existsSync(path)).toBe(true);

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.version).toBe('12.4.7');
      expect(parsed.bun).toBe('1.2.0');
      expect(parsed.uv).toBe('0.4.18');
      expect(typeof parsed.installedAt).toBe('string');
      expect(() => new Date(parsed.installedAt).toISOString()).not.toThrow();
    });

    it('only writes the four documented fields', () => {
      writeInstallMarker(tempDir, '1.0.0', '1.0.0', '0.1.0');
      const parsed = JSON.parse(readFileSync(join(tempDir, '.install-version'), 'utf-8'));
      expect(Object.keys(parsed).sort()).toEqual(['bun', 'installedAt', 'uv', 'version'].sort());
    });
  });

  describe('isInstallCurrent', () => {
    it('returns false when node_modules is missing', () => {
      writeInstallMarker(tempDir, '1.0.0', '1.0.0', '0.1.0');
      expect(isInstallCurrent(tempDir, '1.0.0')).toBe(false);
    });

    it('returns false when marker is missing (but node_modules exists)', () => {
      mkdirSync(join(tempDir, 'node_modules'));
      expect(isInstallCurrent(tempDir, '1.0.0')).toBe(false);
    });

    it('returns false when marker version does not match expected', () => {
      mkdirSync(join(tempDir, 'node_modules'));
      const bunVersion = probeBunVersion() ?? '1.0.0';
      writeInstallMarker(tempDir, '1.0.0', bunVersion, '0.1.0');
      expect(isInstallCurrent(tempDir, '2.0.0')).toBe(false);
    });

    it('returns true when marker matches version and bun version matches', () => {
      const bunVersion = probeBunVersion();
      if (!bunVersion) {
        return;
      }
      mkdirSync(join(tempDir, 'node_modules'));
      writeInstallMarker(tempDir, '1.0.0', bunVersion, '0.1.0');
      expect(isInstallCurrent(tempDir, '1.0.0')).toBe(true);
    });

    it('returns false for a matching legacy plain-text marker when bun is available', () => {
      const bunVersion = probeBunVersion();
      if (!bunVersion) {
        return;
      }
      mkdirSync(join(tempDir, 'node_modules'));
      writeFileSync(join(tempDir, '.install-version'), '1.0.0\n');
      expect(isInstallCurrent(tempDir, '1.0.0')).toBe(false);
    });
  });

  describe('platform remediation strings (Phase 5)', () => {
    it('bun remediation is non-empty and references Bun install', () => {
      const text = platformBunRemediation();
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('Bun');
      expect(text).toContain('claude-mem install');
    });

    it('uv remediation is non-empty and references uv install', () => {
      const text = platformUvRemediation();
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain('uv');
      expect(text).toContain('claude-mem install');
    });
  });
});

describe('setup-runtime binary detection honours installer env vars', () => {
  const bunName = IS_WINDOWS ? 'bun.exe' : 'bun';
  const uvName = IS_WINDOWS ? 'uv.exe' : 'uv';

  it('bunCommonPaths honours BUN_INSTALL', () => {
    const paths = bunCommonPaths({ BUN_INSTALL: '/opt/bun' });
    expect(paths).toContain(join('/opt/bun', 'bin', bunName));
  });

  it('uvCommonPaths honours UV_INSTALL_DIR', () => {
    const paths = uvCommonPaths({ UV_INSTALL_DIR: '/opt/uv/bin' });
    expect(paths).toContain(join('/opt/uv/bin', uvName));
  });

  it('uvCommonPaths honours XDG_BIN_HOME', () => {
    const paths = uvCommonPaths({ XDG_BIN_HOME: '/xdg/bin' });
    expect(paths).toContain(join('/xdg/bin', uvName));
  });

  it('bunCommonPaths returns absolute paths and no duplicates', () => {
    const paths = bunCommonPaths({ BUN_INSTALL: '/opt/bun' });
    expect(paths.length).toBe(new Set(paths).size);
    expect(paths.every(p => p.length > 0)).toBe(true);
  });
});

describe('installPluginDependencies passes the bun path as an argument, not through a shell', () => {
  // The bun path now flows from installer env vars (e.g. $BUN_INSTALL) that can
  // hold spaces or shell metacharacters. execFile must pass it as argv[0] so it
  // never reaches a shell.
  it('runs a bun path containing spaces and injection syntax without evaluating it', async () => {
    if (IS_WINDOWS) return; // POSIX fake-bin shell script

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const marker = join(tmpdir(), `pwned-${unique}`);
    // The bun executable lives in a dir whose name has a space and injection
    // syntax; its output goes to a clean path so the fake script's own redirect
    // is never the thing under test.
    const base = join(tmpdir(), `bun space $(touch ${marker}) ${unique}`);
    const targetDir = join(base, 'target');
    const argsFile = join(tmpdir(), `args-${unique}.txt`);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ dependencies: {} }));

    const fakeBun = join(base, 'bun');
    writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`);
    chmodSync(fakeBun, 0o755);

    try {
      await installPluginDependencies(targetDir, fakeBun);
      const recorded = readFileSync(argsFile, 'utf-8').trim().split('\n');
      expect(recorded).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
      // The $(touch ...) in the path must NOT have executed.
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(marker, { force: true });
      rmSync(argsFile, { force: true });
    }
  });
});

describe('setup-runtime Windows spawn hygiene', () => {
  it('does not use shell: IS_WINDOWS for bun/uv version probes', () => {
    // The probes live in tool-path.ts (shared with plugin/scripts/ensure-launcher.cjs).
    const source = readFileSync(SETUP_RUNTIME_SOURCE_PATH, 'utf-8');
    const toolPathSource = readFileSync(TOOL_PATH_SOURCE_PATH, 'utf-8');
    const sharedSpawnSource = readFileSync(SHARED_SPAWN_SOURCE_PATH, 'utf-8');
    expect(source).not.toContain('shell: IS_WINDOWS');
    expect(toolPathSource).not.toContain('shell: IS_WINDOWS');
    expect(toolPathSource).toContain('buildSpawnSyncInvocation(command, args, options)');
    expect(toolPathSource).toContain('lookupWindowsCommand(command)');
    expect(sharedSpawnSource).toContain("spawnSync('where', [command]");
    expect(sharedSpawnSource).toContain('windowsHide: true');
  });
});

describe('doctor marketplace runtime hygiene', () => {
  it('checks the executable marketplace root marker, not only node_modules', () => {
    const source = readFileSync(DOCTOR_SOURCE_PATH, 'utf-8');
    expect(source).toContain("name: 'Marketplace runtime'");
    expect(source).toContain('isInstallCurrent(marketplaceDir, readPluginVersion())');
    // A missing marker with node_modules present is a warn, not a fail: the
    // marker is written only by the npx installer, and marketplace-flow /
    // dev-sync installs never have one (#3661).
    expect(source).toContain('no npx install marker');
    expect(source).toContain('install marker stale');
  });
});

// #2910: every installer path suppresses lifecycle scripts, so tree-sitter-cli's
// install.js (the step that downloads the executable) never ran and smart_search
// silently returned 0 symbols. The installer now runs that one trusted,
// package-local script when the CLI is not usable.
describe('tree-sitter CLI provisioning (#2910)', () => {
  const TREE_SITTER_BINARY_NAME = process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter';
  const REPO_TREE_SITTER_BINARY = join(import.meta.dir, '..', 'node_modules', 'tree-sitter-cli', TREE_SITTER_BINARY_NAME);
  let tempDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tree-sitter-provision-'));
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = join(tempDir, 'data');
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeCliPackage(installScript?: string): string {
    const cliDir = join(tempDir, 'node_modules', 'tree-sitter-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ bin: { 'tree-sitter': 'tree-sitter' } }));
    if (installScript !== undefined) writeFileSync(join(cliDir, 'install.js'), installScript);
    return cliDir;
  }

  function copyRealBinaryInto(cliDir: string): void {
    const target = join(cliDir, TREE_SITTER_BINARY_NAME);
    copyFileSync(REPO_TREE_SITTER_BINARY, target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
  }

  const materializingInstallScript = (): string => [
    `const fs = require('fs');`,
    `const target = require('path').join(__dirname, ${JSON.stringify(TREE_SITTER_BINARY_NAME)});`,
    `fs.copyFileSync(${JSON.stringify(REPO_TREE_SITTER_BINARY)}, target);`,
    process.platform === 'win32' ? '' : 'fs.chmodSync(target, 0o755);',
  ].join('\n');

  it('runs the package install script when the executable is missing', async () => {
    writeCliPackage(materializingInstallScript());

    await expect(ensureTreeSitterCliBinary(tempDir)).resolves.toBeUndefined();
    expect(existsSync(treeSitterCliBinaryPath(tempDir))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('closes stdin before accepting a package-local version response', async () => {
    const cliDir = writeCliPackage();
    const binaryPath = join(cliDir, 'tree-sitter');
    writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('tree-sitter 0.26.8\\n'));",
    ].join('\n'));
    chmodSync(binaryPath, 0o755);

    const startedAt = Date.now();
    await expect(ensureTreeSitterCliBinary(tempDir)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('never borrows a tree-sitter package from an ancestor node_modules', async () => {
    copyRealBinaryInto(writeCliPackage());

    await expect(ensureTreeSitterCliBinary(join(tempDir, 'nested', 'cache'))).rejects.toThrow('install script not found');
  });

  it('rejects a tree-sitter package path that is not a directory', async () => {
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'tree-sitter-cli'), 'not a directory');

    await expect(ensureTreeSitterCliBinary(tempDir)).rejects.toThrow('package path is not a directory');
  });

  it('install: a provisioning failure only warns, so the install still reaches sign-in', async () => {
    writeCliPackage("console.error('release asset unavailable'); process.exitCode = 2;");
    const summary = createInstallSummary();

    await expect(provisionTreeSitterCli(tempDir, ErrorSeverity.WARN_CONTINUE, summary)).resolves.toBe(false);

    expect(summary.warnings).toEqual([
      expect.objectContaining({
        component: 'tree-sitter-cli-cache',
        remediation: expect.stringContaining('npx claude-mem repair'),
      }),
    ]);
    expect(existsSync(join(tempDir, 'data', 'last-install-error.json'))).toBe(false);
  });

  it('repair: a provisioning failure aborts and keeps the provisioner output', async () => {
    writeCliPackage([
      "console.log('Downloading https://example/tree-sitter');",
      "console.error('release asset unavailable');",
      'process.exitCode = 2;',
    ].join('\n'));

    let caught: unknown = null;
    try {
      await provisionTreeSitterCli(tempDir, ErrorSeverity.ABORT, createInstallSummary());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InstallAbortError);
    expect(caught).toMatchObject({
      category: { id: 'tree-sitter-cli-cache-provisioning-failed' },
      cause: { code: 2 },
    });
    const record = JSON.parse(readFileSync(join(tempDir, 'data', 'last-install-error.json'), 'utf-8'));
    expect(record.details).toContain('Downloading https://example/tree-sitter');
    expect(record.details).toContain('release asset unavailable');
  });

  it('repair: reports a provisioner that runs past the install timeout', async () => {
    writeCliPackage('setTimeout(() => {}, 5000);');

    let caught: unknown = null;
    try {
      await provisionTreeSitterCli(tempDir, ErrorSeverity.ABORT, createInstallSummary(), 1000);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ cause: { killed: true } });
  });

  it('reports nothing when the CLI already works', async () => {
    copyRealBinaryInto(writeCliPackage());
    const summary = createInstallSummary();

    await expect(provisionTreeSitterCli(tempDir, ErrorSeverity.ABORT, summary)).resolves.toBe(true);
    expect(summary.warnings).toEqual([]);
  });
});

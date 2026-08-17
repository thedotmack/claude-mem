import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readInstallMarker,
  writeInstallMarker,
  isInstallCurrent,
  platformBunRemediation,
  platformUvRemediation,
  ensureTreeSitterCliBinary,
  installPluginDependencies,
  treeSitterCliBinaryPath,
} from '../src/npx-cli/install/setup-runtime';
import { warnMarketplaceTreeSitterCliIfUnavailable } from '../src/npx-cli/commands/install';
import type { InstallSummary } from '../src/npx-cli/install/error-reporter';

const SETUP_RUNTIME_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'npx-cli', 'install', 'setup-runtime.ts');
const SHARED_SPAWN_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'shared', 'spawn.ts');
const DOCTOR_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'npx-cli', 'commands', 'doctor.ts');
const REPO_TREE_SITTER_BINARY = join(
  import.meta.dir,
  '..',
  'node_modules',
  'tree-sitter-cli',
  process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter',
);

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

  describe('marketplace tree-sitter warning', () => {
    function summaryWithWarnings(): InstallSummary {
      return { warnings: [] } as unknown as InstallSummary;
    }

    it('does nothing when tree-sitter-cli is not installed in the marketplace root', async () => {
      const summary = summaryWithWarnings();

      await warnMarketplaceTreeSitterCliIfUnavailable(summary, tempDir);

      expect(summary.warnings).toEqual([]);
    });

    it('warns when the marketplace tree-sitter-cli package lacks a usable binary', async () => {
      const cliDir = join(tempDir, 'node_modules', 'tree-sitter-cli');
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, 'package.json'), '{}');
      const summary = summaryWithWarnings();

      await warnMarketplaceTreeSitterCliIfUnavailable(summary, tempDir);

      expect(summary.warnings).toEqual([
        expect.objectContaining({
          component: 'marketplace-tree-sitter-cli',
          remediation: 'Smart-explore may use a PATH tree-sitter binary if available.',
        }),
      ]);
    });

    it('does not warn when the marketplace tree-sitter-cli package already has a usable binary', async () => {
      const cliDir = join(tempDir, 'node_modules', 'tree-sitter-cli');
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, 'package.json'), '{}');
      copyFileSync(REPO_TREE_SITTER_BINARY, join(cliDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter'));
      if (process.platform !== 'win32') {
        chmodSync(join(cliDir, 'tree-sitter'), 0o755);
      }
      const summary = summaryWithWarnings();

      await warnMarketplaceTreeSitterCliIfUnavailable(summary, tempDir);

      expect(summary.warnings).toEqual([]);
    });

    it('provisions an absent binary by running the package install script', async () => {
      const cliDir = join(tempDir, 'node_modules', 'tree-sitter-cli');
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, 'package.json'), '{}');
      writeFileSync(
        join(cliDir, 'install.js'),
        [
          `const fs = require('fs');`,
          `const source = ${JSON.stringify(REPO_TREE_SITTER_BINARY)};`,
          `const target = require('path').join(__dirname, ${JSON.stringify(process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter')});`,
          `fs.copyFileSync(source, target);`,
          process.platform === 'win32' ? '' : `fs.chmodSync(target, 0o755);`,
          '',
        ].join('\n'),
      );

      await expect(ensureTreeSitterCliBinary(tempDir)).resolves.toBeUndefined();
      expect(existsSync(join(cliDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter'))).toBe(true);
    });
  });

  describe('cache dependency installation', () => {
    afterEach(() => {
      delete process.env.CLAUDE_MEM_TEST_EVENTS;
    });

    function createCacheFixture(installScript: string) {
      const cacheDir = join(tempDir, 'cache');
      const cliDir = join(cacheDir, 'node_modules', 'tree-sitter-cli');
      const eventsPath = join(tempDir, 'events.log');
      const bunPath = join(tempDir, process.platform === 'win32' ? 'fake-bun.cmd' : 'fake-bun');

      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cacheDir, 'package.json'), JSON.stringify({
        dependencies: {
          'tree-sitter-cli': '0.26.8',
          'provisioned-dependency': '1.0.0',
        },
      }));
      writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ bin: { 'tree-sitter': 'tree-sitter' } }));
      writeFileSync(join(cliDir, 'install.js'), installScript);
      writeFileSync(join(tempDir, 'fake-bun.js'), [
        `require('fs').appendFileSync(process.env.CLAUDE_MEM_TEST_EVENTS, 'bun ' + process.argv.slice(2).join(' ') + '\\n');`,
      ].join('\n'));

      if (process.platform === 'win32') {
        writeFileSync(bunPath, '@echo off\r\nnode "%~dp0fake-bun.js" %*\r\n');
      } else {
        writeFileSync(bunPath, '#!/bin/sh\nnode "$(dirname "$0")/fake-bun.js" "$@"\n');
        chmodSync(bunPath, 0o755);
      }

      process.env.CLAUDE_MEM_TEST_EVENTS = eventsPath;
      return { cacheDir, cliDir, eventsPath, bunPath };
    }

    function materializingInstallScript(): string {
      const binaryName = process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter';
      return [
        `require('fs').appendFileSync(process.env.CLAUDE_MEM_TEST_EVENTS, 'provision\\n');`,
        `require('fs').mkdirSync(require('path').join(__dirname, '..', 'provisioned-dependency'), { recursive: true });`,
        `require('fs').writeFileSync(require('path').join(__dirname, '..', 'provisioned-dependency', 'package.json'), '{}');`,
        `require('fs').copyFileSync(${JSON.stringify(REPO_TREE_SITTER_BINARY)}, require('path').join(__dirname, ${JSON.stringify(binaryName)}));`,
        process.platform === 'win32' ? '' : `require('fs').chmodSync(require('path').join(__dirname, ${JSON.stringify(binaryName)}), 0o755);`,
      ].join('\n');
    }

    it('provisions the cache binary after script-suppressed Bun install', async () => {
      const fixture = createCacheFixture(materializingInstallScript());
      writeFileSync(fixture.eventsPath, '');

      expect(existsSync(treeSitterCliBinaryPath(fixture.cacheDir))).toBe(false);
      await installPluginDependencies(fixture.cacheDir, fixture.bunPath);
      appendFileSync(fixture.eventsPath, 'returned\n');

      expect(readFileSync(fixture.eventsPath, 'utf-8').trim().split('\n')).toEqual([
        'bun install --frozen-lockfile --ignore-scripts',
        'provision',
        'returned',
      ]);
      expect(existsSync(join(fixture.cacheDir, 'node_modules', 'provisioned-dependency', 'package.json'))).toBe(true);
      expect(existsSync(treeSitterCliBinaryPath(fixture.cacheDir))).toBe(true);
    });

    it('rejects when cache binary provisioning cannot produce a usable executable', async () => {
      const fixture = createCacheFixture([
        `require('fs').appendFileSync(process.env.CLAUDE_MEM_TEST_EVENTS, 'provision\\n');`,
      ].join('\n'));
      writeFileSync(fixture.eventsPath, '');

      await expect(installPluginDependencies(fixture.cacheDir, fixture.bunPath)).rejects.toThrow(
        'without creating a working executable',
      );
      expect(readFileSync(fixture.eventsPath, 'utf-8').trim().split('\n')).toEqual([
        'bun install --frozen-lockfile --ignore-scripts',
        'provision',
      ]);
      expect(existsSync(treeSitterCliBinaryPath(fixture.cacheDir))).toBe(false);
    });

    it('rejects when the cache provisioner exits non-zero', async () => {
      const fixture = createCacheFixture([
        `require('fs').appendFileSync(process.env.CLAUDE_MEM_TEST_EVENTS, 'provision\\n');`,
        'process.exitCode = 2;',
      ].join('\n'));
      writeFileSync(fixture.eventsPath, '');

      await expect(installPluginDependencies(fixture.cacheDir, fixture.bunPath)).rejects.toBeTruthy();
      expect(readFileSync(fixture.eventsPath, 'utf-8').trim().split('\n')).toEqual([
        'bun install --frozen-lockfile --ignore-scripts',
        'provision',
      ]);
    });

    it('rejects when the cache provisioner times out', async () => {
      const fixture = createCacheFixture([
        `require('fs').appendFileSync(process.env.CLAUDE_MEM_TEST_EVENTS, 'provision\\n');`,
        'setTimeout(() => {}, 500);',
      ].join('\n'));
      writeFileSync(fixture.eventsPath, '');
      const previousTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
      process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '25';

      try {
        await expect(installPluginDependencies(fixture.cacheDir, fixture.bunPath)).rejects.toBeTruthy();
      } finally {
        if (previousTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
        else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = previousTimeout;
      }
    });
  });
});

describe('setup-runtime Windows spawn hygiene', () => {
  it('does not use shell: IS_WINDOWS for bun/uv version probes', () => {
    const source = readFileSync(SETUP_RUNTIME_SOURCE_PATH, 'utf-8');
    const sharedSpawnSource = readFileSync(SHARED_SPAWN_SOURCE_PATH, 'utf-8');
    expect(source).not.toContain('shell: IS_WINDOWS');
    expect(source).toContain('buildSpawnSyncInvocation(command, args, options)');
    expect(source).toContain('lookupWindowsCommand(command)');
    expect(sharedSpawnSource).toContain("spawnSync('where', [command]");
    expect(sharedSpawnSource).toContain('windowsHide: true');
  });
});

describe('doctor marketplace runtime hygiene', () => {
  it('checks the executable marketplace root marker, not only node_modules', () => {
    const source = readFileSync(DOCTOR_SOURCE_PATH, 'utf-8');
    expect(source).toContain("name: 'Marketplace runtime'");
    expect(source).toContain('isInstallCurrent(marketplaceDir, readPluginVersion())');
    expect(source).toContain('install marker missing');
    expect(source).toContain('install marker stale');
  });
});

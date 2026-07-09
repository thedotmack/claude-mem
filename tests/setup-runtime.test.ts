import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { join } from 'path';
import { tmpdir } from 'os';
import { PassThrough } from 'stream';
import {
  getPluginDependencyInstallArgs,
  readInstallMarker,
  writeInstallMarker,
  isInstallCurrent,
  platformBunRemediation,
  platformUvRemediation,
} from '../src/npx-cli/install/setup-runtime';

const SETUP_RUNTIME_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'npx-cli', 'install', 'setup-runtime.ts');
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
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `setup-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    spawnSpy = undefined;
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

    it('reads the marker from plugin/.install-version when given a marketplace root', () => {
      mkdirSync(join(tempDir, 'plugin'), { recursive: true });
      writeFileSync(join(tempDir, 'plugin', 'package.json'), JSON.stringify({ name: 'claude-mem' }));
      writeFileSync(
        join(tempDir, 'plugin', '.install-version'),
        JSON.stringify({ version: '13.9.2', bun: '1.3.11', uv: '0.11.14', installedAt: '2026-07-01T00:00:00.000Z' }),
      );

      const marker = readInstallMarker(tempDir);

      expect(marker).toEqual({
        version: '13.9.2',
        bun: '1.3.11',
        uv: '0.11.14',
        installedAt: '2026-07-01T00:00:00.000Z',
      });
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

    it('writes the marker into plugin/.install-version when targetDir is a marketplace root', () => {
      mkdirSync(join(tempDir, 'plugin'), { recursive: true });
      writeFileSync(join(tempDir, 'plugin', 'package.json'), JSON.stringify({ name: 'claude-mem' }));

      writeInstallMarker(tempDir, '13.9.2', '1.3.11', '0.11.14');

      expect(existsSync(join(tempDir, 'plugin', '.install-version'))).toBe(true);
      expect(existsSync(join(tempDir, '.install-version'))).toBe(false);
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

    it('returns false when tree-sitter-cli is declared but its binary is unusable', () => {
      const bunVersion = probeBunVersion();
      if (!bunVersion) {
        return;
      }
      mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
      // Plugin declares tree-sitter-cli, but no working executable is present —
      // e.g. a prior install wrote the marker and later lost the binary. The
      // fast path must not treat this stale cache as current.
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ dependencies: { 'tree-sitter-cli': '^0.26.5' } }),
      );
      writeInstallMarker(tempDir, '1.0.0', bunVersion, '0.1.0');
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

  describe('installPluginDependencies argv', () => {
    it('keeps frozen-lockfile and does not suppress trusted install scripts', () => {
      expect(getPluginDependencyInstallArgs()).toEqual(['install', '--frozen-lockfile']);
      expect(getPluginDependencyInstallArgs()).not.toContain('--ignore-scripts');
    });

    it('reports installer timeouts explicitly when the child is killed', async () => {
      writeFileSync(join(tempDir, 'package.json'), '{}');
      const originalTimeoutOverride = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
      process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '1';

      try {
        spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(() => {
          const fakeChild = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            kill: () => boolean;
          };
          fakeChild.stdout = new PassThrough();
          fakeChild.stderr = new PassThrough();
          fakeChild.kill = () => {
            setTimeout(() => {
              fakeChild.emit('close', null, 'SIGTERM');
            }, 0);
            return true;
          };
          return fakeChild as unknown as ReturnType<typeof childProcess.spawn>;
        });

        const runtime = await import(`../src/npx-cli/install/setup-runtime.ts?timeout-test=${Date.now()}`);
        await expect(runtime.installPluginDependencies(tempDir, 'fake-bun')).rejects.toThrow(
          'bun install timed out after 1ms'
        );
      } finally {
        if (originalTimeoutOverride === undefined) {
          delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
        } else {
          process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = originalTimeoutOverride;
        }
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

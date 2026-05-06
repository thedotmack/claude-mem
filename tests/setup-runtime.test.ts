import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readInstallMarker,
  writeInstallMarker,
  isInstallCurrent,
} from '../src/npx-cli/install/setup-runtime';

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
});

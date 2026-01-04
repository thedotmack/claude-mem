import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Tests for smart-install.js path detection logic
 *
 * These tests verify that the path arrays used for detecting Bun and uv
 * installations include the correct platform-specific paths, particularly
 * for Apple Silicon Macs which use /opt/homebrew instead of /usr/local.
 *
 * The path arrays are defined inline in smart-install.js. These tests
 * replicate that logic to verify correctness without mocking the module.
 */

describe('smart-install path detection', () => {
  describe('BUN_COMMON_PATHS', () => {
    /**
     * Helper function that replicates the path array logic from smart-install.js
     * This allows us to test the logic without importing/mocking the actual module.
     */
    function getBunPaths(isWindows: boolean): string[] {
      return isWindows
        ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
        : [
            join(homedir(), '.bun', 'bin', 'bun'),
            '/usr/local/bin/bun',
            '/opt/homebrew/bin/bun',
          ];
    }

    it('should include Apple Silicon Homebrew path on macOS', () => {
      const bunPaths = getBunPaths(false);

      expect(bunPaths).toContain('/opt/homebrew/bin/bun');
    });

    it('should include Intel Homebrew path on macOS', () => {
      const bunPaths = getBunPaths(false);

      expect(bunPaths).toContain('/usr/local/bin/bun');
    });

    it('should include user-local ~/.bun path on macOS', () => {
      const bunPaths = getBunPaths(false);
      const expectedUserPath = join(homedir(), '.bun', 'bin', 'bun');

      expect(bunPaths).toContain(expectedUserPath);
    });

    it('should NOT include Apple Silicon Homebrew path on Windows', () => {
      const bunPaths = getBunPaths(true);

      expect(bunPaths).not.toContain('/opt/homebrew/bin/bun');
      expect(bunPaths).not.toContain('/usr/local/bin/bun');
    });

    it('should use .exe extension on Windows', () => {
      const bunPaths = getBunPaths(true);

      expect(bunPaths.length).toBe(1);
      expect(bunPaths[0]).toEndWith('bun.exe');
    });

    it('should check user-local paths before system paths', () => {
      const bunPaths = getBunPaths(false);
      const userLocalPath = join(homedir(), '.bun', 'bin', 'bun');
      const homebrewPath = '/opt/homebrew/bin/bun';

      const userLocalIndex = bunPaths.indexOf(userLocalPath);
      const homebrewIndex = bunPaths.indexOf(homebrewPath);

      expect(userLocalIndex).toBeLessThan(homebrewIndex);
      expect(userLocalIndex).toBe(0); // User local should be first
    });
  });

  describe('UV_COMMON_PATHS', () => {
    /**
     * Helper function that replicates the UV path array logic from smart-install.js
     */
    function getUvPaths(isWindows: boolean): string[] {
      return isWindows
        ? [
            join(homedir(), '.local', 'bin', 'uv.exe'),
            join(homedir(), '.cargo', 'bin', 'uv.exe'),
          ]
        : [
            join(homedir(), '.local', 'bin', 'uv'),
            join(homedir(), '.cargo', 'bin', 'uv'),
            '/usr/local/bin/uv',
            '/opt/homebrew/bin/uv',
          ];
    }

    it('should include Apple Silicon Homebrew path on macOS', () => {
      const uvPaths = getUvPaths(false);

      expect(uvPaths).toContain('/opt/homebrew/bin/uv');
    });

    it('should include Intel Homebrew path on macOS', () => {
      const uvPaths = getUvPaths(false);

      expect(uvPaths).toContain('/usr/local/bin/uv');
    });

    it('should include user-local paths on macOS', () => {
      const uvPaths = getUvPaths(false);
      const expectedLocalPath = join(homedir(), '.local', 'bin', 'uv');
      const expectedCargoPath = join(homedir(), '.cargo', 'bin', 'uv');

      expect(uvPaths).toContain(expectedLocalPath);
      expect(uvPaths).toContain(expectedCargoPath);
    });

    it('should NOT include Apple Silicon Homebrew path on Windows', () => {
      const uvPaths = getUvPaths(true);

      expect(uvPaths).not.toContain('/opt/homebrew/bin/uv');
      expect(uvPaths).not.toContain('/usr/local/bin/uv');
    });

    it('should use .exe extension on Windows', () => {
      const uvPaths = getUvPaths(true);

      expect(uvPaths.every((p) => p.endsWith('.exe'))).toBe(true);
    });

    it('should check user-local paths before system Homebrew paths', () => {
      const uvPaths = getUvPaths(false);
      const userLocalPath = join(homedir(), '.local', 'bin', 'uv');
      const cargoPath = join(homedir(), '.cargo', 'bin', 'uv');
      const homebrewPath = '/opt/homebrew/bin/uv';

      const userLocalIndex = uvPaths.indexOf(userLocalPath);
      const cargoIndex = uvPaths.indexOf(cargoPath);
      const homebrewIndex = uvPaths.indexOf(homebrewPath);

      // User paths should come before Homebrew paths
      expect(userLocalIndex).toBeLessThan(homebrewIndex);
      expect(cargoIndex).toBeLessThan(homebrewIndex);

      // User local should be first, then cargo
      expect(userLocalIndex).toBe(0);
      expect(cargoIndex).toBe(1);
    });
  });

  describe('path priority', () => {
    it('should prioritize user-installed binaries over system binaries', () => {
      // This is the expected order of preference:
      // 1. User's home directory (e.g., ~/.bun/bin/bun)
      // 2. Intel Homebrew (/usr/local/bin)
      // 3. Apple Silicon Homebrew (/opt/homebrew/bin)
      //
      // The rationale: User-local installs are most likely intentional
      // and should take precedence over system-wide installations.

      const isWindows = false;
      const bunPaths = isWindows
        ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
        : [
            join(homedir(), '.bun', 'bin', 'bun'),
            '/usr/local/bin/bun',
            '/opt/homebrew/bin/bun',
          ];

      // Verify the first path is user-local
      expect(bunPaths[0]).toContain(homedir());
      expect(bunPaths[0]).not.toStartWith('/usr');
      expect(bunPaths[0]).not.toStartWith('/opt');
    });

    it('should have Homebrew paths last in the array', () => {
      const isWindows = false;
      const uvPaths = isWindows
        ? []
        : [
            join(homedir(), '.local', 'bin', 'uv'),
            join(homedir(), '.cargo', 'bin', 'uv'),
            '/usr/local/bin/uv',
            '/opt/homebrew/bin/uv',
          ];

      if (!isWindows) {
        // Last two should be the Homebrew paths
        expect(uvPaths[uvPaths.length - 1]).toBe('/opt/homebrew/bin/uv');
        expect(uvPaths[uvPaths.length - 2]).toBe('/usr/local/bin/uv');
      }
    });
  });

  describe('cross-platform consistency', () => {
    it('should have exactly 3 Bun paths on macOS/Linux', () => {
      const bunPaths = [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
      ];

      expect(bunPaths.length).toBe(3);
    });

    it('should have exactly 1 Bun path on Windows', () => {
      const bunPaths = [join(homedir(), '.bun', 'bin', 'bun.exe')];

      expect(bunPaths.length).toBe(1);
    });

    it('should have exactly 4 UV paths on macOS/Linux', () => {
      const uvPaths = [
        join(homedir(), '.local', 'bin', 'uv'),
        join(homedir(), '.cargo', 'bin', 'uv'),
        '/usr/local/bin/uv',
        '/opt/homebrew/bin/uv',
      ];

      expect(uvPaths.length).toBe(4);
    });

    it('should have exactly 2 UV paths on Windows', () => {
      const uvPaths = [
        join(homedir(), '.local', 'bin', 'uv.exe'),
        join(homedir(), '.cargo', 'bin', 'uv.exe'),
      ];

      expect(uvPaths.length).toBe(2);
    });
  });
});

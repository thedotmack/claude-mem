/**
 * OpenCode Plugin Installer Tests
 *
 * Tests for install/uninstall/status commands and MCP config management.
 * Uses temp directories for file system isolation (same pattern as cursor-registry.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the exported functions by importing them directly.
// The install/uninstall functions depend on findWorkerServicePath/findMcpServerPath
// which check MARKETPLACE_ROOT and process.cwd(), so we mock those paths.

import {
  installOpenCodePlugin,
  uninstallOpenCodePlugin,
  checkOpenCodePluginStatus,
  handleOpenCodeCommand,
} from '../src/services/integrations/OpenCodePluginInstaller';

describe('OpenCode Plugin Installer', () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    originalCwd = process.cwd();

    // Suppress console output during tests
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('installOpenCodePlugin', () => {
    it('succeeds when scripts are found (via MARKETPLACE_ROOT or cwd)', () => {
      // findWorkerServicePath checks MARKETPLACE_ROOT first, which points to the real project.
      // This test verifies install works when scripts are discoverable.
      process.chdir(tempDir);
      const result = installOpenCodePlugin('project');
      expect(result).toBe(0);
      const pluginPath = join(tempDir, '.opencode', 'plugins', 'claude-mem.ts');
      expect(existsSync(pluginPath)).toBe(true);
    });

    it('creates plugin file and config when both scripts exist', () => {
      const scriptsDir = join(tempDir, 'plugin', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(scriptsDir, 'worker-service.cjs'), '// worker stub', 'utf-8');
      writeFileSync(join(scriptsDir, 'mcp-server.cjs'), '// mcp stub', 'utf-8');

      process.chdir(tempDir);
      const result = installOpenCodePlugin('project');
      expect(result).toBe(0);

      // Plugin file should exist
      const pluginPath = join(tempDir, '.opencode', 'plugins', 'claude-mem.ts');
      expect(existsSync(pluginPath)).toBe(true);

      // Config should have MCP entry
      const configPath = join(tempDir, 'opencode.json');
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcp).toBeDefined();
      expect(config.mcp['claude-mem']).toBeDefined();
      expect(config.mcp['claude-mem'].enabled).toBe(true);
    });

    it('preserves existing config entries when adding MCP', () => {
      const scriptsDir = join(tempDir, 'plugin', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(scriptsDir, 'worker-service.cjs'), '// stub', 'utf-8');
      writeFileSync(join(scriptsDir, 'mcp-server.cjs'), '// stub', 'utf-8');

      // Pre-existing config
      const configPath = join(tempDir, 'opencode.json');
      writeFileSync(configPath, JSON.stringify({ theme: 'dark', mcp: { other: { enabled: true } } }), 'utf-8');

      process.chdir(tempDir);
      const result = installOpenCodePlugin('project');
      expect(result).toBe(0);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.theme).toBe('dark');
      expect(config.mcp.other.enabled).toBe(true);
      expect(config.mcp['claude-mem']).toBeDefined();
    });
  });

  describe('uninstallOpenCodePlugin', () => {
    it('removes plugin file when it exists', () => {
      const pluginDir = join(tempDir, '.opencode', 'plugins');
      mkdirSync(pluginDir, { recursive: true });
      const pluginPath = join(pluginDir, 'claude-mem.ts');
      writeFileSync(pluginPath, '// plugin code', 'utf-8');

      process.chdir(tempDir);
      const result = uninstallOpenCodePlugin('project');
      expect(result).toBe(0);
      expect(existsSync(pluginPath)).toBe(false);
    });

    it('returns 0 even when plugin file does not exist', () => {
      process.chdir(tempDir);
      const result = uninstallOpenCodePlugin('project');
      expect(result).toBe(0);
    });

    it('removes MCP config entry', () => {
      const configPath = join(tempDir, 'opencode.json');
      writeFileSync(configPath, JSON.stringify({
        mcp: {
          'claude-mem': { enabled: true },
          'other-tool': { enabled: true },
        }
      }), 'utf-8');

      process.chdir(tempDir);
      uninstallOpenCodePlugin('project');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcp['claude-mem']).toBeUndefined();
      expect(config.mcp['other-tool']).toBeDefined();
    });
  });

  describe('checkOpenCodePluginStatus', () => {
    it('returns 0 always', () => {
      process.chdir(tempDir);
      const result = checkOpenCodePluginStatus();
      expect(result).toBe(0);
    });

    it('reports not installed when no files exist', () => {
      process.chdir(tempDir);
      checkOpenCodePluginStatus();
      // Should have logged "No OpenCode integration found"
      const calls = consoleLogSpy.mock.calls.map((c: any) => c[0]);
      expect(calls.some((msg: string) => msg.includes('No OpenCode integration found'))).toBe(true);
    });
  });

  describe('handleOpenCodeCommand', () => {
    it('returns 1 for invalid install target', async () => {
      const result = await handleOpenCodeCommand('install', ['invalid']);
      expect(result).toBe(1);
    });

    it('returns 1 for invalid uninstall target', async () => {
      const result = await handleOpenCodeCommand('uninstall', ['invalid']);
      expect(result).toBe(1);
    });

    it('returns 0 for status command', async () => {
      process.chdir(tempDir);
      const result = await handleOpenCodeCommand('status', []);
      expect(result).toBe(0);
    });

    it('returns 0 and prints help for unknown command', async () => {
      const result = await handleOpenCodeCommand('unknown', []);
      expect(result).toBe(0);
      const calls = consoleLogSpy.mock.calls.map((c: any) => c[0]);
      expect(calls.some((msg: string) => msg.includes('OpenCode Integration'))).toBe(true);
    });
  });
});

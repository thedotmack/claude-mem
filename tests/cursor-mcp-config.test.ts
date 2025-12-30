import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  configureCursorMcp,
  removeMcpConfig,
  type CursorMcpConfig
} from '../src/utils/cursor-utils';

/**
 * Tests for Cursor MCP Configuration
 *
 * These tests validate the MCP server configuration that gets written
 * to .cursor/mcp.json (project-level) or ~/.cursor/mcp.json (user-level).
 *
 * The config must match Cursor's expected format for MCP servers.
 */

describe('Cursor MCP Configuration', () => {
  let tempDir: string;
  let mcpJsonPath: string;
  const mcpServerPath = '/path/to/mcp-server.cjs';

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `cursor-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    mcpJsonPath = join(tempDir, '.cursor', 'mcp.json');
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('configureCursorMcp', () => {
    it('creates mcp.json if it does not exist', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      expect(existsSync(mcpJsonPath)).toBe(true);
    });

    it('creates .cursor directory if it does not exist', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      expect(existsSync(join(tempDir, '.cursor'))).toBe(true);
    });

    it('adds claude-mem server with correct structure', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));

      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers['claude-mem']).toBeDefined();
      expect(config.mcpServers['claude-mem'].command).toBe('node');
      expect(config.mcpServers['claude-mem'].args).toEqual([mcpServerPath]);
    });

    it('preserves existing MCP servers when adding claude-mem', () => {
      // Pre-create config with another server
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      const existingConfig = {
        mcpServers: {
          'other-server': {
            command: 'python',
            args: ['/path/to/other.py']
          }
        }
      };
      writeFileSync(mcpJsonPath, JSON.stringify(existingConfig));

      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));

      // Both servers should exist
      expect(config.mcpServers['other-server']).toBeDefined();
      expect(config.mcpServers['other-server'].command).toBe('python');
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });

    it('updates existing claude-mem server path', () => {
      // First config
      configureCursorMcp(mcpJsonPath, '/old/path.cjs');

      // Update with new path
      const newPath = '/new/path.cjs';
      configureCursorMcp(mcpJsonPath, newPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));

      expect(config.mcpServers['claude-mem'].args).toEqual([newPath]);
    });

    it('recovers from corrupt mcp.json', () => {
      // Create corrupt file
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      writeFileSync(mcpJsonPath, 'not valid json {{{{');

      // Should not throw, should overwrite
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });

    it('handles mcp.json with missing mcpServers key', () => {
      // Create file with empty object
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      writeFileSync(mcpJsonPath, '{}');

      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });
  });

  describe('MCP config format validation', () => {
    it('produces valid JSON', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const content = readFileSync(mcpJsonPath, 'utf-8');

      // Should not throw
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('uses pretty-printed JSON (2-space indent)', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const content = readFileSync(mcpJsonPath, 'utf-8');

      // Should contain newlines and indentation
      expect(content).toContain('\n');
      expect(content).toContain('  "mcpServers"');
    });

    it('matches Cursor MCP server schema', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));

      // Top-level must have mcpServers
      expect(config).toHaveProperty('mcpServers');
      expect(typeof config.mcpServers).toBe('object');

      // Each server must have command (string) and optionally args (array)
      for (const [name, server] of Object.entries(config.mcpServers)) {
        expect(typeof name).toBe('string');
        expect((server as { command: string }).command).toBeDefined();
        expect(typeof (server as { command: string }).command).toBe('string');

        const args = (server as { args?: string[] }).args;
        if (args !== undefined) {
          expect(Array.isArray(args)).toBe(true);
          args.forEach((arg: string) => expect(typeof arg).toBe('string'));
        }
      }
    });
  });

  describe('removeMcpConfig', () => {
    it('removes claude-mem server from config', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);
      removeMcpConfig(mcpJsonPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem']).toBeUndefined();
    });

    it('preserves other servers when removing claude-mem', () => {
      // Setup: both servers
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      const config = {
        mcpServers: {
          'other-server': { command: 'python', args: ['/path.py'] },
          'claude-mem': { command: 'node', args: ['/mcp.cjs'] }
        }
      };
      writeFileSync(mcpJsonPath, JSON.stringify(config));

      removeMcpConfig(mcpJsonPath);

      const updated: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(updated.mcpServers['other-server']).toBeDefined();
      expect(updated.mcpServers['claude-mem']).toBeUndefined();
    });

    it('does nothing if mcp.json does not exist', () => {
      // Should not throw
      expect(() => removeMcpConfig(mcpJsonPath)).not.toThrow();
      expect(existsSync(mcpJsonPath)).toBe(false);
    });

    it('does nothing if claude-mem not in config', () => {
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      const config = {
        mcpServers: {
          'other-server': { command: 'python', args: ['/path.py'] }
        }
      };
      writeFileSync(mcpJsonPath, JSON.stringify(config));

      removeMcpConfig(mcpJsonPath);

      const updated: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(updated.mcpServers['other-server']).toBeDefined();
    });
  });

  describe('path handling', () => {
    it('handles absolute path with spaces', () => {
      const pathWithSpaces = '/path/to/my project/mcp-server.cjs';
      configureCursorMcp(mcpJsonPath, pathWithSpaces);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem'].args).toEqual([pathWithSpaces]);
    });

    it('handles Windows-style path', () => {
      const windowsPath = 'C:\\Users\\alex\\.claude\\plugins\\mcp-server.cjs';
      configureCursorMcp(mcpJsonPath, windowsPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem'].args).toEqual([windowsPath]);
    });

    it('handles path with special characters', () => {
      const specialPath = "/path/to/project-name_v2.0 (beta)/mcp-server.cjs";
      configureCursorMcp(mcpJsonPath, specialPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem'].args).toEqual([specialPath]);

      // Verify it survives JSON round-trip
      const reread: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(reread.mcpServers['claude-mem'].args![0]).toBe(specialPath);
    });
  });
});

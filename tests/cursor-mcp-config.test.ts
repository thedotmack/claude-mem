import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  configureCursorMcp,
  type CursorMcpConfig
} from '../src/utils/cursor-utils';

describe('Cursor MCP Configuration', () => {
  let tempDir: string;
  let mcpJsonPath: string;
  const mcpServerPath = '/path/to/mcp-server.cjs';

  beforeEach(() => {
    tempDir = join(tmpdir(), `cursor-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    mcpJsonPath = join(tempDir, '.cursor', 'mcp.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('configureCursorMcp', () => {

    it('adds claude-mem server with correct structure', () => {
      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));

      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers['claude-mem']).toBeDefined();
      expect(config.mcpServers['claude-mem'].command).toBe('node');
      expect(config.mcpServers['claude-mem'].args).toEqual([mcpServerPath]);
    });

    it('updates existing claude-mem server path', () => {
      configureCursorMcp(mcpJsonPath, '/old/path.cjs');

      const newPath = '/new/path.cjs';
      configureCursorMcp(mcpJsonPath, newPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));

      expect(config.mcpServers['claude-mem'].args).toEqual([newPath]);
    });

    it('refuses to overwrite an unparseable mcp.json, keeping the user\'s servers', () => {
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      const userConfig = `{
  // my servers
  "mcpServers": { "github": { "command": "npx", "args": ["github-mcp"] } },
}`;
      writeFileSync(mcpJsonPath, userConfig);

      expect(() => configureCursorMcp(mcpJsonPath, mcpServerPath)).toThrow(/refusing to overwrite/);
      expect(readFileSync(mcpJsonPath, 'utf-8')).toBe(userConfig);
    });

    it('handles mcp.json with missing mcpServers key', () => {
      mkdirSync(join(tempDir, '.cursor'), { recursive: true });
      writeFileSync(mcpJsonPath, '{}');

      configureCursorMcp(mcpJsonPath, mcpServerPath);

      const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });
  });

});

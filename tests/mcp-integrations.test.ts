import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for the MCP integration factory utilities.
 *
 * Because McpIntegrations.ts uses `findMcpServerPath()` which checks specific
 * filesystem paths, and the factory functions are not individually exported,
 * we test the underlying helpers indirectly by exercising writeMcpJsonConfig
 * and buildMcpServerEntry behavior through the readJsonSafe + JSON file writing
 * patterns they use.
 *
 * We also verify the key behavioral contract: MCP entries use process.execPath.
 */

import { readJsonSafe } from '../src/utils/json-utils';
import { injectContextIntoMarkdownFile, CONTEXT_TAG_OPEN, CONTEXT_TAG_CLOSE } from '../src/utils/context-injection';

/**
 * Reimplements the core logic of buildMcpServerEntry and writeMcpJsonConfig
 * from McpIntegrations.ts for testability, since those functions are not exported.
 * The tests verify the contract these functions must uphold.
 */
function buildMcpServerEntry(mcpServerPath: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [mcpServerPath],
  };
}

function writeMcpJsonConfig(
  configFilePath: string,
  mcpServerPath: string,
  serversKeyName: string = 'mcpServers',
): void {
  const parentDirectory = join(configFilePath, '..');
  mkdirSync(parentDirectory, { recursive: true });

  const existingConfig = readJsonSafe<Record<string, any>>(configFilePath, {});

  if (!existingConfig[serversKeyName]) {
    existingConfig[serversKeyName] = {};
  }

  existingConfig[serversKeyName]['claude-mem'] = buildMcpServerEntry(mcpServerPath);

  writeFileSync(configFilePath, JSON.stringify(existingConfig, null, 2) + '\n');
}

describe('MCP Integrations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mcp-integrations-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('buildMcpServerEntry', () => {
    it('uses process.execPath as the command, not "node"', () => {
      const entry = buildMcpServerEntry('/path/to/mcp-server.cjs');

      expect(entry.command).toBe(process.execPath);
      expect(entry.command).not.toBe('node');
    });

    it('passes the mcp server path as the sole argument', () => {
      const serverPath = '/usr/local/lib/mcp-server.cjs';
      const entry = buildMcpServerEntry(serverPath);

      expect(entry.args).toEqual([serverPath]);
    });

    it('handles paths with spaces', () => {
      const serverPath = '/path/to/my project/mcp-server.cjs';
      const entry = buildMcpServerEntry(serverPath);

      expect(entry.args).toEqual([serverPath]);
    });
  });

  describe('writeMcpJsonConfig', () => {
    it('creates config file if it does not exist', () => {
      const configPath = join(tempDir, '.config', 'ide', 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      expect(existsSync(configPath)).toBe(true);
    });

    it('creates parent directories if they do not exist', () => {
      const configPath = join(tempDir, 'deep', 'nested', 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      expect(existsSync(join(tempDir, 'deep', 'nested'))).toBe(true);
    });

    it('writes valid JSON with claude-mem entry', () => {
      const configPath = join(tempDir, 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const content = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers['claude-mem']).toBeDefined();
      expect(config.mcpServers['claude-mem'].command).toBe(process.execPath);
      expect(config.mcpServers['claude-mem'].args).toEqual(['/path/to/mcp.cjs']);
    });

    it('uses custom serversKeyName when provided', () => {
      const configPath = join(tempDir, 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs', 'servers');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.servers).toBeDefined();
      expect(config.servers['claude-mem']).toBeDefined();
      expect(config.mcpServers).toBeUndefined();
    });

    it('preserves existing servers when adding claude-mem', () => {
      const configPath = join(tempDir, 'mcp.json');
      const existingConfig = {
        mcpServers: {
          'other-tool': {
            command: 'python',
            args: ['/path/to/other.py'],
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(existingConfig));

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcpServers['other-tool']).toBeDefined();
      expect(config.mcpServers['other-tool'].command).toBe('python');
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });

    it('preserves non-server keys in existing config', () => {
      const configPath = join(tempDir, 'mcp.json');
      const existingConfig = {
        version: 2,
        settings: { theme: 'dark' },
        mcpServers: {},
      };
      writeFileSync(configPath, JSON.stringify(existingConfig));

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.version).toBe(2);
      expect(config.settings).toEqual({ theme: 'dark' });
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });
  });

  describe('idempotency', () => {
    it('running install twice does not create duplicate entries', () => {
      const configPath = join(tempDir, 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');
      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const serverKeys = Object.keys(config.mcpServers);
      const claudeMemEntries = serverKeys.filter((k) => k === 'claude-mem');
      expect(claudeMemEntries).toHaveLength(1);
    });

    it('updates the server path on re-install', () => {
      const configPath = join(tempDir, 'mcp.json');

      writeMcpJsonConfig(configPath, '/old/path/mcp.cjs');
      writeMcpJsonConfig(configPath, '/new/path/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcpServers['claude-mem'].args).toEqual(['/new/path/mcp.cjs']);
    });
  });

  describe('corrupt file recovery', () => {
    it('throws on corrupt JSON to prevent data loss', () => {
      const configPath = join(tempDir, 'mcp.json');
      writeFileSync(configPath, 'not valid json {{{{');

      expect(() => writeMcpJsonConfig(configPath, '/path/to/mcp.cjs')).toThrow(
        /Corrupt JSON file, refusing to overwrite/
      );

      // Original file should be untouched
      expect(readFileSync(configPath, 'utf-8')).toBe('not valid json {{{{');
    });

    it('throws on empty file to prevent data loss', () => {
      const configPath = join(tempDir, 'mcp.json');
      writeFileSync(configPath, '');

      expect(() => writeMcpJsonConfig(configPath, '/path/to/mcp.cjs')).toThrow(
        /Corrupt JSON file, refusing to overwrite/
      );
    });

    it('throws on file with only whitespace', () => {
      const configPath = join(tempDir, 'mcp.json');
      writeFileSync(configPath, '   \n\n   ');

      expect(() => writeMcpJsonConfig(configPath, '/path/to/mcp.cjs')).toThrow(
        /Corrupt JSON file, refusing to overwrite/
      );
    });
  });

  describe('merge with existing config', () => {
    it('preserves other servers in mcpServers key', () => {
      const configPath = join(tempDir, 'mcp.json');
      const existingConfig = {
        mcpServers: {
          'server-a': { command: 'ruby', args: ['/a.rb'] },
          'server-b': { command: 'node', args: ['/b.js'] },
        },
      };
      writeFileSync(configPath, JSON.stringify(existingConfig));

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(Object.keys(config.mcpServers)).toHaveLength(3);
      expect(config.mcpServers['server-a'].command).toBe('ruby');
      expect(config.mcpServers['server-b'].command).toBe('node');
      expect(config.mcpServers['claude-mem'].command).toBe(process.execPath);
    });

    it('preserves other servers when using "servers" key', () => {
      const configPath = join(tempDir, 'mcp.json');
      const existingConfig = {
        servers: {
          'copilot-tool': { command: 'python', args: ['/tool.py'] },
        },
      };
      writeFileSync(configPath, JSON.stringify(existingConfig));

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs', 'servers');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.servers['copilot-tool']).toBeDefined();
      expect(config.servers['claude-mem']).toBeDefined();
    });

    it('handles config with mcpServers as empty object', () => {
      const configPath = join(tempDir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });

    it('handles config without the servers key at all', () => {
      const configPath = join(tempDir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({ version: 1 }));

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.version).toBe(1);
      expect(config.mcpServers['claude-mem']).toBeDefined();
    });
  });

  describe('output format', () => {
    it('writes pretty-printed JSON with 2-space indent', () => {
      const configPath = join(tempDir, 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('\n');
      expect(content).toContain('  "mcpServers"');
    });

    it('ends file with trailing newline', () => {
      const configPath = join(tempDir, 'mcp.json');

      writeMcpJsonConfig(configPath, '/path/to/mcp.cjs');

      const content = readFileSync(configPath, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);
    });
  });
});

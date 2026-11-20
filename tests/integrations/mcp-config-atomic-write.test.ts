import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { writeMcpJsonConfig } from '../../src/services/integrations/McpIntegrations.js';

// The MCP config is a user-owned JSON file, so a write over an existing file
// must replace it rather than truncate it in place: an interrupted install then
// cannot leave a half-written config that stops every MCP host from launching
// claude-mem. An in-place truncate keeps the same file; a temp-file-plus-rename
// write yields a new one.
describe('McpIntegrations writes JSON configs atomically', () => {
  let tmp: string;
  let configPath: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mcp-config-atomic-'));
    configPath = path.join(tmp, 'mcp.json');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces the config file instead of truncating it in place', () => {
    writeMcpJsonConfig(configPath, '/plugin/scripts/mcp-server.cjs');
    const first = statSync(configPath);

    writeMcpJsonConfig(configPath, '/plugin/scripts/mcp-server.cjs');
    const second = statSync(configPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
  });

  it('still merges claude-mem into an existing config', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeMcpJsonConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.other).toEqual({ command: 'x' });
    expect(config.mcpServers['claude-mem']).toBeDefined();
  });
});

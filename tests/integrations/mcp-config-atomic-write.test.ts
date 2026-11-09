import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { mcpMemberItem } from '../../src/services/wire-gateway/library/agent-library-targets.js';
import { applyLibrary } from '../../src/services/wire-gateway/library/library-engine.js';

// The MCP config is a user-owned JSON file, so a write over an existing file
// must replace it rather than truncate it in place: an interrupted install then
// cannot leave a half-written config that stops every MCP host from launching
// claude-mem (#5413). The MCP-only installers (Copilot CLI, Roo Code, Warp)
// write it through the Library, as this test does. An in-place truncate keeps
// the same file; a temp-file-plus-rename write yields a new one.
describe('MCP JSON configs are written atomically', () => {
  let tmp: string;
  let configPath: string;
  let context: { libraryDirectory: string };

  const install = (serverPath: string) => applyLibrary({
    agentId: 'roo-code',
    items: [mcpMemberItem(configPath, ['mcpServers', 'claude-mem'], { command: 'node', args: [serverPath] })],
    ownedGroups: ['mcp'],
  }, context);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mcp-config-atomic-'));
    configPath = path.join(tmp, 'mcp.json');
    context = { libraryDirectory: path.join(tmp, 'library') };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces the config file instead of truncating it in place', () => {
    install('/plugin/scripts/mcp-server.cjs');
    const first = statSync(configPath);

    // A changed entry, so the second install has bytes to write.
    install('/other-plugin/scripts/mcp-server.cjs');
    const second = statSync(configPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
  });

  it('still merges claude-mem into an existing config', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    install('/plugin/scripts/mcp-server.cjs');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.other).toEqual({ command: 'x' });
    expect(config.mcpServers['claude-mem']).toBeDefined();
  });
});

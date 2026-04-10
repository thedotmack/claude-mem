import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve project root regardless of ESM/CJS context
const _dir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = join(_dir, '..');
const ROOT_MCP_PATH = join(PROJECT_ROOT, '.mcp.json');
const PLUGIN_MCP_PATH = join(PROJECT_ROOT, 'plugin', '.mcp.json');

/**
 * Issue #1471: MCP server not registered because the marketplace root .mcp.json
 * is empty while the actual config lives in plugin/.mcp.json.
 *
 * Claude Code reads .mcp.json from the marketplace root
 * (~/.claude/plugins/marketplaces/thedotmack/.mcp.json), not from the
 * plugin/ subdirectory. Both files must be kept in sync so that
 * MCP search tools are automatically available in every session.
 */
describe('MCP root configuration (issue #1471)', () => {
  it('root .mcp.json exists', () => {
    expect(existsSync(ROOT_MCP_PATH)).toBe(true);
  });

  it('root .mcp.json has mcp-search server registered', () => {
    const content = JSON.parse(readFileSync(ROOT_MCP_PATH, 'utf-8'));
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers['mcp-search']).toBeDefined();
  });

  it('mcp-search command references mcp-server.cjs', () => {
    const content = JSON.parse(readFileSync(ROOT_MCP_PATH, 'utf-8'));
    const mcpSearch = content.mcpServers['mcp-search'];
    expect(mcpSearch.command).toContain('mcp-server.cjs');
  });

  it('root .mcp.json matches plugin/.mcp.json (kept in sync by build)', () => {
    const rootContent = JSON.parse(readFileSync(ROOT_MCP_PATH, 'utf-8'));
    const pluginContent = JSON.parse(readFileSync(PLUGIN_MCP_PATH, 'utf-8'));
    expect(rootContent).toEqual(pluginContent);
  });
});

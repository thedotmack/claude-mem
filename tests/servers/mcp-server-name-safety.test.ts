// #2473 — Plugin MCP server tools were never surfaced to the assistant because
// Claude Code (host-side) built the fully-qualified name with colons
// (`plugin:claude-mem:mcp-search`), and the deferred-tool pattern
// `mcp__<server>__<tool>` rejected the colons. The root cause is HOST-SIDE and
// not fixable in our code (and current Claude Code namespaces with underscores:
// `mcp__plugin_claude-mem_mcp-search__*`, which register correctly).
//
// The one thing under OUR control is the server name we declare in
// plugin/.mcp.json and the tool names we register. Both must stay within the
// MCP-safe character set (alphanumeric, `_`, `-`) and contain NO `:` or `.`, so
// that we never contribute a colon/dot to the qualified name. These tests pin
// that invariant so a future rename can't silently reintroduce the breakage.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

describe('MCP server name safety (#2473)', () => {
  it('every server key declared in plugin/.mcp.json is colon/dot-free and MCP-safe', () => {
    const mcpJsonPath = join(import.meta.dir, '..', '..', 'plugin', '.mcp.json');
    const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    const serverNames = Object.keys(config.mcpServers ?? {});
    expect(serverNames.length).toBeGreaterThan(0);
    for (const name of serverNames) {
      expect(name).not.toContain(':');
      expect(name).not.toContain('.');
      expect(name).toMatch(SAFE_NAME);
    }
  });

  it('every registered MCP tool name is colon/dot-free and within the 64-char fully-qualified budget', () => {
    // Read the source rather than importing it (importing runs the stdio server
    // bootstrap, which is undesirable in a unit test). Extract `name: '...'`
    // entries from the tools array.
    const serverSrcPath = join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts');
    const src = readFileSync(serverSrcPath, 'utf-8');

    const toolNames = Array.from(src.matchAll(/^\s{4}name: '([^']+)',?$/gm)).map(m => m[1]);
    expect(toolNames.length).toBeGreaterThan(5);

    // Worst-case qualified prefix the host applies for this plugin's server.
    const QUALIFIED_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';
    for (const tool of toolNames) {
      expect(tool).not.toContain(':');
      expect(tool).not.toContain('.');
      expect(tool).toMatch(SAFE_NAME);
      // Many MCP hosts cap tool names at 64 chars; staying within budget keeps
      // the tool registrable everywhere.
      expect((QUALIFIED_PREFIX + tool).length).toBeLessThanOrEqual(64);
    }
  });
});

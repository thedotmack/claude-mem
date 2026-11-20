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

});

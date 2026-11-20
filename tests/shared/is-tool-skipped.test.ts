import { describe, it, expect } from 'bun:test';
import { isToolSkipped } from '../../src/shared/is-tool-skipped.js';

describe('isToolSkipped (CLAUDE_MEM_SKIP_TOOLS)', () => {
  it('matches trimmed entries case-insensitively', () => {
    expect(isToolSkipped('todowrite', 'Read, TodoWrite')).toBe(true);
    expect(isToolSkipped('write_file', 'Write_File')).toBe(true);
  });

  it('does not match tools that are not listed, or partial names', () => {
    expect(isToolSkipped('Bash', 'Read,TodoWrite')).toBe(false);
    expect(isToolSkipped('Rea', 'Read')).toBe(false);
  });

  it('skips nothing for an empty or missing setting', () => {
    expect(isToolSkipped('Read', '')).toBe(false);
    expect(isToolSkipped('Read', ' , ,')).toBe(false);
    expect(isToolSkipped('Read', undefined)).toBe(false);
  });

  it('matches an actual native name without inventing aliases for other calls', () => {
    expect(isToolSkipped('apply_patch', ' PATCH ', 'patch')).toBe(true);
    expect(isToolSkipped('Bash', 'shell', 'shell')).toBe(true);
    expect(isToolSkipped('Bash', 'shell')).toBe(false);
    expect(isToolSkipped('mcp__corp__github__search', 'search', 'search')).toBe(true);
    expect(isToolSkipped('mcp__corp__github__search', 'github__search', 'search')).toBe(false);
  });

  it('keeps qualified MCP exclusions scoped to the full tool name', () => {
    expect(isToolSkipped('mcp__docs__mcp__github__search', 'mcp__github__search', 'mcp__github__search')).toBe(false);
    expect(isToolSkipped('mcp__github__search', 'MCP__GITHUB__SEARCH', 'search')).toBe(true);
  });

  it('ignores non-string optional names from older passthrough envelopes', () => {
    expect(isToolSkipped('Bash', 'shell', 42 as never)).toBe(false);
    expect(isToolSkipped('Bash', 'bash', 42 as never)).toBe(true);
  });
});

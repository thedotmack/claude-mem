import { expect } from 'bun:test';

export function expectSafeMcpToolNames(tools: Iterable<{ name: string }>): void {
  const names = Array.from(tools, tool => tool.name);
  expect(names.length).toBeGreaterThan(5);
  for (const name of names) {
    expect(name).not.toContain(':');
    expect(name).not.toContain('.');
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(name).toMatch(/^[a-zA-Z0-9]/);
    expect(('mcp__plugin_claude-mem_mcp-search__' + name).length).toBeLessThanOrEqual(64);
  }
}

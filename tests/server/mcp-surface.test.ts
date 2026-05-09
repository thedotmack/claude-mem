import { describe, expect, it } from 'bun:test';
import { getServerMcpSurface } from '../../src/server/mcp/register.js';

describe('server MCP surface', () => {
  it('declares memory tools with concrete input schemas', () => {
    const surface = getServerMcpSurface();
    const names = surface.tools.map(tool => tool.name);

    expect(names).toEqual([
      'memory_add',
      'memory_search',
      'memory_context',
      'memory_forget',
      'memory_list_recent',
      'memory_record_decision',
    ]);

    for (const tool of surface.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties).length).toBeGreaterThan(0);
      expect(tool.inputSchema.required?.length).toBeGreaterThan(0);
    }
  });

  it('keeps resources and prompts available without Bun-only imports', () => {
    const surface = getServerMcpSurface();

    expect(surface.resources[0].uri).toStartWith('claude-mem://server/');
    expect(surface.prompts[0].name).toBe('record_decision');
  });
});

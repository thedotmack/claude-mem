import { describe, expect, it } from 'bun:test';
import { memoryOptions, memoryPermission } from '../../examples/claude-agent-sdk/memory.js';

describe('Claude Agent SDK memory example', () => {
  it('binds every operation, including ID reads, to the selected project', () => {
    for (const [tool, input] of [['save_memory', { text: 'synthetic' }], ['search', { query: 'fixture' }], ['timeline', { anchor: 1 }], ['get_observations', { ids: [1] }]] as const) {
      const result = memoryPermission('fixture ', `mcp__claude-mem__${tool}`, input);
      expect(result).toMatchObject({ behavior: 'allow', updatedInput: { project: 'fixture ' } });
    }
  });
  it('rejects alternate project forms and other tools', () => {
    for (const input of [{ project: 'other' }, { projects: ['other'] }, { projectId: 'other' }]) {
      expect(memoryPermission('fixture', 'mcp__claude-mem__search', input).behavior).toBe('deny');
    }
    for (const tool of ['Bash', 'mcp__claude-mem__get_tool_uses', 'mcp__claude-mem__constructor']) {
      expect(memoryPermission('fixture', tool, {}).behavior).toBe('deny');
    }
  });
  it('drops model-supplied routing fields outside each tool contract', () => {
    expect(memoryPermission('fixture', 'mcp__claude-mem__get_observations', { ids: [1], cwd: '/other', limit: 100 }))
      .toEqual({ behavior: 'allow', updatedInput: { ids: [1], project: 'fixture' } });
  });
  it('does not load user configuration or auto-approve past the project check', () => {
    const options = memoryOptions('fixture', '/bundle/mcp-server.cjs');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.settings).toEqual({ permissions: { ask: ['mcp__claude-mem__*'] } });
  });
});

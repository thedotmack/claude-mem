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
      .toEqual({ behavior: 'allow', updatedInput: { ids: [1], project: 'fixture', projects: '["fixture"]' } });
  });
  it('pins reads to a one-project JSON list so a worktree cannot widen them', () => {
    for (const [tool, input] of [['search', { query: 'fixture' }], ['timeline', { anchor: 1 }], ['get_observations', { ids: [1] }]] as const) {
      const result = memoryPermission('a, b', `mcp__claude-mem__${tool}`, input);
      expect(result).toMatchObject({ behavior: 'allow', updatedInput: { project: 'a, b', projects: '["a, b"]' } });
    }
  });
  it('sends saves with the project only', () => {
    expect(memoryPermission('fixture', 'mcp__claude-mem__save_memory', { text: 'synthetic', title: 't' }))
      .toEqual({ behavior: 'allow', updatedInput: { text: 'synthetic', title: 't', project: 'fixture' } });
  });
  it('does not load user configuration or auto-approve past the project check', () => {
    const options = memoryOptions('fixture', '/bundle/mcp-server.cjs');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.settings).toEqual({ permissions: { ask: ['mcp__claude-mem__*'] } });
  });
  it('defaults to the haiku alias, never a dated model ID', () => {
    const saved = process.env.CLAUDE_MEM_EXAMPLE_MODEL;
    delete process.env.CLAUDE_MEM_EXAMPLE_MODEL;
    try {
      expect(memoryOptions('fixture', '/bundle/mcp-server.cjs').model).toBe('haiku');
    } finally {
      if (saved !== undefined) process.env.CLAUDE_MEM_EXAMPLE_MODEL = saved;
    }
  });
});

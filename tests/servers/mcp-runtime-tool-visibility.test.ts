import { describe, it, expect } from 'bun:test';
import {
  getAdvertisedMcpToolsForRuntime,
  SERVER_BETA_ONLY_TOOL_NAMES,
  WORKER_ONLY_TOOL_NAMES,
} from '../../src/servers/mcp-tool-visibility.js';

const allTools = [
  { name: 'search', description: '', inputSchema: {} },
  { name: 'timeline', description: '', inputSchema: {} },
  { name: 'get_observations', description: '', inputSchema: {} },
  { name: 'observation_add', description: '', inputSchema: {} },
  { name: 'observation_record_event', description: '', inputSchema: {} },
  { name: 'observation_search', description: '', inputSchema: {} },
  { name: 'observation_context', description: '', inputSchema: {} },
  { name: 'observation_generation_status', description: '', inputSchema: {} },
  { name: 'memory_add', description: '', inputSchema: {} },
  { name: 'memory_search', description: '', inputSchema: {} },
  { name: 'memory_context', description: '', inputSchema: {} },
  { name: 'smart_search', description: '', inputSchema: {} },
  { name: 'get_tool_uses', description: '', inputSchema: {} },
  { name: 'save_memory', description: '', inputSchema: {} },
  { name: 'dumb_search', description: '', inputSchema: {} },
  { name: 'work_state_write', description: '', inputSchema: {} },
  { name: 'work_state_read', description: '', inputSchema: {} },
  { name: 'team_brief', description: '', inputSchema: {} },
  { name: 'team_search', description: '', inputSchema: {} },
];

describe('MCP runtime-aware tool visibility', () => {
  it('base-fails/head-passes: worker hides server-beta-only tool names', () => {
    const workerTools = getAdvertisedMcpToolsForRuntime(allTools, 'worker');
    const names = new Set(workerTools.map(tool => tool.name));

    for (const toolName of SERVER_BETA_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(false);
    }
  });

  it('base-fails/head-passes: server runtime keeps server-beta-only tool names', () => {
    const serverTools = getAdvertisedMcpToolsForRuntime(allTools, 'server');
    const names = new Set(serverTools.map(tool => tool.name));

    for (const toolName of SERVER_BETA_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(true);
    }
  });

  it('server runtime hides worker-only tools that always refuse it', () => {
    const names = new Set(getAdvertisedMcpToolsForRuntime(allTools, 'server').map(tool => tool.name));

    for (const toolName of WORKER_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(false);
    }
    expect(names.has('search')).toBe(true);
    expect(names.has('observation_search')).toBe(true);
    expect(names.has('save_memory')).toBe(false);
    expect(names.has('get_tool_uses')).toBe(false);
  });

  it('worker runtime keeps worker-only tools', () => {
    const names = new Set(getAdvertisedMcpToolsForRuntime(allTools, 'worker').map(tool => tool.name));

    for (const toolName of WORKER_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(true);
    }
  });

  it('worker runtime still advertises core MCP worker tools', () => {
    const workerTools = getAdvertisedMcpToolsForRuntime(allTools, 'worker');
    const names = new Set(workerTools.map(tool => tool.name));

    expect(names.has('search')).toBe(true);
    expect(names.has('timeline')).toBe(true);
    expect(names.has('get_observations')).toBe(true);
    expect(names.has('smart_search')).toBe(true);
  });

});

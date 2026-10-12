import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAdvertisedMcpToolsForRuntime,
  SERVER_BETA_ONLY_TOOL_NAMES,
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

  it('worker runtime still advertises core MCP worker tools', () => {
    const workerTools = getAdvertisedMcpToolsForRuntime(allTools, 'worker');
    const names = new Set(workerTools.map(tool => tool.name));

    expect(names.has('search')).toBe(true);
    expect(names.has('timeline')).toBe(true);
    expect(names.has('get_observations')).toBe(true);
    expect(names.has('smart_search')).toBe(true);
  });

  it('tools/list path references the helper so discovery is runtime-aware', () => {
    const mcpServerPath = join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts');
    const mcpServerSrc = readFileSync(mcpServerPath, 'utf-8');

    expect(mcpServerSrc).toContain('getAdvertisedMcpToolsForRuntime(tools, selectRuntime())');
    expect(mcpServerSrc).not.toContain('tools.map(tool => ({');
  });
});

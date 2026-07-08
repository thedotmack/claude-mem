import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAdvertisedMcpToolsForRuntime,
  SERVER_RUNTIME_ONLY_TOOL_NAMES,
  WORKER_RUNTIME_ONLY_TOOL_NAMES,
} from '../../src/servers/mcp-tool-visibility.js';

const allTools = [
  { name: 'search', description: '', inputSchema: {} },
  { name: 'timeline', description: '', inputSchema: {} },
  { name: 'get_observations', description: '', inputSchema: {} },
  { name: 'memory_save', description: '', inputSchema: {} },
  { name: 'observation_add', description: '', inputSchema: {} },
  { name: 'observation_record_event', description: '', inputSchema: {} },
  { name: 'observation_search', description: '', inputSchema: {} },
  { name: 'observation_context', description: '', inputSchema: {} },
  { name: 'observation_generation_status', description: '', inputSchema: {} },
  { name: 'smart_search', description: '', inputSchema: {} },
];

describe('MCP runtime-aware tool visibility', () => {
  it('worker runtime hides server-runtime-only tool names', () => {
    const workerTools = getAdvertisedMcpToolsForRuntime(allTools, 'worker');
    const names = new Set(workerTools.map(tool => tool.name));

    for (const toolName of SERVER_RUNTIME_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(false);
    }
  });

  it('server runtime keeps server-runtime-only tools and hides worker-only tools', () => {
    const serverTools = getAdvertisedMcpToolsForRuntime(allTools, 'server');
    const names = new Set(serverTools.map(tool => tool.name));

    for (const toolName of SERVER_RUNTIME_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(true);
    }
    for (const toolName of WORKER_RUNTIME_ONLY_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(false);
    }
  });

  it('worker runtime still advertises core worker tools and memory_save', () => {
    const workerTools = getAdvertisedMcpToolsForRuntime(allTools, 'worker');
    const names = new Set(workerTools.map(tool => tool.name));

    expect(names.has('search')).toBe(true);
    expect(names.has('timeline')).toBe(true);
    expect(names.has('get_observations')).toBe(true);
    expect(names.has('memory_save')).toBe(true);
    expect(names.has('smart_search')).toBe(true);
  });

  it('tools/list path uses runtime-aware advertised tools', () => {
    const mcpServerPath = join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts');
    const mcpServerSrc = readFileSync(mcpServerPath, 'utf-8');

    expect(mcpServerSrc).toContain('getAdvertisedMcpToolsForRuntime(tools, selectRuntime())');
    expect(mcpServerSrc).toContain('advertisedTools.map(tool => ({');
  });
});

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAdvertisedMcpToolsForRuntime,
  SERVER_BETA_ONLY_TOOL_NAMES,
  withoutDisabledWorkStateTools,
  WORK_STATE_TOOL_NAMES,
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
  { name: 'work_state_write', description: '', inputSchema: {} },
  { name: 'work_state_read', description: '', inputSchema: {} },
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

  it('hides the work_state tools when CLAUDE_MEM_WORK_STATE_ENABLED=false (#4606)', () => {
    const names = new Set(withoutDisabledWorkStateTools(getAdvertisedMcpToolsForRuntime(allTools, 'worker'), false).map(tool => tool.name));

    for (const toolName of WORK_STATE_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(false);
    }
    expect(names.has('search')).toBe(true);
    expect(names.has('smart_search')).toBe(true);
  });

  it('keeps the work_state tools while work state is on', () => {
    const names = new Set(withoutDisabledWorkStateTools(getAdvertisedMcpToolsForRuntime(allTools, 'worker'), true).map(tool => tool.name));

    for (const toolName of WORK_STATE_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(true);
    }
  });

  it('tools/list and tools/call honor the work-state switch', () => {
    const mcpServerPath = join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts');
    const mcpServerSrc = readFileSync(mcpServerPath, 'utf-8');

    expect(mcpServerSrc).toContain('withoutDisabledWorkStateTools(');
    expect(mcpServerSrc).toContain('Work state is turned off (CLAUDE_MEM_WORK_STATE_ENABLED=false).');
  });
});

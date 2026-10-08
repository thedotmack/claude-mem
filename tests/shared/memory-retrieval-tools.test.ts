import { describe, expect, it } from 'bun:test';
import { isRecursiveMemoryTool, isExplicitMemoryWrite } from '../../src/shared/memory-retrieval-tools.js';
import { observationHandler } from '../../src/cli/handlers/observation.js';

describe('claude-mem retrieval and explicit note classifiers', () => {
  it('excludes normalized MCP retrieval names and native mem_search', () => {
    for (const name of ['mem_search', 'get_summaries', 'mcp__mcp_search__mem_search', 'mcp__mcp-search__get_observations', 'mcp__plugin_claude-mem_mcp-search__mem_search', 'mcp__claude_mem_remote__get_summaries']) {
      expect(isRecursiveMemoryTool(name)).toBe(true);
      expect(isExplicitMemoryWrite(name)).toBe(false);
    }
  });
  it('keeps unrelated search tools and explicit writes out of the retrieval gate', () => {
    for (const name of ['search', 'mcp__notion__search', 'mcp__other__mem_search', 'save_memory', 'mcp__mcp_search__save_memory']) expect(isRecursiveMemoryTool(name)).toBe(false);
    for (const name of ['save_memory', 'mcp__mcp_search__save_memory']) expect(isExplicitMemoryWrite(name)).toBe(true);
    expect(isExplicitMemoryWrite('mcp__other__save_memory')).toBe(false);
  });
  it('drops retrieval hooks before any spool, runtime request or input logging', async () => {
    const result = await observationHandler.execute({ sessionId: 'memory-read-fixture', cwd: '', toolName: 'mcp__mcp_search__mem_search', toolInput: { continuation: 'signed-memory-index' } });
    expect(result).toMatchObject({ continue: true, suppressOutput: true, exitCode: 0 });
  });
});

import { describe, expect, it, spyOn } from 'bun:test';
import { geminiAdapter } from '../../../src/cli/adapters/gemini.js';
import { getPlatformAdapter } from '../../../src/cli/adapters/index.js';
import { isRecursiveMemoryTool } from '../../../src/shared/memory-retrieval-tools.js';
import { observationHandler } from '../../../src/cli/handlers/observation.js';
import { HOOK_EXIT_CODES } from '../../../src/shared/hook-constants.js';
import { logger } from '../../../src/utils/logger.js';

const base = { session_id: 'gemini-session', cwd: '/synthetic/project', transcript_path: '/synthetic/session.jsonl' };
describe('Gemini CLI 0.44.1 hook contract', () => {
  it('selects a dedicated adapter and keeps host session/project identity', () => {
    expect(getPlatformAdapter('gemini')).toBe(geminiAdapter);
    expect(geminiAdapter.normalizeInput({ ...base, hook_event_name: 'SessionStart', source: 'resume' }))
      .toMatchObject({ sessionId: base.session_id, cwd: base.cwd, platform: 'gemini', sessionSource: 'resume' });
  });
  it('maps prompt and final response directly without reading another host transcript', () => {
    expect(geminiAdapter.normalizeInput({ ...base, hook_event_name: 'BeforeAgent', prompt: 'Synthetic prompt' }).prompt).toBe('Synthetic prompt');
    expect(geminiAdapter.normalizeInput({ ...base, hook_event_name: 'AfterAgent', prompt_response: 'Synthetic answer' }).lastAssistantMessage).toBe('Synthetic answer');
  });
  it('preserves native tool evidence and does not invent a receipt ID', () => {
    const input = { file_path: '/synthetic/project/fixture.txt' };
    const response = { llmContent: 'Synthetic file content', returnDisplay: '' };
    const normalized = geminiAdapter.normalizeInput({ ...base, hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: input, tool_response: response });
    expect(normalized).toMatchObject({ toolName: 'Read', toolInput: input, toolResponse: response });
    expect(normalized.toolUseId).toBeUndefined();
    expect(geminiAdapter.normalizeInput({ ...base, tool_name: 'run_shell_command', tool_input: { command: 'echo synthetic' } }).toolName).toBe('Bash');
  });
  it('preserves failed tool results and filters recursive memory tools', () => {
    const response = { error: { message: 'synthetic missing file' }, llmContent: 'missing' };
    expect(geminiAdapter.normalizeInput({ ...base, tool_response: response }).toolResponse).toEqual(response);
    const memory = geminiAdapter.normalizeInput({ ...base, tool_name: 'mcp_claude-mem_search' });
    expect(isRecursiveMemoryTool(memory.toolName!)).toBe(true);
  });
  it('rejects missing identity rather than mixing sessions', () => {
    expect(() => geminiAdapter.normalizeInput({ cwd: base.cwd })).toThrow('missing_session_id');
    expect(() => geminiAdapter.normalizeInput({ session_id: 'session' })).toThrow('invalid_cwd');
  });
  it('emits context without Gemini flow-control or retry fields', () => {
    expect(geminiAdapter.formatOutput({ continue: false, decision: 'block', exitCode: 2, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Saved memory' } }))
      .toEqual({ hookSpecificOutput: { additionalContext: 'Saved memory' } });
    expect(geminiAdapter.formatOutput({ continue: true, suppressOutput: true })).toEqual({});
  });
  it('treats CMEM Pro and other claude-mem recall servers as memory tools, not new work', () => {
    const cases: Array<[string, string]> = [
      ['mcp_cmem_memory_search', 'mcp__cmem__memory_search'],
      ['mcp_claude_mem_timeline', 'mcp__claude_mem__timeline'],
      ['mcp_mcp-search_get_observations', 'mcp__mcp-search__get_observations'],
    ];
    for (const [native, expected] of cases) {
      const toolName = geminiAdapter.normalizeInput({ ...base, hook_event_name: 'AfterTool', tool_name: native }).toolName!;
      expect(toolName).toBe(expected);
      expect(isRecursiveMemoryTool(toolName)).toBe(true);
    }
    expect(geminiAdapter.normalizeInput({ ...base, tool_name: 'mcp_github_search' }).toolName).toBe('mcp_github_search');
  });
  it('shows the session-start message in Gemini without terminal escape codes', () => {
    expect(geminiAdapter.formatOutput({ continue: true, systemMessage: '\u001b[2mViewer: http://localhost:37777\u001b[0m' }))
      .toEqual({ systemMessage: 'Viewer: http://localhost:37777' });
  });
});

describe('Gemini CLI observation handling', () => {
  it('drops a CMEM Pro recall result before anything is logged or sent', async () => {
    const dataIn = spyOn(logger, 'dataIn').mockImplementation(() => {});
    try {
      const input = geminiAdapter.normalizeInput({ ...base, hook_event_name: 'AfterTool', tool_name: 'mcp_cmem_memory_search', tool_input: { query: 'x' }, tool_response: { llmContent: 'saved memory' } });
      const result = await observationHandler.execute(input);
      expect(result).toEqual({ continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS });
      expect(dataIn).not.toHaveBeenCalled();
    } finally {
      dataIn.mockRestore();
    }
  });
});

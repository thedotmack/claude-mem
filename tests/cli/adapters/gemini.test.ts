import { describe, expect, it } from 'bun:test';
import { geminiAdapter } from '../../../src/cli/adapters/gemini.js';
import { getPlatformAdapter } from '../../../src/cli/adapters/index.js';
import { isRecursiveMemoryTool } from '../../../src/shared/memory-retrieval-tools.js';

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
});

import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — Grok Build camelCase', () => {
  const base = { sessionId: 's1', cwd: '/tmp' };

  it('reads camelCase fields when snake_case is absent', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      ...base,
      userPrompt: 'hello',
      toolName: 'read_file',
      toolInput: { target_file: 'C:/src/a.ts' },
      toolResult: { ok: true },
      toolUseId: 'tu1',
      transcriptPath: 'C:/t.jsonl',
      lastAssistantMessage: 'done',
      stopHookActive: true,
      agentId: 'agent-1',
      agentType: 'general',
    });
    expect(normalized.sessionId).toBe('s1');
    expect(normalized.prompt).toBe('hello');
    expect(normalized.toolName).toBe('read_file');
    expect(normalized.toolInput).toEqual({ target_file: 'C:/src/a.ts', file_path: 'C:/src/a.ts' });
    expect(normalized.toolResponse).toEqual({ ok: true });
    expect(normalized.toolUseId).toBe('tu1');
    expect(normalized.transcriptPath).toBe('C:/t.jsonl');
    expect(normalized.lastAssistantMessage).toBe('done');
    expect(normalized.stopHookActive).toBeUndefined();
    expect(normalized.agentId).toBe('agent-1');
    expect(normalized.agentType).toBe('general');
  });

  it('keeps a non-empty snake_case value ahead of camelCase', () => {
    const toolInput = { file_path: 'snake.ts', target_file: 'other.ts' };
    const normalized = claudeCodeAdapter.normalizeInput({
      session_id: 'snake',
      sessionId: 'camel',
      cwd: '/tmp',
      prompt: 'snake-prompt',
      userPrompt: 'camel-prompt',
      tool_name: 'Read',
      toolName: 'read_file',
      tool_input: toolInput,
      toolInput: { target_file: 'camel.ts' },
      tool_response: 'snake-out',
      toolResult: 'camel-out',
      tool_use_id: 'snake-id',
      toolUseId: 'camel-id',
      transcript_path: 'snake.jsonl',
      transcriptPath: 'camel.jsonl',
      last_assistant_message: 'snake-last',
      lastAssistantMessage: 'camel-last',
      stop_hook_active: false,
      stopHookActive: true,
      agent_id: 'snake-agent',
      agentId: 'camel-agent',
      agent_type: 'snake-type',
      subagentType: 'camel-type',
    });
    expect(normalized.sessionId).toBe('snake');
    expect(normalized.prompt).toBe('snake-prompt');
    expect(normalized.toolName).toBe('Read');
    expect(normalized.toolInput).toBe(toolInput);
    expect(normalized.toolResponse).toBe('snake-out');
    expect(normalized.toolUseId).toBe('snake-id');
    expect(normalized.transcriptPath).toBe('snake.jsonl');
    expect(normalized.lastAssistantMessage).toBe('snake-last');
    expect(normalized.stopHookActive).toBeUndefined();
    expect(normalized.agentId).toBe('snake-agent');
    expect(normalized.agentType).toBe('snake-type');
  });

  it('falls through an empty snake string and copies filePath or path onto file_path', () => {
    const fromFilePath = claudeCodeAdapter.normalizeInput({
      ...base,
      tool_name: '',
      toolName: 'read_file',
      tool_input: { file_path: '', filePath: 'from-camel.ts' },
    });
    expect(fromFilePath.toolName).toBe('read_file');
    expect(fromFilePath.toolInput).toEqual({ file_path: 'from-camel.ts', filePath: 'from-camel.ts' });

    const fromPath = claudeCodeAdapter.normalizeInput({
      ...base,
      toolInput: { path: 'from-path.ts' },
    });
    expect(fromPath.toolInput).toEqual({ path: 'from-path.ts', file_path: 'from-path.ts' });
  });

  it('ignores stopHookActive so a blocked stop cannot drop later summaries', () => {
    expect(claudeCodeAdapter.normalizeInput({ ...base, stopHookActive: true }).stopHookActive).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput({ ...base, stopHookActive: false }).stopHookActive).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput({ ...base, stopHookActive: 'yes' }).stopHookActive).toBeUndefined();
  });

  it('uses subagentType when agent_type and agentType are absent', () => {
    expect(claudeCodeAdapter.normalizeInput({ ...base, subagentType: 'explore' }).agentType).toBe('explore');
  });

  it('does not mutate the caller tool input when copying a read path', () => {
    const toolInput = { target_file: 'a.ts' };
    const normalized = claudeCodeAdapter.normalizeInput({ ...base, toolInput });
    expect(toolInput).toEqual({ target_file: 'a.ts' });
    expect(normalized.toolInput).not.toBe(toolInput);
  });
});

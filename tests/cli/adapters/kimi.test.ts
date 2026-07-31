import { describe, it, expect } from 'bun:test';
import { kimiAdapter } from '../../../src/cli/adapters/kimi.js';
import { getPlatformAdapter } from '../../../src/cli/adapters/index.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

describe('kimiAdapter registration', () => {
  it('resolves via the platform registry for kimi and kimi-code', () => {
    expect(getPlatformAdapter('kimi')).toBe(kimiAdapter);
    expect(getPlatformAdapter('kimi-code')).toBe(kimiAdapter);
  });
});

describe('kimiAdapter.normalizeInput', () => {
  it('normalizes a SessionStart payload (source: startup)', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'SessionStart',
      session_id: 'kimi-s1',
      cwd: '/tmp',
      source: 'startup',
      transcript_path: '/tmp/transcript.jsonl',
      model: 'kimi-for-coding',
    });

    expect(normalized.sessionId).toBe('kimi-s1');
    expect(normalized.cwd).toBe('/tmp');
    expect(normalized.sessionSource).toBe('startup');
    expect(normalized.transcriptPath).toBe('/tmp/transcript.jsonl');
    expect(normalized.model).toBe('kimi-for-coding');
  });

  it('normalizes a SessionStart resume payload', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'SessionStart',
      session_id: 'kimi-s2',
      cwd: '/tmp',
      source: 'resume',
    });

    expect(normalized.sessionSource).toBe('resume');
  });

  it('drops unknown SessionStart source values', () => {
    const normalized = kimiAdapter.normalizeInput({
      session_id: 'kimi-s3',
      cwd: '/tmp',
      source: 'weird',
    });

    expect(normalized.sessionSource).toBeUndefined();
  });

  it('normalizes a UserPromptSubmit payload', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'kimi-s4',
      cwd: '/tmp',
      prompt: 'fix the flaky test',
      permission_mode: 'default',
    });

    expect(normalized.prompt).toBe('fix the flaky test');
    expect(normalized.permissionMode).toBe('default');
  });

  it('joins Kimi content-block array prompts into plain text', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'kimi-s4b',
      cwd: '/tmp',
      prompt: [
        { type: 'text', text: 'привет,' },
        { type: 'image', data: '…' },
        { type: 'text', text: 'создай модуль reminders' },
      ],
    });

    expect(normalized.prompt).toBe('привет,\nсоздай модуль reminders');
  });

  it('treats a blocks array with no text as an absent prompt', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'kimi-s4c',
      cwd: '/tmp',
      prompt: [{ type: 'image', data: '…' }],
    });

    expect(normalized.prompt).toBeUndefined();
  });

  it('normalizes a PreToolUse (Read) payload', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'PreToolUse',
      session_id: 'kimi-s5',
      cwd: '/tmp',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.ts' },
    });

    expect(normalized.toolName).toBe('Read');
    expect(normalized.toolInput).toEqual({ file_path: '/tmp/a.ts' });
  });

  it('normalizes a PostToolUse payload', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'PostToolUse',
      session_id: 'kimi-s6',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'ok' },
    });

    expect(normalized.toolName).toBe('Bash');
    expect(normalized.toolResponse).toEqual({ stdout: 'ok' });
  });

  it('normalizes a Stop payload', () => {
    const normalized = kimiAdapter.normalizeInput({
      hook_event_name: 'Stop',
      session_id: 'kimi-s7',
      cwd: '/tmp',
      last_assistant_message: 'done',
      stop_hook_active: true,
    });

    expect(normalized.lastAssistantMessage).toBe('done');
    expect(normalized.stopHookActive).toBe(true);
  });

  it('tolerates missing optional fields', () => {
    const normalized = kimiAdapter.normalizeInput({
      session_id: 'kimi-s8',
      cwd: '/tmp',
    });

    expect(normalized.prompt).toBeUndefined();
    expect(normalized.toolName).toBeUndefined();
    expect(normalized.toolInput).toBeUndefined();
    expect(normalized.toolResponse).toBeUndefined();
    expect(normalized.sessionSource).toBeUndefined();
    expect(normalized.stopHookActive).toBeUndefined();
  });

  it('accepts claude-style fallback session id fields', () => {
    expect(kimiAdapter.normalizeInput({ id: 'x1', cwd: '/tmp' }).sessionId).toBe('x1');
    expect(kimiAdapter.normalizeInput({ sessionId: 'x2', cwd: '/tmp' }).sessionId).toBe('x2');
  });

  it('rejects an invalid cwd', () => {
    expect(() => kimiAdapter.normalizeInput({ session_id: 's', cwd: '' })).toThrow(AdapterRejectedInput);
  });

  it('falls back to process.cwd() when cwd is not a string', () => {
    const normalized = kimiAdapter.normalizeInput({ session_id: 's', cwd: 42 });
    expect(normalized.cwd).toBe(process.cwd());
  });

  it('rejects over-long agent fields but accepts valid ones', () => {
    const normalized = kimiAdapter.normalizeInput({
      session_id: 's',
      cwd: '/tmp',
      agent_id: 'agent-1',
      agent_type: 'x'.repeat(200),
    });

    expect(normalized.agentId).toBe('agent-1');
    expect(normalized.agentType).toBeUndefined();
  });
});

describe('kimiAdapter.formatOutput', () => {
  it('emits additionalContext as plain text (Kimi appends stdout verbatim)', () => {
    const output = kimiAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '## Memory\nstuff' },
    });

    expect(output).toBe('## Memory\nstuff');
  });

  it('stays silent on no-op results — Kimi has no envelope support, so {} would be context noise', () => {
    // Kimi's userPromptHookMessage skips empty stdout; a printed `{}` would be
    // injected as literal text. systemMessage is Claude-only and dropped too.
    expect(kimiAdapter.formatOutput({ continue: true, suppressOutput: true })).toBe('');
    expect(kimiAdapter.formatOutput({ systemMessage: 'hi' })).toBe('');
    expect(
      kimiAdapter.formatOutput({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        systemMessage: 'worker started',
      }),
    ).toBe('');
  });
});

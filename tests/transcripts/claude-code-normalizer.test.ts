import { describe, it, expect } from 'bun:test';
import { normalizeClaudeCodeLine, CLAUDE_CODE_SCHEMA } from '../../src/services/transcripts/claude-code.js';
import { matchesRule } from '../../src/services/transcripts/field-utils.js';

// #2690: the generic schema DSL cannot fan out content-block arrays, so the
// Claude Code normalizer flattens each JSONL line into one synthetic event per
// block. These tests pin that fan-out and the schema routing.
describe('normalizeClaudeCodeLine', () => {
  it('maps a string user message to a single user_prompt', () => {
    const events = normalizeClaudeCodeLine({
      type: 'user',
      sessionId: 's1',
      cwd: '/repo',
      timestamp: '2026-05-04T00:00:00Z',
      message: { role: 'user', content: 'hello there' },
    });
    expect(events).toEqual([
      { __cc: 'user_prompt', sessionId: 's1', cwd: '/repo', ts: '2026-05-04T00:00:00Z', prompt: 'hello there' },
    ]);
  });

  it('maps a string assistant message to a single assistant_text', () => {
    const events = normalizeClaudeCodeLine({
      type: 'assistant',
      sessionId: 's1',
      message: { role: 'assistant', content: 'sure, here you go' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].__cc).toBe('assistant_text');
    expect(events[0].message).toBe('sure, here you go');
  });

  it('fans out an assistant line with text + multiple tool_use blocks', () => {
    const events = normalizeClaudeCodeLine({
      type: 'assistant',
      sessionId: 's1',
      cwd: '/repo',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check two things' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(events.map(e => e.__cc)).toEqual(['assistant_text', 'tool_use', 'tool_use']);
    expect(events[1]).toMatchObject({ toolId: 't1', toolName: 'Read', toolInput: { file_path: '/a' } });
    expect(events[2]).toMatchObject({ toolId: 't2', toolName: 'Bash', toolInput: { command: 'ls' } });
  });

  it('fans out a user line carrying tool_result blocks (no spurious prompt)', () => {
    const events = normalizeClaudeCodeLine({
      type: 'user',
      sessionId: 's1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
          { type: 'tool_result', tool_use_id: 't2', content: 'a\nb' },
        ],
      },
    });
    expect(events.map(e => e.__cc)).toEqual(['tool_result', 'tool_result']);
    expect(events[0]).toMatchObject({ toolId: 't1', toolResponse: 'file contents' });
    // critically, no user_prompt was synthesized for a tool-result-only line
    expect(events.some(e => e.__cc === 'user_prompt')).toBe(false);
  });

  it('ignores non-conversational line types and empty content', () => {
    expect(normalizeClaudeCodeLine({ type: 'permission-mode', permissionMode: 'default' })).toEqual([]);
    expect(normalizeClaudeCodeLine({ type: 'file-history-snapshot' })).toEqual([]);
    expect(normalizeClaudeCodeLine({ type: 'attachment' })).toEqual([]);
    expect(normalizeClaudeCodeLine({ type: 'system' })).toEqual([]);
    expect(normalizeClaudeCodeLine({ type: 'user', message: { content: '   ' } })).toEqual([]);
    expect(normalizeClaudeCodeLine(null)).toEqual([]);
    expect(normalizeClaudeCodeLine('not an object')).toEqual([]);
  });

  it('skips unknown block types (thinking/image) but keeps siblings', () => {
    const events = normalizeClaudeCodeLine({
      type: 'assistant',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'done' },
        ],
      },
    });
    expect(events.map(e => e.__cc)).toEqual(['assistant_text']);
  });
});

describe('CLAUDE_CODE_SCHEMA routing', () => {
  // Each flat event must match exactly one schema event, routing to the right action.
  const route = (cc: string) =>
    CLAUDE_CODE_SCHEMA.events.filter(ev => matchesRule({ __cc: cc }, ev.match, CLAUDE_CODE_SCHEMA));

  it('routes each synthetic type to a single, correct action', () => {
    expect(route('user_prompt').map(e => e.action)).toEqual(['session_init']);
    expect(route('assistant_text').map(e => e.action)).toEqual(['assistant_message']);
    expect(route('tool_use').map(e => e.action)).toEqual(['tool_use']);
    expect(route('tool_result').map(e => e.action)).toEqual(['tool_result']);
  });

  it('is keyed on __cc so foreign lines never match', () => {
    expect(route('something_else')).toHaveLength(0);
  });
});

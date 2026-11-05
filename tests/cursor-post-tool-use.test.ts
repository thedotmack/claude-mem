import { describe, expect, it } from 'bun:test';
import { cursorAdapter } from '../src/cli/adapters/cursor.js';

// Cursor's generic postToolUse event carries tool_output where the per-tool
// hooks carry result_json, and postToolUseFailure carries error_message. Without
// them a read, a search or a failed call reached claude-mem with no result at
// all (#5371).
describe('cursorAdapter: postToolUse payloads', () => {
  const base = { conversation_id: 'conv-1', cwd: process.cwd() };

  it('carries tool_output from postToolUse', () => {
    const normalized = cursorAdapter.normalizeInput({
      ...base,
      tool_name: 'Grep',
      tool_input: { pattern: 'needle', path: 'src' },
      tool_output: '{"matches":3}',
      tool_use_id: 'call-1',
    } as any);

    expect(normalized.toolName).toBe('Grep');
    expect(normalized.toolResponse).toBe('{"matches":3}');
    expect(normalized.toolUseId).toBe('call-1');
  });

  it('marks a failed call as an error instead of a result', () => {
    const normalized = cursorAdapter.normalizeInput({
      ...base,
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.ts', content: 'x' },
      error_message: 'permission denied',
    } as any);

    expect(normalized.toolResponse).toEqual({ is_error: true, error: 'permission denied' });
  });

  it('keeps result_json from the per-tool hooks ahead of tool_output', () => {
    const normalized = cursorAdapter.normalizeInput({
      ...base,
      tool_name: 'Read',
      tool_input: { file_path: 'src/a.ts' },
      result_json: '{"ok":true}',
      tool_output: '{"ignored":true}',
    } as any);

    expect(normalized.toolResponse).toBe('{"ok":true}');
  });
});

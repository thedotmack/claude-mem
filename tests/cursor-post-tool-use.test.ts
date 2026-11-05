import { describe, expect, it } from 'bun:test';
import { cursorAdapter } from '../src/cli/adapters/cursor.js';
import { extractObservationFileEvidence } from '../src/services/worker/agents/ResponseProcessor.js';
import { stripMemoryTags } from '../src/utils/tag-stripping.js';

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

// The shape a Cursor postToolUseFailure call actually reaches the evidence
// extractor in: adapter output, then the worker ingest's
// stripMemoryTags(JSON.stringify(...)) (src/services/worker/http/shared.ts),
// stored as text on the pending message.
describe('Cursor postToolUseFailure through the ingest shape', () => {
  const base = { conversation_id: 'conv-1', cwd: process.cwd() };
  const asStoredMessage = (raw: Record<string, unknown>) => {
    const normalized = cursorAdapter.normalizeInput({ ...base, ...raw } as any);
    return {
      type: 'observation' as const,
      tool_name: normalized.toolName,
      tool_input: stripMemoryTags(JSON.stringify(normalized.toolInput)),
      tool_response: normalized.toolResponse !== undefined
        ? stripMemoryTags(JSON.stringify(normalized.toolResponse))
        : '{}',
    };
  };

  it('records no files_modified for a failed Write', () => {
    const evidence = extractObservationFileEvidence([asStoredMessage({
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.ts', content: 'x' },
      error_message: 'permission denied',
      failure_type: 'permission_denied',
    })] as any);

    expect(evidence.files_modified).toEqual([]);
  });

  it('records files_read for a successful Read', () => {
    const evidence = extractObservationFileEvidence([asStoredMessage({
      tool_name: 'Read',
      tool_input: { file_path: 'src/a.ts' },
      tool_output: '{"content":"x"}',
    })] as any);

    expect(evidence.files_read).toEqual(['src/a.ts']);
  });
});

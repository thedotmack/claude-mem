import { describe, expect, it } from 'bun:test';
import { extractObservationFileEvidence } from '../../../src/services/worker/agents/ResponseProcessor.js';

// A denied or failed Write must not be stored as a completed files_modified
// change: Cursor's postToolUseFailure reports the attempt, not a result (#5371).
describe('extractObservationFileEvidence: failed tool calls', () => {
  const message = (over: Record<string, unknown>) => ({ type: 'observation', ...over }) as any;

  it('records a successful edit', () => {
    const evidence = extractObservationFileEvidence([
      message({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }),
    ]);

    expect(evidence.files_modified).toEqual(['src/a.ts']);
  });

  it('ignores an edit whose response is marked as an error', () => {
    const evidence = extractObservationFileEvidence([
      message({
        tool_name: 'Edit',
        tool_input: { file_path: 'src/a.ts' },
        tool_response: { is_error: true, error: 'permission denied' },
      }),
    ]);

    expect(evidence.files_modified).toEqual([]);
  });

  it('ignores a read whose response is marked as an error', () => {
    const evidence = extractObservationFileEvidence([
      message({
        tool_name: 'Read',
        tool_input: { file_path: 'src/a.ts' },
        tool_response: { isError: true },
      }),
    ]);

    expect(evidence.files_read).toEqual([]);
  });

  it('still records an edit whose response is a normal result', () => {
    const evidence = extractObservationFileEvidence([
      message({
        tool_name: 'Edit',
        tool_input: { file_path: 'src/b.ts' },
        tool_response: { success: true },
      }),
    ]);

    expect(evidence.files_modified).toEqual(['src/b.ts']);
  });

  // The worker stores tool_response as text: ingest JSON.stringify()s it
  // before queueing (http/shared.ts), so the extractor sees a string.
  it('ignores an edit whose stored (JSON string) response is marked as an error', () => {
    const evidence = extractObservationFileEvidence([
      message({
        tool_name: 'Edit',
        tool_input: JSON.stringify({ file_path: 'src/a.ts' }),
        tool_response: JSON.stringify({ is_error: true, error: 'permission denied' }),
      }),
    ]);

    expect(evidence.files_modified).toEqual([]);
  });

  it('still records an edit whose stored response is a plain string result', () => {
    const evidence = extractObservationFileEvidence([
      message({
        tool_name: 'Edit',
        tool_input: JSON.stringify({ file_path: 'src/c.ts' }),
        tool_response: JSON.stringify('{"is_error":true}'),
      }),
    ]);

    expect(evidence.files_modified).toEqual(['src/c.ts']);
  });
});

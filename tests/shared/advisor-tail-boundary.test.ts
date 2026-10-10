import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractAdvisorCalls } from '../../src/shared/advisor-transcript.js';

it('keeps a complete advisor call when the bounded tail starts exactly at its line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-advisor-boundary-'));
  try {
    const file = join(dir, 'transcript.jsonl');
    const prefix = JSON.stringify({ type: 'user', message: { content: 'earlier prompt' } }) + '\n';
    const tail = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'advisor' }] }, timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'advisor_tool_result', tool_use_id: 'srvtoolu_fixture', content: { type: 'advisor_result', text: 'Keep this advice.' } }] } }),
    ].join('\n') + '\n';
    writeFileSync(file, prefix + tail);
    const calls = extractAdvisorCalls(file, { maxTailBytes: Buffer.byteLength(tail), currentTurnOnly: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].advice).toBe('Keep this advice.');
    expect(calls[0].transcriptByteOffset).toBe(Buffer.byteLength(prefix));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

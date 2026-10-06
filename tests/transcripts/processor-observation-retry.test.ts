import { afterAll, describe, expect, it, mock } from 'bun:test';
import * as shared from '../../src/services/worker/http/shared.js';
const snapshot = { ...shared };
let mode: 'decline' | 'throw' | 'accepted-throw' | 'ok' = 'ok';
const calls: unknown[] = [];
mock.module('../../src/services/worker/http/shared.js', () => ({
  ...snapshot,
  ingestObservation: async (payload: unknown, handoff?: { markHandedOff?: () => void }) => {
    calls.push(payload);
    if (mode === 'decline') return { ok: false, reason: 'busy', status: 500 };
    if (mode === 'throw') throw new Error('busy');
    if (mode === 'accepted-throw') { handoff?.markHandedOff?.(); throw new Error('kick failed'); }
    return { ok: true, sessionDbId: 1 };
  },
}));
afterAll(() => mock.module('../../src/services/worker/http/shared.js', () => snapshot));
import { TranscriptEventProcessor, TranscriptObservationError } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';
const schema: TranscriptSchema = { name: 'retry', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
] };
const watch = { name: 'retry', path: '/unused', workspace: '/repo', schema };
describe('transcript observation retry', () => {
  for (const failure of ['decline', 'throw'] as const) {
    it(`retains tool metadata when ingest ${failure}s before acceptance`, async () => {
      calls.length = 0; mode = failure;
      const processor = new TranscriptEventProcessor();
      await processor.processEntry({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } }, watch, schema);
      const result = { session: 's', type: 'result', id: 't', output: 'contents' };
      await expect(processor.processEntry(result, watch, schema)).rejects.toBeInstanceOf(TranscriptObservationError);
      mode = 'ok';
      await processor.processEntry(result, watch, schema);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ toolName: 'Read', toolInput: { path: 'a' }, toolResponse: 'contents', toolUseId: 't' });
    });
  }
  it('does not retry an event already handed off when the generator kick fails', async () => {
    calls.length = 0; mode = 'accepted-throw';
    const processor = new TranscriptEventProcessor();
    await processor.processEntry({ session: 's', type: 'use', id: 't', name: 'Read' }, watch, schema);
    const result = { session: 's', type: 'result', id: 't', output: 'contents' };
    await expect(processor.processEntry(result, watch, schema)).resolves.toBeUndefined();
    mode = 'ok';
    await processor.processEntry(result, watch, schema);
    expect(calls).toHaveLength(1);
  });
});

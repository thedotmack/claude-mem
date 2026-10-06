import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { TranscriptEventProcessor, TranscriptObservationError } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';

// The real ingestObservation, with the worker's dependencies stubbed the way
// tests/worker/hook-spool-drain.test.ts does. Each failure is one the worker
// can really hit: a session-resolution error (declined before acceptance), a
// queue that throws (before the hand-off), and a generator kick that fails
// after the observation was queued (accepted).
type Failure = 'session-resolution' | 'queue' | 'generator-kick' | 'none';
let failure: Failure = 'none';
let store: SessionStore;
const queued: Array<{ tool_name: string; tool_input: string; tool_response: string; toolUseId?: string }> = [];

beforeEach(() => {
  failure = 'none';
  queued.length = 0;
  store = new SessionStore(new Database(':memory:'));
  const createSDKSession = store.createSDKSession.bind(store);
  store.createSDKSession = ((...args: Parameters<SessionStore['createSDKSession']>) => {
    if (failure === 'session-resolution') throw new Error('database is locked');
    return createSDKSession(...args);
  }) as SessionStore['createSDKSession'];
  setIngestContext({
    sessionManager: {
      queueObservation: (_sessionDbId: number, message: (typeof queued)[number]) => {
        if (failure === 'queue') throw new Error('queue unavailable');
        queued.push(message);
      },
    } as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {
      if (failure === 'generator-kick') throw new Error('kick failed');
    },
  });
});

afterEach(() => store.close());

const schema: TranscriptSchema = { name: 'retry', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
] };
const watch = { name: 'retry', path: '/unused', workspace: '/repo', schema };

describe('transcript observation retry', () => {
  for (const before of ['session-resolution', 'queue'] as const) {
    it(`keeps the tool call when ingest fails at ${before} (before accepting it)`, async () => {
      const processor = new TranscriptEventProcessor();
      await processor.processEntry({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } }, watch, schema);
      const result = { session: 's', type: 'result', id: 't', output: 'contents' };
      failure = before;
      await expect(processor.processEntry(result, watch, schema)).rejects.toBeInstanceOf(TranscriptObservationError);
      expect(queued).toHaveLength(0);
      failure = 'none';
      await processor.processEntry(result, watch, schema);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ tool_name: 'Read', toolUseId: 't' });
      expect(JSON.parse(queued[0].tool_input)).toEqual({ path: 'a' });
      expect(JSON.parse(queued[0].tool_response)).toBe('contents');
    });
  }

  it('does not retry an observation already queued when the generator kick fails', async () => {
    const processor = new TranscriptEventProcessor();
    await processor.processEntry({ session: 's', type: 'use', id: 't', name: 'Read' }, watch, schema);
    const result = { session: 's', type: 'result', id: 't', output: 'contents' };
    failure = 'generator-kick';
    await expect(processor.processEntry(result, watch, schema)).resolves.toBeUndefined();
    failure = 'none';
    // The tool call was consumed: a replayed result has no tool name to send.
    await processor.processEntry(result, watch, schema);
    expect(queued).toHaveLength(1);
  });
});

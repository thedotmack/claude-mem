import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import * as realShared from '../../src/services/worker/http/shared.js';

const realSharedSnapshot = { ...realShared };
const ingestCalls: Array<Record<string, unknown>> = [];

afterAll(() => {
  mock.module('../../src/services/worker/http/shared.js', () => realSharedSnapshot);
});

mock.module('../../src/services/worker/http/shared.js', () => ({
  ingestObservation: async (payload: Record<string, unknown>) => {
    ingestCalls.push(payload);
    return { ok: true, sessionDbId: 1 };
  },
}));

import { resolveWatchAgentId, TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';

const schema: TranscriptSchema = {
  name: 'grok-bot',
  events: [
    {
      name: 'grok-tool-result',
      match: { path: 'role', equals: 'tool' },
      action: 'tool_result',
      fields: {
        sessionId: { value: 'session-grok-1' },
        toolId: 'message.content[0].toolUseId',
        toolName: 'message.content[0].name',
        toolResponse: 'message.content[0].content',
      },
    },
  ],
};

const makeWatch = (overrides: Partial<WatchTarget> = {}): WatchTarget => ({
  name: 'grok-bot',
  path: join(tmpdir(), 'agent-transcripts', '521e962d-2ec3-4488-bfbc-54d5209ce118', '*.jsonl'),
  schema: 'grok-bot',
  project: 'cmem_work_lfg',
  workspace: join(tmpdir(), 'workspace'),
  ...overrides,
});

describe('resolveWatchAgentId', () => {
  it('prefers the explicit watch.agentId', () => {
    expect(resolveWatchAgentId(makeWatch({
      agentId: '95601360-61f7-4fd9-bb3a-2c976b2b85c0',
      path: join(tmpdir(), 'agent-transcripts', '521e962d-2ec3-4488-bfbc-54d5209ce118', '*.jsonl'),
    }))).toBe('95601360-61f7-4fd9-bb3a-2c976b2b85c0');
  });

  it('falls back to the agent-transcripts UUID in the watch path', () => {
    expect(resolveWatchAgentId(makeWatch({ agentId: undefined }))).toBe(
      '521e962d-2ec3-4488-bfbc-54d5209ce118',
    );
  });

  it('ignores the catch-all * watch id', () => {
    expect(resolveWatchAgentId(makeWatch({
      agentId: '*',
      path: join(tmpdir(), 'agent-transcripts', '*', '*.jsonl'),
    }))).toBeUndefined();
  });
});

describe('TranscriptEventProcessor agentId ingest', () => {
  let processor: TranscriptEventProcessor;

  beforeEach(() => {
    processor = new TranscriptEventProcessor();
    ingestCalls.length = 0;
  });

  afterEach(() => {
    ingestCalls.length = 0;
  });

  it('passes watch.agentId through to ingestObservation', async () => {
    const agentId = '521e962d-2ec3-4488-bfbc-54d5209ce118';
    await processor.processEntry({
      role: 'tool',
      message: {
        content: [{
          toolUseId: 'toolu_1',
          name: 'Read',
          content: 'ok',
        }],
      },
    }, makeWatch({ agentId }), schema);

    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].agentId).toBe(agentId);
    expect(ingestCalls[0].toolName).toBe('Read');
  });

  it('omits agentId when the watch has no agent identity', async () => {
    await processor.processEntry({
      role: 'tool',
      message: {
        content: [{
          toolUseId: 'toolu_1',
          name: 'Read',
          content: 'ok',
        }],
      },
    }, makeWatch({
      agentId: undefined,
      path: join(tmpdir(), 'transcripts', '**', '*.jsonl'),
    }), schema);

    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].agentId).toBeUndefined();
  });
});

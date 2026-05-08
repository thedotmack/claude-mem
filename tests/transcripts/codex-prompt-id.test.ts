import { describe, it, expect, beforeEach, mock } from 'bun:test';

const sessionInitCalls: any[] = [];

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: any) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

describe('Codex transcript prompt IDs', () => {
  beforeEach(() => {
    sessionInitCalls.length = 0;
  });

  it('threads task_started turn_id into user_message session init as promptId', async () => {
    const { TranscriptEventProcessor } = await import('../../src/services/transcripts/processor.js');
    const { SAMPLE_CONFIG } = await import('../../src/services/transcripts/config.js');
    const schema = {
      ...SAMPLE_CONFIG.schemas!.codex,
      events: SAMPLE_CONFIG.schemas!.codex.events.filter(event => event.name !== 'task-started'),
    };
    const watch = SAMPLE_CONFIG.watches[0];
    const processor = new TranscriptEventProcessor();
    const sessionId = '019e04f9-9424-7102-ac94-95891b33f2a3';

    await processor.processEntry({
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: '/tmp/project',
      },
    }, watch, schema);

    await processor.processEntry({
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: '019e0201-66d5-79f0-9e35-93e03cc7080f',
      },
    }, watch, schema, sessionId);

    await processor.processEntry({
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'does the v2 plan address that?',
        images: [],
        local_images: [],
        text_elements: [],
      },
    }, watch, schema, sessionId);

    expect(sessionInitCalls).toHaveLength(1);
    expect(sessionInitCalls[0]).toMatchObject({
      sessionId,
      cwd: '/tmp/project',
      prompt: 'does the v2 plan address that?',
      promptId: '019e0201-66d5-79f0-9e35-93e03cc7080f',
      turnId: '019e0201-66d5-79f0-9e35-93e03cc7080f',
      platform: 'codex',
    });
  });
});

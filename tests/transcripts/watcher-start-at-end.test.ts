import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

const waitForAsyncTail = () => new Promise(resolve => setTimeout(resolve, 50));

describe('TranscriptWatcher startAtEnd', () => {
  let tmpRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    sessionInitCalls.length = 0;
    tmpRoot = join(tmpdir(), `claude-mem-transcript-watch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not replay history from transcript files discovered after startup', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');

    writeFileSync(
      filePath,
      `${JSON.stringify({
        type: 'event',
        payload: {
          type: 'user_message',
          session_id: sessionId,
          message: 'historical prompt that must not be replayed',
        },
      })}\n`,
      'utf8',
    );

    const schema: TranscriptSchema = {
      name: 'codex-test',
      events: [
        {
          name: 'user-message',
          match: { path: 'payload.type', equals: 'user_message' },
          action: 'session_init',
          fields: {
            sessionId: 'payload.session_id',
            prompt: 'payload.message',
          },
        },
      ],
    };
    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema,
      startAtEnd: true,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();

    expect(sessionInitCalls).toHaveLength(0);

    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'event',
        payload: {
          type: 'user_message',
          session_id: sessionId,
          message: 'live prompt',
        },
      })}\n`,
      'utf8',
    );

    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts).toContain('live prompt');
    expect(prompts).not.toContain('historical prompt that must not be replayed');
  });
});

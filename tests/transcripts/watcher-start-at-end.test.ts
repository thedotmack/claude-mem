import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so this partial session-init stub would
// otherwise leak into other test files in the same `bun test` run.
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
const realSessionInitSnapshot = { ...realSessionInit };

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

const waitForAsyncTail = () => new Promise(resolve => setTimeout(resolve, 50));

const createUserMessage = (sessionId: string, prompt: string) => JSON.stringify({
  type: 'event',
  payload: {
    type: 'user_message',
    session_id: sessionId,
    message: prompt,
  },
});

const createSchema = (): TranscriptSchema => ({
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
});

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
      `${createUserMessage(sessionId, 'historical prompt that must not be replayed')}\n`,
      'utf8',
    );

    const schema = createSchema();
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
      `${createUserMessage(sessionId, 'live prompt')}\n`,
      'utf8',
    );

    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts).toContain('live prompt');
    expect(prompts).not.toContain('historical prompt that must not be replayed');
  });

  it('serializes overlapping poke calls for the same appended data', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763b';
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');
    const schema = createSchema();
    const watch: WatchTarget = {
      name: 'codex',
      path: filePath,
      schema,
      startAtEnd: true,
    };

    writeFileSync(filePath, `${createUserMessage(sessionId, 'historical prompt')}\n`, 'utf8');

    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();

    const tailer = (watcher as any).tailers.get(filePath);
    tailer.close();
    appendFileSync(filePath, `${createUserMessage(sessionId, 'live prompt')}\n`, 'utf8');

    tailer.poke();
    tailer.poke();
    await waitForAsyncTail();
    watcher.stop();

    const livePrompts = sessionInitCalls.filter(call => call.prompt === 'live prompt');
    expect(livePrompts).toHaveLength(1);
  });

  it('discards a buffered partial line when the file is truncated', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763c';
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');
    const schema = createSchema();
    const watch: WatchTarget = {
      name: 'codex',
      path: filePath,
      schema,
    };

    writeFileSync(filePath, `{"incomplete":"${'x'.repeat(1024)}`, 'utf8');

    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();

    const tailer = (watcher as any).tailers.get(filePath);
    tailer.close();
    writeFileSync(filePath, `${createUserMessage(sessionId, 'after truncation')}\n`, 'utf8');

    tailer.poke();
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['after truncation']);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { zstdCompressSync } from 'node:zlib';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll (same pattern as watcher-start-at-end.test.ts).
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

/** Compress JSONL lines into one independently decodable zstd frame. */
const zstdFrame = (lines: string[]): Buffer => zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));

const userMessageEvent = (seq: number, text: string): string =>
  JSON.stringify({ type: 'user/message', seq, time: Date.now(), data: { content: [{ type: 'text', text }] } });

const dshSchema: TranscriptSchema = {
  name: 'dsh-test',
  events: [
    {
      name: 'user-message',
      match: { path: 'type', equals: 'user/message' },
      action: 'session_init',
      fields: { prompt: 'data.content[0].text' },
    },
  ],
};

describe('TranscriptWatcher zstd (DSH session logs)', () => {
  let tmpRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    sessionInitCalls.length = 0;
    tmpRoot = join(tmpdir(), `claude-mem-dsh-watch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

  it('decodes a concatenated-frame zstd transcript and replays its events', async () => {
    const sessionId = 'da71594b-8076-4960-adba-8b272cfcfa17';
    const sessionDir = join(tmpRoot, `session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.jsonl.zstd');
    const statePath = join(tmpRoot, 'state.json');

    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    // Simulate two durable writes: each appends one zstd frame.
    writeFileSync(filePath, zstdFrame([
      JSON.stringify({ type: 'session', id: `session-${sessionId}`, cwd: '/tmp/project', createdAt: Date.now() }),
      userMessageEvent(0, 'first prompt'),
    ]));
    appendFileSync(filePath, zstdFrame([userMessageEvent(1, 'second prompt')]));

    const matches = (watcher as any).resolveWatchFiles(join(tmpRoot, '**', '*.jsonl.zstd'));
    expect(matches).toContain(filePath);

    await (watcher as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();
    watcher.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts).toContain('first prompt');
    expect(prompts).toContain('second prompt');
  });

  it('only replays frames appended after the stored offset (no duplicates)', async () => {
    const sessionId = 'e8f2c3a1-1234-5678-9abc-def012345678';
    const sessionDir = join(tmpRoot, `session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.jsonl.zstd');
    const statePath = join(tmpRoot, 'state.json');

    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    writeFileSync(filePath, zstdFrame([userMessageEvent(0, 'already seen')]));
    await (watcher as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();
    expect(sessionInitCalls.map(call => call.prompt)).toContain('already seen');

    // Rewrite the file with a new frame appended; only the new frame should replay.
    appendFileSync(filePath, zstdFrame([userMessageEvent(1, 'brand new')]));
    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts.filter(p => p === 'already seen')).toHaveLength(1);
    expect(prompts.filter(p => p === 'brand new')).toHaveLength(1);
  });
});

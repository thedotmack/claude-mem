import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { zstdCompressSync } from 'node:zlib';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];
/** Optional per-dispatch delay so tests can hold a read in-flight. */
let handlerDelayMs = 0;

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll (same pattern as watcher-start-at-end.test.ts).
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
const realSessionInitSnapshot = { ...realSessionInit };

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      if (handlerDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, handlerDelayMs));
      }
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

  it('does not advance the offset past a corrupt frame; retries it on the next change', async () => {
    const sessionId = 'c3a94b21-1111-2222-3333-444455556666';
    const sessionDir = join(tmpRoot, `session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.jsonl.zstd');
    const statePath = join(tmpRoot, 'state.json');

    // Structurally complete frame with a wrong checksum: scanZstdFrames
    // locates it, but zstdDecompressSync rejects it.
    const corruptFrame = () => {
      const b = Buffer.alloc(21);
      b.writeUInt32LE(0xfd2fb528, 0); // magic
      b.writeUInt8(0x24, 4); // descriptor: single-segment + checksum
      b.writeUInt8(8, 5); // frame content size = 8
      b.writeUIntLE(0x41, 6, 3); // block header: last(1) + raw(0) + size 8
      b.fill(0xab, 9, 17); // 8 payload bytes
      b.fill(0xff, 17, 21); // wrong 4-byte checksum
      return b;
    };

    const goodFrameA = zstdFrame([userMessageEvent(0, 'before corrupt')]);
    const goodFrameC = zstdFrame([userMessageEvent(2, 'after corrupt')]);

    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    // Frame A (valid) + corrupt frame + frame C (valid).
    writeFileSync(filePath, Buffer.concat([goodFrameA, corruptFrame(), goodFrameC]));
    await (watcher as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();

    // Frame A dispatched; frame C withheld because the corrupt frame stops the
    // pass, and the durable offset never advances past it.
    expect(sessionInitCalls.map(call => call.prompt)).toContain('before corrupt');
    expect(sessionInitCalls.map(call => call.prompt)).not.toContain('after corrupt');
    const offsets = JSON.parse((await import('fs')).readFileSync(statePath, 'utf8')).offsets as Record<string, number>;
    expect(offsets[filePath]).toBe(goodFrameA.length);

    // Rewrite with a valid frame in place of the corrupt one: the withheld
    // event is now replayed, and the offset advances to the end of the file.
    writeFileSync(filePath, Buffer.concat([goodFrameA, goodFrameC]));
    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toContain('after corrupt');
    expect(sessionInitCalls.filter(c => c.prompt === 'before corrupt')).toHaveLength(1);
    const finalOffsets = JSON.parse((await import('fs')).readFileSync(statePath, 'utf8')).offsets as Record<string, number>;
    expect(finalOffsets[filePath]).toBe(goodFrameA.length + goodFrameC.length);
  });

  it('coalesces a poke received mid-read instead of dispatching twice', async () => {
    const sessionId = 'f7b21c33-4444-5555-6666-777788889999';
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

    writeFileSync(filePath, zstdFrame([userMessageEvent(0, 'only once')]));

    // Hold the first dispatch in-flight so the poke lands mid-read.
    handlerDelayMs = 150;
    try {
      await (watcher as any).addTailer(filePath, watch, dshSchema);
      await waitForAsyncTail();
      (watcher as any).tailers.get(filePath)?.poke();
      await waitForAsyncTail();
      // Let the second (coalesced) pass finish if one started.
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally {
      handlerDelayMs = 0;
    }
    watcher.stop();

    expect(sessionInitCalls.filter(c => c.prompt === 'only once')).toHaveLength(1);
  });

  it('suppresses a queued read after close (no dispatch after shutdown)', async () => {
    const sessionId = 'a9d41e55-6666-7777-8888-999900001111';
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

    // Two frames: the first dispatch is held in-flight, a poke queues the
    // second frame's read, then the tailer is closed before the hold releases.
    writeFileSync(filePath, Buffer.concat([
      zstdFrame([userMessageEvent(0, 'first')]),
      zstdFrame([userMessageEvent(1, 'second')]),
    ]));

    handlerDelayMs = 150;
    try {
      await (watcher as any).addTailer(filePath, watch, dshSchema);
      await waitForAsyncTail();
      (watcher as any).tailers.get(filePath)?.poke();
      watcher.stop(); // closes tailers while the first dispatch is in flight
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally {
      handlerDelayMs = 0;
    }

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts).toContain('first');
    expect(prompts).not.toContain('second');
  });
});

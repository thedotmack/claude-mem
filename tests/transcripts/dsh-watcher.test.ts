import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
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

const fakeSessionInit = async (input: NormalizedHookInput) => {
  sessionInitCalls.push(input);
  if (handlerDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, handlerDelayMs));
  }
  return { continue: true, suppressOutput: true };
};
mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: { execute: fakeSessionInit },
  recordSessionPrompt: fakeSessionInit,
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import * as zstdFrames from '../../src/services/transcripts/zstd-frames.js';

const waitForAsyncTail = () => new Promise(resolve => setTimeout(resolve, 50));

/** Compress JSONL lines into one independently decodable zstd frame. */
const zstdFrame = (lines: string[]): Buffer => zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));

/** Structurally complete frame with a wrong checksum: scanned, but not decompressible. */
const corruptZstdFrame = (): Buffer => {
  const b = Buffer.alloc(21);
  b.writeUInt32LE(0xfd2fb528, 0); // magic
  b.writeUInt8(0x24, 4); // descriptor: single-segment + checksum
  b.writeUInt8(8, 5); // frame content size = 8
  b.writeUIntLE(0x41, 6, 3); // block header: last(1) + raw(0) + size 8
  b.fill(0xab, 9, 17); // 8 payload bytes
  b.fill(0xff, 17, 21); // wrong 4-byte checksum
  return b;
};

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

    const goodFrameA = zstdFrame([userMessageEvent(0, 'before corrupt')]);
    const goodFrameC = zstdFrame([userMessageEvent(2, 'after corrupt')]);

    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    // Frame A (valid) + corrupt frame + frame C (valid).
    writeFileSync(filePath, Buffer.concat([goodFrameA, corruptZstdFrame(), goodFrameC]));
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

  it('does not advance from a corrupt zstd frame to a later torn frame', async () => {
    const sessionId = 'b8ec2566-2222-3333-4444-555566667777';
    const sessionDir = join(tmpRoot, `session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.jsonl.zstd');
    const statePath = join(tmpRoot, 'state.json');

    const goodFrameA = zstdFrame([userMessageEvent(0, 'before corrupt and torn')]);
    const replacementFrameB = zstdFrame([userMessageEvent(1, 'replacement frame')]);
    const tornFrameC = zstdFrame([userMessageEvent(2, 'after torn')]).subarray(0, 12);

    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    writeFileSync(filePath, Buffer.concat([goodFrameA, corruptZstdFrame(), tornFrameC]));
    await (watcher as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();

    expect(sessionInitCalls.map(call => call.prompt)).toContain('before corrupt and torn');
    const offsets = JSON.parse(readFileSync(statePath, 'utf8')).offsets as Record<string, number>;
    expect(offsets[filePath]).toBe(goodFrameA.length);

    writeFileSync(filePath, Buffer.concat([goodFrameA, replacementFrameB]));
    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toContain('replacement frame');
    const finalOffsets = JSON.parse(readFileSync(statePath, 'utf8')).offsets as Record<string, number>;
    expect(finalOffsets[filePath]).toBe(goodFrameA.length + replacementFrameB.length);
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

  it('reassembles a JSONL record split across zstd frames after watcher replacement', async () => {
    const sessionId = '2f1a0b3c-aaaa-bbbb-cccc-ddddeeeeffff';
    const sessionDir = join(tmpRoot, `session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.jsonl.zstd');
    const statePath = join(tmpRoot, 'state.json');

    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
    };

    // Frame A ends in the middle of the second JSONL record: one complete
    // line, then the record's prefix with no trailing newline.
    const firstEvent = userMessageEvent(0, 'complete in frame A');
    const secondEvent = userMessageEvent(1, 'split across frames');
    const splitAt = secondEvent.length - 18;
    const prefix = secondEvent.slice(0, splitAt);
    const suffix = secondEvent.slice(splitAt);
    expect(prefix).not.toContain('\n');
    expect(suffix).not.toContain('\n');

    const frameA = zstdCompressSync(Buffer.from(`${firstEvent}\n${prefix}`, 'utf8'));
    writeFileSync(filePath, frameA);

    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (watcher as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();

    // The complete line dispatched; the durable offset advanced past all of
    // frame A together with the persisted unterminated prefix.
    expect(sessionInitCalls.map(call => call.prompt)).toContain('complete in frame A');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(persisted.offsets[filePath]).toBe(frameA.length);
    expect(persisted.partials[filePath]).toBe(prefix);
    watcher.stop();

    // Frame B arrives only after the watcher was replaced: without a persisted
    // prefix the replacement would parse the bare suffix as a standalone line
    // and silently drop the event that spans the two frames.
    appendFileSync(filePath, zstdCompressSync(Buffer.from(`${suffix}\n`, 'utf8')));
    const replacement = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (replacement as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();
    replacement.stop();

    const prompts = sessionInitCalls.map(call => call.prompt);
    expect(prompts.filter(p => p === 'complete in frame A')).toHaveLength(1);
    expect(prompts.filter(p => p === 'split across frames')).toHaveLength(1);
  });

  it('starts a startAtEnd zstd file after its last complete frame, not inside a torn one', async () => {
    const sessionId = '3c5d7e9f-aaaa-4bbb-8ccc-0123456789ab';
    const sessionDir = join(tmpRoot, `session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.jsonl.zstd');
    const statePath = join(tmpRoot, 'state.json');
    const watch: WatchTarget = {
      name: 'dsh',
      path: join(tmpRoot, '**', '*.jsonl.zstd'),
      schema: dshSchema,
      startAtEnd: true,
    };

    // History, then a write that was interrupted at startup.
    const history = zstdFrame([userMessageEvent(0, 'history')]);
    const pending = zstdFrame([userMessageEvent(1, 'written across the restart')]);
    writeFileSync(filePath, Buffer.concat([history, pending.subarray(0, 10)]));

    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (watcher as any).addTailer(filePath, watch, dshSchema);
    await waitForAsyncTail();
    expect(sessionInitCalls).toHaveLength(0);

    // The interrupted write completes; the frame is read from its start.
    writeFileSync(filePath, Buffer.concat([history, pending]));
    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['written across the restart']);
  });

  it('skips zstd files with one warning on a runtime without zstd support', async () => {
    const supportSpy = spyOn(zstdFrames, 'isZstdSupported').mockReturnValue(false);
    try {
      const statePath = join(tmpRoot, 'state.json');
      const watch: WatchTarget = { name: 'dsh', path: join(tmpRoot, '**', '*.jsonl.zstd'), schema: dshSchema };
      const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
      for (const name of ['a', 'b']) {
        const filePath = join(tmpRoot, `${name}.jsonl.zstd`);
        writeFileSync(filePath, zstdFrame([userMessageEvent(0, `prompt ${name}`)]));
        await (watcher as any).addTailer(filePath, watch, dshSchema);
      }
      await waitForAsyncTail();
      watcher.stop();

      expect(sessionInitCalls).toHaveLength(0);
      const warnSpy = loggerSpies[2];
      const skipWarnings = warnSpy.mock.calls.filter((call: unknown[]) => String(call[1]).includes('Skipping zstd transcripts'));
      expect(skipWarnings).toHaveLength(1);
    } finally {
      supportSpy.mockRestore();
    }
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { zstdCompressSync } from 'node:zlib';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

import * as realSessionInit from '../../src/cli/handlers/session-init.js';
const realSessionInitSnapshot = { ...realSessionInit };

/** Prompts the worker recorded, in order. */
const recorded: string[] = [];
/**
 * Prompts whose init calls fail, as an unreachable worker would, until the
 * test deletes them. Failing until released, not once: macOS can deliver a
 * late fs.watch event for the file's initial write after tailing starts,
 * which retries the failed turn before the test's own poke or restart.
 */
const failing = new Set<string>();

const fakeSessionInit = async (input: NormalizedHookInput) => {
  const prompt = input.prompt ?? '';
  if (failing.has(prompt)) {
    throw new Error('session-init did not record the prompt (worker_unreachable)');
  }
  recorded.push(prompt);
  return { continue: true, suppressOutput: true };
};
mock.module('../../src/cli/handlers/session-init.js', () => ({
  ...realSessionInitSnapshot,
  sessionInitHandler: { execute: fakeSessionInit },
  recordSessionPrompt: fakeSessionInit,
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import * as zstdFrames from '../../src/services/transcripts/zstd-frames.js';

const schema: TranscriptSchema = {
  name: 'retry-test',
  events: [
    {
      name: 'turn',
      match: { path: 'type', equals: 'turn' },
      action: 'session_init',
      fields: { sessionId: 'session', cwd: 'cwd', prompt: 'text' },
    },
  ],
};

const turnLine = (text: string, padding = ''): string =>
  JSON.stringify({ type: 'turn', session: 'session-retry', cwd: join(tmpdir(), 'retry-project'), text, padding });

const zstdFrame = (texts: string[]): Buffer =>
  zstdCompressSync(Buffer.from(`${texts.map(text => turnLine(text)).join('\n')}\n`, 'utf8'));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80));

// The multi-megabyte backlogs take well under a second alone, but the full
// suite runs files side by side; the default 5 s test timeout is too tight.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

describe('TranscriptWatcher consumes failed live handoffs', () => {
  let tmpRoot: string;
  let statePath: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  const watchers: TranscriptWatcher[] = [];

  beforeEach(() => {
    recorded.length = 0;
    failing.clear();
    tmpRoot = join(tmpdir(), `claude-mem-anchor-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    statePath = join(tmpRoot, 'state.json');
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function tail(filePath: string): Promise<{ watcher: TranscriptWatcher; poke: () => Promise<void> }> {
    const watcher = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    watchers.push(watcher);
    const watch: WatchTarget = { name: 'retry-test', path: filePath, schema };
    await (watcher as any).addTailer(filePath, watch, schema);
    const tailer = (watcher as any).tailers.get(filePath);
    await tailer.readTask;
    return { watcher, poke: async () => { tailer.poke(); await tailer.readTask; } };
  }

  const savedOffset = (filePath: string): number | undefined =>
    JSON.parse(readFileSync(statePath, 'utf8')).offsets[filePath];

  for (const restart of [false, true]) it(`JSONL: skips outage lines after ${restart ? 'restart' : 'recovery'}`, async () => {
    const filePath = join(tmpRoot, 'rollout.jsonl');
    writeFileSync(filePath, ['L1', 'L2', 'L3', 'L4'].map(text => `${turnLine(text)}\n`).join(''));
    failing.add('L3');
    failing.add('L4');
    const first = await tail(filePath);
    expect(recorded).toEqual(['L1', 'L2']);
    expect(savedOffset(filePath)).toBe(statSync(filePath).size);
    if (restart) first.watcher.stop();
    failing.clear();
    const active = restart ? await tail(filePath) : first;
    await active.poke();
    expect(recorded).toEqual(['L1', 'L2']);
    appendFileSync(filePath, `${turnLine('L5')}\n`);
    await active.poke();
    expect(recorded).toEqual(['L1', 'L2', 'L5']);
    expect(savedOffset(filePath)).toBe(statSync(filePath).size);
  });

  for (const frames of [
    [['Z1'], ['Z2'], ['Z3'], ['Z4']],
    [['A1', 'A2'], ['B1', 'B2']],
  ]) for (const restart of [false, true]) it(`zstd: skips failed lines across ${frames.length} frames after ${restart ? 'restart' : 'recovery'}`, async () => {
    const filePath = join(tmpRoot, 'session.jsonl.zstd');
    writeFileSync(filePath, Buffer.concat(frames.map(zstdFrame)));
    const rejected = frames.at(-1)!;
    rejected.forEach(text => failing.add(text));
    const first = await tail(filePath);
    const accepted = frames.slice(0, -1).flat();
    expect(recorded).toEqual(accepted);
    expect(savedOffset(filePath)).toBe(statSync(filePath).size);
    if (restart) first.watcher.stop();
    failing.clear();
    const active = restart ? await tail(filePath) : first;
    await active.poke();
    expect(recorded).toEqual(accepted);
    appendFileSync(filePath, zstdFrame(['fresh']));
    await active.poke();
    expect(recorded).toEqual([...accepted, 'fresh']);
  });

  it('JSONL: a backlog larger than one pass is read in bounded passes, every line once', async () => {
    const filePath = join(tmpRoot, 'big.jsonl');
    const padding = 'x'.repeat(2000);
    const texts = Array.from({ length: 3000 }, (_, index) => `big-${index}`);
    writeFileSync(filePath, texts.map(text => `${turnLine(text, padding)}\n`).join(''));
    expect(statSync(filePath).size).toBeGreaterThan(4 * 1024 * 1024);

    await tail(filePath);
    await waitFor(() => recorded.length >= texts.length, HEAVY_TEST_TIMEOUT_MS);
    await settle();
    expect(recorded).toEqual(texts);
  }, HEAVY_TEST_TIMEOUT_MS + 5_000);

  it('zstd: a backlog larger than one pass is read in bounded passes, every frame once', async () => {
    const filePath = join(tmpRoot, 'big.jsonl.zstd');
    // Incompressible padding, so the compressed frames really exceed one pass.
    const texts = Array.from({ length: 60 }, (_, index) => `frame-${index}`);
    writeFileSync(filePath, Buffer.concat(texts.map(text => zstdCompressSync(
      Buffer.from(`${turnLine(text, randomBytes(96 * 1024).toString('base64'))}\n`, 'utf8'),
    ))));
    expect(statSync(filePath).size).toBeGreaterThan(4 * 1024 * 1024);

    await tail(filePath);
    await waitFor(() => recorded.length >= texts.length, HEAVY_TEST_TIMEOUT_MS);
    await settle();
    expect(recorded).toEqual(texts);
  }, HEAVY_TEST_TIMEOUT_MS + 5_000);
});

describe('TranscriptWatcher startAtEnd discovery (R5-8)', () => {
  let tmpRoot: string;
  let statePath: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  const watchers: TranscriptWatcher[] = [];

  beforeEach(() => {
    recorded.length = 0;
    failing.clear();
    tmpRoot = join(tmpdir(), `claude-mem-start-at-end-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    statePath = join(tmpRoot, 'state.json');
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function startWatching(pattern: string): Promise<TranscriptWatcher> {
    const watch: WatchTarget = { name: 'retry-test', path: pattern, schema, startAtEnd: true };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    watchers.push(watcher);
    await watcher.start();
    return watcher;
  }

  const savedOffsets = (): Record<string, number> => JSON.parse(readFileSync(statePath, 'utf8')).offsets;

  it('saves a historical file\'s start offset at discovery and keeps it across boots', async () => {
    const filePath = join(tmpRoot, 'history.jsonl');
    writeFileSync(filePath, `${turnLine('old-1')}\n${turnLine('old-2')}\n`);
    const historicalSize = statSync(filePath).size;

    const first = await startWatching(join(tmpRoot, '*.jsonl'));
    await settle();
    expect(savedOffsets()[filePath]).toBe(historicalSize);
    first.stop();

    // Written while no watcher ran: read on the next boot, not skipped by a new startAtEnd.
    appendFileSync(filePath, `${turnLine('while-down')}\n`);
    await startWatching(join(tmpRoot, '*.jsonl'));
    await waitFor(() => recorded.length >= 1);
    await settle();
    expect(recorded).toEqual(['while-down']);
  });

  it('does not frame-scan an unchanged zstd file again on the next boot', async () => {
    const filePath = join(tmpRoot, 'session.jsonl.zstd');
    writeFileSync(filePath, Buffer.concat([zstdFrame(['old-1']), zstdFrame(['old-2'])]));

    const first = await startWatching(join(tmpRoot, '*.jsonl.zstd'));
    await settle();
    expect(savedOffsets()[filePath]).toBe(statSync(filePath).size);
    first.stop();

    const scanSpy = spyOn(zstdFrames, 'scanZstdFramesInFile');
    try {
      await startWatching(join(tmpRoot, '*.jsonl.zstd'));
      await settle();
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
    }
    expect(recorded).toEqual([]);
  });

  it('starts a large file with a fresh mtime at EOF when it appears after startup (a copied history)', async () => {
    const watcher = await startWatching(join(tmpRoot, '*.jsonl'));
    const filePath = join(tmpRoot, 'copied.jsonl');
    const padding = 'y'.repeat(1000);
    writeFileSync(filePath, Array.from({ length: 400 }, (_, index) => `${turnLine(`history-${index}`, padding)}\n`).join(''));
    expect(statSync(filePath).size).toBeGreaterThan(256 * 1024);

    const watch: WatchTarget = { name: 'retry-test', path: join(tmpRoot, '*.jsonl'), schema, startAtEnd: true };
    await (watcher as any).addTailer(filePath, watch, schema, true);
    appendFileSync(filePath, `${turnLine('live')}\n`);
    (watcher as any).tailers.get(filePath)?.poke();
    await waitFor(() => recorded.length >= 1);
    await settle();
    expect(recorded).toEqual(['live']);
  });

  it('reads a large file from byte 0 when its first record began after startup (a live session)', async () => {
    const watcher = await startWatching(join(tmpRoot, '*.jsonl'));
    const filePath = join(tmpRoot, 'live-large.jsonl');
    const opening = JSON.stringify({ type: 'turn', session: 'session-retry', cwd: join(tmpdir(), 'retry-project'), text: 'opening', timestamp: new Date().toISOString() });
    const padding = 'z'.repeat(1000);
    writeFileSync(filePath, `${opening}\n${Array.from({ length: 300 }, (_, index) => `${turnLine(`turn-${index}`, padding)}\n`).join('')}`);
    expect(statSync(filePath).size).toBeGreaterThan(256 * 1024);

    const watch: WatchTarget = { name: 'retry-test', path: join(tmpRoot, '*.jsonl'), schema, startAtEnd: true };
    await (watcher as any).addTailer(filePath, watch, schema, true);
    await waitFor(() => recorded.length >= 301, HEAVY_TEST_TIMEOUT_MS);
    await settle();
    expect(recorded[0]).toBe('opening');
    expect(recorded).toHaveLength(301);
  }, HEAVY_TEST_TIMEOUT_MS + 5_000);

  it('starts even a small copied history at EOF when its first record is older than startup', async () => {
    const watcher = await startWatching(join(tmpRoot, '*.jsonl'));
    const filePath = join(tmpRoot, 'copied-small.jsonl');
    const oldOpening = JSON.stringify({ type: 'turn', session: 'session-retry', cwd: join(tmpdir(), 'retry-project'), text: 'old opening', timestamp: '2026-01-02T03:04:05.000Z' });
    writeFileSync(filePath, `${oldOpening}\n${turnLine('old turn')}\n`);

    const watch: WatchTarget = { name: 'retry-test', path: join(tmpRoot, '*.jsonl'), schema, startAtEnd: true };
    await (watcher as any).addTailer(filePath, watch, schema, true);
    appendFileSync(filePath, `${turnLine('live')}\n`);
    (watcher as any).tailers.get(filePath)?.poke();
    await waitFor(() => recorded.length >= 1);
    await settle();
    expect(recorded).toEqual(['live']);
  });

  it('does not start a tailer that was still finding its start offset when the watcher stopped', async () => {
    const filePath = join(tmpRoot, 'late.jsonl.zstd');
    writeFileSync(filePath, zstdFrame(['before-stop']));
    const watch: WatchTarget = { name: 'retry-test', path: join(tmpRoot, '*.jsonl.zstd'), schema, startAtEnd: true };
    const watcher = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    watchers.push(watcher);

    const adding = (watcher as any).addTailer(filePath, watch, schema) as Promise<void>;
    watcher.stop();
    await adding;
    appendFileSync(filePath, zstdFrame(['after-stop']));
    await settle();

    expect((watcher as any).tailers.size).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('still reads a small new file from byte 0 when it appears after startup', async () => {
    const watcher = await startWatching(join(tmpRoot, '*.jsonl'));
    const filePath = join(tmpRoot, 'new-session.jsonl');
    writeFileSync(filePath, `${turnLine('opening prompt')}\n`);

    const watch: WatchTarget = { name: 'retry-test', path: join(tmpRoot, '*.jsonl'), schema, startAtEnd: true };
    await (watcher as any).addTailer(filePath, watch, schema, true);
    await waitFor(() => recorded.length >= 1);
    await settle();
    expect(recorded).toEqual(['opening prompt']);
  });
});

import { afterAll, expect, it, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RECORD_BYTES, TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import { logger } from '../../src/utils/logger.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const root = mkdtempSync(join(tmpdir(), 'cm-watcher-long-records-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const schema: TranscriptSchema = { name: 'long-record', events: [] };
interface Tailer { readTask: Promise<void> | null; poke(): void }
interface WatcherProbe {
  handleLine(line: string): Promise<void>;
  addTailer(path: string, watch: WatchTarget, schema: TranscriptSchema): Promise<void>;
  tailers: Map<string, Tailer>;
}

async function setup(name: string, content: Buffer | string) {
  const path = join(root, `${name}.jsonl`);
  const statePath = join(root, `${name}-state.json`);
  writeFileSync(path, content);
  const watch = { name, path, schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
  const probe = watcher as unknown as WatcherProbe;
  const lines: string[] = [];
  probe.handleLine = async line => { lines.push(line); };
  await probe.addTailer(path, watch, schema);
  const tailer = probe.tailers.get(path)!;
  await tailer.readTask;
  return { path, statePath, watcher, tailer, lines };
}

it('joins long UTF-8 records once complete and keeps byte-exact append checkpoints', async () => {
  const first = JSON.stringify({ text: 'a'.repeat(4 * 1024 * 1024 - 10) + '中文🙂é' });
  const second = JSON.stringify({ text: 'second'.repeat(800_000) });
  const bytes = Buffer.from(first + '\r\n' + second);
  const fixture = await setup('append', bytes.subarray(0, bytes.length - 3));
  try {
    expect(fixture.lines).toEqual([first]);
    expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(Buffer.byteLength(first + '\r\n'));
    appendFileSync(fixture.path, Buffer.concat([bytes.subarray(bytes.length - 3), Buffer.from('\n{"last":true}\n')]));
    fixture.tailer.poke();
    await fixture.tailer.readTask;
    expect(fixture.lines).toEqual([first, second, '{"last":true}']);
    expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(statSync(fixture.path).size);
  } finally {
    fixture.watcher.stop();
    await fixture.tailer.readTask;
  }
});

// One byte past the cap: the record is skipped whole, never cut.
const oversized = JSON.stringify({ text: 'x'.repeat(MAX_RECORD_BYTES - 11 + 1) });

function skipWarnings(warn: ReturnType<typeof spyOn>) {
  return warn.mock.calls
    .filter(call => call[1] === 'Skipped a transcript record larger than the record cap')
    .map(call => call[2]);
}

it('skips a record beyond the record cap instead of accumulating it without bound', async () => {
  // A record with no newline (a runaway writer, a corrupted transcript) would
  // otherwise keep every pass's bytes in pendingRecordParts until the newline
  // finally arrives, growing worker memory without bound. Past the cap the
  // record is skipped — loudly, and without parking the source cursor — so
  // the lines after it still flow and the checkpoint still reaches the end.
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  const fixture = await setup('capped', 'preamble\n' + oversized);
  try {
    expect(fixture.lines).toEqual(['preamble']);
    appendFileSync(fixture.path, '\n{"after-cap":true}\n');
    fixture.tailer.poke();
    await fixture.tailer.readTask;
    expect(fixture.lines).toEqual(['preamble', '{"after-cap":true}']);
    expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(statSync(fixture.path).size);
    expect(skipWarnings(warn)).toEqual([
      { file: fixture.path, capBytes: MAX_RECORD_BYTES, recordStartOffset: 9, skippedBytes: oversized.length },
    ]);
  } finally {
    warn.mockRestore();
    fixture.watcher.stop();
    await fixture.tailer.readTask;
  }
});

it('skips an oversized record whose newline is already on disk', async () => {
  // The reverse write order of the capped test: the whole oversized record,
  // newline included, is on disk before the tailer starts. Accumulation alone
  // would dispatch it on the pass that finds the newline, so the cap has to
  // be checked when the record is assembled, not only between passes.
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  const fixture = await setup('capped-on-disk', 'preamble\n' + oversized + '\n{"after-cap":true}\n');
  try {
    expect(fixture.lines).toEqual(['preamble', '{"after-cap":true}']);
    expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(statSync(fixture.path).size);
    expect(skipWarnings(warn)).toEqual([
      { file: fixture.path, capBytes: MAX_RECORD_BYTES, recordStartOffset: 9, skippedBytes: oversized.length },
    ]);
  } finally {
    warn.mockRestore();
    fixture.watcher.stop();
    await fixture.tailer.readTask;
  }
});

it('dispatches a record as large as the largest one measured in real transcripts', async () => {
  // The largest Codex rollout record measured on 2026-11-21 (see the comment
  // on MAX_RECORD_BYTES) was 46,315,620 bytes. A real record that size has to
  // come through whole, not be skipped as oversized.
  const largestMeasuredRecordBytes = 46_315_620;
  const real = JSON.stringify({ text: 'y'.repeat(largestMeasuredRecordBytes - 11) });
  const fixture = await setup('largest-measured', 'preamble\n' + real + '\n{"after":true}\n');
  try {
    expect(fixture.lines.length).toBe(3);
    expect(fixture.lines[1].length).toBe(largestMeasuredRecordBytes);
    expect(fixture.lines[2]).toBe('{"after":true}');
    expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(statSync(fixture.path).size);
  } finally {
    fixture.watcher.stop();
    await fixture.tailer.readTask;
  }
});

for (const replacement of ['truncate', 'rename'] as const) {
  it(`discards unfinished long-record fragments after ${replacement}`, async () => {
    const fixture = await setup(replacement, '{"text":"' + 'x'.repeat(5 * 1024 * 1024));
    try {
      expect(fixture.lines).toEqual([]);
      expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(0);
      const next = '{"replacement":true}\n';
      if (replacement === 'truncate') writeFileSync(fixture.path, next);
      else {
        writeFileSync(fixture.path + '.next', next);
        renameSync(fixture.path + '.next', fixture.path);
      }
      fixture.tailer.poke();
      await fixture.tailer.readTask;
      expect(fixture.lines).toEqual([next.trim()]);
      expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(Buffer.byteLength(next));
    } finally {
      fixture.watcher.stop();
      await fixture.tailer.readTask;
    }
  });
}

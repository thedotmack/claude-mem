import { afterAll, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
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

it('skips a record beyond the tail cap instead of accumulating it without bound', async () => {
  // A record with no newline (a runaway writer, a corrupted transcript) would
  // otherwise keep every pass's bytes in pendingRecordParts until the newline
  // finally arrives, growing worker memory without bound. Past the cap the
  // record is skipped — loudly, and without parking the source cursor — so
  // the lines after it still flow and the checkpoint still reaches the end.
  const huge = JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) });
  const fixture = await setup('capped', 'preamble\n' + huge);
  try {
    expect(fixture.lines).toEqual(['preamble']);
    appendFileSync(fixture.path, '\n{"after-cap":true}\n');
    fixture.tailer.poke();
    await fixture.tailer.readTask;
    expect(fixture.lines).toEqual(['preamble', '{"after-cap":true}']);
    expect(loadWatchState(fixture.statePath).offsets[fixture.path]).toBe(statSync(fixture.path).size);
  } finally {
    fixture.watcher.stop();
    await fixture.tailer.readTask;
  }
});

it('skips an oversized record whose newline is already on disk', async () => {
  // The reverse write order of the capped test: the whole oversized record,
  // newline included, is on disk before the tailer starts. Accumulation alone
  // would dispatch it on the pass that finds the newline, so the cap has to
  // be checked when the record is assembled, not only between passes.
  const huge = JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) });
  const fixture = await setup('capped-on-disk', 'preamble\n' + huge + '\n{"after-cap":true}\n');
  try {
    expect(fixture.lines).toEqual(['preamble', '{"after-cap":true}']);
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

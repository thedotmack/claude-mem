import { afterAll, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { zstdCompressSync } from 'node:zlib';
import { loadWatchState } from '../../src/services/transcripts/state.js';
const root = mkdtempSync(join(tmpdir(), 'cm-stop-drain-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const compressed of [false, true]) it(`stops ${compressed ? 'zstd' : 'JSONL'} backlog dispatch and preserves its resume checkpoint`, async () => {
  const path = join(root, compressed ? 'owned.jsonl.zstd' : 'owned.jsonl'); const statePath = join(root, compressed ? 'compressed-state.json' : 'state.json');
  const lines = ['{"owned":1}', '{"owned":2}', '{"owned":3}'];
  const bytes = Buffer.from(lines.join('\n')+'\n');
  writeFileSync(path, compressed ? zstdCompressSync(bytes) : bytes);
  const schema = { name: 'owned', events: [] };
  const watch = { name: 'owned', path, schema };
  const watcher = new TranscriptWatcher({ version:1, watches:[watch] }, statePath);
  let entered!: () => void; let release!: () => void;
  const first = new Promise<void>(resolve => {entered=resolve;});
  const gate = new Promise<void>(resolve => {release=resolve;});
  const dispatched: string[]=[];
  (watcher as any).handleLine = async (line:string) => {
    dispatched.push(line); if(dispatched.length===1){entered();await gate;}
  };
  try {
    await (watcher as any).addTailer(path, watch, schema); await first;
    watcher.stop(); release();
    await new Promise(resolve => setTimeout(resolve,30));
    expect(dispatched).toEqual([lines[0]]);
    const state = loadWatchState(statePath);
    expect(state.offsets[path]).toBe(compressed ? 0 : Buffer.byteLength(lines[0]+'\n'));
    if (compressed) expect(state.frameLines?.[path]).toBe(1);
  } finally {release();watcher.stop();}
});

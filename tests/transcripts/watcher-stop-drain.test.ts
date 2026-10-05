import { afterAll, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
async function bounded(task: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within 2 seconds`)), 2000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const root = mkdtempSync(join(tmpdir(), 'cm-stop-drain-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const compressed of [false, true]) it(`stops ${compressed ? 'zstd' : 'JSONL'} backlog dispatch and preserves its resume checkpoint`, async () => {
  const path = join(root, compressed ? 'owned.jsonl.zstd' : 'owned.jsonl'); const statePath = join(root, compressed ? 'compressed-state.json' : 'state.json');
  const lines = ['{"owned":1}', '{"owned":2}', '{"owned":3}'];
  const bytes = Buffer.from(lines.join('\n')+'\n');
  // Fixed zstd frame for the three owned lines; avoids requiring a new zlib API on supported Bun versions.
  writeFileSync(path, compressed ? Buffer.from('KLUv/SAkxQAAgHsib3duZWQiOjF9CjIzfQoCAMCIFyUJ', 'base64') : bytes);
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
  let readTask: Promise<void> | undefined;
  try {
    await (watcher as any).addTailer(path, watch, schema);
    await bounded(first, 'first callback');
    readTask = (watcher as any).tailers.get(path).readTask;
    expect(readTask).toBeInstanceOf(Promise);
    watcher.stop(); release();
    await bounded(readTask!, 'buffered read');
    expect(dispatched).toEqual([lines[0]]);
    const state = loadWatchState(statePath);
    expect(state.offsets[path]).toBe(compressed ? 0 : Buffer.byteLength(lines[0]+'\n'));
    if (compressed) expect(state.frameLines?.[path]).toBe(1);
    const resumed = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    const remaining: string[] = [];
    (resumed as any).handleLine = async (line: string) => { remaining.push(line); };
    let resumeTask: Promise<void> | undefined;
    try {
      await (resumed as any).addTailer(path, watch, schema);
      resumeTask = (resumed as any).tailers.get(path).readTask;
      await bounded(resumeTask!, 'resumed read');
      expect(remaining).toEqual(lines.slice(1));
      expect(loadWatchState(statePath).offsets[path]).toBe(statSync(path).size);
    } finally {
      resumed.stop();
      if (resumeTask) await bounded(resumeTask, 'resumed cleanup');
    }
  } finally {
    readTask ??= (watcher as any).tailers.get(path)?.readTask;
    release(); watcher.stop();
    if (readTask) await bounded(readTask, 'cleanup drain');
  }
});

import { afterAll, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
const root = mkdtempSync(join(tmpdir(), 'cm-checkpoint-zstd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const offset of [undefined, -1, '8', 0]) {
  it(`keeps zstd resume metadata consistent with offset ${String(offset)}`, async () => {
    const file = join(root, `owned-${String(offset)}.jsonl.zstd`);
    const statePath = `${file}.state`;
    const lines = ['{"owned":1}', '{"owned":2}'];
    writeFileSync(file, zstdCompressSync(Buffer.from(lines.join('\n')+'\n')));
    writeFileSync(statePath, JSON.stringify({ offsets: offset === undefined ? {} : {[file]:offset},
      partials: {[file]:offset === 0 ? '' : 'STALE'}, frameLines: {[file]:1} }));
    const schema = {name:'owned',events:[]}; const watch = {name:'owned',path:file,schema};
    const watcher = new TranscriptWatcher({version:1,watches:[watch]},statePath);
    const seen: string[]=[];
    (watcher as any).handleLine = async (line:string) => {seen.push(line);};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await (watcher as any).addTailer(file,watch,schema);
      const task=(watcher as any).tailers.get(file).readTask;
      await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned read did not finish')),2000);})]);
      expect(seen).toEqual(offset === 0 ? [lines[1]] : lines);
      expect(loadWatchState(statePath).offsets[file]).toBeGreaterThan(0);
    } finally {if(timer) clearTimeout(timer);watcher.stop();}
  });
}

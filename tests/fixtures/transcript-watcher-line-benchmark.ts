import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

const sizeMiB = Number(process.argv[2] ?? 64);
const root = mkdtempSync(join(tmpdir(), 'cm-watcher-line-bench-'));
const path = join(root, 'session.jsonl');
const size = sizeMiB * 1024 * 1024;
writeFileSync(path, JSON.stringify({ text: 'x'.repeat(size) }) + '\n');
const samples: number[] = [];
try {
  for (let run = 0; run < 3; run++) {
    Bun.gc(true);
    const schema = { name: 'benchmark', events: [] };
    const watch = { name: 'benchmark', path, schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(root, `state-${run}.json`));
    const probe = watcher as unknown as {
      handleLine(line: string): Promise<void>;
      addTailer: (path: string, targetWatch: typeof watch, targetSchema: typeof schema) => Promise<void>;
      tailers: Map<string, { readTask: Promise<void> }>;
    };
    let lines = 0;
    probe.handleLine = async line => {
      if (line.length !== size + 11) throw new Error('Incomplete record');
      lines++;
    };
    const start = performance.now();
    try {
      await probe.addTailer(path, watch, schema);
      await probe.tailers.get(path)!.readTask;
      if (lines !== 1) throw new Error(`Expected one record, got ${lines}`);
      samples.push(Math.round((performance.now() - start) * 10) / 10);
    } finally { watcher.stop(); }
  }
  console.log(JSON.stringify({ sizeMiB, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[1] }));
} finally { rmSync(root, { recursive: true, force: true }); }

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { extractLastMessage } from '../../src/shared/transcript-parser.js';

const dir = mkdtempSync(join(tmpdir(), 'cm-tail-bench-'));
const file = join(dir, 'session.jsonl');
const sizeMiB = Number(process.argv[2] ?? 16);
const chunkKiB = Number(process.argv[3] ?? 64);
try {
  const answer = JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'test', content: [{ type: 'text', text: 'saved answer' }] } });
  const tool = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(sizeMiB * 1024 * 1024) }] } });
  writeFileSync(file, answer + '\n' + tool + '\n');
  const samples = [];
  const options = chunkKiB === 0 ? undefined : { initialBytes: chunkKiB * 1024, maxChunkBytes: chunkKiB * 1024 };
  for (let run = 0; run < 3; run++) {
    Bun.gc(true);
    const start = performance.now();
    const text = extractLastMessage(file, 'assistant', false, options);
    if (text !== 'saved answer') throw new Error('wrong recovered answer');
    samples.push(Math.round((performance.now() - start) * 10) / 10);
  }
  console.log(JSON.stringify({ sizeMiB, chunkKiB, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[1] }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

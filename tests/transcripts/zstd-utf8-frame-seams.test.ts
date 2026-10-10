import { expect, it, mock, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import * as sessionInit from '../../src/cli/handlers/session-init.js';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';
const snapshot = { ...sessionInit };
const prompts: unknown[] = [];
const receive = async (input: NormalizedHookInput) => { prompts.push(input.prompt); return { continue: true, suppressOutput: true }; };
mock.module('../../src/cli/handlers/session-init.js', () => ({ sessionInitHandler: { execute: receive }, recordSessionPrompt: receive }));
afterAll(() => mock.module('../../src/cli/handlers/session-init.js', () => snapshot));
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
const schema: TranscriptSchema = { name: 'utf8', sessionIdPath: 'session', events: [
  { name: 'prompt', action: 'session_init', fields: { prompt: 'text', cwd: 'cwd' } },
] };
for (const restart of [false, true]) for (const text of ['修改项目', 'memory 🧠 intact']) {
  it(`keeps UTF-8 across a compressed frame seam, restart=${restart}, ${text}`, async () => {
    prompts.length = 0;
    const root = mkdtempSync(join(tmpdir(), 'cmem-zstd-utf8-'));
    const file = join(root, 'session.jsonl.zstd');
    const state = join(root, 'state.json');
    const record = Buffer.from(JSON.stringify({ session: 'fixture', cwd: '/fixture', text }) + '\n');
    const character = text.includes('🧠') ? '🧠' : '修';
    const seam = record.indexOf(Buffer.from(character)) + 1;
    const firstFrame = zstdCompressSync(record.subarray(0, seam));
    const secondFrame = zstdCompressSync(record.subarray(seam));
    const watch = { name: 'utf8', path: file, schema };
    let watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
    try {
      writeFileSync(file, restart ? firstFrame : Buffer.concat([firstFrame, secondFrame]));
      await (watcher as any).addTailer(file, watch, schema);
      await (watcher as any).tailers.get(file).readTask;
      if (restart) {
        expect(prompts).toEqual([]);
        watcher.stop();
        appendFileSync(file, secondFrame);
        watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
        await (watcher as any).addTailer(file, watch, schema);
        await (watcher as any).tailers.get(file).readTask;
      }
      expect(prompts).toEqual([text]);
    } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}

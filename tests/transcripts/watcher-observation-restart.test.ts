import { afterAll, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import * as shared from '../../src/services/worker/http/shared.js';
const original = { ...shared };
let accepting = false;
const delivered: any[] = [];
mock.module('../../src/services/worker/http/shared.js', () => ({ ...original, ingestObservation: async (payload: any) => {
  if (!accepting) return { ok: false, reason: 'busy', status: 503 };
  delivered.push(payload); return { ok: true, sessionDbId: 1 };
} }));
afterAll(() => mock.module('../../src/services/worker/http/shared.js', () => original));
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';
const schema: TranscriptSchema = { name: 'retry', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
] };
for (const compressed of [false, true]) it(`retries a result-only ${compressed ? 'zstd' : 'JSONL'} record after watcher restart`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retry-restart-'));
  const file = join(root, compressed ? 'session.jsonl.zstd' : 'session.jsonl');
  const statePath = join(root, 'state.json');
  const use = JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } }) + '\n';
  const result = JSON.stringify({ session: 's', type: 'result', id: 't', output: 'contents' }) + '\n';
  const bytes = Buffer.from(use + result);
  writeFileSync(file, compressed ? zstdCompressSync(bytes) : bytes);
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
  let second: TranscriptWatcher | undefined;
  try {
    delivered.length = 0; accepting = false;
    await (first as any).addTailer(file, watch, schema);
    await (first as any).tailers.get(file).readTask;
    first.stop();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.offsets[file]).toBe(compressed ? 0 : Buffer.byteLength(use));
    if (compressed) expect(saved.frameLines[file]).toBe(1);
    expect(saved.pendingTools[file]['retry:s'].t).toEqual({ toolName: 'Read', toolInput: { path: 'a' } });
    accepting = true;
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
    await (second as any).addTailer(file, watch, schema);
    await (second as any).tailers.get(file).readTask;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ toolName: 'Read', toolInput: { path: 'a' }, toolResponse: 'contents', toolUseId: 't' });
    const done = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(done.offsets[file]).toBe(statSync(file).size);
    expect(done.pendingTools[file]).toEqual({});
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

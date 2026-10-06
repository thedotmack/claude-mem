import { afterAll, expect, it, mock } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
for (const restart of [false, true]) it(`does not reuse pending metadata from a replaced transcript${restart ? ' across restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retry-replaced-'));
  const file = join(root, 'session.jsonl'); const state = join(root, 'state.json');
  const use = JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'old-long-enough-metadata-file' } }) + '\n';
  const result = JSON.stringify({ session: 's', type: 'result', id: 't', output: 'new' }) + '\n';
  writeFileSync(file, use);
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  let second: TranscriptWatcher | undefined;
  try {
    delivered.length = 0; accepting = true;
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    if (restart) first.stop();
    const replacement = join(root, 'new.jsonl'); writeFileSync(replacement, result);
    const { renameSync } = await import('node:fs'); renameSync(replacement, file);
    if (restart) {
      second = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
      await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask;
    } else { await (first as any).tailers.get(file).readNewData(); }
    expect(delivered).toHaveLength(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]).toEqual({});
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});
for (const restart of [false, true]) it(`retires unmatched tools when their transcript is no longer tracked${restart ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retired-tools-'));
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { token: 'fake-secret' } }) + '\n');
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); await (first as any).tailers.get(file).readTask;
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].t.toolInput.token).toBe('fake-secret');
    if (restart) first.stop(); rmSync(file);
    if (restart) { second = new TranscriptWatcher({ version: 1, watches: [watch] }, state); await second.start(); }
    else (first as any).handleRootWatchEvent(root, file, watch, schema, 'session.jsonl');
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.pendingTools[file]).toBeUndefined(); expect(saved.pendingToolFileIdentities[file]).toBeUndefined();
    expect(readFileSync(state, 'utf8')).not.toContain('fake-secret');
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`clears pending metadata on same-inode truncation${restart ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-truncate-tools-'));
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'old-long-enough-metadata-file' } }) + '\n');
  const inode = statSync(file).ino;
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    delivered.length = 0; accepting = true;
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    if (restart) first.stop();
    writeFileSync(file, JSON.stringify({ session: 's', type: 'result', id: 't', output: 'new' }) + '\n');
    expect(statSync(file).ino).toBe(inode);
    if (restart) { second = new TranscriptWatcher({ version: 1, watches: [watch] }, state); await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask; }
    else await (first as any).tailers.get(file).readNewData();
    expect(delivered).toHaveLength(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]).toEqual({});
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});
for (const restart of [false, true]) for (const sameId of [false, true]) it(`preserves other files' pending tools when one is replaced (${restart ? 'restart' : 'live'}, ${sameId ? 'shared' : 'distinct'} ID)`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-shared-tools-'));
  const a = join(root, 'a.jsonl'); const b = join(root, 'b.jsonl'); const state = join(root, 'checkpoint.json');
  const idB = sameId ? 'a' : 'b';
  writeFileSync(a, JSON.stringify({ session: 's', type: 'use', id: 'a', name: 'Read', input: { path: 'A' } }) + '\n');
  writeFileSync(b, JSON.stringify({ session: 's', type: 'use', id: idB, name: 'Write', input: { path: 'B' } }) + '\n');
  const watch = { name: 'retry', path: join(root, '*.jsonl'), workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    delivered.length = 0; accepting = true;
    for (const file of [a,b]) { await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask; }
    // A later event must not copy B's pending tool into A's durable snapshot.
    appendFileSync(a, JSON.stringify({ session: 's', type: 'result', id: 'unmatched', output: 'ignored' }) + '\n');
    await (first as any).tailers.get(a).readNewData();
    if (restart) first.stop();
    const replacement = join(root, 'replacement'); writeFileSync(replacement, JSON.stringify({ session: 's', type: 'use', id: 'new-a', name: 'Edit', input: { path: 'new-A' } }) + '\n');
    const { renameSync } = await import('node:fs'); renameSync(replacement, a);
    const current = restart ? (second = new TranscriptWatcher({ version: 1, watches: [watch] }, state)) : first;
    if (restart) for (const file of [a,b]) { await (current as any).addTailer(file, watch, schema); await (current as any).tailers.get(file).readTask; }
    else await (current as any).tailers.get(a).readNewData();
    appendFileSync(b, JSON.stringify({ session: 's', type: 'result', id: idB, output: 'B done' }) + '\n');
    await (current as any).tailers.get(b).readNewData();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ toolName: 'Write', toolInput: { path: 'B' }, toolResponse: 'B done' });
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});
it('does not retire saved retry metadata when stop cancels asynchronous start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cancel-metadata-')); const state = join(root, 'checkpoint.json'); const file = join(root, 'session.jsonl');
  writeFileSync(state, JSON.stringify({ offsets: { [file]: 0 }, pendingTools: { [file]: { 'retry:s': { t: { toolName: 'Read', toolInput: 'saved' } } } } }));
  const watcher = new TranscriptWatcher({ version: 1, watches: [{ name: 'retry', path: file, workspace: '/repo', schema }] }, state);
  let release!: () => void; (watcher as any).setupWatch = () => new Promise<void>(resolve => { release = resolve; });
  try { const start = watcher.start(); watcher.stop(); release(); await start; expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].t.toolInput).toBe('saved'); }
  finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

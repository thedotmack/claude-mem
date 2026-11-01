import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import * as watchState from '../../src/services/transcripts/state.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';

// The real ingestObservation with the worker's dependencies stubbed (as in
// tests/worker/hook-spool-drain.test.ts). While `accepting` is false the
// session cannot be resolved, so ingest declines before accepting anything.
let accepting = false;
let store: SessionStore;
const delivered: any[] = [];
beforeEach(() => {
  accepting = false;
  delivered.length = 0;
  store = new SessionStore(new Database(':memory:'));
  const createSDKSession = store.createSDKSession.bind(store);
  store.createSDKSession = ((...args: Parameters<SessionStore['createSDKSession']>) => {
    if (!accepting) throw new Error('database is locked');
    return createSDKSession(...args);
  }) as SessionStore['createSDKSession'];
  setIngestContext({
    sessionManager: {
      queueObservation: (_sessionDbId: number, message: any) => {
        delivered.push({
          toolName: message.tool_name,
          toolInput: JSON.parse(message.tool_input),
          toolResponse: JSON.parse(message.tool_response),
          toolUseId: message.toolUseId,
          cwd: message.cwd,
        });
      },
    } as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
});
afterEach(() => store.close());

const schema: TranscriptSchema = { name: 'retry', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
] };
const line = (record: unknown) => JSON.stringify(record) + '\n';
/** A watcher whose missing-transcript grace is short, so retirement tests do not wait a second. */
const quickWatcher = (config: ConstructorParameters<typeof TranscriptWatcher>[0], statePath: string) => {
  const watcher = new TranscriptWatcher(config, statePath);
  (watcher as any).missingTranscriptGraceMs = 20;
  return watcher;
};
const afterGrace = () => new Promise(resolve => setTimeout(resolve, 150));

for (const compressed of [false, true]) it(`retries a result-only ${compressed ? 'zstd' : 'JSONL'} record after watcher restart`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retry-restart-'));
  const file = join(root, compressed ? 'session.jsonl.zstd' : 'session.jsonl');
  const statePath = join(root, 'state.json');
  const use = line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } });
  const result = line({ session: 's', type: 'result', id: 't', output: 'contents' });
  const bytes = Buffer.from(use + result);
  writeFileSync(file, compressed ? zstdCompressSync(bytes) : bytes);
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
  let second: TranscriptWatcher | undefined;
  try {
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
  writeFileSync(file, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'old-long-enough-metadata-file' } }));
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  let second: TranscriptWatcher | undefined;
  try {
    accepting = true;
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    if (restart) first.stop();
    const replacement = join(root, 'new.jsonl'); writeFileSync(replacement, line({ session: 's', type: 'result', id: 't', output: 'new' }));
    renameSync(replacement, file);
    if (restart) {
      second = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
      await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask;
    } else { await (first as any).tailers.get(file).readNewData(); }
    expect(delivered).toHaveLength(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]).toEqual({});
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`retires the saved tool calls of a transcript that is gone, keeping its checkpoint${restart ? ' (after restart)' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retired-tools-'));
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { token: 'fake-secret' } }));
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = quickWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); await (first as any).tailers.get(file).readTask;
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].t.toolInput.token).toBe('fake-secret');
    const offset = statSync(file).size;
    if (restart) first.stop(); rmSync(file);
    if (restart) { second = quickWatcher({ version: 1, watches: [watch] }, state); await second.start(); }
    else (first as any).handleRootWatchEvent(root, file, watch, schema, 'session.jsonl');
    await afterGrace();
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.pendingTools[file]).toBeUndefined();
    expect(readFileSync(state, 'utf8')).not.toContain('fake-secret');
    // Only the tool calls are retired: the checkpoint stays, as for any file.
    expect(saved.offsets[file]).toBe(offset);
    expect(((second ?? first) as any).retirementCandidates.size).toBe(0);
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('retires the tool calls of several missing transcripts in one state write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retire-batch-'));
  const state = join(root, 'checkpoint.json');
  const files = ['a', 'b', 'c'].map(name => join(root, `${name}.jsonl`));
  writeFileSync(state, JSON.stringify({
    offsets: Object.fromEntries(files.map(file => [file, 10])),
    pendingTools: Object.fromEntries(files.map(file => [file, { 'retry:s': { t: { toolName: 'Read', toolInput: 'saved' } } }])),
  }));
  const watcher = quickWatcher({ version: 1, watches: [] }, state);
  const saves = spyOn(watchState, 'saveWatchState');
  try {
    await watcher.start();
    await afterGrace();
    expect(saves).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    for (const file of files) {
      expect(saved.pendingTools[file]).toBeUndefined();
      expect(saved.offsets[file]).toBe(10);
    }
  } finally { saves.mockRestore(); watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`clears pending metadata on same-inode truncation${restart ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-truncate-tools-'));
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'old-long-enough-metadata-file' } }));
  const inode = statSync(file).ino;
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    accepting = true;
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    if (restart) first.stop();
    writeFileSync(file, line({ session: 's', type: 'result', id: 't', output: 'new' }));
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
  writeFileSync(a, line({ session: 's', type: 'use', id: 'a', name: 'Read', input: { path: 'A' } }));
  writeFileSync(b, line({ session: 's', type: 'use', id: idB, name: 'Write', input: { path: 'B' } }));
  const watch = { name: 'retry', path: join(root, '*.jsonl'), workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    accepting = true;
    for (const file of [a, b]) { await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask; }
    // A later event must not copy B's pending tool into A's durable snapshot.
    appendFileSync(a, line({ session: 's', type: 'result', id: 'unmatched', output: 'ignored' }));
    await (first as any).tailers.get(a).readNewData();
    if (restart) first.stop();
    const replacement = join(root, 'replacement'); writeFileSync(replacement, line({ session: 's', type: 'use', id: 'new-a', name: 'Edit', input: { path: 'new-A' } }));
    renameSync(replacement, a);
    const current = restart ? (second = new TranscriptWatcher({ version: 1, watches: [watch] }, state)) : first;
    if (restart) for (const file of [a, b]) { await (current as any).addTailer(file, watch, schema); await (current as any).tailers.get(file).readTask; }
    else await (current as any).tailers.get(a).readNewData();
    appendFileSync(b, line({ session: 's', type: 'result', id: idB, output: 'B done' }));
    await (current as any).tailers.get(b).readNewData();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ toolName: 'Write', toolInput: { path: 'B' }, toolResponse: 'B done' });
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('does not retire saved retry metadata when stop cancels asynchronous start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cancel-metadata-')); const state = join(root, 'checkpoint.json'); const file = join(root, 'session.jsonl');
  writeFileSync(state, JSON.stringify({ offsets: { [file]: 0 }, pendingTools: { [file]: { 'retry:s': { t: { toolName: 'Read', toolInput: 'saved' } } } } }));
  const watcher = quickWatcher({ version: 1, watches: [{ name: 'retry', path: file, workspace: '/repo', schema }] }, state);
  let release!: () => void; (watcher as any).setupWatch = () => new Promise<void>(resolve => { release = resolve; });
  try {
    const start = watcher.start(); watcher.stop(); release(); await start;
    await afterGrace();
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].t.toolInput).toBe('saved');
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`matches a unique cross-file tool result${restart ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cross-result-')); accepting = true;
  const a = join(root, 'z-source.jsonl'), b = join(root, 'a-result.jsonl'), state = join(root, 'checkpoint.json');
  writeFileSync(a, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'A' } })); writeFileSync(b, '');
  const watch = { name: 'spool', path: join(root, '*.jsonl'), workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); for (const tailer of (first as any).tailers.values()) await tailer.readTask;
    if (restart) {
      first.stop(); second = new TranscriptWatcher({ version: 1, watches: [watch] }, state); await second.start();
      for (const tailer of (second as any).tailers.values()) await tailer.readTask;
    }
    const current = second ?? first;
    appendFileSync(b, line({ session: 's', type: 'result', id: 't', output: 'B result' }));
    await (current as any).tailers.get(b).readNewData();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ toolName: 'Read', toolInput: { path: 'A' }, toolResponse: 'B result' });
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[a]['spool:s']?.t).toBeUndefined();
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('does not guess between ambiguous same-ID tools from other files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-ambiguous-result-')); accepting = true;
  const files = ['a', 'b', 'c'].map(name => join(root, name + '.jsonl')); const state = join(root, 'checkpoint.json');
  for (const [index, file] of files.entries()) {
    writeFileSync(file, index === 2 ? '' : line({ session: 's', type: 'use', id: 't', name: index === 0 ? 'Read' : 'Write', input: { path: index === 0 ? 'A' : 'B' } }));
  }
  const watch = { name: 'spool', path: join(root, '*.jsonl'), workspace: '/repo', schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  try {
    await watcher.start(); for (const tailer of (watcher as any).tailers.values()) await tailer.readTask;
    appendFileSync(files[2], line({ session: 's', type: 'result', id: 't', output: 'ambiguous' }));
    await (watcher as any).tailers.get(files[2]).readNewData();
    expect(delivered).toHaveLength(0);
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('preserves tools/checkpoint across a brief same-inode disappearance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-returned-file-')); accepting = true;
  const file = join(root, 'session.jsonl'), away = join(root, 'away'), state = join(root, 'checkpoint.json');
  writeFileSync(file, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'A' } })); const inode = statSync(file).ino;
  const watch = { name: 'spool', path: file, workspace: '/repo', schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  try {
    await watcher.start(); await (watcher as any).tailers.get(file).readTask;
    renameSync(file, away); (watcher as any).handleRootWatchEvent(root, file, watch, schema, 'session.jsonl');
    await new Promise(resolve => setTimeout(resolve, 20));
    renameSync(away, file); appendFileSync(file, line({ session: 's', type: 'result', id: 't', output: 'returned' }));
    expect(statSync(file).ino).toBe(inode);
    await (watcher as any).addTailer(file, watch, schema, true); await (watcher as any).tailers.get(file).readTask;
    expect(delivered).toHaveLength(1); expect(delivered[0].toolName).toBe('Read');
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('starts a larger replacement at zero with its new cwd after disappearance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-recreated-file-')); accepting = true;
  const file = join(root, 'session.jsonl'), state = join(root, 'checkpoint.json');
  const localSchema = { ...schema, events: [{ name: 'context', match: { path: 'type', equals: 'ctx' }, action: 'session_context', fields: { cwd: 'cwd' } }, ...schema.events] } as any;
  writeFileSync(file, line({ session: 's', type: 'ctx', cwd: '/old' }) + line({ session: 's', type: 'use', id: 'old', name: 'Read', input: { path: 'old' } }));
  const watch = { name: 'spool', path: file, schema: localSchema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  try {
    await watcher.start(); await (watcher as any).tailers.get(file).readTask;
    const prior = statSync(file).size; rmSync(file); (watcher as any).handleRootWatchEvent(root, file, watch, localSchema, 'session.jsonl');
    const replacement = line({ session: 's', type: 'ctx', cwd: '/new' }) + line({ session: 's', type: 'use', id: 'new', name: 'Write', input: { path: 'X'.repeat(300) } }) + line({ session: 's', type: 'result', id: 'new', output: 'new contents' });
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(prior);
    writeFileSync(file, replacement);
    await (watcher as any).addTailer(file, watch, localSchema, true); await (watcher as any).tailers.get(file).readTask;
    expect(delivered).toHaveLength(1); expect(delivered[0]).toMatchObject({ toolName: 'Write', cwd: '/new' });
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('does not borrow tools from a file the current watch configuration excludes, and keeps them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-excluded-tool-')); accepting = true;
  const a = join(root, 'source.jsonl'), b = join(root, 'result.jsonl'), state = join(root, 'checkpoint.json');
  writeFileSync(a, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'excluded' } })); writeFileSync(b, '');
  const watch = { name: 'spool', path: a, workspace: '/repo', schema };
  const first = quickWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); await (first as any).tailers.get(a).readTask; first.stop();
    appendFileSync(b, line({ session: 's', type: 'result', id: 't', output: 'ignored' }));
    second = quickWatcher({ version: 1, watches: [{ ...watch, path: b }] }, state);
    await second.start(); await (second as any).tailers.get(b).readTask;
    expect(delivered).toHaveLength(0);
    await afterGrace();
    // The retirement check ran, and kept them: not tailed is not gone (the watch may come back).
    expect((second as any).retirementCandidates.size).toBe(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[a]['spool:s'].t.toolName).toBe('Read');
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('cancels bounded retirement timers on stop without deleting valid retry state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-stop-retirement-')); const file = join(root, 'session.jsonl'), state = join(root, 'checkpoint.json');
  writeFileSync(state, JSON.stringify({ offsets: { [file]: 20 }, pendingTools: { [file]: { 'spool:s': { t: { toolName: 'Read' } } } } }));
  const watcher = quickWatcher({ version: 1, watches: [] }, state);
  try {
    await watcher.start(); expect((watcher as any).retirementCandidates.size).toBe(1);
    watcher.stop(); expect((watcher as any).retirementCandidates.size).toBe(0);
    await afterGrace();
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.offsets[file]).toBe(20);
    expect(saved.pendingTools[file]['spool:s'].t.toolName).toBe('Read');
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('does not lend truncated source metadata to an earlier-enumerated result after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-truncated-cross-')); accepting = true;
  const source = join(root, 'z-source.jsonl'), result = join(root, 'a-result.jsonl'), state = join(root, 'checkpoint.json');
  writeFileSync(source, line({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'retired-original-input' } })); writeFileSync(result, '');
  const watch = { name: 'spool', path: join(root, '*.jsonl'), workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); for (const tailer of (first as any).tailers.values()) await tailer.readTask; first.stop();
    const inode = statSync(source).ino; writeFileSync(source, '{}\n'); expect(statSync(source).ino).toBe(inode);
    appendFileSync(result, line({ session: 's', type: 'result', id: 't', output: 'new' }));
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
    const add = (second as any).addTailer.bind(second);
    (second as any).addTailer = async (file: string, ...args: any[]) => { if (file === source) await new Promise(resolve => setTimeout(resolve, 50)); return add(file, ...args); };
    await second.start(); for (const tailer of (second as any).tailers.values()) await tailer.readTask;
    expect(delivered).toHaveLength(0);
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('rewinds a replacement that returns after disappearing before tailer attachment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-attach-replacement-')); accepting = true;
  const file = join(root, 'session.jsonl'), away = join(root, 'away'), state = join(root, 'checkpoint.json');
  writeFileSync(file, line({ session: 's', type: 'use', id: 'old', name: 'Read', input: { path: 'old' } }));
  const watch = { name: 'spool', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); await (first as any).tailers.get(file).readTask; first.stop(); renameSync(file, away);
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
    await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask;
    writeFileSync(file, line({ session: 's', type: 'use', id: 'new', name: 'Write', input: { path: 'x'.repeat(300) } }) + line({ session: 's', type: 'result', id: 'new', output: 'returned new' }));
    await (second as any).tailers.get(file).readNewData();
    expect(delivered).toHaveLength(1); expect(delivered[0].toolName).toBe('Write');
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("keeps only a file's newest 64 outstanding tool calls", async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-capped-tools-'));
  const file = join(root, 'session.jsonl'), state = join(root, 'checkpoint.json');
  // Interrupted turns: tool calls whose results never come.
  writeFileSync(file, Array.from({ length: 70 }, (_, index) => line({ session: 's', type: 'use', id: `t${index}`, name: 'Read', input: { path: `f${index}` } })).join(''));
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  try {
    await watcher.start(); await (watcher as any).tailers.get(file).readTask;
    const ids = Object.keys(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s']);
    expect(ids).toHaveLength(64);
    expect(ids[0]).toBe('t6');
    expect(ids.at(-1)).toBe('t69');
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('saves only the name of a tool call whose input is larger than 64 KiB, and still sends the input in-process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-large-tool-input-')); accepting = true;
  const file = join(root, 'session.jsonl'), state = join(root, 'checkpoint.json');
  const content = 'x'.repeat(70 * 1024);
  writeFileSync(file, line({ session: 's', type: 'use', id: 'w', name: 'Write', input: { content } }));
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, state);
  try {
    await watcher.start(); await (watcher as any).tailers.get(file).readTask;
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].w).toEqual({ toolName: 'Write' });
    appendFileSync(file, line({ session: 's', type: 'result', id: 'w', output: 'written' }));
    await (watcher as any).tailers.get(file).readNewData();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ toolName: 'Write', toolInput: { content }, toolResponse: 'written' });
  } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

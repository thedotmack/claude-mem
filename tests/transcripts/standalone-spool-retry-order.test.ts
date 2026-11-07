import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { nudgeWorkerToDrainHookSpool, settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import * as workerUtils from '../../src/shared/worker-utils.js';

const original = process.env.CLAUDE_MEM_DATA_DIR;
afterEach(async () => {
  await settleHookSpoolNudges();
  if (original === undefined) delete process.env.CLAUDE_MEM_DATA_DIR; else process.env.CLAUDE_MEM_DATA_DIR = original;
});
const schema = { name: 'spool', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
  { name: 'edit', match: { path: 'type', equals: 'edit' }, action: 'file_edit', fields: { filePath: 'path' } },
  { name: 'end', match: { path: 'type', equals: 'end' }, action: 'session_end' },
] } as any;

// Records each live observer handoff and answers as an unavailable worker:
// the contract skips the event, so nothing may be retried or spooled.
function unavailableWorker() {
  const handoffs: { path: string; body: any }[] = [];
  const request = spyOn(workerUtils, 'workerHttpRequest').mockImplementation(async (path: string, init: any = {}) => {
    handoffs.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    throw new Error('worker unavailable');
  });
  return { handoffs, request };
}

function diskSpoolEntries(): any[] {
  const entries: any[] = [];
  return new HookSpool().drain(entry => { entries.push(entry); return true; }).then(() => entries);
}

it('pairs a pending tool across restart and hands result and summary off live once, in order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-standalone-live-'));
  process.env.CLAUDE_MEM_DATA_DIR = root;
  const file = join(root, 'session.jsonl'); const state = join(root, 'state.json');
  const use = JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } }) + '\n';
  writeFileSync(file, use);
  const watch = { name: 'spool', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool');
  let second: TranscriptWatcher | undefined;
  const { handoffs, request } = unavailableWorker();
  try {
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    first.stop();
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.offsets[file]).toBe(Buffer.byteLength(use));
    expect(saved.pendingTools[file]['spool:s'].t.toolName).toBe('Read');
    writeFileSync(file, use + JSON.stringify({ session: 's', type: 'result', id: 't', output: 'contents' }) + '\n' + JSON.stringify({ session: 's', type: 'end' }) + '\n');
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool');
    await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask;
    await settleHookSpoolNudges();
    const observer = handoffs.filter(h => h.path === '/api/sessions/observations' || h.path === '/api/sessions/summarize');
    expect(observer.map(h => h.path)).toEqual(['/api/sessions/observations', '/api/sessions/summarize']);
    expect(observer[0].body).toMatchObject({ contentSessionId: 's', tool_name: 'Read', tool_input: { path: 'a' }, tool_response: 'contents' });
    expect(observer[1].body).toMatchObject({ contentSessionId: 's' });
    // A failed handoff is skipped: the cursor moves on and nothing is kept for replay.
    expect(JSON.parse(readFileSync(state, 'utf8')).offsets[file]).toBe(Buffer.byteLength(readFileSync(file)));
    expect(await diskSpoolEntries()).toEqual([]);
  } finally { first.stop(); second?.stop(); await settleHookSpoolNudges(); request.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it('hands a transcript file edit off live once, with no disk spool or retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-standalone-edit-'));
  process.env.CLAUDE_MEM_DATA_DIR = root;
  const watch = { name: 'spool', path: '/unused', workspace: '/repo', schema };
  const processor = new TranscriptEventProcessor('spool');
  const edit = { session: 's', type: 'edit', path: 'src/a.ts' };
  const { handoffs, request } = unavailableWorker();
  try {
    await processor.processEntry(edit, watch, schema);
    await settleHookSpoolNudges();
    expect(handoffs.map(h => h.path)).toEqual(['/api/sessions/observations']);
    expect(handoffs[0].body).toMatchObject({ contentSessionId: 's', tool_input: { filePath: 'src/a.ts' } });
    expect(await diskSpoolEntries()).toEqual([]);
  } finally { await settleHookSpoolNudges(); request.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it('keeps same-session summaries behind a declined observation while other sessions progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-spool-order-')); process.env.CLAUDE_MEM_DATA_DIR = root;
  try {
    const spool = new HookSpool();
    spool.enqueue('observation', { contentSessionId: 'a', platformSource: 'claude', toolName: 'Read', toolInput: null, toolResponse: 'contents', toolUseId: 'a1' });
    spool.enqueue('summarize', { contentSessionId: 'a', platformSource: 'claude', lastAssistantMessage: 'done' });
    spool.enqueue('observation', { contentSessionId: 'b', platformSource: 'claude', toolName: 'Read', toolInput: null, toolResponse: 'other', toolUseId: 'b1' });
    const seen: string[] = [];
    const first = await spool.drain(entry => { seen.push(entry.payload.contentSessionId + ':' + entry.kind); return entry.payload.contentSessionId !== 'a'; });
    expect(seen).toEqual(['a:observation', 'b:observation']); expect(first.retained).toBe(2);
    seen.length = 0;
    await spool.drain(entry => { seen.push(entry.payload.contentSessionId + ':' + entry.kind); return true; });
    expect(seen).toEqual(['a:observation', 'a:summarize']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not hold a session's observations behind its summary retained for an unknown session", async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-spool-unknown-session-')); process.env.CLAUDE_MEM_DATA_DIR = root;
  try {
    const spool = new HookSpool();
    // The summary arrives first; the worker does not know the session until an observation creates it.
    spool.enqueue('summarize', { contentSessionId: 'late', platformSource: 'claude', lastAssistantMessage: 'done' });
    spool.enqueue('observation', { contentSessionId: 'late', platformSource: 'claude', toolName: 'Read', toolInput: null, toolResponse: 'contents', toolUseId: 'l1' });
    let sessionKnown = false;
    const seen: string[] = [];
    const accept = (entry: any) => {
      seen.push(entry.kind);
      if (entry.kind === 'observation') { sessionKnown = true; return true; }
      return sessionKnown;
    };
    const first = await spool.drain(accept);
    expect(seen).toEqual(['summarize', 'observation']);
    expect(first).toMatchObject({ drained: 1, retained: 1 });
    seen.length = 0;
    const second = await spool.drain(accept);
    expect(seen).toEqual(['summarize']);
    expect(second).toMatchObject({ drained: 1, retained: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('shares one in-flight worker nudge across a burst of spooled events', async () => {
  let resolveRequest!: (response: Response) => void;
  const request = spyOn(workerUtils, 'workerHttpRequest').mockImplementation(() => new Promise<Response>(resolve => { resolveRequest = resolve; }));
  try {
    const nudges = Array.from({ length: 50 }, () => nudgeWorkerToDrainHookSpool());
    expect(request).toHaveBeenCalledTimes(1);
    expect(new Set(nudges).size).toBe(1);
    resolveRequest(new Response(null));
    await settleHookSpoolNudges();
    void nudgeWorkerToDrainHookSpool();
    expect(request).toHaveBeenCalledTimes(2);
    resolveRequest(new Response(null));
    await settleHookSpoolNudges();
  } finally { request.mockRestore(); }
});

import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
const original = process.env.CLAUDE_MEM_DATA_DIR;
afterEach(async () => { await settleHookSpoolNudges(); if (original === undefined) delete process.env.CLAUDE_MEM_DATA_DIR; else process.env.CLAUDE_MEM_DATA_DIR = original; });
const schema = { name: 'spool', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
  { name: 'end', match: { path: 'type', equals: 'end' }, action: 'session_end' },
] } as any;
it('retries a disk-rejected result after restart and spools summary behind it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-standalone-retry-'));
  process.env.CLAUDE_MEM_DATA_DIR = root;
  const file = join(root, 'session.jsonl'); const state = join(root, 'state.json');
  const use = JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } }) + '\n';
  writeFileSync(file, use + JSON.stringify({ session: 's', type: 'result', id: 't', output: 'contents' }) + '\n' + JSON.stringify({ session: 's', type: 'end' }) + '\n');
  const obstruction = join(root, 'state'); writeFileSync(obstruction, 'blocks spool directory');
  const watch = { name: 'spool', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool');
  let second: TranscriptWatcher | undefined;
  try {
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    first.stop();
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.offsets[file]).toBe(Buffer.byteLength(use));
    expect(saved.pendingTools[file]['spool:s'].t.toolName).toBe('Read');
    rmSync(obstruction);
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool');
    await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask;
    const entries: any[] = [];
    await new HookSpool().drain(entry => { entries.push(entry); return true; });
    expect(entries.map(entry => entry.kind)).toEqual(['observation', 'summarize']);
    expect(entries[0].payload).toMatchObject({ toolName: 'Read', toolInput: { path: 'a' }, toolResponse: 'contents' });
    expect(JSON.parse(readFileSync(state, 'utf8')).offsets[file]).toBe(Buffer.byteLength(readFileSync(file)));
  } finally { first.stop(); second?.stop(); await settleHookSpoolNudges(); rmSync(root, { recursive: true, force: true }); }
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

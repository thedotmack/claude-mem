import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ingestSummarize, setIngestContext } from '../../src/services/worker/http/shared.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import * as workerUtils from '../../src/shared/worker-utils.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';

const schema: TranscriptSchema = { name: 'summary-handoff', sessionIdPath: 'session', events: [
  { name: 'assistant', match: { path: 'type', equals: 'assistant' }, action: 'assistant_message', fields: { message: 'text' } },
  { name: 'end', match: { path: 'type', equals: 'end' }, action: 'session_end' },
] };
const watch = { name: 'summary-handoff', path: '/unused', workspace: '/repo', schema };
let store: SessionStore;
let failure: 'queue' | 'kick' | null;
let queued: Array<string | undefined>;
let ready: ReturnType<typeof spyOn>;
let request: ReturnType<typeof spyOn>;
let root: string;
beforeEach(() => {
  store = new SessionStore(new Database(':memory:'));
  store.createSDKSession('s', 'repo', 'prompt', undefined, 'summary-handoff');
  failure = null;
  queued = [];
  // The old HTTP path must never start or contact a real worker.
  ready = spyOn(workerUtils, 'ensureWorkerRunning').mockResolvedValue(true);
  request = spyOn(workerUtils, 'workerHttpRequest').mockImplementation(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    try {
      await ingestSummarize({ contentSessionId: body.contentSessionId, platformSource: body.platformSource,
        lastAssistantMessage: body.last_assistant_message, cwd: body.cwd });
      return new Response('{"status":"queued"}');
    } catch {
      // The route's wrapHandler returns an error for either a queue rejection
      // or a generator-kick failure. It cannot expose the handoff boundary.
      return new Response('{"error":"ingest failed"}', { status: 500 });
    }
  });
  root = mkdtempSync(join(tmpdir(), 'cm-summary-handoff-'));
  setIngestContext({
    sessionManager: { queueSummarize: (_id: number, message?: string) => {
      if (failure === 'queue') throw new Error('queue unavailable');
      queued.push(message);
    } } as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: { broadcastSummarizeQueued: () => {} } as any,
    ensureGeneratorRunning: async () => { if (failure === 'kick') throw new Error('kick failed'); },
  });
});
afterEach(() => {
  ready.mockRestore();
  request.mockRestore();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('in-process transcript summary handoff', () => {
  it('surfaces a rejected queue operation and retains the assistant text for the existing retry', async () => {
    const processor = new TranscriptEventProcessor();
    await processor.processEntry({ session: 's', type: 'assistant', text: 'finished work' }, watch, schema);
    failure = 'queue';
    await expect(processor.processEntry({ session: 's', type: 'end' }, watch, schema))
      .rejects.toThrow('summary not accepted');
    expect(queued).toEqual([]);
    failure = null;
    await processor.processEntry({ session: 's', type: 'end' }, watch, schema);
    expect(queued).toEqual(['finished work']);
    expect(ready).not.toHaveBeenCalled();
  });

  it('does not reject a summary already queued when the generator kick fails', async () => {
    failure = 'kick';
    const processor = new TranscriptEventProcessor();
    await expect(processor.processEntry({ session: 's', type: 'end' }, watch, schema)).resolves.toBeUndefined();
    expect(queued).toEqual(['']);
    expect((processor as any).sessions.size).toBe(0);
  });

  it('preserves the terminal skip for an unknown session', async () => {
    const processor = new TranscriptEventProcessor();
    await expect(processor.processEntry({ session: 'unknown', type: 'end' }, watch, schema)).resolves.toBeUndefined();
    expect(queued).toEqual([]);
    expect((processor as any).sessions.size).toBe(0);
  });

  it('honors excluded projects without queuing or retaining the session', async () => {
    const previous = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'repo';
    try {
      const processor = new TranscriptEventProcessor();
      await processor.processEntry({ session: 's', type: 'end' }, watch, schema);
      expect(queued).toEqual([]);
      expect((processor as any).sessions.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      else process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = previous;
    }
  });

  it('honors an entirely private prompt without queuing or retaining the session', async () => {
    const id = store.findSessionDbIdByContentSessionId('s', 'summary-handoff')!;
    store.saveUserPrompt('s', 1, '', id);
    const processor = new TranscriptEventProcessor();
    await processor.processEntry({ session: 's', type: 'end' }, watch, schema);
    expect(queued).toEqual([]);
    expect((processor as any).sessions.size).toBe(0);
  });

  it('retains the rejected end event across restart without claiming to persist assistant text', async () => {
    const path = join(root, 'restart.jsonl');
    const statePath = join(root, 'restart-state.json');
    const assistant = JSON.stringify({ session: 's', type: 'assistant', text: 'finished work' }) + '\n';
    const end = JSON.stringify({ session: 's', type: 'end' }) + '\n';
    writeFileSync(path, assistant + end);
    const fileWatch = { ...watch, path };
    const first = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    failure = 'queue';
    try {
      await (first as any).addTailer(path, fileWatch, schema);
      await (first as any).tailers.get(path).readTask;
      expect(loadWatchState(statePath).offsets[path]).toBe(Buffer.byteLength(assistant));
    } finally { first.stop(); }
    failure = null;
    const resumed = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    try {
      await (resumed as any).addTailer(path, fileWatch, schema);
      await (resumed as any).tailers.get(path).readTask;
      // Assistant text is not part of the existing durable watcher state.
      expect(queued).toEqual(['']);
      expect(loadWatchState(statePath).offsets[path]).toBe(Buffer.byteLength(assistant + end));
    } finally { resumed.stop(); }
  });

  it('keeps the watcher checkpoint at the rejected session_end line', async () => {
    const path = join(root, 'session.jsonl');
    const statePath = join(root, 'state.json');
    const assistant = JSON.stringify({ session: 's', type: 'assistant', text: 'finished work' }) + '\n';
    const end = JSON.stringify({ session: 's', type: 'end' }) + '\n';
    writeFileSync(path, assistant + end);
    const fileWatch = { ...watch, path };
    const watcher = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    failure = 'queue';
    try {
      await (watcher as any).addTailer(path, fileWatch, schema);
      await (watcher as any).tailers.get(path).readTask;
      expect(loadWatchState(statePath).offsets[path]).toBe(Buffer.byteLength(assistant));
      expect(queued).toEqual([]);
      failure = null;
      await (watcher as any).tailers.get(path).readNewData();
      expect(queued).toEqual(['finished work']);
      expect(loadWatchState(statePath).offsets[path]).toBe(Buffer.byteLength(assistant + end));
    } finally { watcher.stop(); }
  });
});

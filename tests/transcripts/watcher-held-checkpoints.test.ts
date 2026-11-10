import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';

const schema: TranscriptSchema = { name: 'live', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
] };
const line = (record: unknown) => JSON.stringify(record) + '\n';
const tool = (session: string, id: string) =>
  line({ session, type: 'use', id, name: 'Read', input: { path: id } })
  + line({ session, type: 'result', id, output: id });
let root: string;
let store: SessionStore;
let buffer: SessionMessageBuffer;
let unavailable: boolean;
let queued: ReturnType<typeof mock>;
let providerStarts: ReturnType<typeof mock>;
const watchers: TranscriptWatcher[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-live-checkpoints-'));
  store = new SessionStore(new Database(':memory:'));
  buffer = new SessionMessageBuffer();
  unavailable = false;
  queued = mock((sessionDbId: number, message: { toolUseId?: string }) => {
    if (unavailable) throw new Error('worker unavailable');
    buffer.enqueue(sessionDbId, { type: 'observation', toolUseId: message.toolUseId } as any);
  });
  providerStarts = mock(async () => {});
  setIngestContext({
    sessionManager: { queueObservation: queued } as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: providerStarts,
  });
});

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(path: string, statePath: string): Promise<TranscriptWatcher> {
  const watch = { name: 'live', path, workspace: '/repo', schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
  watchers.push(watcher);
  await (watcher as any).addTailer(path, watch, schema);
  await (watcher as any).tailers.get(path).readTask;
  return watcher;
}

async function read(watcher: TranscriptWatcher, path: string): Promise<void> {
  const tailer = (watcher as any).tailers.get(path);
  tailer.poke();
  await tailer.readTask;
}

for (const restart of [false, true]) it(`an outage across sessions never sends old lines after ${restart ? 'restart' : 'recovery'}, while fresh capture starts`, async () => {
  const path = join(root, 'sessions.jsonl');
  const statePath = join(root, 'state.json');
  writeFileSync(path, ['a', 'b', 'c'].map(session => tool(session, 'outage-' + session)).join(''));
  unavailable = true;
  const first = await start(path, statePath);
  expect(providerStarts).not.toHaveBeenCalled();
  expect(loadWatchState(statePath).offsets[path]).toBe(statSync(path).size);
  expect(loadWatchState(statePath).pendingTools?.[path]).toEqual({});
  if (restart) {
    first.stop();
    buffer = new SessionMessageBuffer();
  }
  unavailable = false;
  queued.mockClear();
  const active = restart ? await start(path, statePath) : first;
  await read(active, path);
  expect(queued).not.toHaveBeenCalled();
  expect(providerStarts).not.toHaveBeenCalled();
  appendFileSync(path, tool('a', 'fresh'));
  await read(active, path);
  expect(queued).toHaveBeenCalledTimes(1);
  expect(queued.mock.calls[0][1]).toMatchObject({ toolUseId: 'fresh' });
  expect(providerStarts).toHaveBeenCalledTimes(1);
});

it('persists consumed offsets before buffered work commits, so a restart cannot replay uncommitted work', async () => {
  const path = join(root, 'buffered.jsonl');
  const statePath = join(root, 'state.json');
  writeFileSync(path, tool('s', 'uncommitted'));
  const first = await start(path, statePath);
  expect(queued).toHaveBeenCalledTimes(1);
  expect(providerStarts).toHaveBeenCalledTimes(1);
  expect(loadWatchState(statePath).offsets[path]).toBe(statSync(path).size);
  first.stop();
  buffer = new SessionMessageBuffer();
  const restarted = await start(path, statePath);
  await read(restarted, path);
  expect(queued).toHaveBeenCalledTimes(1);
  expect(providerStarts).toHaveBeenCalledTimes(1);
  appendFileSync(path, tool('s', 'fresh'));
  await read(restarted, path);
  expect(queued).toHaveBeenCalledTimes(2);
  expect(queued.mock.calls[1][1]).toMatchObject({ toolUseId: 'fresh' });
  expect(providerStarts).toHaveBeenCalledTimes(2);
});

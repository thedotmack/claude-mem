import { afterAll, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import type { TranscriptCheckpointGate, TranscriptSchema } from '../../src/services/transcripts/types.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';

const root = mkdtempSync(join(tmpdir(), 'cm-held-checkpoints-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function readAll(watcher: TranscriptWatcher, path: string, watch: object, schema: object): Promise<void> {
  await (watcher as any).addTailer(path, watch, schema);
  await (watcher as any).tailers.get(path).readTask;
}

it('saves a checkpoint only once the work its lines buffered is stored, so a restart resumes at unstored work', async () => {
  const path = join(root, 'session.jsonl');
  const statePath = join(root, 'state.json');
  const lines = ['{"n":1}', '{"n":2}', '{"n":3}'];
  writeFileSync(path, lines.join('\n') + '\n');
  const schema = { name: 'held', events: [] };
  const watch = { name: 'held', path, schema };

  // Each line buffers one message; `storedThrough` is the newest one stored.
  let sequence = 0;
  let storedThrough = 0;
  const gate: TranscriptCheckpointGate = {
    sequence: () => sequence,
    drainedThrough: (_sessions, upTo) => upTo <= storedThrough,
  };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', gate);
  (watcher as any).handleLine = async () => { sequence++; };
  try {
    await readAll(watcher, path, watch, schema);
    expect(loadWatchState(statePath).offsets[path] ?? 0).toBe(0);

    storedThrough = 1;
    (watcher as any).commitHeldCheckpoints();
    expect(loadWatchState(statePath).offsets[path]).toBe(Buffer.byteLength(lines[0] + '\n'));
  } finally {
    watcher.stop();
  }

  // The worker died with messages 2 and 3 still buffered.
  const resumed = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
  const replayed: string[] = [];
  (resumed as any).handleLine = async (line: string) => { replayed.push(line); };
  try {
    await readAll(resumed, path, watch, schema);
    expect(replayed).toEqual(lines.slice(1));
  } finally {
    resumed.stop();
  }
});

it('saves the newest checkpoint once everything is stored', async () => {
  const path = join(root, 'drained.jsonl');
  const statePath = join(root, 'drained-state.json');
  writeFileSync(path, '{"n":1}\n{"n":2}\n');
  const schema = { name: 'drained', events: [] };
  const watch = { name: 'drained', path, schema };
  let sequence = 0;
  let storedThrough = 0;
  const gate: TranscriptCheckpointGate = { sequence: () => sequence, drainedThrough: (_s, upTo) => upTo <= storedThrough };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', gate);
  (watcher as any).handleLine = async () => { sequence++; };
  try {
    await readAll(watcher, path, watch, schema);
    storedThrough = sequence;
    (watcher as any).commitHeldCheckpoints();
    expect(loadWatchState(statePath).offsets[path]).toBe(statSync(path).size);
    expect((watcher as any).heldCheckpoints.size).toBe(0);
  } finally {
    watcher.stop();
  }
});

it('drops a retired transcript\'s held checkpoints, so its saved tool inputs are never written back', async () => {
  const path = join(root, 'retired.jsonl');
  const statePath = join(root, 'retired-state.json');
  writeFileSync(path, '{"n":1}\n{"n":2}\n');
  const schema = { name: 'retired', events: [] };
  const watch = { name: 'retired', path, schema };
  let sequence = 0;
  let storedThrough = 0;
  const gate: TranscriptCheckpointGate = { sequence: () => sequence, drainedThrough: (_s, upTo) => upTo <= storedThrough };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', gate);
  // Each line buffers one message and leaves a tool call whose input holds a secret.
  (watcher as any).handleLine = async (_line: string, _w: unknown, _s: unknown, _f: string, _o: unknown, fileContext: any) => {
    sequence++;
    fileContext.pendingTools = { session: { [`tool-${sequence}`]: { toolName: 'Bash', toolInput: { command: 'export TOKEN=secret' } } } };
  };
  try {
    await readAll(watcher, path, watch, schema);
    expect((watcher as any).heldCheckpoints.has(path)).toBe(true);

    // The transcript disappears and is retired while its checkpoints are still held.
    (watcher as any).tailers.get(path).close();
    (watcher as any).tailers.delete(path);
    rmSync(path);
    (watcher as any).retirementCandidates.add(path);
    (watcher as any).retireMissingTranscripts();

    storedThrough = sequence;
    (watcher as any).commitHeldCheckpoints();
    const state = loadWatchState(statePath);
    expect(state.pendingTools?.[path]).toBeUndefined();
    expect(state.offsets[path]).toBeUndefined();
    expect((watcher as any).heldCheckpoints.has(path)).toBe(false);
  } finally {
    watcher.stop();
  }
});

it('keeps per-line recovery points in memory and writes the state file once per batch, not after every line', async () => {
  const path = join(root, 'batched.jsonl');
  const statePath = join(root, 'batched-state.json');
  writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":3}\n');
  const schema = { name: 'batched', events: [] };
  const watch = { name: 'batched', path, schema };
  let sequence = 0;
  const gate: TranscriptCheckpointGate = { sequence: () => sequence, drainedThrough: () => true };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', gate);
  const savedOffsetSeenByLine: number[] = [];
  (watcher as any).handleLine = async () => {
    sequence++;
    savedOffsetSeenByLine.push(loadWatchState(statePath).offsets[path] ?? 0);
  };
  try {
    await readAll(watcher, path, watch, schema);
    // Every line's work was stored at once, yet nothing was written mid-read.
    expect(savedOffsetSeenByLine).toEqual([0, 0, 0]);
    expect(loadWatchState(statePath).offsets[path]).toBe(statSync(path).size);
  } finally {
    watcher.stop();
  }
});

// Live-only observer contract (AGENTS.md, docs/architecture/observer-lifecycle.md):
// a worker restart must not cause later, unrequested inference spend. The
// watcher holds its checkpoint while work is buffered, so after a restart it
// re-reads lines whose observation may already have committed.
it('a restart that re-reads a held checkpoint does not re-queue or re-spend on committed work, and fresh capture still starts', async () => {
  const dir = mkdtempSync(join(root, 'restart-no-spend-'));
  const path = join(dir, 'session.jsonl');
  const statePath = join(dir, 'state.json');
  const schema: TranscriptSchema = { name: 'restart', sessionIdPath: 'session', events: [
    { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
    { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
  ] };
  const line = (record: unknown) => JSON.stringify(record) + '\n';
  writeFileSync(path,
    line({ session: 's', type: 'use', id: 'toolu_done', name: 'Read', input: { path: 'a' } })
    + line({ session: 's', type: 'result', id: 'toolu_done', output: 'contents' }));
  const watch = { name: 'restart', path, workspace: '/repo', schema };

  // The real ingestObservation, feeding a real SessionMessageBuffer. Starting
  // the generator is the only way queued work reaches the paid provider.
  const store = new SessionStore(new Database(':memory:'));
  let buffer = new SessionMessageBuffer();
  const queueObservation = mock((sessionDbId: number, message: { toolUseId?: string }) =>
    buffer.enqueue(sessionDbId, { type: 'observation', toolUseId: message.toolUseId } as any));
  const providerStarts = mock(async () => {});
  setIngestContext({
    sessionManager: { queueObservation } as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: providerStarts,
  });
  // The checkpoint stays held: nothing the watcher buffered counts as stored.
  const heldGate: TranscriptCheckpointGate = { sequence: () => 0, drainedThrough: () => false };

  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', heldGate);
  let second: TranscriptWatcher | undefined;
  try {
    await readAll(first, path, watch, schema);
    expect(queueObservation).toHaveBeenCalledTimes(1);
    expect(providerStarts).toHaveBeenCalledTimes(1);

    // The observer answered and its result committed with the terminal marker.
    const session = store.db.prepare(
      "SELECT platform_source FROM sdk_sessions WHERE content_session_id = 's'"
    ).get() as { platform_source: string };
    store.db.transaction(() => store.markCommittedToolUses({
      platformSource: session.platform_source, contentSessionId: 's', toolUseIds: ['toolu_done'],
    }))();

    // The worker dies before the held checkpoint is written.
    first.stop();
    expect(loadWatchState(statePath).offsets[path] ?? 0).toBe(0);

    // A fresh worker: the in-memory toolUseId dedup is gone, the DB is not.
    buffer = new SessionMessageBuffer();
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', heldGate);
    await readAll(second, path, watch, schema);
    expect(queueObservation).toHaveBeenCalledTimes(1);
    expect(providerStarts).toHaveBeenCalledTimes(1);

    // New activity after the restart is still captured. The append can also
    // wake the tailer's own file watch, so count by tool use: the committed
    // one is never queued again, and the new one is queued and starts work.
    appendFileSync(path,
      line({ session: 's', type: 'use', id: 'toolu_new', name: 'Read', input: { path: 'b' } })
      + line({ session: 's', type: 'result', id: 'toolu_new', output: 'fresh' }));
    await (second as any).tailers.get(path).readNewData();
    const queuedFor = (toolUseId: string) => queueObservation.mock.calls
      .filter(call => (call[1] as { toolUseId?: string }).toolUseId === toolUseId).length;
    expect(queuedFor('toolu_done')).toBe(1);
    expect(queuedFor('toolu_new')).toBeGreaterThanOrEqual(1);
    expect(providerStarts.mock.calls.length).toBeGreaterThan(1);
  } finally {
    first.stop();
    second?.stop();
    store.close();
  }
});

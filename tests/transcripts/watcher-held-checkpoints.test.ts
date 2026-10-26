import { afterAll, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import type { TranscriptCheckpointGate } from '../../src/services/transcripts/types.js';

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

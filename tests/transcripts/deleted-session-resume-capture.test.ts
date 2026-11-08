// A session the user deleted keeps out every transcript line from before the
// deletion, including the ones a restarted worker re-reads from a held
// checkpoint, while a resumed conversation's new lines are captured again
// (follow-up to #5321). Transcript path: the real watcher and processor, the
// real prompt anchor (recordSessionPrompt) and the real worker routes.
import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import type { TranscriptCheckpointGate, TranscriptSchema } from '../../src/services/transcripts/types.js';
import { deleteSessionLikeTheViewer, startCaptureWorker, type CaptureWorker } from '../helpers/deleted-session-capture-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'cm-deleted-transcript-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SESSION = 'resumed-transcript';
const schema: TranscriptSchema = { name: 'resume', sessionIdPath: 'session', events: [
  { name: 'user', match: { path: 'type', equals: 'user' }, action: 'user_message', fields: { message: 'text' } },
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
] };
const line = (record: Record<string, unknown>) => JSON.stringify({ session: SESSION, ...record }) + '\n';
const turn = (prompt: string, toolUseId: string, at: number | null) => {
  const timestamp = at === null ? {} : { timestamp: new Date(at).toISOString() };
  return line({ ...timestamp, type: 'user', text: prompt })
    + line({ ...timestamp, type: 'use', id: toolUseId, name: 'Read', input: { path: toolUseId } })
    + line({ ...timestamp, type: 'result', id: toolUseId, output: `contents of ${toolUseId}` });
};
// The checkpoint stays held: nothing the watcher buffered counts as stored,
// so every restart re-reads the file from the start.
const heldGate: TranscriptCheckpointGate = { sequence: () => 0, drainedThrough: () => false };

let worker: CaptureWorker;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(root, 'run-'));
  worker = await startCaptureWorker();
});
afterEach(async () => { await worker.close(); });

async function startWatcher(path: string, statePath: string) {
  const watch = { name: 'resume', path, workspace: dir, schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath, 'in-process', heldGate);
  await (watcher as any).addTailer(path, watch, schema);
  await (watcher as any).tailers.get(path).readTask;
  return watcher;
}
const queuedFor = (toolUseId: string) => worker.queuedToolUseIds.filter(id => id === toolUseId).length;

it('a restart re-reading lines from before the deletion captures none of them, and new lines in the resumed conversation are captured', async () => {
  const path = join(dir, 'session.jsonl');
  const statePath = join(dir, 'state.json');
  writeFileSync(path, turn('old prompt', 'toolu_old', Date.now() - 60_000));

  const first = await startWatcher(path, statePath);
  let second: TranscriptWatcher | undefined;
  let third: TranscriptWatcher | undefined;
  try {
    expect(worker.promptTexts(SESSION)).toEqual(['old prompt']);
    expect(queuedFor('toolu_old')).toBe(1);
    const [{ platform_source: platformSource }] = worker.sessionRows(SESSION);

    deleteSessionLikeTheViewer(worker.store, platformSource, SESSION);
    first.stop();

    // A fresh worker re-reads the held lines: none of them comes back.
    second = await startWatcher(path, statePath);
    expect(worker.sessionRows(SESSION)).toHaveLength(0);
    expect(worker.promptTexts(SESSION)).toEqual([]);
    expect(worker.toolUseIds(SESSION)).toEqual([]);
    expect(queuedFor('toolu_old')).toBe(1);

    // The user resumes the conversation: its new lines are captured.
    await Bun.sleep(5);
    appendFileSync(path, turn('resumed prompt', 'toolu_new', Date.now()));
    // A line with no timestamp cannot prove it is newer than the deletion.
    appendFileSync(path, turn('untimed prompt', 'toolu_untimed', null));
    await (second as any).tailers.get(path).readNewData();
    expect(worker.sessionRows(SESSION)).toHaveLength(1);
    expect(worker.promptTexts(SESSION)).toEqual(['resumed prompt']);
    expect(worker.toolUseIds(SESSION)).toEqual(['toolu_new']);
    expect(queuedFor('toolu_new')).toBeGreaterThanOrEqual(1);
    expect(queuedFor('toolu_untimed')).toBe(0);
    second.stop();

    // Another restart after the session exists again: old lines still stay out.
    third = await startWatcher(path, statePath);
    expect(worker.promptTexts(SESSION)).not.toContain('old prompt');
    expect(worker.toolUseIds(SESSION)).toEqual(['toolu_new']);
    expect(queuedFor('toolu_old')).toBe(1);
    expect(queuedFor('toolu_untimed')).toBe(0);
    expect(worker.deletionSkipsLogged().length).toBeGreaterThanOrEqual(4);
  } finally {
    first.stop();
    second?.stop();
    third?.stop();
  }
});

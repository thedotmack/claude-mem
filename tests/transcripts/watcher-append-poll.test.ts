import { afterEach, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';

/** Short enough for the suite; production uses TAILED_APPEND_POLL_MS. */
const POLL_MS = 40;
/**
 * Longer than the root watch's settle delay, so a callback queued for the
 * initial write runs before the append under test.
 */
const WATCH_FLUSH_MS = 150;

const roots: string[] = [];
const watchers: TranscriptWatcher[] = [];
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const contextLine = (cwd: string) => JSON.stringify({ cwd }) + '\n';
const contextSchema = {
  name: 'context',
  sessionIdPath: 'session',
  events: [{
    name: 'context',
    action: 'session_context' as const,
    fields: { sessionId: { value: 's' }, cwd: 'cwd' },
  }],
};

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for transcript watcher');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Close the per-file watch and every root watch. An append after this can
 * reach the tailer only through the append poll, including on platforms
 * where fs.watch does report in-place writes.
 */
function silenceFilesystemWatches(watcher: TranscriptWatcher): void {
  const internal = watcher as any;
  for (const tailer of internal.tailers.values()) {
    tailer.watcher?.close();
    tailer.watcher = null;
  }
  for (const rootWatcher of internal.rootWatchers) rootWatcher.close();
  internal.rootWatchers = [];
}

function startWatcher(path: string, statePath: string): TranscriptWatcher {
  const watcher = new TranscriptWatcher(
    { version: 1, watches: [{ name: 'context', path, schema: contextSchema }] },
    statePath,
    'in-process',
    POLL_MS,
  );
  watchers.push(watcher);
  return watcher;
}

it('reads an in-place append when fs.watch does not fire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-append-poll-'));
  roots.push(root);
  const file = join(root, 'rollout.jsonl');
  const statePath = join(root, 'state.json');
  const first = contextLine('/first');
  const second = contextLine('/second');
  writeFileSync(file, first);

  const watcher = startWatcher(file, statePath);
  await watcher.start();
  await waitFor(() => loadWatchState(statePath).cwds?.[file] === '/first');
  expect(loadWatchState(statePath).offsets[file]).toBe(Buffer.byteLength(first));

  silenceFilesystemWatches(watcher);
  await delay(WATCH_FLUSH_MS);

  const internal = watcher as any;
  let pollSawUnreadBytes = false;
  const originalPoll = internal.pollTailedAppends.bind(watcher);
  internal.pollTailedAppends = () => {
    const tailer = internal.tailers.get(file);
    if (tailer?.hasBytesPastReadOffset()) pollSawUnreadBytes = true;
    return originalPoll();
  };

  // appendFileSync writes into the existing inode; it does not replace the file.
  appendFileSync(file, second);
  await waitFor(() => loadWatchState(statePath).cwds?.[file] === '/second');
  expect(pollSawUnreadBytes).toBe(true);
  expect(loadWatchState(statePath).offsets[file]).toBe(statSync(file).size);
  expect(statSync(file).size).toBe(Buffer.byteLength(first + second));
});

it('stop() clears the append poll', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-append-poll-stop-'));
  roots.push(root);
  const file = join(root, 'rollout.jsonl');
  const statePath = join(root, 'state.json');
  const first = contextLine('/first');
  writeFileSync(file, first);

  const watcher = startWatcher(file, statePath);
  await watcher.start();
  await waitFor(() => loadWatchState(statePath).cwds?.[file] === '/first');

  const internal = watcher as any;
  expect(internal.appendPollTimer).not.toBeNull();
  let polls = 0;
  const originalPoll = internal.pollTailedAppends.bind(watcher);
  internal.pollTailedAppends = () => {
    polls += 1;
    return originalPoll();
  };
  await waitFor(() => polls >= 1);

  const tailer = internal.tailers.get(file);
  let reads = 0;
  const originalRead = tailer.readNewData.bind(tailer);
  tailer.readNewData = async () => {
    reads += 1;
    return originalRead();
  };

  watcher.stop();
  expect(internal.appendPollTimer).toBeNull();
  const pollsAtStop = polls;
  const readsAtStop = reads;

  appendFileSync(file, contextLine('/second'));
  await delay(POLL_MS * 4);
  expect(polls).toBe(pollsAtStop);
  expect(reads).toBe(readsAtStop);
  const saved = loadWatchState(statePath);
  expect(saved.cwds?.[file]).toBe('/first');
  expect(saved.offsets[file]).toBe(Buffer.byteLength(first));
});

it('does not open a tailer for a file created after startup when watches are silent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-append-poll-discover-'));
  roots.push(root);
  const firstFile = join(root, 'first.jsonl');
  const secondFile = join(root, 'second.jsonl');
  const statePath = join(root, 'state.json');
  writeFileSync(firstFile, contextLine('/first'));

  const watcher = startWatcher(join(root, '*.jsonl'), statePath);
  await watcher.start();
  await waitFor(() => loadWatchState(statePath).cwds?.[firstFile] === '/first');
  silenceFilesystemWatches(watcher);
  await delay(WATCH_FLUSH_MS);

  writeFileSync(secondFile, contextLine('/second'));
  await delay(POLL_MS * 4);

  const internal = watcher as any;
  expect(internal.tailers.has(secondFile)).toBe(false);
  expect(internal.tailers.size).toBe(1);
  const saved = loadWatchState(statePath);
  expect(saved.offsets[secondFile]).toBeUndefined();
  expect(saved.cwds?.[secondFile]).toBeUndefined();
  expect(saved.cwds?.[firstFile]).toBe('/first');
});

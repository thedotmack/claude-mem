/**
 * Local tester proof. Read selected exports, replay small real prefixes into a new
 * temporary database, reopen it, and check the dates through Claude-Mem's timeline.
 * Print counts and UTC dates only, and remove the disposable database on exit.
 */
import { Database } from 'bun:sqlite';
import { createReadStream, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import { localChatObserver } from '../src/services/history-import/local-observer.js';
import { replayHistoricalChats } from '../src/services/history-import/replay.js';
import { readChatExports, type HistoricalChat } from '../src/services/history-import/sources.js';
import { HistoryReplayStore } from '../src/services/history-import/store.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: { model: {type: 'string'}, 'checkpoint-dir': {type: 'string'}, 'per-file': {type: 'string', default: '4'}, 'as-of': {type: 'string'} },
});
const perFile = Number(values['per-file']);
const windowEnd = values['as-of'] ? Date.parse(values['as-of']) : Date.now();
if (!positionals.length || !Number.isSafeInteger(perFile) || perFile < 1 || !Number.isFinite(windowEnd))
  throw new Error('Usage: bun scripts/verify-chat-import.ts <file-or-folder> [...] [--model NAME] [--per-file TURNS] [--as-of ISO_DATE] [--checkpoint-dir PRIVATE_DIRECTORY]');
const selection: HistoricalChat[] = [];
const rawClaudeDates = new Map<string, number>();
let recognized = 0, skipped = 0, nativeRecords = 0;
for (const path of positionals) {
  const input = await readChatExports(path, {now: windowEnd});
  skipped += input.skipped;
  // Independent date oracle for explicitly selected Claude Code JSONL files.
  // Use native IDs and parse the original timestamp directly, without the import reader.
  if (path.toLowerCase().endsWith('.jsonl') && input.chats.some(chat => chat.source === 'claude-code')) {
    const lines = createInterface({input: createReadStream(path, {encoding: 'utf8'}), crlfDelay: Infinity});
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      nativeRecords++;
      if (typeof row.uuid !== 'string' || typeof row.sessionId !== 'string' || typeof row.timestamp !== 'string') continue;
      const rawKey = JSON.stringify([row.sessionId, row.uuid]);
      const timestamp = Date.parse(row.timestamp);
      if (rawClaudeDates.has(rawKey) && rawClaudeDates.get(rawKey) !== timestamp)
        throw new Error('Conflicting timestamps found for the same original Claude Code message.');
      rawClaudeDates.set(rawKey, timestamp);
    }
  }
  let remaining = perFile;
  for (const chat of input.chats) {
    recognized += chat.messages.length;
    if (!remaining) continue;
    const messages = chat.messages.slice(0, remaining);
    remaining -= messages.length;
    selection.push({...chat, messages});
  }
}
if (!selection.length) throw new Error('No selected dated messages in the 30-day window.');

type Row = {id: number; project: string; created_at: string; created_at_epoch: number; metadata: string};
const sourceDates = new Map<string, number>();
for (const chat of selection) for (const msg of chat.messages)
  sourceDates.set(JSON.stringify([chat.source, chat.id, msg.id, chat.project]), msg.timestampMs);
const dir = values['checkpoint-dir'] || mkdtempSync(join(tmpdir(), 'cmem-dated-chat-proof-'));
if (values['checkpoint-dir']) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
    throw new Error('Use a private empty checkpoint directory created for this verifier (mode 0700 on POSIX).');
}

const dbPath = join(dir, 'proof.db');
const open = () => new SessionStore(new Database(dbPath));
let sessions = open();
try {
  const mode = ModeManager.getInstance().loadMode('code');
  const first = await replayHistoricalChats(selection, new HistoryReplayStore(sessions),
    () => localChatObserver(values.model), mode, Infinity, (_unit, receipt) => {
      if (values['checkpoint-dir']) {
        process.stderr.write(`Processed a dated turn (${receipt.ids.length} observations).
`);
      }
    });
  sessions.close();
  sessions = open();
  const saved = () => sessions.db.query<Row, []>(
    'SELECT id, project, created_at, created_at_epoch, metadata FROM observations ORDER BY created_at_epoch, id'
  ).all();
  const rows = saved();
  if (!rows.length) throw new Error('The observer produced no observations for the selected turns. No timeline dates could be verified.');
  const dates = new Map<string, number>();
  let rawDateMatches = 0;
  for (const row of rows) {
    const meta = JSON.parse(row.metadata).importSource;
    const expected = sourceDates.get(JSON.stringify([meta.provider, meta.conversationId, meta.messageId, row.project]));
    if (expected === undefined || expected !== row.created_at_epoch || new Date(expected).toISOString() !== row.created_at ||
        meta.occurredAt !== row.created_at) throw new Error('A persisted observation did not match its source message and timestamp.');
    if (meta.provider === 'claude-code' && rawClaudeDates.size) {
      const rawKey = JSON.stringify([meta.conversationId, meta.messageId]);
      if (rawClaudeDates.get(rawKey) !== row.created_at_epoch)
        throw new Error('The timeline timestamp differs from the original JSONL timestamp.');
      rawDateMatches++;
    }
    const timeline = sessions.getTimelineAroundObservation(row.id, expected, 0, 0, row.project);
    if (!timeline.observations.some(item => item.id === row.id && item.created_at_epoch === expected))
      throw new Error('The observation was missing at its source timestamp on the project timeline.');
    const day = row.created_at.slice(0, 10);
    dates.set(day, (dates.get(day) || 0) + 1);
  }
  const again = await replayHistoricalChats(selection, new HistoryReplayStore(sessions),
    async () => { throw new Error('Repeat requested inference for a completed message.'); }, mode, Infinity, () => {});
  if (again.stored || again.calls || JSON.stringify(rows) !== JSON.stringify(saved()))
    throw new Error('A completed replay changed the saved observations.');
  console.log(JSON.stringify({
    windowEndUTC: new Date(windowEnd).toISOString(), rawClaudeCodeRecords: nativeRecords, matchedOriginalJsonlTimestamps: rawDateMatches, recognizedTurns: recognized, skippedSourceRecords: skipped,
    selectedTurns: sourceDates.size, selectedChats: new Set(selection.map(c => JSON.stringify([c.source,c.id]))).size,
    selectedProjects: new Set(selection.map(c => c.projectId || c.project)).size,
    turnsWithoutObservation: first.skipped, modelCalls: first.calls, confirmedTimelineObservations: rows.length, exactTimestampMatches: rows.length, observationsByDayUTC: Object.fromEntries([...dates.entries()].sort()),
    repeatModelCalls: again.calls, repeatNewObservations: again.stored
  }, null, 2));
} finally {
  sessions.close();
  if (!values['checkpoint-dir']) rmSync(dir, {recursive: true, force: true});
}

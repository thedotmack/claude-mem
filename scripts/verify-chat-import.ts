/** Replay selected real transcripts locally, reopen SQLite and check source dates through the timeline. */
import { Database } from 'bun:sqlite';
import { createReadStream, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import { localChatObserver } from '../src/services/history-import/local-observer.js';
import { conversationKey, replayHistoricalChats } from '../src/services/history-import/replay.js';
import { readChatExports, type HistoricalChat } from '../src/services/history-import/sources.js';
import { HistoryReplayStore } from '../src/services/history-import/store.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    'per-file': { type: 'string', default: '4' },
    'as-of': { type: 'string' },
    'checkpoint-dir': { type: 'string' },
  },
});
const perFile = Number(values['per-file']);
const windowEnd = values['as-of'] ? Date.parse(values['as-of']) : Date.now();
if (!positionals.length || !Number.isSafeInteger(perFile) || perFile < 1 || !Number.isFinite(windowEnd)) {
  throw new Error('Usage: bun scripts/verify-chat-import.ts <file-or-folder> [...] [--model NAME] [--per-file TURNS] [--as-of ISO_DATE] [--checkpoint-dir PRIVATE_DIRECTORY]');
}

function sourceKey(provider: string, chatId: string, messageId: string): string {
  return JSON.stringify([provider, chatId, messageId]);
}

type OriginalMessage = { timestamp: number; role: string; text: string };

// Verify selected native messages independently without keeping the rest of the raw export in memory.
async function readOriginalClaudeMessages(path: string, selected: Set<string>, original: Map<string, OriginalMessage>): Promise<number> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let records = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    records++;
    const row = JSON.parse(line);
    if (typeof row.uuid !== 'string' || typeof row.sessionId !== 'string' || typeof row.timestamp !== 'string') continue;
    const key = sourceKey('claude-code', row.sessionId, row.uuid);
    if (!selected.has(key)) continue;
    const timestamp = Date.parse(row.timestamp);
    if (original.has(key) && original.get(key)?.timestamp !== timestamp) {
      throw new Error('Conflicting timestamps for one original Claude Code message.');
    }
    const content = row.message?.content;
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
      .filter((part: { type?: string; text?: string }) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: { text: string }) => part.text.trim()).filter(Boolean).join('\n');
    original.set(key, { timestamp, role: row.type, text });
  }
  return records;
}

const selection: HistoricalChat[] = [];
const expected = new Map<string, OriginalMessage & { project: string }>();
const originals = new Map<string, OriginalMessage>();
const checkRaw = new Set<string>();
let recognized = 0;
let skipped = 0;
let nativeRecords = 0;
for (const path of positionals) {
  const input = await readChatExports(path, { now: windowEnd });
  skipped += input.skipped;
  const nativeFile = path.toLowerCase().endsWith('.jsonl') && input.chats.some(chat => chat.source === 'claude-code');

  // A single session can move among projects. Select its true chronological prefix across all groups.
  const dated = input.chats.flatMap(chat => chat.messages.map(message => ({ chat, message })));
  dated.sort((a, b) => a.message.timestampMs - b.message.timestampMs);
  recognized += dated.length;
  const groups = new Map<HistoricalChat, HistoricalChat>();
  for (const { chat, message } of dated.slice(0, perFile)) {
    const key = sourceKey(chat.source, chat.id, message.id);
    if (nativeFile && chat.source === 'claude-code') checkRaw.add(key);
    if (expected.has(key)) continue;
    expected.set(key, { timestamp: message.timestampMs, project: chat.project, role: message.role, text: message.text });
    const group = groups.get(chat) ?? { ...chat, messages: [] };
    group.messages.push(message);
    groups.set(chat, group);
  }
  if (nativeFile) nativeRecords += await readOriginalClaudeMessages(path, checkRaw, originals);
  selection.push(...groups.values());
}
if (!selection.length) throw new Error('No selected dated messages in the 30-day window.');

const checkpoint = values['checkpoint-dir'];
const dir = checkpoint || mkdtempSync(join(tmpdir(), 'cmem-dated-chat-proof-'));
if (checkpoint) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('Use a dedicated private checkpoint directory (mode 0700 on POSIX).');
  }
}
const open = () => new SessionStore(new Database(join(dir, 'proof.db')));
type Row = {
  id: number; project: string; created_at: string; created_at_epoch: number; metadata: string;
  title: string; facts: string; subtitle: string | null; narrative: string | null;
};
let sessions = open();
try {
  const mode = ModeManager.getInstance().loadMode('code');
  const receiptIds = new Set<number>();
  const completed = new Set<string>();
  let turnsWithoutObservation = 0;
  const first = await replayHistoricalChats(selection, new HistoryReplayStore(sessions),
    () => localChatObserver(values.model), mode, Infinity, (unit, receipt) => {
      completed.add(sourceKey(unit.source, unit.conversationId, unit.messageId));
      if (!receipt.ids.length) turnsWithoutObservation++;
      for (const id of receipt.ids) {
        if (receiptIds.has(id)) throw new Error('An observation ID occurred more than once in the replay proof.');
        receiptIds.add(id);
      }
      if (checkpoint) process.stderr.write(`Processed a dated turn (${receipt.ids.length} observations).\n`);
    });

  sessions.close();
  sessions = open();
  const saved = () => sessions.db.query<Row, []>(
    'SELECT id, project, created_at, created_at_epoch, metadata, title, facts, subtitle, narrative FROM observations ORDER BY created_at_epoch, id'
  ).all();
  const rows = saved();
  if (rows.length !== receiptIds.size || rows.some(row => !receiptIds.has(row.id))) {
    throw new Error('The saved observations differ from the selected turns. Use a dedicated checkpoint for each selection.');
  }
  const byDay = new Map<string, number>();
  let rawDateMatches = 0;
  for (const row of rows) {
    const meta = JSON.parse(row.metadata).importSource;
    const key = sourceKey(meta.provider, meta.conversationId, meta.messageId);
    const source = expected.get(key);
    if (!source || source.project !== row.project || source.timestamp !== row.created_at_epoch ||
        new Date(source.timestamp).toISOString() !== row.created_at || meta.occurredAt !== row.created_at) {
      throw new Error('A persisted observation does not match its source message, project and original timestamp.');
    }
    const facts: unknown = JSON.parse(row.facts);
    if (!Array.isArray(facts) || facts.length !== 1 || typeof facts[0] !== 'string' ||
        !facts[0] || !source.text.includes(facts[0]) || row.narrative || row.subtitle) {
      throw new Error('The saved observation contains wording outside the selected source passage.');
    }
    const rolePrefix = source.role === 'user' ? 'User said “' : 'Assistant said “';
    const titlePassage = row.title.slice(rolePrefix.length, -1);
    if (!row.title.startsWith(rolePrefix) || !row.title.endsWith('”') || !titlePassage ||
        !(facts[0].startsWith(titlePassage) || (titlePassage.endsWith('…') && facts[0].startsWith(titlePassage.slice(0, -1))))) {
      throw new Error('The saved title is not attributed to the speaker and their selected words.');
    }
    if (checkRaw.has(key)) {
      const raw = originals.get(key);
      if (!raw || raw.timestamp !== row.created_at_epoch || raw.role !== source.role || !raw.text.includes(facts[0])) {
        throw new Error('The saved date, speaker or passage differs from the original JSONL message.');
      }
      rawDateMatches++;
    }
    const timeline = sessions.getTimelineAroundObservation(row.id, source.timestamp, 0, 0, row.project);
    if (!timeline.observations.some(item => item.id === row.id && item.created_at_epoch === source.timestamp)) {
      throw new Error('The observation was missing from its original date on the project timeline.');
    }
    const day = row.created_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  // Gaps have no receipts and remain retryable. Only completed turns may be replayed without inference.
  const pending = expected.size - completed.size;
  const repeatSelection = selection.map(chat => ({
    ...chat,
    messages: chat.messages.filter(message => completed.has(sourceKey(chat.source, chat.id, message.id))),
  }));
  const again = await replayHistoricalChats(repeatSelection, new HistoryReplayStore(sessions),
    async () => { throw new Error('Repeat requested inference for an already completed message.'); }, mode, Infinity, () => {});
  if (again.stored || again.calls || JSON.stringify(rows) !== JSON.stringify(saved())) {
    throw new Error('Replaying the same turns changed their saved observations.');
  }
  console.log(JSON.stringify({
    windowEndUTC: new Date(windowEnd).toISOString(),
    rawClaudeCodeRecords: nativeRecords,
    recognizedTurns: recognized,
    skippedSourceRecords: skipped,
    selectedTurns: expected.size,
    completedTurns: completed.size,
    unverifiedTurns: pending,
    completeSelection: pending === 0,
    timelineChecked: rows.length > 0,
    selectedChats: new Set(selection.map(conversationKey)).size,
    selectedProjects: new Set(selection.map(chat => chat.projectId || chat.project)).size,
    turnsWithoutObservation,
    previousReceipts: first.existing,
    newModelCalls: first.calls,
    confirmedTimelineObservations: rows.length,
    exactTimestampMatches: rows.length,
    matchedSourcePassages: rows.length,
    matchedSpeakerAttributions: rows.length,
    matchedOriginalJsonlTimestamps: rawDateMatches,
    matchedOriginalJsonlPassages: rawDateMatches,
    observationsByDayUTC: Object.fromEntries(byDay),
    repeatCheckedTurns: completed.size,
    repeatModelCalls: again.calls,
    repeatNewObservations: again.stored,
  }, null, 2));
  if (pending || !rows.length) process.exitCode = 2;
} finally {
  sessions.close();
  if (!checkpoint) rmSync(dir, { recursive: true, force: true });
}

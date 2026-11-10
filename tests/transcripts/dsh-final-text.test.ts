import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import { buildSummaryPrompt } from '../../src/sdk/prompts.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const schema = JSON.parse(readFileSync(new URL('../../dsh/transcript-schema.json', import.meta.url), 'utf8')) as TranscriptSchema;
const reasoning = 'Internal hypothesis: the migration may have failed.';
const answer = 'The migration completed and the records are available.';
const text = (value: string, type: string | undefined = 'text') => ({ type, text: value });

async function summaryFromTranscript(messages: unknown[], expected: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cm-dsh-final-text-'));
  const store = new SessionStore(join(root, 'memory.db'), { syncOpsEnabled: false });
  const id = 'session-owned-dsh-summary';
  const sessionDbId = store.createSDKSession(id, 'owned-project', 'Apply the migration.', undefined, 'dsh');
  store.saveUserPrompt(id, 1, 'Apply the migration.', sessionDbId);
  const dbManager = { getSessionStore: () => store, getSessionById: (key: number) => store.getSessionById(key) };
  const sessionManager = new SessionManager(dbManager as never);
  const started: number[] = [];
  setIngestContext({ sessionManager, dbManager: dbManager as never,
    eventBroadcaster: { broadcastSummarizeQueued() {} } as never,
    ensureGeneratorRunning: async key => { started.push(key); },
  });
  const file = join(root, 'session.jsonl.zstd');
  const statePath = join(root, 'state.json');
  const watch: WatchTarget = { name: 'dsh', path: file, schema };
  const watcher = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
  const events = [
    { type: 'session', id, cwd: root, createdAt: Date.now() },
    { type: 'turn/start', data: {} },
    ...messages.map(content => ({ type: 'assistant/message', data: { message: { role: 'assistant', content } } })),
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
  const compressed = zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'));
  writeFileSync(file, compressed);
  try {
    await (watcher as any).addTailer(file, watch, schema);
    await (watcher as any).tailers.get(file).readTask;
    expect(started).toEqual([sessionDbId]);
    expect(store.findSessionDbIdByContentSessionId(id, 'dsh')).toBe(sessionDbId);
    const queued = sessionManager.getMessageBuffer().claimNextMatching(sessionDbId, () => true);
    expect(queued).toMatchObject({ type: 'summarize', prompt_number: 1, last_assistant_message: expected });
    expect(sessionManager.getMessageBuffer().claimNextMatching(sessionDbId, () => true)).toBeNull();
    ModeManager.getInstance().loadMode('code');
    const prompt = buildSummaryPrompt({ id: sessionDbId, memory_session_id: 'owned-memory', project: 'owned-project',
      user_prompt: 'Apply the migration.', last_assistant_message: queued!.last_assistant_message },
      ModeManager.getInstance().getActiveMode());
    expect(prompt).not.toContain(reasoning);
    if (expected) expect(prompt).toContain(expected);
    expect(loadWatchState(statePath).offsets[file]).toBe(compressed.length);
    expect(readFileSync(file)).toEqual(compressed);
  } finally {
    watcher.stop();
    sessionManager.discardBufferedWork(sessionDbId);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it('hands off visible DSH answer blocks without reasoning as the final answer', async () => {
  await summaryFromTranscript([[text(reasoning, 'reasoning'), text(answer), text('Checks passed.')]], answer + '\nChecks passed.');
});

it('does not replace the last visible answer with a reasoning-only assistant message', async () => {
  await summaryFromTranscript([[text(answer)], [text(reasoning, 'reasoning'), text('')]], answer);
});

it('does not invent a final answer from a reasoning-only turn', async () => {
  await summaryFromTranscript([[text(reasoning, 'reasoning')]], '');
});

it('preserves string messages and legacy untyped text blocks', async () => {
  await summaryFromTranscript(['Earlier answer.', [{ text: answer }]], answer);
  await summaryFromTranscript([answer], answer);
});

it('preserves input_text and output_text content from compatible schemas', async () => {
  await summaryFromTranscript([[text('Visible request.', 'input_text'), text(answer, 'output_text')]], 'Visible request.\n' + answer);
});

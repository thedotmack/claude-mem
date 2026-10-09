import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = (path: string) => resolve(import.meta.dir, '../../../src', path);
const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const projectDir = join(dataDir, 'project');

mock.module(source('services/integrations/TelegramNotifier.ts'), () => ({ notifyTelegram: () => Promise.resolve() }));
mock.module(source('services/integrations/GrokBotAwarenessPusher.ts'), () => ({ notifyGrokBotAwareness: () => Promise.resolve() }));
mock.module(source('services/integrations/GrokBotBrainbeat.ts'), () => ({ notifyGrokBotBrainbeat: () => Promise.resolve() }));
mock.module(source('services/integrations/GrokBotIndexWriter.ts'), () => ({ notifyGrokBotIndex: () => {} }));
mock.module(source('services/integrations/CursorHooksInstaller.ts'), () => ({ updateCursorContextForProject: () => Promise.resolve() }));

const { SettingsDefaultsManager } = await import(source('shared/SettingsDefaultsManager.ts'));
SettingsDefaultsManager.loadFromFile = () => ({
  ...SettingsDefaultsManager.getAllDefaults(),
  CLAUDE_MEM_SKIP_TOOLS: '', CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
});
const { SessionStore } = await import(source('services/sqlite/SessionStore.ts'));
const { SessionSearch } = await import(source('services/sqlite/SessionSearch.ts'));
const { SessionManager } = await import(source('services/worker/SessionManager.ts'));
const { HookSpool } = await import(source('shared/hook-spool.ts'));
const { drainHookSpool } = await import(source('services/worker/hook-spool-drain.ts'));
const { setIngestContext, ingestObservation } = await import(source('services/worker/http/shared.ts'));
const { processAgentResponse } = await import(source('services/worker/agents/ResponseProcessor.ts'));
const { ModeManager } = await import(source('services/domain/ModeManager.ts'));
ModeManager.getInstance().loadMode('code');
mkdirSync(projectDir, { recursive: true });
const store = new SessionStore(':memory:');
const db = {
  getSessionStore: () => store,
  getSessionById: (id: number) => store.getSessionById(id),
  getChromaSync: () => null, getCloudSync: () => null,
};
const manager = new SessionManager(db as any);
setIngestContext({ sessionManager: manager, dbManager: db as any,
  eventBroadcaster: { broadcastObservationQueued() {}, broadcastSummarizeQueued() {} } as any,
  ensureGeneratorRunning: async () => {},
});
const spool = new HookSpool(join(dataDir, 'spool'));
const captureDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const captureTime = Date.parse(captureDay + 'T12:00:00Z');
spool.enqueue('observation', {
  contentSessionId: 'spooled-time-1', platformSource: 'claude',
  cwd: projectDir, toolName: 'Read', toolInput: { file_path: 'handler.ts' },
  toolResponse: 'The handler writes the event before returning.', toolUseId: 'tool-time-1',
}, captureTime);
spool.enqueue('observation', {
  contentSessionId: 'spooled-time-1', platformSource: 'claude',
  cwd: projectDir, toolName: 'Read', toolInput: { file_path: 'queue.ts' },
  toolResponse: 'The queue keeps events in capture order.', toolUseId: 'tool-time-2',
}, captureTime + 500);
spool.enqueue('summarize', {
  contentSessionId: 'spooled-time-1', platformSource: 'claude',
  lastAssistantMessage: 'Verified the handler persists events before returning.',
}, captureTime + 1000);
const drain = await drainHookSpool(spool);
assert.equal(drain.drained, 3);
const sid = store.findSessionDbIdByContentSessionId('spooled-time-1', 'claude')!;
const session = manager.getSession(sid)!;
session.memorySessionId = 'spooled-time-memory-1';
const iterator = manager.getMessageIterator(sid);
const { value: message } = await iterator.next();
assert.ok(message);
await processAgentResponse(
  '<observation><type>discovery</type><title>Handler capture order</title><facts><fact>The handler persists an event before returning.</fact></facts><narrative>Verified event capture order.</narrative><concepts><concept>how-it-works</concept></concepts></observation>',
  session, db as any, manager, undefined, 0, session.earliestPendingTimestamp, 'TestProvider',
);
const row = store.db.query('SELECT title, created_at, created_at_epoch FROM observations').get() as any;
const { value: secondMessage } = await iterator.next();
assert.ok(secondMessage);
assert.equal(secondMessage.toolUseId, 'tool-time-2', 'second capture keeps FIFO order');
await processAgentResponse(
  '<observation><type>discovery</type><title>Queue FIFO order</title><facts><fact>The queue follows capture order.</fact></facts><narrative>Verified queue ordering.</narrative><concepts><concept>how-it-works</concept></concepts></observation>',
  session, db as any, manager, undefined, 0, session.earliestPendingTimestamp, 'TestProvider',
);
const { value: summaryMessage } = await iterator.next();
assert.ok(summaryMessage);
await processAgentResponse(
  '<summary><request>Verify event capture order</request><completed>Confirmed persistence precedes return.</completed></summary>',
  session, db as any, manager, undefined, 0, session.earliestPendingTimestamp, 'TestProvider',
);
const summaryRow = store.db.query('SELECT request, created_at, created_at_epoch FROM session_summaries').get() as any;
const search = new SessionSearch(store.db);
const captureDayStart = Date.parse(new Date(captureTime).toISOString().slice(0, 10));
const dateRange = { start: captureDayStart, end: captureDayStart + 24 * 60 * 60 * 1000 - 1 };
const captureDayObservations = search.searchObservations(undefined, { dateRange, orderBy: 'date_asc' });
const captureDaySummaries = search.searchSessions(undefined, { dateRange, orderBy: 'date_asc' });
// An ordinary non-spooled caller has no original timestamp and must retain
// the existing enqueue-time behavior. This passes even on the buggy baseline.
const beforeLive = Date.now();
await ingestObservation({ contentSessionId: 'spooled-time-1', platformSource: 'claude',
  cwd: projectDir, toolName: 'Read', toolInput: { file_path: 'live.ts' },
  toolResponse: 'live result', toolUseId: 'tool-time-live' });
const afterLive = Date.now();
const { value: liveMessage } = await iterator.next();
assert.ok(liveMessage);
assert.ok(liveMessage._originalTimestamp >= beforeLive && liveMessage._originalTimestamp <= afterLive);
console.log(JSON.stringify({ captureTime, captureDate: new Date(captureTime).toISOString(),
  bufferTimestamp: message._originalTimestamp, secondBufferTimestamp: secondMessage._originalTimestamp,
  row, summaryRow, captureDayObservations: captureDayObservations.map((entry: any) => entry.title),
  captureDaySummaries: captureDaySummaries.map((entry: any) => entry.request), liveTimestampInRange: true, drain }));
session.abortController.abort();
await iterator.return?.();
manager.removeSessionImmediate(sid);
store.close();
assert.equal(captureDayObservations.length, 2, 'Date-filtered retrieval must find both observations on their capture day');
assert.equal(captureDaySummaries.length, 1, 'Date-filtered retrieval must find the Stop summary on its capture day');
assert.deepEqual(captureDayObservations.map((entry: any) => entry.title), ['Handler capture order', 'Queue FIFO order']);
assert.equal(row.created_at_epoch, captureTime, 'Delayed spool ingestion must retain hook capture timestamp');
assert.equal(secondMessage._originalTimestamp, captureTime + 500);
assert.equal(summaryRow.created_at_epoch, captureTime + 1000);

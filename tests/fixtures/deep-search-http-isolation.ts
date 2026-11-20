import express from 'express';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { configureToolUseIndex } from '../../src/services/sqlite/tool-use-search.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { ContextReadWorkerClient } from '../../src/services/context/ContextReadWorkerClient.js';
import { generateContextWithStats } from '../../src/services/context/ContextBuilder.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { DeepSearchClient } from '../../src/services/deep-search/DeepSearchClient.js';
import { getDeepSearchProgram } from '../../src/services/deep-search/child-program.js';
import { readSnapshotProbe, waitForReadSnapshot } from '../helpers/deep-search-snapshot.js';

ModeManager.getInstance().loadMode('code');
const path = process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db';
const store = new SessionStore(path);
const session = store.createSDKSession('session', 'app', 'prompt');
store.ensureMemorySessionIdRegistered(session, 'memory');
store.storeObservation('memory', 'app', { type: 'discovery', title: 'ORDINARY_CONTEXT_RECORD', subtitle: null,
  narrative: 'ordinary evidence', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
// Only the deep child reads this database; the probe connection only writes.
const rawPath = process.env.CLAUDE_MEM_DATA_DIR + '/raw-only.db';
const rawStore = new SessionStore(rawPath);
const terms = Array.from({ length: 400 }, (_, i) => `x${i}`).join(' ');
rawStore.db.transaction(() => {
  for (let i = 0; i < 32000; i++) rawStore.upsertToolUse({ toolUseId: `slow-${i}`, contentSessionId: 's', project: 'slow',
    toolName: 'Read', toolResponse: '一 ' + terms });
})();
rawStore.upsertToolUse({ toolUseId: 'one', contentSessionId: 's', project: 'app', toolName: 'Read', toolResponse: 'RECOVERY_MARKER' });
configureToolUseIndex(rawStore.db, true);
const search = new SessionSearch(store.db, { toolUseIndexEnabled: true });
const context = new ContextReadWorkerClient();
const program = await getDeepSearchProgram();
const snapshotPinned = readSnapshotProbe(rawStore.db);
const deep = new DeepSearchClient(rawPath, { deadlineMs: 5000, program: async () => program });
const manager = new SearchManager(search, store, null, new FormattingService(), {} as any, undefined, context, deep);
const app = express(); app.use(express.json()); new SearchRoutes(manager).setupRoutes(app);
app.get('/fixture/context', async (_request, response) => {
  const result = await generateContextWithStats({ projects: ['app'], timePlaceholders: true, includePriorMessage: false }, false,
    { execution: 'worker', reader: context });
  response.send(result.text);
});
app.get('/fixture/health', (_request, response) => response.json({ ok: true }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const get = async (query: string, project = 'slow', raw = true) => {
  const response = await fetch(origin + '/api/search?' + new URLSearchParams({ query, project, deep: String(raw), format: 'json' }));
  if (!response.ok) throw new Error('HTTP search failed: ' + await response.text());
  return response.json() as Promise<any>;
};
async function sample(confirmOverlap?: () => Promise<void>) {
  const times: number[] = []; const texts: string[] = [];
  for (let i = 0; i < 10; i++) {
    await confirmOverlap?.();
    const started = performance.now();
    const response = await fetch(origin + '/fixture/context');
    if (!response.ok) throw new Error('Context render failed');
    const text = await response.text();
    const elapsed = performance.now() - started;
    await confirmOverlap?.();
    texts.push(text); times.push(elapsed);
  }
  return { times, texts };
}
try {
  await sample(); // warm normal context without deep search
  const baseline = await sample();
  let finished = false;
  const pending = get('一 ' + terms + ' absent').then(result => { finished = true; return result; });
  await waitForReadSnapshot(snapshotPinned, () => finished, 4000);
  // Probe writes can briefly be SQLITE_BUSY while the same raw SELECT remains
  // active. Retry asynchronously at every boundary, not only at scan startup.
  // Still require a real snapshot before/after each response; never count an
  // inconclusive probe or a response completed after the deep request ended.
  const confirmOverlap = () => waitForReadSnapshot(snapshotPinned, () => finished, 1000);
  const busy = await get('RECOVERY_MARKER', 'app');
  // A second WAL writer can temporarily prevent the probe's UPDATE without
  // stopping the deep child's read. Exercise that distinction deterministically.
  let releaseWriter: Promise<void> | undefined;
  if (process.env.CM_TEST_SNAPSHOT_CONTENTION === 'true') {
    const writer = new Database(rawPath);
    writer.run('BEGIN IMMEDIATE');
    releaseWriter = Bun.sleep(75).then(() => { writer.run('ROLLBACK'); writer.close(); });
  }
  let underLoad;
  try { underLoad = await sample(confirmOverlap); }
  finally { await releaseWriter; }
  const health = await (await fetch(origin + '/fixture/health')).json();
  await confirmOverlap();
  const ordinary = await get('ORDINARY_CONTEXT_RECORD', 'app', false);
  await confirmOverlap();
  const timeout = await pending;
  // The slot can remain busy briefly while SIGKILL is reaped.
  let recovery;
  for (let attempt = 0; attempt < 20; attempt++) {
    recovery = await get('RECOVERY_MARKER', 'app');
    if (recovery.deep.status !== 'busy') break;
    await Bun.sleep(10);
  }
  console.log(JSON.stringify({ baseline, underLoad, busy, timeout, recovery, health, ordinary }));
} finally {
  await Promise.all([deep.close(), context.close()]);
  await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rawStore.close();
}

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { setSystemTime } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { MemoryRoutes } from '../../../src/services/worker/http/routes/MemoryRoutes.js';
import { DataRoutes } from '../../../src/services/worker/http/routes/DataRoutes.js';

const mode = process.argv[2];
const platform = mode === 'codex' ? 'codex' : 'claude';
const project = 'manual-after-delete';
const dbPath = join(process.env.CLAUDE_MEM_DATA_DIR!, 'memory.db');
if (mode === 'same-millisecond') setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
let store = new SessionStore(dbPath);
const dbManager = {
  getConnection: () => store.db, getSessionStore: () => store,
  getCloudSync: () => null, getChromaSync: () => null,
};
const app = express();
app.use(express.json());
new MemoryRoutes(dbManager as any, project).setupRoutes(app);
new DataRoutes({} as any, dbManager as any, { getSession: () => undefined } as any,
  { broadcast() {} } as any, {} as any, Date.now()).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function save(text: string, source = platform) {
  const response = await fetch(`${origin}/api/memory/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, text, ...(source === 'claude' ? {} : { metadata: { platformSource: ` ${source} ` } }) }),
  });
  const result = await response.json() as { id: number; success: boolean };
  assert.equal(response.status, 200, `A new save must succeed: ${JSON.stringify(result)}`);
  assert.equal(result.success, true);
  return result.id;
}

type Session = { memory_session_id: string; content_session_id: string; started_at: string; started_at_epoch: number };
function sessionFor(id: number): Session {
  return store.db.query(`SELECT s.memory_session_id, s.content_session_id, s.started_at, s.started_at_epoch
    FROM observations o JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.id = ?`).get(id) as Session;
}

try {
  const otherPlatform = platform === 'claude' ? 'cursor' : 'claude';
  const unrelatedId = await save('Keep the independent platform note.', otherPlatform);
  const unrelatedSession = sessionFor(unrelatedId);
  let currentId = await save('Original erasable note.');
  let current = sessionFor(currentId);
  assert.equal(current.memory_session_id, `manual-${project}-${platform}`);
  const deletedMemoryIds: string[] = [];

  for (const generation of [1, 2]) {
    const response = await fetch(`${origin}/api/sessions/${platform}/${encodeURIComponent(current.content_session_id)}`, { method: 'DELETE' });
    const result = await response.json() as { success: boolean; deletedCounts: { observations: number } };
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.success, true);
    assert.ok(result.deletedCounts.observations > 0);
    deletedMemoryIds.push(current.memory_session_id);
    assert.equal(store.getObservationsByIds([currentId]).length, 0);
    const cutoff = store.getSessionDeletedAtEpochMs(platform, current.content_session_id)!;

    currentId = await save(`New generation ${generation} recallmarker.`);
    const next = sessionFor(currentId);
    assert.ok(!deletedMemoryIds.includes(next.memory_session_id), 'New saves need an identity distinct from every deleted generation');
    assert.ok(next.started_at_epoch > cutoff, 'Even a same-millisecond explicit save is later than the committed delete');
    assert.equal(store.getObservationsByIds([unrelatedId])[0].memory_session_id, unrelatedSession.memory_session_id);
    assert.equal(new SessionSearch(store.db).searchObservations('recallmarker', { project, platformSource: platform }).length, 1);

    // Reload the real database and save again: reuse the active generation,
    // rather than making a session for every note or depending on process state.
    store.close();
    store = new SessionStore(dbPath);
    assert.equal(sessionFor(await save(`Another note in generation ${generation}.`)).memory_session_id, next.memory_session_id);
    current = next;
  }

  for (const memorySessionId of deletedMemoryIds) {
    assert.ok(store.db.query('SELECT 1 FROM deleted_memory_sessions WHERE memory_session_id = ?').get(memorySessionId));
    // A sync/backup payload that knows only an old memory identity must remain
    // rejected, even if it carries another content id and a later timestamp.
    assert.throws(() => store.importSdkSession({
      memory_session_id: memorySessionId, content_session_id: `replayed-${memorySessionId}`,
      platform_source: platform, project, user_prompt: '',
      started_at: new Date(Date.now() + 1000).toISOString(), started_at_epoch: Date.now() + 1000,
      completed_at: null, completed_at_epoch: null, status: 'completed',
    }), /session_deleted/);
  }
  assert.equal((store.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).n, 2);
  console.log(`Manual-memory ${mode}: new saves, repeated deletion, restart reuse, recall and old-identity tombstones passed`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  setSystemTime();
}

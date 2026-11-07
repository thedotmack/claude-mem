import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { MemoryIngestRoutes } from '../../../src/services/worker/http/routes/MemoryIngestRoutes.js';
import { claudeProjectsDir, type MemoryIngestReport } from '../../../src/services/memory/ingest.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

const root = process.env.CLAUDE_MEM_DATA_DIR!;
const cwd = join(root, 'revision-project');
mkdirSync(cwd, { recursive: true });
const project = 'revision-project';
const memoryDir = join(claudeProjectsDir(), '-revision-project', 'memory');
mkdirSync(memoryDir, { recursive: true });
writeFileSync(join(memoryDir, '../session.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n');

const store = new SessionStore(':memory:');
const search = new SessionSearch(store.db);
const indexed: Array<{ id: number; title: string | null; narrative: string | null }> = [];
const dbManager = {
  getSessionStore: () => store,
  getCloudSync: () => null,
  getChromaSync: () => ({
    syncObservation: async (id: number, _session: string, _project: string, observation: { title: string | null; narrative: string | null }) => {
      indexed.push({ id, title: observation.title, narrative: observation.narrative });
    },
  }),
} as unknown as DatabaseManager;
const app = express();
app.use(express.json());
new MemoryIngestRoutes(dbManager).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');

function note(file: string, title: string, body: string) {
  writeFileSync(join(memoryDir, file), `---\nname: ${title}\nmetadata:\n  type: project\n---\n\n${body}\n`);
}

async function ingest(): Promise<MemoryIngestReport> {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/memory/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: memoryDir }),
  });
  assert.equal(response.status, 200);
  const report = await response.json() as MemoryIngestReport;
  assert.equal(report.failed, 0, JSON.stringify(report));
  return report;
}

try {
  note('database.md', 'Database configuration', 'The pool uses a legacy connection limit.');
  const first = await ingest();
  assert.equal(first.stored, 1);
  const originalId = first.files[0].observationId!;

  // Claude Code edits the prose under the same stable frontmatter name.
  note('database.md', 'Database configuration', 'The verified pool setting is maxconnections=24.');
  const changed = await ingest();
  assert.equal(changed.stored, 1, `a changed note is new content, not a title-only repeat: ${JSON.stringify(changed)}`);
  assert.equal(changed.deduped, 0);
  const revisedId = changed.files[0].observationId!;
  assert.notEqual(revisedId, originalId);
  const revised = store.getObservationsByIds([revisedId])[0];
  assert.equal(revised.title, 'Database configuration');
  assert.equal(revised.narrative, 'The verified pool setting is maxconnections=24.\n');
  assert.ok(search.searchObservations('maxconnections', { project }).some(row => row.id === revisedId), 'the new fact must be recallable through real FTS');
  assert.equal(store.getObservationsByIds([originalId])[0].narrative, 'The pool uses a legacy connection limit.\n');

  // Distinct topic files can legitimately share a human title too.
  note('replica.md', 'Database configuration', 'Replication uses a dedicated readonlyendpoint.');
  const another = await ingest();
  assert.equal(another.stored, 1);
  assert.equal(another.deduped, 1);
  const replicaId = another.files.find(file => file.file === 'replica.md')!.observationId!;
  assert.notEqual(replicaId, revisedId);
  assert.ok(search.searchObservations('readonlyendpoint', { project }).some(row => row.id === replicaId));

  // A replay must neither insert rows nor overwrite/index an earlier revision.
  const indexedBeforeReplay = indexed.length;
  const replay = await ingest();
  assert.equal(replay.stored, 0);
  assert.equal(replay.deduped, 2);
  assert.equal(indexed.length, indexedBeforeReplay);
  assert.deepEqual(indexed.map(row => row.id), [originalId, revisedId, replicaId]);
  for (const row of indexed) assert.equal(row.narrative, store.getObservationsByIds([row.id])[0].narrative);

  // A dedup scan must not make the next source revision lossy again.
  store.runDedupScan();
  note('database.md', 'Database configuration', 'The measured pool setting is maxconnections=32.');
  const afterScan = await ingest();
  assert.equal(afterScan.stored, 1);
  assert.equal(afterScan.deduped, 1);
  assert.equal(search.searchObservations('maxconnections', { project }).length, 2);

  // The optional title dedup contract for generated observations still holds.
  process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
  function generated(sessionId: string, title: string) {
    const id = store.createSDKSession(`content-${sessionId}`, 'generated-project', 'prompt');
    store.updateMemorySessionId(id, sessionId);
    return store.storeObservation(sessionId, 'generated-project', {
      type: 'discovery', title, subtitle: null, narrative: 'Repeated observed behavior.',
      facts: [], concepts: [], files_read: [], files_modified: [],
    });
  }
  const generatedFirst = generated('generated-first', 'A stable finding');
  const generatedRepeat = generated('generated-repeat', 'a stable finding.');
  assert.equal(generatedRepeat.id, generatedFirst.id);
  assert.equal(generatedRepeat.mergedIntoExisting, true);
  assert.equal((store.db.query('SELECT occurrence_count FROM observations WHERE id = ?').get(generatedFirst.id) as { occurrence_count: number }).occurrence_count, 2);
  console.log('Native note revisions, same-title files, exact replay, post-scan revision and generated title dedup: passed');
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
}

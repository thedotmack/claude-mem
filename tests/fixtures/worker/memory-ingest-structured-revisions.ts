import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { MemoryIngestRoutes } from '../../../src/services/worker/http/routes/MemoryIngestRoutes.js';

const mode = process.argv[2];
const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const memory = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-fixture', 'memory');
mkdirSync(memory, { recursive: true });
const file = join(memory, 'note.md');
const contents = (description = 'First description', type = 'project', origin = 'first') =>
  `---\nname: Shared note\ndescription: ${description}\nmetadata:\n  type: ${type}\n  originSessionId: ${origin}\n---\nUse the amber target.\n`;
const store = new SessionStore(join(dataDir, 'memory.db'));
let calls = 0;
const originalStore = store.storeObservation.bind(store);
store.storeObservation = (...args: Parameters<typeof originalStore>) => { calls++; return originalStore(...args); };
const manager = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null };
const app = express();
app.use(express.json());
new MemoryIngestRoutes(manager as any).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function ingest() {
  const response = await fetch(origin + '/api/memory/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: memory }),
  });
  const report = await response.json() as { stored: number; deduped: number; failed: number; files: Array<{ observationId: number }> };
  assert.equal(response.status, 200, JSON.stringify(report));
  assert.equal(report.failed, 0, JSON.stringify(report));
  return report;
}

try {
  writeFileSync(file, contents());
  const first = await ingest();
  assert.equal(first.stored, 1);
  const firstId = first.files[0].observationId;
  const original = store.getObservationById(firstId)!;
  assert.equal(original.subtitle, 'First description');
  assert(JSON.parse(original.concepts!).includes('memory-type:project'));

  if (mode === 'provenance') {
    writeFileSync(file, contents('First description', 'project', 'second'));
    const repeated = await ingest();
    assert.equal(repeated.deduped, 1);
    assert.equal(repeated.stored, 0);
    assert.equal(repeated.files[0].observationId, firstId);
    assert.equal(calls, 1, 'Provenance alone must not create a content revision');
  } else if (mode === 'retained-variant') {
    const variant = store.storeObservation(original.memory_session_id, original.project, {
      type: original.type, title: original.title, subtitle: 'Changed description', narrative: original.narrative,
      facts: JSON.parse(original.facts!), concepts: JSON.parse(original.concepts!), files_read: [], files_modified: [],
    }, 0, 0, undefined, undefined, { skipTitleDedup: true });
    assert.notEqual(variant.id, firstId);
    store.db.query('DELETE FROM observations WHERE id=?').run(firstId);
    writeFileSync(file, contents('Changed description'));
    const before = calls;
    const repeated = await ingest();
    assert.equal(repeated.stored, 0, 'Retained variants must be reported as already imported');
    assert.equal(repeated.deduped, 1);
    assert.equal(repeated.files[0].observationId, variant.id);
    assert.equal(calls, before, 'A replay must bypass the mutating store/index path');
    assert.equal((store.db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 1);
  } else {
    const description = mode === 'description' ? 'Changed description' : 'First description';
    const type = mode === 'type' ? 'feedback' : 'project';
    writeFileSync(file, contents(description, type));
    const changed = await ingest();
    assert.equal(changed.stored, 1, 'Changed structured content must be stored');
    assert.equal(changed.deduped, 0);
    const changedId = changed.files[0].observationId;
    assert.notEqual(changedId, firstId);
    const actual = store.getObservationById(changedId)!;
    assert.equal(actual.subtitle, description);
    assert(JSON.parse(actual.concepts!).includes(`memory-type:${type}`));
    assert.equal(actual.narrative, original.narrative);
    assert.equal(store.getObservationById(firstId)!.subtitle, 'First description');
    assert(JSON.parse(store.getObservationById(firstId)!.concepts!).includes('memory-type:project'));
    for (const [text, expectedId] of [[contents(description, type), changedId], [contents(), firstId]] as const) {
      writeFileSync(file, text);
      const repeated = await ingest();
      assert.equal(repeated.stored, 0);
      assert.equal(repeated.deduped, 1);
      assert.equal(repeated.files[0].observationId, expectedId);
    }
    assert.equal(calls, 2, 'Exact replays must not reinforce or reindex the stored records');
    assert.equal((store.db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 2);
  }
  console.log(`PASS real HTTP file import: ${mode}`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
}

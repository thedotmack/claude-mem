import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { saveMemory } from '../../../src/services/memory/save-memory.js';

// Run manually with Bun and an owned output directory; this is not a test lane.
const output = process.argv[2];
if (!output) throw new Error('Usage: bun tests/fixtures/memory/replay-lookup-benchmark.ts <output-directory>');
mkdirSync(output, { recursive: true });
const databasePath = join(output, 'memory.db');
let store = new SessionStore(databasePath);
const rowCount = 100_000;
const replayCount = 50;
store.db.run('DROP INDEX IF EXISTS idx_observations_source_fingerprint');
store.db.query(`INSERT INTO sdk_sessions
  (id, content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch)
  VALUES (1, 'content-1', 'memory-1', 'Project', 'codex', '2026-11-11T00:00:00Z', 1794355200000)`).run();
const insert = store.db.query(`INSERT INTO observations
  (id, memory_session_id, project, type, title, narrative, metadata, created_at, created_at_epoch)
  VALUES (?, 'memory-1', 'Project', 'discovery', ?, ?, ?, '2026-11-11T00:00:00Z', 1794355200000)`);
store.db.transaction(() => {
  for (let id = 1; id <= rowCount; id++) {
    const metadata = id <= replayCount ? JSON.stringify({ sourceFingerprint: `snapshot-${id}` })
      : id % 2 ? null : JSON.stringify({ source: 'history', unrelated: 'x'.repeat(120) });
    insert.run(id, `Memory ${id}`, 'A historical observation recorded before this source replay.', metadata);
  }
})();
store.close();
// Both versions start from an existing database without the new index.
const openStart = performance.now();
store = new SessionStore(databasePath);
const reopenMs = performance.now() - openStart;
try {
  const manager = {
    getConnection: () => store.db,
    getSessionStore: () => { throw new Error('Benchmark replay unexpectedly attempted a write'); },
  };
  const read = () => Array.from({ length: replayCount }, (_, index) => saveMemory(manager as any, 'Project', {
    text: 'Source note replay', metadata: { sourceFingerprint: `snapshot-${index + 1}`, platformSource: 'codex' },
  }));
  const expected = Array.from({ length: replayCount }, (_, index) => ({
    success: true, id: index + 1, title: `Memory ${index + 1}`, project: 'Project', duplicate: true,
    message: `Memory already saved as observation #${index + 1}`,
  }));
  let replaySql = '';
  const query = store.db.query.bind(store.db);
  store.db.query = ((sql: string) => {
    if (sql.includes('sourceFingerprint')) replaySql = sql;
    return query(sql);
  }) as typeof store.db.query;
  let results: ReturnType<typeof read>;
  try { results = read(); } // One complete warm-up, including the actual prepared query.
  finally { store.db.query = query; }
  assert.deepEqual(results, expected);
  const samplesMs: number[] = [];
  for (let round = 0; round < 5; round++) {
    const started = performance.now();
    const current = read();
    samplesMs.push(performance.now() - started);
    assert.deepEqual(current, expected);
  }
  assert.deepEqual(store.db.query('SELECT count(*) AS n FROM observations').get(), { n: rowCount });
  const plan = store.db.query(`EXPLAIN QUERY PLAN ${replaySql}`).all('Project', 'codex', 'snapshot-1');
  const resultHash = createHash('sha256').update(JSON.stringify(results)).digest('hex');
  const summary = {
    rowCount, replayCount, warmups: 1, measuredRounds: 5, samplesMs,
    medianMs: [...samplesMs].sort((a, b) => a - b)[2], resultHash, reopenMs,
    databaseBytes: statSync(databasePath).size, plan,
  };
  writeFileSync(join(output, 'result.json'), JSON.stringify({ ...summary, results }, null, 2));
  console.log(JSON.stringify(summary));
} finally { store.close(); }

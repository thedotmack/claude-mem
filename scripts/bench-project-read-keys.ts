/**
 * Bun benchmark for project scope expansion. Arguments: absolute checkout
 * path, row count (default 50000), reads (default 100), partial|whole|none.
 * Uses the production SessionStore schema/indexes with direct fixture inserts;
 * all setup is outside the measured interval. No model or network calls.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = resolve(process.argv[2] ?? '.');
const rows = Number(process.argv[3] ?? 50_000);
const reads = Number(process.argv[4] ?? 100);
const scenario = process.argv[5] ?? 'partial';
if (!Number.isSafeInteger(rows) || rows < 2 || !Number.isSafeInteger(reads) || reads < 1
  || !['partial', 'whole', 'none'].includes(scenario)) throw new Error('Invalid benchmark arguments');
const load = (path: string) => import(pathToFileURL(resolve(checkout, path)).href);
const [{ SessionStore }, { projectReadKeys }] = await Promise.all([
  load('src/services/sqlite/SessionStore.ts'), load('src/services/sqlite/project-read-keys.ts'),
]);
const store = new SessionStore(':memory:');
try {
  const session = store.createSDKSession('source-content', 'source', 'request');
  store.ensureMemorySessionIdRegistered(session, 'source-memory');
  const destination = scenario === 'whole' ? "'target'" : scenario === 'none' ? 'NULL'
    : "CASE WHEN n = 1 THEN 'target' ELSE NULL END";
  store.db.run(`WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
    INSERT INTO observations(memory_session_id, project, type, title, created_at, created_at_epoch, merged_into_project)
    SELECT 'source-memory', 'source', 'discovery', 'record ' || n, '2026-01-01T00:00:00.000Z', 1767225600000 + n, ${destination}
    FROM numbers`, [rows]);
  const expectedKeys = projectReadKeys(store.db, ['target']);
  const digest = createHash('sha256');
  Bun.gc(true);
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < reads; i++) digest.update(JSON.stringify(projectReadKeys(store.db, ['target'])));
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ checkout, rows, reads, scenario, expectedKeys, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, resultSha256: digest.digest('hex') }));
} finally {
  store.close();
}

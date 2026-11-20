/**
 * Native project-catalog benchmark. Arguments: absolute checkout path,
 * project count (default 10000), reads (default 5). Each project has sessions
 * under two stored source aliases that normalize to Claude. Fixture writes
 * precede measurement; the complete production query and projection are timed.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = resolve(process.argv[2] ?? '.');
const projects = Number(process.argv[3] ?? 10_000);
const reads = Number(process.argv[4] ?? 5);
if (!Number.isSafeInteger(projects) || projects < 1 || !Number.isSafeInteger(reads) || reads < 1) {
  throw new Error('Expected positive integer project/read counts');
}
const { SessionStore } = await import(pathToFileURL(resolve(checkout, 'src/services/sqlite/SessionStore.ts')).href);
const store = new SessionStore(':memory:');
try {
  store.db.run(`WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
    INSERT INTO sdk_sessions(content_session_id, project, platform_source, started_at, started_at_epoch)
    SELECT 'content-' || n, 'repository-' || printf('%05d', (n + 1) / 2),
      CASE WHEN n % 2 = 0 THEN 'claude' ELSE 'Claude Code' END,
      '2026-01-01T00:00:00.000Z', 1767225600000 + n FROM numbers`, [projects * 2]);
  const initial = store.getProjectCatalog();
  if (initial.projects.length !== projects || initial.projectsBySource.claude.length !== projects) {
    throw new Error('Fixture catalog lost or duplicated a project');
  }
  const digest = createHash('sha256');
  Bun.gc(true);
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < reads; i++) digest.update(JSON.stringify(store.getProjectCatalog()));
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ checkout, projects, reads, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, resultSha256: digest.digest('hex') }));
} finally {
  store.close();
}

/**
 * Native recent-context benchmark. Arguments: absolute checkout path,
 * session count (default 10000), summaries per session (default 4), reads (20).
 * Uses production SessionStore schema/indexes and SearchManager rendering.
 * Direct fixture inserts are outside the measured interval; no model/network.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = resolve(process.argv[2] ?? '.');
const sessions = Number(process.argv[3] ?? 10_000);
const summaries = Number(process.argv[4] ?? 4);
const reads = Number(process.argv[5] ?? 20);
if (!Number.isSafeInteger(sessions) || sessions < 3 || !Number.isSafeInteger(summaries) || summaries < 0
  || !Number.isSafeInteger(reads) || reads < 1) throw new Error('Invalid benchmark arguments');
const load = (path: string) => import(pathToFileURL(resolve(checkout, path)).href);
const [storeModule, searchModule, managerModule, formatterModule, timelineModule, modeModule] = await Promise.all([
  load('src/services/sqlite/SessionStore.ts'), load('src/services/sqlite/SessionSearch.ts'),
  load('src/services/worker/SearchManager.ts'), load('src/services/worker/FormattingService.ts'),
  load('src/services/worker/TimelineService.ts'), load('src/services/domain/ModeManager.ts'),
]);
modeModule.ModeManager.getInstance().loadMode('code');
const store = new storeModule.SessionStore(':memory:');
try {
  store.db.transaction(() => {
    store.db.run(`WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO sdk_sessions(content_session_id, memory_session_id, project, platform_source,
        user_prompt, started_at, started_at_epoch, status)
      SELECT 'content-' || n, 'memory-' || n, 'app', 'claude-code', 'request ' || n,
        '2026-01-01T00:00:00.000Z', 1767225600000 + n, 'completed' FROM numbers`, [sessions]);
    if (summaries > 0) store.db.run(`WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO session_summaries(memory_session_id, project, request, completed, created_at, created_at_epoch)
      SELECT 'memory-' || (1 + (n - 1) / ?), 'app', 'summary ' || n, 'Saved result ' || n,
        '2026-01-01T00:00:00.000Z', 1767225600000 + n FROM numbers`, [sessions * summaries, summaries]);
  })();
  const manager = new managerModule.SearchManager(new searchModule.SessionSearch(store.db), store, null,
    new formatterModule.FormattingService(), new timelineModule.TimelineService());
  const request = { project: 'app', limit: 3 };
  await manager.getRecentContext(request);
  Bun.gc(true);
  const digest = createHash('sha256');
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < reads; i++) digest.update(JSON.stringify(await manager.getRecentContext(request)));
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ checkout, sessions, summaries, reads, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, resultSha256: digest.digest('hex') }));
} finally {
  store.close();
}

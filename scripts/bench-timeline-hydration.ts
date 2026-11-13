/**
 * Native timeline benchmark with dense observations and sparse summaries.
 * Run with Bun from the repository root. Optional arguments are an absolute
 * checkout path, observation count (default 10000), and reads (default 20).
 * Initialization is outside the measured interval. The digest covers the
 * complete rendered response, so two checkouts can be compared for parity.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = resolve(process.argv[2] ?? '.');
const count = Number(process.argv[3] ?? 10_000);
const reads = Number(process.argv[4] ?? 20);
if (!Number.isSafeInteger(count) || count < 4 || !Number.isSafeInteger(reads) || reads < 1) {
  throw new Error('Expected observation count >= 4 and reads >= 1');
}
const load = (path: string) => import(pathToFileURL(resolve(checkout, path)).href);
const [storeModule, searchModule, managerModule, formatterModule, timelineModule, modeModule] = await Promise.all([
  load('src/services/sqlite/SessionStore.ts'), load('src/services/sqlite/SessionSearch.ts'),
  load('src/services/worker/SearchManager.ts'), load('src/services/worker/FormattingService.ts'),
  load('src/services/worker/TimelineService.ts'), load('src/services/domain/ModeManager.ts'),
]);
modeModule.ModeManager.getInstance().loadMode('code');
const store = new storeModule.SessionStore(':memory:');
try {
  const project = 'timeline-hydration-benchmark';
  const epoch = Date.UTC(2026, 0, 1);
  const session = store.createSDKSession('benchmark-content', project, 'request');
  store.ensureMemorySessionIdRegistered(session, 'benchmark-memory');
  const middle = Math.floor(count / 2);
  let anchor = 0;
  store.db.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const result = store.storeObservation('benchmark-memory', project, {
        type: 'discovery', title: `Observation ${i}`, subtitle: null, narrative: 'stored context '.repeat(150),
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, 1, 0, epoch + i);
      if (i === middle) anchor = result.id;
    }
    for (const offset of [0, count + 1]) store.storeSummary('benchmark-memory', project, {
      request: `Sparse summary ${offset}`, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, epoch + offset);
  })();
  const manager = new managerModule.SearchManager(new searchModule.SessionSearch(store.db), store, null,
    new formatterModule.FormattingService(), new timelineModule.TimelineService());
  const raw = store.getTimelineAroundObservation(anchor, epoch + middle, 1, 1, project);
  const hydratedRows = raw.observations.length + raw.sessions.length + raw.prompts.length;
  const request = { anchor, project, depth_before: 1, depth_after: 1 };
  await manager.timeline(request);
  Bun.gc(true);
  const digest = createHash('sha256');
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < reads; i++) digest.update(JSON.stringify(await manager.timeline(request)));
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ checkout, count, reads, hydratedRows, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, maxRssKiB: process.resourceUsage().maxRSS,
    resultSha256: digest.digest('hex') }));
} finally {
  store.close();
}

import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMemoryHooks } from '../../src/integrations/dsh-plugin/hooks.js';
import { WorkerClient } from '../../src/integrations/dsh-plugin/worker.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

// Run with an owned CLAUDE_MEM_DATA_DIR before any module loads. The lifecycle
// callback, HTTP client, route and SQLite writer are the production code.
const scenario = process.argv[2];
const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const projectRoot = join(dataDir, 'owned-project');
const leaf = scenario === 'whitespace-cwd'
  ? (process.platform === 'win32' ? ' src with spaces' : 'src with spaces ')
  : 'src';
const checkout = join(projectRoot, leaf);
mkdirSync(checkout, { recursive: true });
writeFileSync(join(projectRoot, '.claude-mem-project'), '');
const hasCwd = !scenario.startsWith('no-cwd');
const override = scenario.endsWith('override') ? 'chosen-project' : undefined;
const excluded = scenario.startsWith('excluded');
process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = excluded ? checkout : '';

const store = new SessionStore(join(dataDir, 'memory.sqlite'));
const dbManager = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null };
const app = express();
app.use(express.json());
let posted: Record<string, unknown> | undefined;
app.use((req, _res, next) => { posted = req.body; next(); });
new MemoryRoutes(dbManager as any, 'worker-default').setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address()!;
assert.notEqual(typeof address, 'string');
const worker = new WorkerClient({ baseUrl: `http://127.0.0.1:${(address as { port: number }).port}`, timeoutMs: 2000 });
const save = worker.save.bind(worker);
let completed: ReturnType<WorkerClient['save']> | undefined;
worker.save = request => { completed = save(request); return completed; };
const handlers = new Map<string, (...args: any[]) => unknown>();
applyMemoryHooks({ on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any, worker, {
  platformSource: 'dsh', project: override, injectContext: false, ingest: true, summarize: false,
  toolFilter: { names: ['read'] },
});

try {
  let continued = 0;
  await handlers.get('tools/post-execute')!({
    name: 'read', agent: { session: { id: 'owned-dsh-session', header: hasCwd ? { cwd: checkout } : {} } },
  }, { isError: false, content: [{ type: 'text', text: 'Owned native tool result' }] }, async () => { continued++; return {}; });
  assert.ok(completed, 'the successful native tool result must schedule a save');
  const response = await completed;
  assert.equal(continued, 1, 'capture must continue the original tool lifecycle');
  const rows = store.db.query(`SELECT o.project, o.narrative, s.platform_source FROM observations o
    JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id`).all();
  const project = override ?? (hasCwd ? 'owned-project' : 'dsh');
  assert.deepEqual(rows, excluded ? [] : [{ project, narrative: '[read] Owned native tool result', platform_source: 'dsh' }]);
  assert.equal(posted?.cwd, hasCwd ? checkout : undefined, 'the original checkout must reach exclusion and project resolution');
  assert.equal(posted?.project, override ?? (hasCwd ? undefined : 'dsh'));
  if (excluded) {
    assert.deepEqual(response, { success: false, skipped: true, reason: 'project_excluded' });
    assert.equal((store.db.query('SELECT count(*) AS count FROM sdk_sessions').get() as { count: number }).count, 0);
  }
  console.log(JSON.stringify({ scenario, saved: rows.length, project: excluded ? null : project, continued }));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}

import assert from 'node:assert/strict';
import express from 'express';
import { resolveSessionStartProjects } from '../../src/cli/handlers/context.js';
import { generateContextWithStats } from '../../src/services/context/ContextBuilder.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { DB_PATH } from '../../src/shared/paths.js';

const store = new SessionStore(DB_PATH);
const excludedPath = '/srv/work/secret-client';
const checkouts = [
  ['secret-client', excludedPath],
  ['org/app', excludedPath],
  ['org/app', '/public/app'],
  ['ORG/App', '/other/app'],
  ['__proto__', '/public/secret-client'],
  ['legacy', null],
  ['ignore-legacy', null],
  ['ignore-by-name-only', '/public/named-environment'],
  ['current', '/srv/work/current'],
] as const;
for (const [index, [project, cwd]] of checkouts.entries()) {
  const memory = `memory-${index}`;
  const session = store.createSDKSession(`session-${index}`, project, 'prompt');
  if (cwd) store.setSessionCwd(session, cwd);
  store.ensureMemorySessionIdRegistered(session, memory);
  store.storeObservation(memory, project, {
    type: 'discovery', title: `Observation for ${project}.`, subtitle: null, narrative: null,
    facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [],
  }, 1);
}

const app = express();
app.get('/api/readiness', (_req, res) => res.sendStatus(200));
new DataRoutes({} as any, { getSessionStore: () => store } as any,
  {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.CLAUDE_MEM_WORKER_URL = `http://127.0.0.1:${address.port}`;
  const projects = await resolveSessionStartProjects({
    CLAUDE_MEM_CONTEXT_PROJECTS: 'all', CLAUDE_MEM_EXCLUDED_PROJECTS: `${excludedPath},ignore-*`,
  }, ['current'], 'worker');
  assert.deepEqual(projects, ['__proto__', 'legacy', 'current']);

  ModeManager.getInstance().loadMode('code');
  const { text, stats } = await generateContextWithStats({ projects, includePriorMessage: false });
  assert.equal(stats?.observation_count, projects.length);
  for (const project of projects) assert.ok(text.includes(`Observation for ${project}.`));
  for (const project of ['secret-client', 'org/app', 'ORG/App', 'ignore-legacy', 'ignore-by-name-only']) assert.ok(!text.includes(`Observation for ${project}.`));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}

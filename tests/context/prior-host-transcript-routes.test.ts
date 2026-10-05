import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { cwdToDashed } from './src/services/context/ObservationCompiler.ts';
  ModeManager.getInstance().loadMode('code');
  const cwd = '/owned/host-project';
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prior-host.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The prior host response.' }] } }) + '\n');
  if (process.env.TRANSCRIPT_ACTIVE === 'true') writeFileSync(join(dir, 'current-host.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The active host response.' }] } }) + '\n');
  const app = express(); app.use(express.json());
  let cleanup = async () => {};
  let cache, store, runtime;
  if (process.env.TRANSCRIPT_ROUTE_KIND === 'server') {
    const pg = (await import('pg')).default;
    const { bootstrapServerPostgresSchema, createPostgresStorageRepositories } = await import('./src/storage/postgres/index.ts');
    const { ServerV1PostgresRoutes } = await import('./src/server/routes/v1/ServerV1PostgresRoutes.ts');
    const { createHash } = await import('node:crypto');
    const schema = 'transcript_' + crypto.randomUUID().replaceAll('-', '_');
    const admin = new pg.Pool({ connectionString: process.env.CLAUDE_MEM_TEST_POSTGRES_URL });
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({ connectionString: process.env.CLAUDE_MEM_TEST_POSTGRES_URL, options: '-c search_path=' + schema });
    cleanup = async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); };
    await bootstrapServerPostgresSchema(pool);
    const repos = createPostgresStorageRepositories(pool);
    const team = await repos.teams.create({ name: 'Owned transcript team' });
    const project = await repos.projects.create({ teamId: team.id, name: 'Owned transcript project' });
    const session = await repos.sessions.create({ teamId: team.id, projectId: project.id, externalSessionId: 'prior-host', contentSessionId: 'prior-host', platformSource: 'claude' });
    await repos.observations.create({ teamId: team.id, projectId: project.id, serverSessionId: session.id, kind: 'discovery', content: 'An observed fact', metadata: { title: 'Observed fact', project: 'project' } });
    await repos.auth.createApiKey({ keyHash: createHash('sha256').update('owned-fixture-key').digest('hex'), teamId: team.id, projectId: project.id, actorId: 'owned-fixture-actor', name: 'Owned fixture key', scopes: ['memories:read'] });
    new ServerV1PostgresRoutes({ pool, queueManager: {}, authMode: 'api-key' }).setupRoutes(app);
    runtime = { projectId: project.id, serverSessionId: session.id };
  } else {
    const { SessionStore } = await import('./src/services/sqlite/SessionStore.ts');
    const { SearchRoutes } = await import('./src/services/worker/http/routes/SearchRoutes.ts');
    const { ContextCacheService } = await import('./src/services/worker/ContextCacheService.ts');
    store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
    const session = store.createSDKSession('prior-host', 'project', 'prompt');
    store.updateMemorySessionId(session, 'prior-observer');
    store.storeObservation('prior-observer', 'project', { type: 'discovery', title: 'Observed fact', subtitle: null, narrative: 'An observed fact', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
    if (process.env.TRANSCRIPT_ACTIVE === 'true') {
      const active = store.createSDKSession('current-host', 'project', 'prompt');
      store.updateMemorySessionId(active, 'current-observer');
      store.storeObservation('current-observer', 'project', { type: 'discovery', title: 'Active fact', subtitle: null, narrative: 'A current fact', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1, 0, Date.now() + 1000);
    }
    let routes;
    cache = new ContextCacheService({ renderVariant: keys => routes.renderContextVariant(keys), expandProjectReadKeys: keys => store.getProjectReadKeys(keys) });
    routes = new SearchRoutes({ getSessionStore: () => store }, cache);
    cache.start(); routes.setupRoutes(app);
    cleanup = async () => { cache.stop(); store.close(); };
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  try {
    if (runtime) {
      const { ServerClient } = await import('./src/services/hooks/server-client.ts');
      const { generateServerContextWithStats } = await import('./src/services/context/ContextBuilder.ts');
      const client = new ServerClient({ serverBaseUrl: baseUrl, apiKey: 'owned-fixture-key' });
      const rows = await client.contextObservations({ projectId: runtime.projectId, folderProjects: ['project'] });
      const result = await generateServerContextWithStats({ runtime: 'server', projectId: runtime.projectId, serverBaseUrl: baseUrl, client }, { projects: ['project'], cwd, session_id: 'current-host' });
      console.log(JSON.stringify({ text: result.text, host: rows.observations[0].contentSessionId, distinct: runtime.serverSessionId !== 'prior-host' }));
    } else {
      const text = await (await fetch(baseUrl + '/api/context/inject?' + new URLSearchParams({ projects: 'project', cwd, sessionId: 'current-host' }))).text();
      const { emitContextInvalidation } = await import('./src/shared/context-invalidation.ts');
      const { contextCacheKeys, readContextCache } = await import('./src/shared/context-cache.ts');
      emitContextInvalidation({ projects: ['project'] }, 'owned-fixture');
      await cache.flushPendingRenders();
      const cached = readContextCache(contextCacheKeys(['project'], undefined, false, cwd, 'current-host'), Date.now());
      let other;
      if (process.env.TRANSCRIPT_ACTIVE === 'true') {
        other = await (await fetch(baseUrl + '/api/context/inject?' + new URLSearchParams({ projects: 'project', cwd, sessionId: 'other-host' }))).text();
      }
      console.log(JSON.stringify({ text, cached: cached?.body, other }));
    }
  } finally { await new Promise(resolve => server.close(resolve)); await cleanup(); }
`;

function run(kind: string, active = false): any {
  const dir = mkdtempSync(join(tmpdir(), 'prior-transcript-route-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({ CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true', CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false' }));
    const result = Bun.spawnSync([process.execPath, '-e', fixture], { cwd: join(import.meta.dir, '../..'), env: { ...process.env, TRANSCRIPT_ROUTE_KIND: kind, TRANSCRIPT_ACTIVE: String(active), CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('prior host transcript in production context routes', () => {
  it('uses the host cwd for live worker rendering without persisting a session variant', () => {
    const result = run('worker');
    expect(result.text).toContain('The prior host response.');
    expect(result.cached).toBeUndefined();
  });
  it('excludes an active host transcript in live clear or compact context', () => {
    const result = run('worker', true);
    expect(result.text).not.toContain('The active host response.');
    expect(result.cached).toBeUndefined();
    expect(result.other).toContain('The active host response.');
  });
  (process.env.CLAUDE_MEM_TEST_POSTGRES_URL ? it : it.skip)('carries the host identity through real Postgres, HTTP, and the server renderer', () => {
    const result = run('server');
    expect(result.distinct).toBe(true);
    expect(result.host).toBe('prior-host');
    expect(result.text).toContain('The prior host response.');
  });
});

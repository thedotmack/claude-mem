// SPDX-License-Identifier: Apache-2.0
//
// Session start in server runtime, end to end: the real ServerClient asks the
// real Postgres /v1/context route for the newest rows of this folder, and the
// block is rendered through the local renderer and budget fitter. Pins the
// client/route contract (no query key, folderProjects, the 200 cap) that the
// unit tests only mock. Postgres-gated; isolation via tests/sdk/pg-isolation.ts.

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { ServerClient } from '../../src/services/hooks/server-client.js';
import { generateServerContextWithStats } from '../../src/services/context/ContextBuilder.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';
import { newApiKey, createIsolatedSchema, poolForSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('server-runtime session start reads the shared store', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let apiKey: string;
  let teamId: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeAll(() => {
    ModeManager.getInstance().loadMode('code');
  });

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    );
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_session_start_store');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId, name: 'store' });
    projectId = project.id;

    const session = await storage.sessions.create({
      projectId, teamId, contentSessionId: 'claude-session', platformSource: 'claude',
    });
    await storage.observations.create({
      projectId, teamId, serverSessionId: session.id, kind: 'bugfix',
      content: 'Fixed the import batch abort',
      metadata: { title: 'Import no longer aborts on a bad row', project: 'this-repo' },
    });
    await storage.observations.create({
      projectId, teamId, serverSessionId: session.id, kind: 'discovery',
      content: 'Another repo entirely',
      metadata: { title: 'Work in a different repo', project: 'other-repo' },
    });
    await storage.observations.create({
      projectId, teamId, serverSessionId: session.id, kind: 'summary',
      content: 'summary body',
      metadata: { request: 'Stop one bad row from aborting the restore', project: 'this-repo' },
    });

    const key = newApiKey();
    apiKey = key.raw;
    await storage.auth.createApiKey({
      keyHash: key.hash, teamId, projectId: null, actorId: 't', scopes: ['memories:read', 'memories:write'],
    });

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    spies.forEach((spy) => spy.mockRestore());
  });

  function runtime() {
    const serverBaseUrl = `http://127.0.0.1:${port}`;
    return {
      runtime: 'server' as const,
      projectId,
      serverBaseUrl,
      client: new ServerClient({ serverBaseUrl, apiKey }),
    };
  }

  it('renders only this folder\'s observations and its summary', async () => {
    const { text, stats } = await generateServerContextWithStats(runtime(), {
      projects: ['this-repo'],
      cwd: process.cwd(),
      platformSource: 'claude',
    });

    expect(text).toContain('# [this-repo] recent context');
    expect(text).toContain('Import no longer aborts on a bad row');
    expect(text).toContain('Stop one bad row from aborting the restore');
    expect(text).not.toContain('Work in a different repo');
    expect(stats!.observation_count).toBe(1);
    expect(stats!.has_session_summary).toBe(true);
  });

  it('renders the empty state for a folder with no rows, not another folder\'s memory', async () => {
    const { text, stats } = await generateServerContextWithStats(runtime(), {
      projects: ['a-new-repo'],
      cwd: process.cwd(),
    });

    expect(text).toContain('No previous sessions found.');
    expect(stats).toBeNull();
  });

  for (const kind of ['discovery', 'summary']) {
    it(`keeps both context categories when recent ${kind} rows exceed the combined limit`, async () => {
      // Default context asks for 50 observations and 10 summaries (+1 lookahead).
      // One busy session, or many short sessions, can fill that entire recency
      // window with a single kind. The other category still has available rows.
      await client.query('UPDATE observations SET created_at = now() - interval \'1 day\'');
      for (let index = 0; index < 65; index++) {
        await storage.observations.create({
          projectId, teamId, kind, content: `Recent ${kind} ${index}`,
          metadata: { title: `Recent ${kind} ${index}`, request: `Task ${index}`, project: 'this-repo' },
        });
      }
      const { text, stats } = await generateServerContextWithStats(runtime(), {
        projects: ['this-repo'], cwd: process.cwd(),
      });
      expect(stats!.observation_count).toBe(kind === 'discovery' ? 50 : 1);
      expect(stats!.has_session_summary).toBe(true);
      if (kind === 'summary') expect(text).toContain('Import no longer aborts on a bad row');
      else expect(text).toContain('Stop one bad row from aborting the restore');
    });
  }

  it('asks for everything in full mode and stays within the route cap', async () => {
    const { text } = await generateServerContextWithStats(runtime(), {
      projects: ['this-repo'],
      cwd: process.cwd(),
      full: true,
    });

    expect(text).toContain('Import no longer aborts on a bad row');
  });
});

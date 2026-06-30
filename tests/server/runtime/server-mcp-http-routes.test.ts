// SPDX-License-Identifier: Apache-2.0
//
// Integration test for the remote authenticated MCP endpoint (POST /v1/mcp).
//
// The unit test (tests/server/mcp/recall-mcp-server.test.ts) covers tool logic
// over an in-memory transport. THIS test covers the part the unit test can't:
// the real streamable-HTTP wiring through Express 5 + readAuth + Postgres. It
// boots the actual server, inserts observations, then drives /v1/mcp with a
// genuine MCP HTTP client carrying an `Authorization: Bearer cm_...` header —
// the exact path a user's Claude Code takes.
//
// Postgres-gated, like server-mcp-routes.test.ts: requires CLAUDE_MEM_TEST_POSTGRES_URL.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('POST /v1/mcp — remote authenticated MCP recall (streamable HTTP)', () => {
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
  let teamId: string;
  let projectId: string;
  let apiKeyRaw: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_mcp_http_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;

    // The MCP endpoint is read-only, so a read-scoped key must be sufficient.
    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId,
      actorId: 'test',
      scopes: ['memories:read'],
    });

    // Seed memory directly (bypassing auth) so recall has something to find.
    await storage.observations.create({
      projectId, teamId, kind: 'manual',
      content: 'The login bug was a stale CSRF cookie on the callback.',
    });
    await storage.observations.create({
      projectId, teamId, kind: 'manual',
      content: 'We chose per-user namespaces for the shared cloud instance.',
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
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
      runtime: 'server-beta',
      sessionPolicy: 'per-event',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function connectMcp(key: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/v1/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${key}` } } },
    );
    const mcp = new Client({ name: 'integration-test', version: '0' }, { capabilities: {} });
    return mcp.connect(transport).then(() => mcp);
  }

  function textOf(result: { content: unknown }): string {
    return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  }

  it('lists the recall tools over HTTP with a valid key', async () => {
    const mcp = await connectMcp(apiKeyRaw);
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['context', 'recent', 'search']);
    await mcp.close();
  });

  it('recent returns the team-scoped observations', async () => {
    const mcp = await connectMcp(apiKeyRaw);
    const res = await mcp.callTool({ name: 'recent', arguments: { projectId, limit: 10 } });
    const { observations } = JSON.parse(textOf(res));
    expect(observations.length).toBe(2);
    const contents = observations.map((o: { content: string }) => o.content).join(' ');
    expect(contents).toContain('CSRF cookie');
    await mcp.close();
  });

  it('search finds an observation by content', async () => {
    const mcp = await connectMcp(apiKeyRaw);
    const res = await mcp.callTool({ name: 'search', arguments: { projectId, query: 'login bug' } });
    const { observations } = JSON.parse(textOf(res));
    expect(observations.some((o: { content: string }) => o.content.includes('login bug'))).toBe(true);
    await mcp.close();
  });

  it('writes audit_log rows for MCP reads, with the right mode per tool', async () => {
    const mcp = await connectMcp(apiKeyRaw);
    await mcp.callTool({ name: 'recent', arguments: { projectId, limit: 5 } });
    await mcp.callTool({ name: 'context', arguments: { projectId, query: 'login bug' } });
    await mcp.close();
    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE team_id = $1 AND action = 'observation.read'`,
      [teamId],
    );
    const modes = audit.rows.map((r: { details: { via?: string; mode?: string } }) =>
      r.details?.via === 'mcp' ? r.details?.mode : null,
    ).filter(Boolean);
    expect(modes).toContain('recent');
    expect(modes).toContain('context');
  });

  it('rejects an unauthenticated connection (no key → 401)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/v1/mcp`));
    const mcp = new Client({ name: 'noauth', version: '0' }, { capabilities: {} });
    await expect(mcp.connect(transport)).rejects.toThrow();
  });
});

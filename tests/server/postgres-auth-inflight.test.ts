import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import express from 'express';
import http from 'node:http';
import pg from 'pg';
import { requirePostgresServerAuth } from '../../src/server/middleware/postgres-auth.js';
import { apiKeyPrefix, hashApiKey } from '../../src/server/auth/api-key-hash.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../src/storage/postgres/index.js';
import { createIsolatedSchema, dropSchema, newApiKey, poolForSchema } from '../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('Postgres authentication while a proof is in flight', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schema: string;
  let server: http.Server;

  beforeEach(async () => {
    schema = await createIsolatedSchema(databaseUrl, 'cm_auth_inflight');
    pool = poolForSchema(databaseUrl, schema);
    await bootstrapServerPostgresSchema(pool);
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
    await dropSchema(databaseUrl, schema);
  });

  it.each(['revoked', 'scope removed', 'hash replaced', 'unchanged'])('uses live key state (%s) for a joined request', async change => {
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'Authentication freshness' });
    const { raw } = newApiKey();
    const key = await storage.auth.createApiKey({
      keyHash: hashApiKey(raw), keyPrefix: apiKeyPrefix(raw), teamId: team.id,
      actorId: 'test', scopes: ['memories:read'],
    });
    let prefixRead!: () => void;
    let release!: () => void;
    const read = new Promise<void>(resolve => { prefixRead = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const query = pool.query.bind(pool);
    let prefixReads = 0;
    const querySpy = spyOn(pool, 'query').mockImplementation((async (...args: Parameters<typeof pool.query>) => {
      const result = await query(...args);
      if (typeof args[0] === 'string' && /FROM api_keys\s+WHERE key_prefix = \$1/.test(args[0])) {
        prefixReads++;
        prefixRead();
        // Hold the real result after its database snapshot but before scrypt.
        await gate;
      }
      return result;
    }) as typeof pool.query);

    let secondArrived!: () => void;
    const joined = new Promise<void>(resolve => { secondArrived = resolve; });
    let arrivals = 0;
    const app = express();
    app.get('/protected', (_req, _res, next) => {
      if (++arrivals === 2) secondArrived();
      next();
    }, requirePostgresServerAuth(pool, { requiredScopes: ['memories:read'] }), (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    const request = () => fetch(`http://127.0.0.1:${address.port}/protected`, { headers: { Authorization: `Bearer ${raw}` } });

    const first = request();
    await read;
    try {
      if (change === 'revoked') await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key.id]);
      else if (change === 'scope removed') await query("UPDATE api_keys SET scopes = '[]'::jsonb WHERE id = $1", [key.id]);
      else if (change === 'hash replaced') await query('UPDATE api_keys SET key_hash = $1 WHERE id = $2', [hashApiKey('replacement-key'), key.id]);
      const second = request();
      await joined;
      release();
      const responses = await Promise.all([first, second]);
      await Promise.all(responses.map(response => response.text()));
      expect(prefixReads).toBe(1);
      expect(responses[1].status).toBe(change === 'unchanged' ? 200 : 403);
    } finally {
      release();
      await first;
      querySpy.mockRestore();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { bootstrapServerApiKey, rotateServerApiKey } from '../../../src/services/hooks/server-bootstrap.js';
import { bootstrapServerPostgresSchema } from '../../../src/storage/postgres/schema.js';
import { verifyRawKeyAgainstStoredHashAsync } from '../../../src/server/auth/api-key-hash.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';

const url = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
describe.skipIf(!url)('Postgres hook-key bootstrap transaction', () => {
  let schema: string;
  let pool: pg.Pool;
  beforeEach(async () => {
    schema = await createIsolatedSchema(url!, 'key_transaction');
    pool = poolForSchema(url!, schema);
    await bootstrapServerPostgresSchema(pool, 'off');
  });
  afterEach(async () => {
    await pool.end();
    await dropSchema(url!, schema);
  });
  const mint = () => bootstrapServerApiKey({ pool, closePool: false });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM teams) AS teams,
    (SELECT count(*)::int FROM projects) AS projects,
    (SELECT count(*)::int FROM api_keys) AS keys,
    (SELECT count(*)::int FROM audit_log) AS audits`)).rows[0];
  const rejectAudit = () => pool.query(`
    CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit fixture rejected write'; END $$;
    CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_test_audit();
  `);

  test('audit failure rolls back a new key and newly provisioned tenant rows', async () => {
    await rejectAudit();
    await expect(mint()).rejects.toThrow('audit fixture rejected write');
    expect(await counts()).toEqual({ teams: 0, projects: 0, keys: 0, audits: 0 });
  });

  test('failed rotation retains the old key without an unreported replacement', async () => {
    const previous = await mint();
    await rejectAudit();
    await expect(rotateServerApiKey({ pool, previousApiKeyId: previous.apiKeyId })).rejects.toThrow('audit fixture rejected write');
    expect(await counts()).toEqual({ teams: 1, projects: 1, keys: 1, audits: 1 });
    expect((await pool.query('SELECT revoked_at FROM api_keys WHERE id = $1', [previous.apiKeyId])).rows[0].revoked_at).toBeNull();
  });

  test('successful provisioning commits a verifiable key with its linked audit', async () => {
    const result = await mint();
    const row = (await pool.query(`SELECT k.key_hash, k.team_id, k.project_id,
      a.api_key_id, a.action FROM api_keys k JOIN audit_log a ON a.api_key_id = k.id
      WHERE k.id = $1`, [result.apiKeyId])).rows[0];
    expect(await verifyRawKeyAgainstStoredHashAsync(result.rawKey, row.key_hash)).toBe(true);
    expect(row.team_id).toBe(result.teamId);
    expect(row.project_id).toBe(result.projectId);
    expect(row.action).toBe('api_key.create');
    expect(await counts()).toEqual({ teams: 1, projects: 1, keys: 1, audits: 1 });
  });

  test('a concurrent schema bootstrap and audit insertion both complete', async () => {
    const key = Math.floor(Math.random() * 0x0fffffff);
    const blocker = await pool.connect();
    const ddl = await pool.connect();
    let provisioning: Promise<unknown> | undefined;
    let migrating: Promise<unknown> | undefined;
    const waitFor = async (sql: string, values: unknown[]) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await pool.query(sql, values)).rows[0]?.ready) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('database lock barrier did not become ready');
    };
    try {
      await pool.query(`CREATE FUNCTION hold_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(93844, ${key}); RETURN NEW; END $$;
        CREATE TRIGGER hold_test_audit BEFORE INSERT ON audit_log
          FOR EACH ROW EXECUTE FUNCTION hold_test_audit();`);
      await blocker.query('SELECT pg_advisory_lock(93844, $1)', [key]);
      provisioning = mint().catch(error => error);
      // The BEFORE trigger holds the INSERT before its foreign-key checks,
      // with the audit table locked, reproducing the production lock order.
      await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 93844 AND objid = $1 AND NOT granted) AS ready`, [key]);
      const pid = (await ddl.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      migrating = bootstrapServerPostgresSchema(ddl, 'off').catch(error => error);
      await waitFor('SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted) AS ready', [pid]);
      await blocker.query('SELECT pg_advisory_unlock(93844, $1)', [key]);
      const [issued, migrated] = await Promise.all([provisioning, migrating]);
      expect(issued).not.toBeInstanceOf(Error);
      expect(migrated).not.toBeInstanceOf(Error);
      expect(await counts()).toEqual({ teams: 1, projects: 1, keys: 1, audits: 1 });
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(93844, $1)', [key]);
      await Promise.allSettled([provisioning, migrating].filter(Boolean));
      blocker.release();
      ddl.release();
    }
  }, 20000);
});

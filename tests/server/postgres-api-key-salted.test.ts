// #2541 follow-up for the Postgres backend: API keys must be stored as
// salted, memory-hard scrypt hashes (the scheme the SQLite backend already
// uses), with the legacy unsalted SHA-256 rows kept working through a
// dual-verifier that transparently upgrades them on first successful verify.
import { describe, expect, it } from 'bun:test';
import type { PostgresPool } from '../../src/storage/postgres/pool.js';
import type { Request, Response } from 'express';
import { requirePostgresServerAuth, verifyPostgresApiKey } from '../../src/server/middleware/postgres-auth.js';
import {
  hashApiKey,
  hashApiKeyLegacySha256,
  SCRYPT_MAX_WAITERS,
  ScryptQueueFullError,
  verifyRawKeyAgainstStoredHash,
} from '../../src/server/auth/api-key-hash.js';
import { ensureApiKeySchema, API_KEY_SCHEMA_SQL } from '../../src/storage/postgres/schema.js';
import type { PostgresQueryable } from '../../src/storage/postgres/pool.js';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function mockPool(
  matchers: Array<{ match: (sql: string) => boolean; rows: Record<string, unknown>[] | (() => Record<string, unknown>[]) }>,
): { pool: PostgresPool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      const hit = matchers.find(entry => entry.match(text));
      const rows = hit ? (typeof hit.rows === 'function' ? hit.rows() : hit.rows) : [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as PostgresPool;
  return { pool, queries };
}

function saltedRow(rawKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'key-salted-1',
    team_id: 'team-1',
    project_id: null,
    scopes: ['memories:read'],
    revoked_at: null,
    expires_at: null,
    key_hash: hashApiKey(rawKey),
    ...overrides,
  };
}

function legacyRow(rawKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'key-legacy-1',
    team_id: 'team-1',
    project_id: null,
    scopes: ['memories:read'],
    revoked_at: null,
    expires_at: null,
    key_hash: hashApiKeyLegacySha256(rawKey),
    ...overrides,
  };
}

const isPrefixLookup = (sql: string): boolean => /FROM api_keys\s+WHERE key_prefix = \$1/.test(sql);
const isHashLookup = (sql: string): boolean => /FROM api_keys\s+WHERE key_hash = \$1/.test(sql);
const isRehashUpdate = (sql: string): boolean =>
  /UPDATE api_keys\s+SET key_hash = \$1/.test(sql) && /key_prefix/.test(sql);

describe('postgres API key storage (#2541 salted scrypt)', () => {
  it('verifies a key stored under the salted scrypt scheme via prefix lookup', async () => {
    const rawKey = 'cmem_test-salted-key-0123456789';
    const { pool, queries } = mockPool([
      { match: isPrefixLookup, rows: [saltedRow(rawKey)] },
      { match: isHashLookup, rows: [] },
    ]);

    const verified = await verifyPostgresApiKey(pool, rawKey, ['memories:read']);

    expect(verified).not.toBeNull();
    expect(verified?.apiKeyId).toBe('key-salted-1');
    expect(verified?.teamId).toBe('team-1');
    expect(queries.some(query => isPrefixLookup(query.text))).toBe(true);
    expect(queries.some(query => isPrefixLookup(query.text)
      && query.params[0] === rawKey.slice(0, 10))).toBe(true);
  });

  it('still verifies a legacy unsalted SHA-256 key and re-hashes it to scrypt on success', async () => {
    const rawKey = 'cmem_legacy-key-0123456789';
    const { pool, queries } = mockPool([
      { match: isPrefixLookup, rows: [] },
      { match: isHashLookup, rows: [legacyRow(rawKey)] },
      { match: isRehashUpdate, rows: [] },
    ]);

    const verified = await verifyPostgresApiKey(pool, rawKey, ['memories:read']);

    expect(verified).not.toBeNull();
    expect(verified?.apiKeyId).toBe('key-legacy-1');
    // The legacy SHA-256 lookup ran with the deterministic digest...
    const lookup = queries.find(query => isHashLookup(query.text));
    expect(lookup?.params[0]).toBe(hashApiKeyLegacySha256(rawKey));
    // ...and the row was transparently upgraded to the salted scheme with
    // its prefix recorded for future salted lookups.
    const rehash = queries.find(query => isRehashUpdate(query.text));
    expect(rehash).toBeDefined();
    expect(String(rehash?.params[0])).toStartWith('scrypt$');
    expect(rehash?.params[1]).toBe(rawKey.slice(0, 10));
    expect(rehash?.params[2]).toBe('key-legacy-1');
  });

  it('rejects a key that matches neither scheme', async () => {
    const { pool } = mockPool([
      { match: isPrefixLookup, rows: [] },
      { match: isHashLookup, rows: [] },
    ]);

    expect(await verifyPostgresApiKey(pool, 'cmem_wrong-key-0123456789', [])).toBeNull();
  });

  it('rejects a revoked or expired key even when the hash matches', async () => {
    const rawKey = 'cmem_revoked-key-0123456789';
    const revoked = mockPool([
      { match: isPrefixLookup, rows: [saltedRow(rawKey, { revoked_at: new Date() })] },
    ]);
    expect(await verifyPostgresApiKey(revoked.pool, rawKey, [])).toBeNull();

    const expired = mockPool([
      {
        match: isPrefixLookup,
        rows: [saltedRow(rawKey, { expires_at: new Date(Date.now() - 1000) })],
      },
    ]);
    expect(await verifyPostgresApiKey(expired.pool, rawKey, [])).toBeNull();
  });

  it('rejects a matching key that lacks a required scope', async () => {
    const rawKey = 'cmem_scoped-key-0123456789';
    const { pool } = mockPool([
      { match: isPrefixLookup, rows: [saltedRow(rawKey)] },
    ]);

    expect(await verifyPostgresApiKey(pool, rawKey, ['memories:write'])).toBeNull();
    expect(await verifyPostgresApiKey(pool, rawKey, ['memories:read'])).not.toBeNull();
  });

  it('hashes are salted: same raw key yields different stored hashes that both verify', () => {
    const rawKey = 'cmem_same-key-0123456789';
    const first = hashApiKey(rawKey);
    const second = hashApiKey(rawKey);
    expect(first).toStartWith('scrypt$');
    expect(first).not.toBe(second);
    expect(verifyRawKeyAgainstStoredHash(rawKey, first)).toBe(true);
    expect(verifyRawKeyAgainstStoredHash(rawKey, second)).toBe(true);
    expect(verifyRawKeyAgainstStoredHash('cmem_other-key', first)).toBe(false);
  });

  it('a valid legacy key still verifies when a concurrent request upgrades the row between the prefix and legacy lookups (#2 recheck)', async () => {
    const rawKey = 'cmem_race-key-0123456789';
    let prefixLookups = 0;
    const upgraded = saltedRow(rawKey);
    const { pool } = mockPool([
      {
        match: isPrefixLookup,
        rows: () => {
          prefixLookups++;
          return prefixLookups === 1 ? [] : [upgraded];
        },
      },
      { match: isHashLookup, rows: [] },
    ]);

    const verified = await verifyPostgresApiKey(pool, rawKey, ['memories:read']);

    expect(verified).not.toBeNull();
    expect(verified?.apiKeyId).toBe('key-salted-1');
    expect(prefixLookups).toBe(2);
  });

  it('excludes revoked and expired keys from prefix lookups and bounds candidate attempts', async () => {
    const rawKey = 'cmem_probe-key-0123456789';
    const { pool, queries } = mockPool([
      { match: isPrefixLookup, rows: [] },
      { match: isHashLookup, rows: [] },
    ]);

    await verifyPostgresApiKey(pool, rawKey, ['memories:read']);

    const prefixSql = queries.find(query => isPrefixLookup(query.text));
    expect(prefixSql).toBeDefined();
    expect(prefixSql!.text).toContain('revoked_at IS NULL');
    expect(prefixSql!.text).toContain('expires_at');
    expect(prefixSql!.text).toMatch(/LIMIT\s+\d+/);
  });

  describe('verified-key cache and bounded scrypt queue', () => {
    const isIdLookup = (sql: string): boolean => /FROM api_keys WHERE id = \$1/.test(sql);

    function poolWithLiveRow(row: Record<string, unknown>): { pool: PostgresPool; queries: RecordedQuery[]; live: Record<string, unknown> } {
      const live = { ...row };
      const { pool, queries } = mockPool([
        { match: isPrefixLookup, rows: () => [live] },
        { match: isIdLookup, rows: () => [live] },
        { match: isHashLookup, rows: [] },
      ]);
      return { pool, queries, live };
    }

    it('N concurrent requests with one valid key share a single derivation, and later requests skip scrypt', async () => {
      const rawKey = 'cmem_cache-key-0123456789';
      const { pool, queries } = poolWithLiveRow(saltedRow(rawKey, { id: 'key-cache-1' }));

      const concurrent = await Promise.all(
        Array.from({ length: 20 }, () => verifyPostgresApiKey(pool, rawKey, ['memories:read'])),
      );
      expect(concurrent.every(result => result?.apiKeyId === 'key-cache-1')).toBe(true);
      // One prefix lookup == one derivation pass for all 20 requests.
      expect(queries.filter(query => isPrefixLookup(query.text)).length).toBe(1);

      const later = await verifyPostgresApiKey(pool, rawKey, ['memories:read']);
      expect(later?.apiKeyId).toBe('key-cache-1');
      expect(queries.filter(query => isPrefixLookup(query.text)).length).toBe(1);
      expect(queries.filter(query => isIdLookup(query.text)).length).toBe(1);
    });

    it('a cached key is refused on the next request after it is revoked, expires or loses a scope', async () => {
      const rawKey = 'cmem_cache-revoke-0123456789';
      const { pool, live } = poolWithLiveRow(saltedRow(rawKey, { id: 'key-cache-2' }));
      expect(await verifyPostgresApiKey(pool, rawKey, ['memories:read'])).not.toBeNull();

      live.scopes = [];
      expect(await verifyPostgresApiKey(pool, rawKey, ['memories:read'])).toBeNull();
      live.scopes = ['memories:read'];

      live.expires_at = new Date(Date.now() - 1000);
      expect(await verifyPostgresApiKey(pool, rawKey, ['memories:read'])).toBeNull();
      live.expires_at = null;

      live.revoked_at = new Date();
      expect(await verifyPostgresApiKey(pool, rawKey, ['memories:read'])).toBeNull();
    });

    it('a cached proof is dropped when the row is re-keyed, so the old raw key stops working', async () => {
      const rawKey = 'cmem_cache-rekey-0123456789';
      const { pool, live } = poolWithLiveRow(saltedRow(rawKey, { id: 'key-cache-3' }));
      expect(await verifyPostgresApiKey(pool, rawKey, [])).not.toBeNull();

      live.key_hash = hashApiKey('cmem_cache-rekey-NEWSECRET');
      expect(await verifyPostgresApiKey(pool, rawKey, [])).toBeNull();
    });

    it('refuses with ScryptQueueFullError when failing verifications exceed the waiter cap', async () => {
      const validKey = 'cmem_flood-0123456789-valid';
      const { pool } = poolWithLiveRow(saltedRow(validKey, { id: 'key-flood-1' }));

      const flood = Array.from({ length: SCRYPT_MAX_WAITERS + 20 }, (_, index) =>
        verifyPostgresApiKey(pool, `cmem_flood-0123456789-wrong-${index}`, []).then(
          result => ({ ok: true as const, result }),
          error => ({ ok: false as const, error }),
        ),
      );
      const outcomes = await Promise.all(flood);
      const refused = outcomes.filter(outcome => !outcome.ok);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.every(outcome => !outcome.ok && outcome.error instanceof ScryptQueueFullError)).toBe(true);
      expect(outcomes.filter(outcome => outcome.ok).every(outcome => outcome.ok && outcome.result === null)).toBe(true);
    });

    it('a flood of wrong-suffix keys does not delay a valid cached key', async () => {
      const validKey = 'cmem_starve-0123456789-valid';
      const { pool } = poolWithLiveRow(saltedRow(validKey, { id: 'key-starve-1' }));
      expect(await verifyPostgresApiKey(pool, validKey, [])).not.toBeNull();

      let floodSettled = 0;
      const flood = Array.from({ length: SCRYPT_MAX_WAITERS }, (_, index) =>
        verifyPostgresApiKey(pool, `cmem_starve-0123456789-wrong-${index}`, [])
          .catch(() => null)
          .finally(() => { floodSettled++; }),
      );

      const valid = await verifyPostgresApiKey(pool, validKey, []);
      expect(valid?.apiKeyId).toBe('key-starve-1');
      // The valid key answered while the flood was still queued on scrypt.
      expect(floodSettled).toBeLessThan(flood.length);
      await Promise.all(flood);
    });

    it('the middleware answers 503 with Retry-After when the scrypt queue is full', async () => {
      const validKey = 'cmem_mw503-0123456789-valid';
      const { pool } = poolWithLiveRow(saltedRow(validKey, { id: 'key-mw-1' }));
      const middleware = requirePostgresServerAuth(pool, { authMode: 'api-key' });

      const responses = await Promise.all(
        Array.from({ length: SCRYPT_MAX_WAITERS + 20 }, (_, index) => new Promise<{ status: number; headers: Record<string, string> }>(resolve => {
          const headers: Record<string, string> = {};
          let status = 200;
          const req = {
            path: '/v1/test',
            header: (name: string) => (name.toLowerCase() === 'authorization'
              ? `Bearer cmem_mw503-0123456789-wrong-${index}`
              : undefined),
          } as unknown as Request;
          const res = {
            setHeader: (name: string, value: string) => { headers[name] = value; },
            status: (code: number) => { status = code; return res; },
            json: () => { resolve({ status, headers }); return res; },
          } as unknown as Response;
          middleware(req, res, () => resolve({ status: 200, headers }));
        })),
      );

      const unavailable = responses.filter(response => response.status === 503);
      expect(unavailable.length).toBeGreaterThan(0);
      expect(unavailable.every(response => response.headers['Retry-After'] === '1')).toBe(true);
      expect(responses.every(response => response.status === 503 || response.status === 403)).toBe(true);
    });
  });

  describe('ensureApiKeySchema (standalone key-command upgrade path)', () => {
    it('adds key_prefix and its index when the table already exists', async () => {
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
          return { rows: [] };
        },
      } as unknown as PostgresQueryable;

      await ensureApiKeySchema(client);

      expect(queries.some(q => q.includes('ADD COLUMN IF NOT EXISTS key_prefix'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix)'))).toBe(true);
    });

    it('does not issue DDL when the api_keys table does not exist yet', async () => {
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [{ present: false }] };
        },
      } as unknown as PostgresQueryable;

      await ensureApiKeySchema(client);

      expect(queries.length).toBe(1);
      expect(queries[0]).toContain('to_regclass');
      expect(queries.some(q => q.includes('ALTER TABLE') || q.includes('CREATE INDEX'))).toBe(false);
    });

    it('keeps the upgrade SQL in the full phase-1 bootstrap text too', () => {
      expect(API_KEY_SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS key_prefix');
      expect(API_KEY_SCHEMA_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix)');
    });
  });
});
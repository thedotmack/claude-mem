import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createServerApiKey,
  createRawServerApiKey,
  hashServerApiKey,
  hashServerApiKeyLegacySha256,
  verifyRawKeyAgainstStoredHash,
  migrateServerApiKeyScopes,
  revokeServerApiKey,
  verifyServerApiKey,
  DEFAULT_LOCAL_API_KEY_SCOPES,
} from '../../src/server/auth/sqlite-api-key-service.js';
import { requireServerAuth } from '../../src/server/middleware/auth.js';
import { AuthRepository, ProjectsRepository, ensureServerStorageSchema } from '../../src/storage/sqlite/index.js';

function seedTeam(db: Database, id: string): string {
  ensureServerStorageSchema(db);
  db.prepare("INSERT INTO teams (id, name, created_at_epoch, updated_at_epoch) VALUES (?, 'Core', 0, 0)").run(id);
  return id;
}

describe('server API key auth', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('creates raw keys once while storing only a salted hash', () => {
    const created = createServerApiKey(db, {
      name: 'Team key',
      teamId: null,
      projectId: null,
      scopes: ['memories:read'],
    });

    expect(created.rawKey).toStartWith('cmem_');
    // #2541 — stored hash is salted scrypt (non-deterministic per raw key),
    // never the plaintext, and verifiable via the constant-time verifier.
    expect(created.record.keyHash).toStartWith('scrypt$');
    expect(created.record.keyHash).not.toContain(created.rawKey);
    expect(verifyRawKeyAgainstStoredHash(created.rawKey, created.record.keyHash)).toBe(true);
    // Salt makes two hashes of the same input differ.
    expect(hashServerApiKey(created.rawKey)).not.toBe(hashServerApiKey(created.rawKey));
    expect(created.record.prefix).toBe(created.rawKey.slice(0, 10));
  });

  it('verifies a key created with the salted scheme', () => {
    const created = createServerApiKey(db, { name: 'k', scopes: ['memories:read'] });
    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])?.record.id).toBe(created.record.id);
    expect(verifyServerApiKey(db, 'cmem_wrong-key', ['memories:read'])).toBeNull();
  });

  it('still verifies legacy unsalted SHA-256 keys (#2541 backward compat)', () => {
    // Seed a key the OLD way: unsalted SHA-256 hash written directly.
    const rawKey = createRawServerApiKey();
    const legacyHash = hashServerApiKeyLegacySha256(rawKey);
    const repo = new AuthRepository(db);
    const record = repo.createApiKey({
      name: 'legacy',
      keyHash: legacyHash,
      prefix: rawKey.slice(0, 10),
      scopes: ['memories:read'],
    });
    expect(record.keyHash).toBe(legacyHash);

    // Legacy key still authenticates.
    const verified = verifyServerApiKey(db, rawKey, ['memories:read']);
    expect(verified?.record.id).toBe(record.id);

    // After verify, the stored hash is transparently upgraded to salted scrypt.
    const upgraded = new AuthRepository(db).getApiKeyById(record.id);
    expect(upgraded?.keyHash).toStartWith('scrypt$');
    // And it still verifies under the new scheme.
    expect(verifyServerApiKey(db, rawKey, ['memories:read'])?.record.id).toBe(record.id);
  });

  it('defaults new keys to read+write scopes matching the v1 routes (#2428)', () => {
    const created = createServerApiKey(db, { name: 'default-scope-key' });
    expect(created.record.scopes).toEqual([...DEFAULT_LOCAL_API_KEY_SCOPES]);
    // A default key is authorized for both read and write routes.
    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])).not.toBeNull();
    expect(verifyServerApiKey(db, created.rawKey, ['memories:write'])).not.toBeNull();
    // But NOT for a scope it was never granted.
    expect(verifyServerApiKey(db, created.rawKey, ['admin:all'])).toBeNull();
  });

  it('migrates a legacy key with empty scopes up to working defaults (#2560)', () => {
    const rawKey = createRawServerApiKey();
    const repo = new AuthRepository(db);
    const record = repo.createApiKey({
      name: 'empty-scope',
      keyHash: hashServerApiKeyLegacySha256(rawKey),
      prefix: rawKey.slice(0, 10),
      scopes: [],
    });
    // Empty-scope key cannot access read routes.
    expect(verifyServerApiKey(db, rawKey, ['memories:read'])).toBeNull();

    const migrated = migrateServerApiKeyScopes(db, record.id);
    expect(migrated?.scopes).toEqual([...DEFAULT_LOCAL_API_KEY_SCOPES]);
    // Now it works.
    expect(verifyServerApiKey(db, rawKey, ['memories:read'])).not.toBeNull();
    expect(verifyServerApiKey(db, rawKey, ['memories:write'])).not.toBeNull();
  });

  it('verifies required scopes and rejects revoked keys', () => {
    const created = createServerApiKey(db, {
      name: 'Scoped key',
      scopes: ['memories:read'],
    });

    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])?.record.id).toBe(created.record.id);
    expect(verifyServerApiKey(db, created.rawKey, ['memories:write'])).toBeNull();

    revokeServerApiKey(db, created.record.id);
    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])).toBeNull();
  });

  function runAuth(
    options: Parameters<typeof requireServerAuth>[1] = {},
    { ip = '127.0.0.1', headers = {} }: { ip?: string; headers?: Record<string, string> } = {},
  ) {
    const req: any = { ip, socket: { remoteAddress: ip }, header: (name: string) => headers[name.toLowerCase()] };
    let nexted = false;
    let status = 200;
    let body: unknown;
    const res: any = {
      status: (code: number) => { status = code; return res; },
      json: (value: unknown) => { body = value; },
    };
    requireServerAuth(() => db, options)(req, res, () => { nexted = true; });
    return { nexted, status, body, ctx: req.authContext };
  }

  it('middleware allows localhost local-dev without a bearer token', () => {
    const result = runAuth({ authMode: 'local-dev', allowLocalDevBypass: true }, {
      headers: { host: '127.0.0.1:37777' },
    });
    expect(result.nexted).toBe(true);
    expect(result.ctx).toMatchObject({ mode: 'local-dev', scopes: ['local-dev'] });
  });

  it('middleware requires explicit opt-in before local-dev bypass is honored', () => {
    const result = runAuth({ authMode: 'local-dev' }, { headers: { host: 'localhost:37777' } });
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
  });

  it('middleware blocks local-dev bypass when forwarded proxy headers are present', () => {
    const result = runAuth({ authMode: 'local-dev', allowLocalDevBypass: true }, {
      headers: { host: 'claude-mem.example.com', 'x-forwarded-for': '203.0.113.10' },
    });
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
  });

  it('middleware accepts bracketed IPv6 loopback host headers in explicit local-dev mode', () => {
    const result = runAuth({ authMode: 'local-dev', allowLocalDevBypass: true }, {
      ip: '::1', headers: { host: '[::1]:37777' },
    });
    expect(result.nexted).toBe(true);
    expect(result.ctx).toMatchObject({ mode: 'local-dev', scopes: ['local-dev'] });
  });

  it('middleware defaults to API-key auth when auth mode is not explicitly set', () => {
    const originalAuthMode = process.env.CLAUDE_MEM_AUTH_MODE;
    delete process.env.CLAUDE_MEM_AUTH_MODE;
    try {
      const result = runAuth({}, { headers: { host: 'localhost:37777' } });
      expect(result.nexted).toBe(false);
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: 'Unauthorized' });
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_MEM_AUTH_MODE;
      } else {
        process.env.CLAUDE_MEM_AUTH_MODE = originalAuthMode;
      }
    }
  });

  it('middleware requires a scoped bearer API key outside local-dev fallback', () => {
    const teamId = seedTeam(db, 'team-core');
    const project = new ProjectsRepository(db).create({ name: 'Project' });
    const created = createServerApiKey(db, {
      name: 'Write key', teamId, projectId: project.id, scopes: ['memories:write'],
    });
    const result = runAuth({ authMode: 'api-key', requiredScopes: ['memories:write'] }, {
      ip: '10.0.0.5', headers: { authorization: `Bearer ${created.rawKey}` },
    });
    expect(result.nexted).toBe(true);
    expect(result.ctx).toMatchObject({
      mode: 'api-key', apiKeyId: created.record.id, teamId, projectId: project.id, scopes: ['memories:write'],
    });
  });

  it('middleware accepts X-Api-Key header as fallback when Bearer is absent', () => {
    // Clients using @better-auth/api-key defaults (e.g. the worker bundle
    // shipped from the Windows-canary line) send raw API keys via X-Api-Key
    // instead of "Authorization: Bearer ...". The middleware accepts either
    // so the server-beta runtime works with both client shapes out of the box.
    const teamId = seedTeam(db, 'team-core');
    const project = new ProjectsRepository(db).create({ name: 'Project' });
    const created = createServerApiKey(db, {
      name: 'XApiKey client', teamId, projectId: project.id, scopes: ['memories:write'],
    });
    const result = runAuth({ authMode: 'api-key', requiredScopes: ['memories:write'] }, {
      ip: '10.0.0.5', headers: { 'x-api-key': created.rawKey },
    });
    expect(result.nexted).toBe(true);
    expect(result.ctx).toMatchObject({
      mode: 'api-key', apiKeyId: created.record.id, teamId, projectId: project.id, scopes: ['memories:write'],
    });
  });

  it('middleware prefers Bearer over X-Api-Key when both are present', () => {
    // Defense-in-depth: if a client sends both, Bearer wins. Avoids surprises
    // where an unrelated X-Api-Key sneaks in via a proxy or a stale env var.
    const teamId = seedTeam(db, 'team-core');
    const bearerKey = createServerApiKey(db, {
      name: 'Bearer key', teamId, projectId: null, scopes: ['memories:write'],
    });
    const xApiKeyKey = createServerApiKey(db, {
      name: 'X-Api-Key key', teamId, projectId: null, scopes: ['memories:write'],
    });
    const result = runAuth({ authMode: 'api-key', requiredScopes: ['memories:write'] }, {
      ip: '10.0.0.5', headers: { authorization: `Bearer ${bearerKey.rawKey}`, 'x-api-key': xApiKeyKey.rawKey },
    });
    expect(result.nexted).toBe(true);
    expect(result.ctx?.apiKeyId).toBe(bearerKey.record.id);
  });

  it('middleware rejects requests with neither Bearer nor X-Api-Key', () => {
    const result = runAuth({ authMode: 'api-key' }, { ip: '10.0.0.5' });
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({
      error: 'Unauthorized',
      message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)',
    });
  });
});

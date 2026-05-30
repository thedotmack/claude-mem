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
import { AuthRepository, ProjectsRepository, TeamsRepository } from '../../src/storage/sqlite/index.js';

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

  it('middleware allows localhost local-dev without a bearer token', () => {
    const middleware = requireServerAuth(() => db, { authMode: 'local-dev', allowLocalDevBypass: true });
    const req: any = {
      ip: '127.0.0.1',
      socket: {},
      header: (name: string) => name.toLowerCase() === 'host' ? '127.0.0.1:37777' : undefined,
    };
    const res: any = {
      status: () => res,
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(true);
    expect(req.authContext).toMatchObject({ mode: 'local-dev', scopes: ['local-dev'] });
  });

  it('middleware requires explicit opt-in before local-dev bypass is honored', () => {
    const middleware = requireServerAuth(() => db, { authMode: 'local-dev' });
    const req: any = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      header: (name: string) => name.toLowerCase() === 'host' ? 'localhost:37777' : undefined,
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('middleware blocks local-dev bypass when forwarded proxy headers are present', () => {
    const middleware = requireServerAuth(() => db, { authMode: 'local-dev', allowLocalDevBypass: true });
    const req: any = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      header: (name: string) => {
        const normalized = name.toLowerCase();
        if (normalized === 'host') return 'claude-mem.example.com';
        if (normalized === 'x-forwarded-for') return '203.0.113.10';
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('middleware accepts bracketed IPv6 loopback host headers in explicit local-dev mode', () => {
    const middleware = requireServerAuth(() => db, { authMode: 'local-dev', allowLocalDevBypass: true });
    const req: any = {
      ip: '::1',
      socket: { remoteAddress: '::1' },
      header: (name: string) => name.toLowerCase() === 'host' ? '[::1]:37777' : undefined,
    };
    const res: any = {
      status: () => res,
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(true);
    expect(req.authContext).toMatchObject({ mode: 'local-dev', scopes: ['local-dev'] });
  });

  it('middleware defaults to API-key auth when auth mode is not explicitly set', () => {
    const originalAuthMode = process.env.CLAUDE_MEM_AUTH_MODE;
    delete process.env.CLAUDE_MEM_AUTH_MODE;
    try {
      const middleware = requireServerAuth(() => db);
      const req: any = {
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        header: (name: string) => name.toLowerCase() === 'host' ? 'localhost:37777' : undefined,
      };
      const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(body: unknown) {
          this.body = body;
        },
      };
      let calledNext = false;

      middleware(req, res, () => {
        calledNext = true;
      });

      expect(calledNext).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ error: 'Unauthorized' });
    } finally {
      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_MEM_AUTH_MODE;
      } else {
        process.env.CLAUDE_MEM_AUTH_MODE = originalAuthMode;
      }
    }
  });

  it('middleware requires a scoped bearer API key outside local-dev fallback', () => {
    const team = new TeamsRepository(db).create({ name: 'Core' });
    const project = new ProjectsRepository(db).create({ name: 'Project' });
    const created = createServerApiKey(db, {
      name: 'Write key',
      teamId: team.id,
      projectId: project.id,
      scopes: ['memories:write'],
    });
    const middleware = requireServerAuth(() => db, {
      authMode: 'api-key',
      requiredScopes: ['memories:write'],
    });
    const req: any = {
      ip: '10.0.0.5',
      socket: {},
      header: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${created.rawKey}` : undefined,
    };
    const res: any = {
      status: () => res,
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(true);
    expect(req.authContext).toMatchObject({
      mode: 'api-key',
      apiKeyId: created.record.id,
      teamId: team.id,
      projectId: project.id,
      scopes: ['memories:write'],
    });
  });

  it('middleware accepts X-Api-Key header as fallback when Bearer is absent', () => {
    // Clients using @better-auth/api-key defaults (e.g. the worker bundle
    // shipped from the Windows-canary line) send raw API keys via X-Api-Key
    // instead of "Authorization: Bearer ...". The middleware accepts either
    // so the server-beta runtime works with both client shapes out of the box.
    const team = new TeamsRepository(db).create({ name: 'Core' });
    const project = new ProjectsRepository(db).create({ name: 'Project' });
    const created = createServerApiKey(db, {
      name: 'XApiKey client',
      teamId: team.id,
      projectId: project.id,
      scopes: ['memories:write'],
    });
    const middleware = requireServerAuth(() => db, {
      authMode: 'api-key',
      requiredScopes: ['memories:write'],
    });
    const req: any = {
      ip: '10.0.0.5',
      socket: {},
      header: (name: string) => name.toLowerCase() === 'x-api-key' ? created.rawKey : undefined,
    };
    const res: any = {
      status: () => res,
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(true);
    expect(req.authContext).toMatchObject({
      mode: 'api-key',
      apiKeyId: created.record.id,
      teamId: team.id,
      projectId: project.id,
      scopes: ['memories:write'],
    });
  });

  it('middleware prefers Bearer over X-Api-Key when both are present', () => {
    // Defense-in-depth: if a client sends both, Bearer wins. Avoids surprises
    // where an unrelated X-Api-Key sneaks in via a proxy or a stale env var.
    const team = new TeamsRepository(db).create({ name: 'Core' });
    const bearerKey = createServerApiKey(db, {
      name: 'Bearer key',
      teamId: team.id,
      projectId: null,
      scopes: ['memories:write'],
    });
    const xApiKeyKey = createServerApiKey(db, {
      name: 'X-Api-Key key',
      teamId: team.id,
      projectId: null,
      scopes: ['memories:write'],
    });
    const middleware = requireServerAuth(() => db, {
      authMode: 'api-key',
      requiredScopes: ['memories:write'],
    });
    const req: any = {
      ip: '10.0.0.5',
      socket: {},
      header: (name: string) => {
        const normalized = name.toLowerCase();
        if (normalized === 'authorization') return `Bearer ${bearerKey.rawKey}`;
        if (normalized === 'x-api-key') return xApiKeyKey.rawKey;
        return undefined;
      },
    };
    const res: any = {
      status: () => res,
      json: () => {},
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(true);
    expect(req.authContext?.apiKeyId).toBe(bearerKey.record.id);
  });

  it('middleware rejects requests with neither Bearer nor X-Api-Key', () => {
    const middleware = requireServerAuth(() => db, { authMode: 'api-key' });
    const req: any = {
      ip: '10.0.0.5',
      socket: {},
      header: (_name: string) => undefined,
    };
    const res: any = {
      statusCode: 200,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
      },
    };
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      error: 'Unauthorized',
      message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)',
    });
  });
});

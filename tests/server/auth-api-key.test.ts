import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createServerApiKey,
  hashServerApiKey,
  revokeServerApiKey,
  verifyServerApiKey,
} from '../../src/server/auth/api-key-service.js';
import { requireServerAuth } from '../../src/server/middleware/auth.js';
import { ProjectsRepository, TeamsRepository } from '../../src/storage/sqlite/index.js';

describe('server API key auth', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('creates raw keys once while storing only a hash', () => {
    const created = createServerApiKey(db, {
      name: 'Team key',
      teamId: null,
      projectId: null,
      scopes: ['memories:read'],
    });

    expect(created.rawKey).toStartWith('cmem_');
    expect(created.record.keyHash).toBe(hashServerApiKey(created.rawKey));
    expect(created.record.keyHash).not.toContain(created.rawKey);
    expect(created.record.prefix).toBe(created.rawKey.slice(0, 10));
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
});

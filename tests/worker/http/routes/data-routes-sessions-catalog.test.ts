import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

describe('GET /api/sessions', () => {
  let db: Database;
  let store: SessionStore;
  let handlers: Map<string, (req: Request, res: Response) => void>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    store.createSDKSession('content-catalog', 'proj-catalog', 'hi');
    store.createSDKSession('content-other', 'proj-other', 'hi', undefined, 'codex');

    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => null } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
    handlers = new Map();
    routes.setupRoutes({
      get: mock((path: string, handler: (req: Request, res: Response) => void) => {
        handlers.set(path, handler);
      }),
      post: mock(() => {}),
      delete: mock(() => {}),
    } as any);
  });

  afterEach(() => {
    db.close();
  });

  function callCatalogPage(query: Record<string, string>) {
    let responseBody: any;
    const response = { json(value: unknown) { responseBody = value; return this; } } as unknown as Response;
    handlers.get('/api/sessions')!({ query, get: () => undefined } as unknown as Request, response);
    return responseBody as { sessions: Array<{ content_session_id: string; project: string; platform_source: string }>; hasMore: boolean };
  }

  function callCatalog(query: Record<string, string>) {
    return callCatalogPage(query).sessions;
  }

  it('returns the session catalog with each session\'s platform', () => {
    const sessions = callCatalog({});
    expect(sessions).toHaveLength(2);
    expect(sessions.find(s => s.content_session_id === 'content-catalog')).toMatchObject({ project: 'proj-catalog', platform_source: 'claude' });
    expect(sessions.find(s => s.content_session_id === 'content-other')).toMatchObject({ platform_source: 'codex' });
  });

  it('filters by project and platform server-side, and honors a limit', () => {
    expect(callCatalog({ project: 'proj-catalog' }).map(s => s.content_session_id)).toEqual(['content-catalog']);
    expect(callCatalog({ platformSource: 'codex' }).map(s => s.content_session_id)).toEqual(['content-other']);
    expect(callCatalog({ limit: '1' })).toHaveLength(1);
  });

  it('pages through older sessions: hasMore until the offset passes the last one', () => {
    const first = callCatalogPage({ limit: '1' });
    expect(first.hasMore).toBe(true);
    const second = callCatalogPage({ limit: '1', offset: '1' });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].content_session_id).not.toBe(first.sessions[0].content_session_id);
    expect(second.hasMore).toBe(false);
  });
});

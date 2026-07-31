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

  it('returns the session catalog', () => {
    let responseBody: any;
    const response = { json(value: unknown) { responseBody = value; return this; } } as unknown as Response;

    handlers.get('/api/sessions')!({ query: {}, get: () => undefined } as unknown as Request, response);

    expect(responseBody.sessions).toHaveLength(1);
    expect(responseBody.sessions[0]).toMatchObject({ content_session_id: 'content-catalog', project: 'proj-catalog' });
  });
});

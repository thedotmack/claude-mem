import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

function capturePostChain(routes: DataRoutes, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const app = {
    get: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path !== targetPath) return;
      if (rest.length === 1) {
        handler = rest[0];
      } else {
        middleware = rest[0];
        handler = rest[1];
      }
    }),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error(`Handler not registered for ${targetPath}`);

  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler!(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

describe('DataRoutes import platform scoping', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('imports prompts for overlapping raw ids into their platform sessions', () => {
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
    const handler = capturePostChain(routes, '/api/import');
    const contentSessionId = 'shared-import-route-raw-id';
    const startedAt = new Date().toISOString();
    const json = mock(() => {});
    const status = mock(() => ({ json }));

    handler({
      path: '/api/import',
      query: {},
      body: {
        sessions: [
          {
            content_session_id: contentSessionId,
            memory_session_id: 'claude-memory',
            project: 'claude-project',
            platform_source: 'claude',
            user_prompt: 'claude prompt',
            started_at: startedAt,
            started_at_epoch: 1,
            completed_at: null,
            completed_at_epoch: null,
            status: 'active',
          },
          {
            content_session_id: contentSessionId,
            memory_session_id: 'cursor-memory',
            project: 'cursor-project',
            platform_source: 'cursor',
            user_prompt: 'cursor prompt',
            started_at: startedAt,
            started_at_epoch: 2,
            completed_at: null,
            completed_at_epoch: null,
            status: 'active',
          },
        ],
        prompts: [
          {
            content_session_id: contentSessionId,
            platform_source: 'cursor',
            prompt_number: 1,
            prompt_text: 'cursor imported prompt',
            created_at: startedAt,
            created_at_epoch: 3,
          },
          {
            content_session_id: contentSessionId,
            platform_source: 'claude',
            prompt_number: 1,
            prompt_text: 'claude imported prompt',
            created_at: startedAt,
            created_at_epoch: 4,
          },
        ],
      },
    } as any, {
      json,
      status,
      headersSent: false,
    } as any);

    expect(json).toHaveBeenCalledWith({
      success: true,
      stats: {
        sessionsImported: 2,
        sessionsSkipped: 0,
        summariesImported: 0,
        summariesSkipped: 0,
        observationsImported: 0,
        observationsSkipped: 0,
        promptsImported: 2,
        promptsSkipped: 0,
      },
    });

    const rows = store.db.prepare(`
      SELECT up.prompt_text, s.platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.content_session_id = ?
      ORDER BY s.platform_source
    `).all(contentSessionId) as Array<{ prompt_text: string; platform_source: string }>;

    expect(rows).toEqual([
      { prompt_text: 'claude imported prompt', platform_source: 'claude' },
      { prompt_text: 'cursor imported prompt', platform_source: 'cursor' },
    ]);
  });
});

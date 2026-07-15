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

function makeRoutes(store: SessionStore): DataRoutes {
  return new DataRoutes(
    {} as any,
    { getSessionStore: () => store, getChromaSync: () => null } as any,
    {} as any,
    {} as any,
    {} as any,
    Date.now(),
  );
}

describe('DataRoutes import with array-valued fields (cloud shape)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('imports observations whose facts/concepts/file lists arrive as real arrays', () => {
    const routes = makeRoutes(store);
    const handler = capturePostChain(routes, '/api/import');
    const memorySessionId = 'array-fields-memory';
    const startedAt = new Date().toISOString();
    const json = mock(() => {});
    const status = mock(() => ({ json }));

    // Mirrors the CloudSync `toCloud` shape, where parseJson turns the locally
    // JSON-string columns back into real arrays before they cross /api/import.
    const importOnce = () => handler({
      path: '/api/import',
      query: {},
      body: {
        sessions: [
          {
            content_session_id: 'array-fields-content',
            memory_session_id: memorySessionId,
            project: 'array-project',
            platform_source: 'claude',
            user_prompt: 'do the thing',
            started_at: startedAt,
            started_at_epoch: 1,
            completed_at: null,
            completed_at_epoch: null,
            status: 'active',
          },
        ],
        observations: [
          {
            memory_session_id: memorySessionId,
            project: 'array-project',
            text: null,
            type: 'discovery',
            title: 'array observation',
            subtitle: 'has array fields',
            facts: ['fact one', 'fact two'],
            narrative: 'narrative text',
            concepts: ['concept-a', 'concept-b'],
            files_read: ['/src/a.ts', '/src/b.ts'],
            files_modified: ['/src/c.ts'],
            prompt_number: 1,
            discovery_tokens: 0,
            created_at: startedAt,
            created_at_epoch: 5,
          },
        ],
      },
    } as any, {
      json,
      status,
      headersSent: false,
    } as any);

    // Must not throw the bun:sqlite "Binding expected string…" error.
    expect(importOnce).not.toThrow();

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      stats: expect.objectContaining({
        observationsImported: 1,
        observationsSkipped: 0,
      }),
    }));

    const row = store.db.prepare(`
      SELECT facts, concepts, files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).get(memorySessionId) as {
      facts: string;
      concepts: string;
      files_read: string;
      files_modified: string;
    };

    // Stored as canonical JSON strings so downstream JSON.parse consumers work.
    expect(JSON.parse(row.facts)).toEqual(['fact one', 'fact two']);
    expect(JSON.parse(row.concepts)).toEqual(['concept-a', 'concept-b']);
    expect(JSON.parse(row.files_read)).toEqual(['/src/a.ts', '/src/b.ts']);
    expect(JSON.parse(row.files_modified)).toEqual(['/src/c.ts']);
  });

  it('imports session summaries whose file lists arrive as real arrays', () => {
    const routes = makeRoutes(store);
    const handler = capturePostChain(routes, '/api/import');
    const memorySessionId = 'array-summary-memory';
    const startedAt = new Date().toISOString();
    const json = mock(() => {});
    const status = mock(() => ({ json }));

    const importOnce = () => handler({
      path: '/api/import',
      query: {},
      body: {
        sessions: [
          {
            content_session_id: 'array-summary-content',
            memory_session_id: memorySessionId,
            project: 'array-project',
            platform_source: 'claude',
            user_prompt: 'do the thing',
            started_at: startedAt,
            started_at_epoch: 1,
            completed_at: null,
            completed_at_epoch: null,
            status: 'active',
          },
        ],
        summaries: [
          {
            memory_session_id: memorySessionId,
            project: 'array-project',
            request: 'the request',
            investigated: 'the investigation',
            learned: 'the learning',
            completed: 'the completion',
            next_steps: 'the next steps',
            files_read: ['/src/a.ts'],
            files_edited: ['/src/b.ts', '/src/c.ts'],
            notes: 'the notes',
            prompt_number: 1,
            discovery_tokens: 0,
            created_at: startedAt,
            created_at_epoch: 7,
          },
        ],
      },
    } as any, {
      json,
      status,
      headersSent: false,
    } as any);

    expect(importOnce).not.toThrow();

    const row = store.db.prepare(`
      SELECT files_read, files_edited
      FROM session_summaries
      WHERE memory_session_id = ?
    `).get(memorySessionId) as { files_read: string; files_edited: string };

    expect(JSON.parse(row.files_read)).toEqual(['/src/a.ts']);
    expect(JSON.parse(row.files_edited)).toEqual(['/src/b.ts', '/src/c.ts']);
  });
});

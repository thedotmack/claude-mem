import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

function capturePostChain(routes: DataRoutes, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const app = {
    get: mock(() => {}),
    delete: mock(() => {}),
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

describe('DataRoutes import reports rejected rows instead of aborting the batch', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function observationRow(memorySessionId: unknown, title: string, epoch: number): Record<string, unknown> {
    return {
      memory_session_id: memorySessionId,
      project: 'reject-project',
      text: null,
      type: 'discovery',
      title,
      subtitle: null,
      facts: '[]',
      narrative: 'narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(epoch).toISOString(),
      created_at_epoch: epoch,
    };
  }

  function runImport(body: Record<string, unknown>): any {
    const handler = capturePostChain(makeRoutes(store), '/api/import');
    const json = mock((_payload: unknown) => {});
    const status = mock(() => ({ json }));
    handler({ path: '/api/import', query: {}, body } as any, { json, status, headersSent: false } as any);
    expect(json).toHaveBeenCalledTimes(1);
    return json.mock.calls[0]![0];
  }

  it('imports the valid rows and names each rejected row by index and reason', () => {
    const result = runImport({
      sessions: [{
        content_session_id: 'reject-content',
        memory_session_id: 'reject-memory',
        project: 'reject-project',
        platform_source: 'claude',
        user_prompt: 'prompt',
        started_at: new Date(1).toISOString(),
        started_at_epoch: 1,
        completed_at: null,
        completed_at_epoch: null,
        status: 'completed',
      }],
      observations: [
        observationRow('reject-memory', 'kept first', 10),
        observationRow(null, 'no session id', 11),
        observationRow({}, 'object session id', 12),
        observationRow('memory-session-not-in-this-database', 'unknown session', 13),
        observationRow('reject-memory', 'kept last', 14),
      ],
      summaries: [
        { memory_session_id: '   ', project: 'reject-project', created_at: 'x', created_at_epoch: 1 },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.stats).toMatchObject({
      sessionsImported: 1,
      observationsImported: 2,
      observationsRejected: 3,
      summariesRejected: 1,
    });
    expect(result.rejected.observations.map((row: { index: number }) => row.index)).toEqual([1, 2, 3]);
    expect(result.rejected.observations[0].reason).toContain('memory_session_id');
    expect(result.rejected.observations[2].reason).toContain('FOREIGN KEY');
    expect(result.rejected.summaries[0]).toMatchObject({ index: 0 });
    expect(result.rejected.summaries[0].reason).toContain('memory_session_id');

    const titles = (store.db.prepare('SELECT title FROM observations ORDER BY created_at_epoch').all() as Array<{ title: string }>)
      .map(row => row.title);
    expect(titles).toEqual(['kept first', 'kept last']);
  });

  it('reports no rejections for a clean batch', () => {
    const result = runImport({ observations: [], summaries: [] });
    expect(result.rejected).toEqual({ sessions: [], summaries: [], observations: [], prompts: [] });
    expect(result.stats.observationsRejected).toBe(0);
  });
});

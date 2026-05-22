import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import {
  __setExternalMemoryDriverLoaderForTesting,
  closeExternalMemorySyncService,
} from '../../../../src/services/external-memory/sync-service.js';

class FakePgPool {
  queries: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    if (text.includes('format_type(a.atttypid, a.atttypmod)')) {
      return { rows: [{ embedding_type: 'vector(1536)' }], rowCount: 1 };
    }
    if (text.includes("kind = 'observation'")) {
      return { rows: [externalRow('observation')], rowCount: 1 };
    }
    if (text.includes("kind = 'summary'")) {
      return { rows: [externalRow('summary')], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async end() {}
}

class FakeRedis {
  async set() { return 'OK'; }
  async get() { return null; }
  async zadd() { return 1; }
  async zrevrange() { return []; }
  async expire() { return 1; }
  async quit() { return 'OK'; }
  disconnect() {}
}

function externalRow(kind: 'observation' | 'summary') {
  return {
    id: kind === 'observation' ? 101 : 201,
    memory_session_id: 'memory-session-primary',
    project: 'claude-mem',
    kind,
    type: kind === 'observation' ? 'decision' : 'session_summary',
    title: kind === 'observation' ? 'Observation hit' : 'Summary hit',
    subtitle: null,
    content: `${kind} content`,
    facts: [],
    narrative: 'Primary search result',
    concepts: [],
    files_read: ['src/services/worker/http/routes/SearchRoutes.ts'],
    files_modified: [],
    prompt_number: 7,
    discovery_tokens: 10,
    metadata: kind === 'summary'
      ? { request: 'Search by file', learned: 'Summaries are indexed by file' }
      : {},
    created_at: '2026-05-22T00:00:00.000Z',
    created_at_epoch: kind === 'observation' ? 1_700_000_000_100 : 1_700_000_000_000,
  };
}

function captureGetHandler(routes: SearchRoutes, routePath: string): (req: Request, res: Response) => void {
  let captured: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock((path: string, handler: (req: Request, res: Response) => void) => {
      if (path === routePath) {
        captured = handler;
      }
    }),
    post: mock(() => {}),
    delete: mock(() => {}),
    use: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  if (!captured) throw new Error(`Failed to capture ${routePath} handler`);
  return captured;
}

function createMockRes() {
  const res = {
    status: mock(() => res),
    json: mock(() => {}),
    headersSent: false,
  };
  return res;
}

describe('SearchRoutes external primary search', () => {
  let restoreLoader: (() => void) | null = null;
  let pools: FakePgPool[] = [];

  afterEach(async () => {
    restoreLoader?.();
    restoreLoader = null;
    pools = [];
    delete process.env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED;
    delete process.env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE;
    delete process.env.CLAUDE_MEM_PG_URL;
    delete process.env.CLAUDE_MEM_VALKEY_URL;
    await closeExternalMemorySyncService();
  });

  it('maps by-file query options explicitly and includes primary summary results', async () => {
    class Pool extends FakePgPool {
      constructor() {
        super();
        pools.push(this);
      }
    }

    restoreLoader = __setExternalMemoryDriverLoaderForTesting(async () => ({
      Pool: Pool as any,
      Redis: FakeRedis as any,
    }));
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED = 'true';
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE = 'primary';
    process.env.CLAUDE_MEM_PG_URL = 'postgres://example/claude_mem';
    process.env.CLAUDE_MEM_VALKEY_URL = 'redis://example:6379';

    const routes = new SearchRoutes({
      getOrchestrator: () => ({
        findByFile: mock(() => {
          throw new Error('SQLite path should not be used in external primary mode');
        }),
      }),
      getFormatter: () => ({
        formatTableHeader: () => 'HEADER',
        formatObservationIndex: (obs: { id: number }) => `OBS:${obs.id}`,
        formatSessionIndex: (session: { id: number }) => `SESSION:${session.id}`,
      }),
    } as any);
    const handler = captureGetHandler(routes, '/api/search/by-file');
    const res = createMockRes();

    handler({
      path: '/api/search/by-file',
      query: {
        filePath: 'src/services/worker/http/routes/SearchRoutes.ts',
        project: 'claude-mem',
        limit: '7',
        unexpected: 'do-not-forward',
      },
    } as unknown as Request, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.content[0].text).toContain('OBS:101');
    expect(payload.content[0].text).toContain('SESSION:201');

    const searchQueries = pools[0]!.queries.filter(query => query.text.includes('claude_mem_external_memory_items') && query.text.includes('kind = '));
    expect(searchQueries).toHaveLength(2);
    for (const query of searchQueries) {
      expect(query.values).toContain('claude-mem');
      expect(query.values).toContain('%src/services/worker/http/routes/SearchRoutes.ts%');
      expect(query.values).toContain(7);
      expect(query.values).not.toContain('do-not-forward');
    }
  });
});

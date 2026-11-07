// GET /api/search/by-file passed `projects` straight from the query string.
// With Chroma off, a comma-separated value reached SessionSearch as a string
// and threw (scopedProjects called .map on it). With Chroma on, the hybrid
// strategy's SQLite file lookup ignored `projects`, so every project's rows
// matched. The route now parses `projects` into a list once, and both
// strategies scope the file lookup by the same read keys.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';

type Handler = (req: Request, res: Response) => void;

let store: SessionStore;
let search: SessionSearch;

function seedObservation(memorySessionId: string, project: string, title: string, mergedInto: string | null = null): void {
  const sessionDbId = store.createSDKSession(`content-${memorySessionId}`, project, `prompt about ${title}`);
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  store.storeObservation(memorySessionId, project, {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: `${title} narrative`,
    concepts: [],
    files_read: ['src/app.ts'],
    files_modified: [],
  }, 1);
  if (mergedInto) {
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?').run(mergedInto, memorySessionId);
  }
}

beforeEach(() => {
  store = new SessionStore(':memory:');
  search = new SessionSearch(store.db);
  // The folder key the checkout wrote under before a slug renamed it.
  seedObservation('mem-folder', 'api', 'FOLDER_KEY_RECORD');
  // The slug key it writes under now.
  seedObservation('mem-slug', 'acme/api', 'SLUG_KEY_RECORD');
  // A project merged into `api`, and a worktree merged into that one.
  seedObservation('mem-merged', 'api-old', 'MERGED_PROJECT_RECORD', 'api');
  seedObservation('mem-worktree', 'api-old/wt', 'TWO_HOP_RECORD', 'api-old');
  seedObservation('mem-other', 'other', 'UNRELATED_RECORD');
});

afterEach(() => {
  store.close();
});

// Prints titles only, so the assertions read the rows the search returned
// without depending on the active mode's type icons.
const titleFormatter = {
  formatTableHeader: () => '',
  formatObservationIndex: (observation: { title: string }) => `OBS ${observation.title}`,
  formatSessionIndex: (summary: { request: string }) => `SESSION ${summary.request}`,
};

// Ranks every stored observation; the hybrid strategy keeps only the rows its
// SQLite file lookup matched.
function fakeChromaSync() {
  return {
    queryChroma: mock(async () => ({
      ids: (store.db.prepare('SELECT id FROM observations ORDER BY id DESC').all() as Array<{ id: number }>).map(row => row.id),
      distances: [],
      metadatas: [],
    })),
  };
}

function byFileHandler(chromaSync: unknown): Handler {
  const manager = new SearchManager(search, store, chromaSync as any, titleFormatter as any, new TimelineService());
  const handlers = new Map<string, Handler>();
  new SearchRoutes(manager).setupRoutes({
    use: () => {},
    get: (path: string, handler: Handler) => { handlers.set(path, handler); },
    post: () => {},
  } as any);
  return handlers.get('/api/search/by-file')!;
}

async function requestByFile(handler: Handler, query: Record<string, unknown>): Promise<{ status: number; body: any }> {
  let status = 200;
  let body: any;
  let responded!: () => void;
  const response = new Promise<void>(resolve => { responded = resolve; });
  const res = {
    headersSent: false,
    locals: {},
    status(code: number) { status = code; return res; },
    json(payload: unknown) { body = payload; responded(); return res; },
  };
  handler({ path: '/api/search/by-file', query, body: {}, get: () => undefined } as any, res as any);
  await response;
  return { status, body };
}

function titlesIn(body: any): string[] {
  const text: string = body?.content?.[0]?.text ?? '';
  return [...text.matchAll(/OBS (\S+)/g)].map(match => match[1]).sort();
}

const READ_BY_THE_CHECKOUT = ['FOLDER_KEY_RECORD', 'MERGED_PROJECT_RECORD', 'SLUG_KEY_RECORD', 'TWO_HOP_RECORD'];

describe('GET /api/search/by-file scoped by a projects list', () => {
  it('reads every listed project and the projects merged into them, with Chroma off', async () => {
    const handler = byFileHandler(null);

    for (const projects of ['api,acme/api', ['api', 'acme/api']]) {
      const { status, body } = await requestByFile(handler, { filePath: 'src/app.ts', projects });
      expect(status).toBe(200);
      expect(titlesIn(body)).toEqual(READ_BY_THE_CHECKOUT);
    }
  });

  it('reads every listed project and the projects merged into them, with Chroma on', async () => {
    const chromaSync = fakeChromaSync();
    const handler = byFileHandler(chromaSync);

    for (const projects of ['api,acme/api', ['api', 'acme/api']]) {
      const { status, body } = await requestByFile(handler, { filePath: 'src/app.ts', projects });
      expect(status).toBe(200);
      expect(titlesIn(body)).toEqual(READ_BY_THE_CHECKOUT);
    }
    expect(chromaSync.queryChroma).toHaveBeenCalled();
  });

  it('rejects a projects value that is not a key or a list of keys', async () => {
    const { status, body } = await requestByFile(byFileHandler(null), {
      filePath: 'src/app.ts',
      projects: { key: 'api' },
    });

    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PROJECTS');
  });
});

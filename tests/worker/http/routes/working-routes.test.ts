// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Request, Response } from 'express';
import { WorkingRoutes } from '../../../../src/services/worker/http/routes/WorkingRoutes.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import type { SettingsDefaults } from '../../../../src/shared/SettingsDefaultsManager.js';

type Handler = (req: Request, res: Response) => void;

const SETTINGS: Partial<SettingsDefaults> = {
  CLAUDE_MEM_WORKING_ENABLED: 'true',
  CLAUDE_MEM_WORKING_MAX_KEYS: '2',
  CLAUDE_MEM_WORKING_MAX_TOKENS: '1000',
  CLAUDE_MEM_WORKING_JOURNAL_SIZE: '2',
  CLAUDE_MEM_WORKING_TTL_DAYS: '7',
};

let store: SessionStore;
let handlers: Map<string, Handler>;

beforeEach(() => {
  store = new SessionStore(':memory:');
  handlers = new Map();

  const routes = new WorkingRoutes(
    {
      getSessionStore: () => store,
      getCloudSync: () => null,
    } as any,
    () => SETTINGS as SettingsDefaults,
  );

  const capture = (method: string) => (path: string, ...rest: any[]) => {
    handlers.set(`${method} ${path}`, rest[rest.length - 1]);
  };
  const app = {
    use: mock(() => {}),
    get: mock(capture('GET')),
    put: mock(capture('PUT')),
    delete: mock(capture('DELETE')),
    post: mock(capture('POST')),
  };
  routes.setupRoutes(app as any);
});

function makeResponse(): { res: Response; body: () => any; statusCode: () => number } {
  const res: any = {
    headersSent: false,
    locals: {},
    statusCodeValue: 200,
    jsonBody: undefined,
  };
  res.status = mock((code: number) => {
    res.statusCodeValue = code;
    return res;
  });
  res.json = mock((body: unknown) => {
    res.jsonBody = body;
    return res;
  });
  return {
    res: res as Response,
    body: () => res.jsonBody,
    statusCode: () => res.statusCodeValue,
  };
}

function makeRequest(over: { body?: Record<string, unknown>; query?: Record<string, unknown>; path?: string }): Request {
  return {
    path: over.path ?? '/api/working',
    body: over.body ?? {},
    query: over.query ?? {},
    get: () => undefined,
  } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function run(methodPath: string, req: Request): Promise<{ body: any; status: number }> {
  const handler = handlers.get(methodPath);
  if (!handler) throw new Error(`handler not registered: ${methodPath}`);
  const response = makeResponse();
  handler(req, response.res);
  await flushAsyncHandlers();
  return { body: response.body(), status: response.statusCode() };
}

const PROJECT = 'proj';

describe('WorkingRoutes', () => {
  it('registers all six endpoints', () => {
    for (const key of [
      'GET /api/working',
      'PUT /api/working',
      'DELETE /api/working',
      'POST /api/working/journal',
      'POST /api/working/promote',
      'POST /api/working/close',
    ]) {
      expect(handlers.has(key)).toBe(true);
    }
  });

  it('PUT upserts and GET lists the entry with limits and tokens', async () => {
    const put = await run('PUT /api/working', makeRequest({
      body: { project: PROJECT, key: 'hypothesis', value: 'cache bug' },
    }));
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(put.body.entry.kind).toBe('intent');

    const list = await run('GET /api/working', makeRequest({ query: { project: PROJECT } }));
    expect(list.status).toBe(200);
    expect(list.body.entries.length).toBe(1);
    expect(list.body.entries[0].key).toBe('hypothesis');
    expect(list.body.limits.maxKeys).toBe(2);
    expect(list.body.tokens).toBeGreaterThan(0);
  });

  it('PUT over the slot limit answers 409 with the current key list', async () => {
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'a', value: '1' } }));
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'b', value: '22' } }));

    const over = await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'c', value: '3' } }));
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('WORKING_LIMIT');
    expect(over.body.keys).toEqual([
      { key: 'a', chars: 1 },
      { key: 'b', chars: 2 },
    ]);
  });

  it('journal POST appends a ring entry that does not consume intent slots', async () => {
    await run('POST /api/working/journal', makeRequest({ body: { project: PROJECT, text: 'Read src/x.ts' } }));
    await run('POST /api/working/journal', makeRequest({ body: { project: PROJECT, text: 'Edit src/y.ts' } }));
    await run('POST /api/working/journal', makeRequest({ body: { project: PROJECT, text: 'Bash: bun test' } }));

    // Ring of 2: the oldest line is gone.
    const list = await run('GET /api/working', makeRequest({ query: { project: PROJECT } }));
    const journal = list.body.entries.filter((e: any) => e.kind === 'journal').map((e: any) => e.value);
    expect(journal).toEqual(['Edit src/y.ts', 'Bash: bun test']);

    // Both intent slots still free.
    const put = await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'a', value: '1' } }));
    expect(put.status).toBe(200);
  });

  it('DELETE removes a slot and 404s on a missing one', async () => {
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'a', value: '1' } }));

    const del = await run('DELETE /api/working', makeRequest({ body: { project: PROJECT, key: 'a' } }));
    expect(del.status).toBe(200);

    const missing = await run('DELETE /api/working', makeRequest({ body: { project: PROJECT, key: 'a' } }));
    expect(missing.status).toBe(404);
  });

  it('promote creates an observation and clears the slot', async () => {
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'confirmed', value: 'the fix worked' } }));

    const promoted = await run('POST /api/working/promote', makeRequest({
      body: { project: PROJECT, key: 'confirmed', type: 'decision' },
    }));
    expect(promoted.status).toBe(200);
    expect(promoted.body.success).toBe(true);
    expect(typeof promoted.body.observationId).toBe('number');

    const obs = store.db.prepare('SELECT * FROM observations WHERE id = ?').get(promoted.body.observationId) as any;
    expect(obs.narrative).toBe('the fix worked');
    expect(obs.type).toBe('decision');

    const list = await run('GET /api/working', makeRequest({ query: { project: PROJECT } }));
    expect(list.body.entries).toEqual([]);
  });

  it('promote 404s on a missing key', async () => {
    const missing = await run('POST /api/working/promote', makeRequest({
      body: { project: PROJECT, key: 'nope' },
    }));
    expect(missing.status).toBe(404);
  });

  it('close drops the whole task set', async () => {
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'a', value: '1' } }));
    await run('POST /api/working/journal', makeRequest({ body: { project: PROJECT, text: 'Read src/x.ts' } }));

    const closed = await run('POST /api/working/close', makeRequest({ body: { project: PROJECT } }));
    expect(closed.status).toBe(200);
    expect(closed.body.dropped).toBe(2);

    const list = await run('GET /api/working', makeRequest({ query: { project: PROJECT } }));
    expect(list.body.entries).toEqual([]);
  });

  it('GET requires the project parameter', async () => {
    const res = await run('GET /api/working', makeRequest({ query: {} }));
    expect(res.status).toBe(400);
  });

  it('scopes entries by task', async () => {
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, task: 'bugfix', key: 'a', value: '1' } }));
    await run('PUT /api/working', makeRequest({ body: { project: PROJECT, key: 'b', value: '2' } }));

    const bugfix = await run('GET /api/working', makeRequest({ query: { project: PROJECT, task: 'bugfix' } }));
    expect(bugfix.body.entries.map((e: any) => e.key)).toEqual(['a']);

    const all = await run('GET /api/working', makeRequest({ query: { project: PROJECT } }));
    expect(all.body.entries.length).toBe(2);
  });
});

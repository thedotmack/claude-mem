import { expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../../../src/services/worker/PaginationHelper.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

type CatalogBody = {
  sessions: Array<{ content_session_id: string; summary_title?: string | null; item_count: number }>;
  hasMore: boolean;
};

it('GET /api/sessions titles each session by its newest summary, null when it has none', async () => {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  const facade = { getSessionStore: () => store } as any;
  const app = express();
  new DataRoutes(new PaginationHelper(facade), facade, {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const empty = { investigated: '', learned: '', completed: '', next_steps: '', notes: null };
    const titled = store.createSDKSession('titled-session', 'Acme/Repo', 'first');
    store.ensureMemorySessionIdRegistered(titled, 'titled-memory');
    store.storeSummary('titled-memory', 'Acme/Repo', { request: 'Earlier ask', ...empty }, 1, 0, 1_000);
    store.storeSummary('titled-memory', 'Acme/Repo', { request: '  Ship the session titles  ', ...empty }, 2, 0, 2_000);
    store.storeSummary('titled-memory', 'Acme/Repo', { request: '   ', ...empty }, 3, 0, 3_000);
    const untitled = store.createSDKSession('untitled-session', 'Acme/Repo', 'second');
    store.ensureMemorySessionIdRegistered(untitled, 'untitled-memory');
    store.db.prepare('UPDATE sdk_sessions SET started_at_epoch = started_at_epoch + 1 WHERE id = ?').run(untitled);

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No owned HTTP listener');
    const url = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${url}/api/sessions?project=acme%2Frepo&limit=1`);
    expect(response.status).toBe(200);
    const first = await response.json() as CatalogBody;
    expect(first.hasMore).toBe(true);
    // Present as null, not missing: the viewer tells this worker from an older one by the field being there.
    expect(first.sessions).toEqual([expect.objectContaining({ content_session_id: 'untitled-session', summary_title: null, item_count: 0 })]);
    expect(Object.hasOwn(first.sessions[0], 'summary_title')).toBe(true);

    const second = await (await fetch(`${url}/api/sessions?project=acme%2Frepo&limit=1&offset=1`)).json() as CatalogBody;
    expect(second.hasMore).toBe(false);
    expect(second.sessions).toEqual([expect.objectContaining({ content_session_id: 'titled-session', summary_title: 'Ship the session titles', item_count: 3 })]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});

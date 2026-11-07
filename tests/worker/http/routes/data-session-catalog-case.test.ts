import { expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../../../src/services/worker/PaginationHelper.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

for (const project of ['acme/repo', 'ACME/REPO']) {
  it(`keeps the Sessions catalog aligned with the feed for project ${project}`, async () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const facade = { getSessionStore: () => store } as any;
    const app = express();
    new DataRoutes(new PaginationHelper(facade), facade, {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      for (const source of ['claude', 'cursor']) {
        const sid = store.createSDKSession('same-content-id', 'Acme/Repo', 'fixture', undefined, source);
        store.ensureMemorySessionIdRegistered(sid, `${source}-memory`);
        store.storeObservation(`${source}-memory`, 'Acme/Repo', {
          type: 'discovery', title: `${source} fact`, narrative: 'Fixture fact', facts: [], concepts: [], files_read: [], files_modified: [],
        }, 1);
        store.storeSummary(`${source}-memory`, 'Acme/Repo', {
          request: 'Fixture summary', investigated: null, learned: null, completed: null, next_steps: null, notes: null,
        }, 1);
        store.saveUserPrompt('same-content-id', 1, 'Fixture ask', sid);
      }
      store.createSDKSession('different-project', 'Acme/Repo-tools', 'other', undefined, 'cursor');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No owned HTTP listener');
      const url = `http://127.0.0.1:${address.port}`;
      const filter = new URLSearchParams({ project, platformSource: 'cursor', limit: '1' });
      const feed = await (await fetch(`${url}/api/observations?${filter}`)).json() as { items: unknown[] };
      expect(feed.items).toHaveLength(1);
      const response = await fetch(`${url}/api/sessions?${filter}`);
      expect(response.status).toBe(200);
      const catalog = await response.json() as { sessions: Array<{ project: string; platform_source: string; item_count: number }>; hasMore: boolean };
      expect(catalog.sessions).toHaveLength(1);
      expect(catalog.sessions[0]).toMatchObject({ project: 'Acme/Repo', platform_source: 'cursor', item_count: 3 });
      expect(catalog.hasMore).toBe(false);
      const next = await (await fetch(`${url}/api/sessions?${filter}&offset=1`)).json() as { sessions: unknown[] };
      expect(next.sessions).toEqual([]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    }
  });
}

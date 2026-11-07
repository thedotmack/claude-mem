import { expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../../../src/services/worker/PaginationHelper.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

async function withFeed(store: SessionStore, check: (url: string) => Promise<void>) {
  const facade = { getSessionStore: () => store } as any;
  const app = express();
  new DataRoutes(new PaginationHelper(facade), facade, {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP listener');
  try { await check(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it('pages newest feed rows first when capture timestamps tie', async () => {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const sid = store.createSDKSession('tied-feed', 'project', 'fixture');
    store.ensureMemorySessionIdRegistered(sid, 'tied-memory');
    for (let index = 1; index <= 3; index++) {
      store.storeObservation('tied-memory', 'project', {
        type: 'discovery', title: `Observation ${index}`, subtitle: null, narrative: `Fact ${index}`,
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, index, 0, 1000);
      store.storeSummary('tied-memory', 'project', {
        request: `Summary ${index}`, investigated: null, learned: null, completed: null, next_steps: null, notes: null,
      }, index, 0, 1000);
      const prompt = store.saveUserPrompt('tied-feed', index, `Prompt ${index}`, sid);
      store.db.run('UPDATE user_prompts SET created_at_epoch = 1000 WHERE id = ?', [prompt]);
    }
    await withFeed(store, async url => {
      for (const kind of ['observations', 'summaries', 'prompts']) {
        const ids: number[] = [];
        for (let offset = 0; offset < 3; offset++) {
          const response = await fetch(`${url}/api/${kind}?project=project&limit=1&offset=${offset}`);
          expect(response.status).toBe(200);
          const page = await response.json() as {items: Array<{id:number}>; hasMore: boolean};
          expect(page.items).toHaveLength(1);
          expect(page.hasMore).toBe(offset < 2);
          ids.push(page.items[0].id);
        }
        expect(ids).toEqual([3,2,1]);
      }
    });
  } finally { store.close(); }
});

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

it('keeps repeated native turns in the viewer while deduplicating only legacy deliveries', async () => {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const sid = store.createSDKSession('native-feed', 'project', 'again', undefined, 'hermes');
    const first = store.saveNativeUserPrompt('native-feed', sid, 'turn-one', 'again');
    const second = store.saveNativeUserPrompt('native-feed', sid, 'turn-two', 'again');
    expect(store.saveNativeUserPrompt('native-feed', sid, 'turn-one', 'again').id).toBe(first.id);
    const legacyFirst = store.saveUserPrompt('native-feed', 3, 'legacy repeat', sid);
    const legacySecond = store.saveUserPrompt('native-feed', 4, 'legacy repeat', sid);
    [first.id, second.id, legacyFirst, legacySecond].forEach((id, index) => {
      store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?', [1000 + index * 1000, id]);
    });
    await withFeed(store, async url => {
      const ids: number[] = [];
      for (let offset = 0; offset < 3; offset++) {
        const response = await fetch(`${url}/api/prompts?project=project&platformSource=hermes&limit=1&offset=${offset}`);
        expect(response.status).toBe(200);
        const page = await response.json() as { items: Array<{id: number}>; hasMore: boolean };
        expect(page.items).toHaveLength(1);
        expect(page.hasMore).toBe(offset < 2);
        ids.push(page.items[0].id);
      }
      expect(ids).toEqual([legacySecond, second.id, first.id]);
    });
  } finally { store.close(); }
});

it('does not let a native turn erase an earlier legacy prompt with equal text', async () => {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const sid = store.createSDKSession('mixed-feed', 'project', 'again');
    const legacy = store.saveUserPrompt('mixed-feed', 1, 'again', sid);
    const native = store.saveNativeUserPrompt('mixed-feed', sid, 'real-turn', 'again');
    await withFeed(store, async url => {
      const page = await (await fetch(`${url}/api/prompts?project=project`)).json() as {items: Array<{id: number}>};
      expect(page.items.map(row => row.id).sort((a,b) => a-b)).toEqual([legacy,native.id]);
    });
  } finally { store.close(); }
});

it('does not let a later legacy delivery erase an earlier native turn with equal text', async () => {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const sid = store.createSDKSession('native-then-legacy', 'project', 'again');
    const native = store.saveNativeUserPrompt('native-then-legacy', sid, 'real-turn', 'again');
    const legacy = store.saveUserPrompt('native-then-legacy', 2, 'again', sid);
    store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?', [1000, native.id]);
    store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?', [2000, legacy]);
    await withFeed(store, async url => {
      const page = await (await fetch(`${url}/api/prompts?project=project`)).json() as {items: Array<{id: number}>};
      expect(page.items.map(row => row.id)).toEqual([legacy, native.id]);
    });
  } finally { store.close(); }
});

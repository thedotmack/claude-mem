import { describe, expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

describe('raw tool reads share the case-insensitive project scope', () => {
  it('lists, fetches, and counts stored tool uses after a project case change', async () => {
    const store = new SessionStore(':memory:');
    const id = store.upsertToolUse({ toolUseId: 'call-1', contentSessionId: 'host-1', project: 'MyProject', toolName: 'Read', toolInput: '{}', toolResponse: 'file contents' });
    const app = express();
    app.use(express.json());
    new DataRoutes({} as any, { getSessionStore: () => store } as any, {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const listing = await (await fetch(`${url}/api/tool-uses?project=myproject`)).json();
      const batch = await (await fetch(`${url}/api/tool-uses/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], project: 'MYPROJECT' }) })).json();
      const unrelated = await (await fetch(`${url}/api/tool-uses?project=other`)).json();
      expect(listing.toolUses.map((row: { id: number }) => row.id)).toEqual([id]);
      expect(batch.map((row: { id: number }) => row.id)).toEqual([id]);
      expect(store.countToolUses({ project: 'mYpRoJeCt' })).toEqual([{ tool_name: 'Read', uses: 1 }]);
      expect(unrelated.toolUses).toEqual([]);
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tool_uses' AND name = ?").get('idx_tool_uses_project_nocase_created')).toEqual({ name: 'idx_tool_uses_project_nocase_created' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  });
});

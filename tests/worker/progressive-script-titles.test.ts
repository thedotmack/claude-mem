import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ProgressiveMemorySearch } from '../../src/services/worker/ProgressiveMemorySearch.js';
import { progressiveSearchToolResult } from '../../src/shared/progressive-search.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';

const cases = [
  { query: '用户', title: '修复用户身份认证', kind: 'observation' },
  { query: 'ユーザー', title: 'ユーザー認証の不具合修正', kind: 'summary' },
  { query: '로그인', title: '로그인실패해결', kind: 'observation' },
  { query: 'ข้อมูล', title: 'แก้ไขข้อมูลผู้ใช้', kind: 'summary' },
  { query: '𠮷野', title: '対応済み𠮷野家の認証', kind: 'observation' },
] as const;

describe('Dumb search title evidence in unsegmented scripts', () => {
  for (const { query, title, kind } of cases) {
    it(`fetches the ${kind} selected by ${query} through the real HTTP search route`, async () => {
      const db = new Database(':memory:');
      const store = new SessionStore(db);
      const search = new SessionSearch(db);
      const manager = new SearchManager(search, store, null, new FormattingService(), new TimelineService());
      const project = 'script-title-fixture';
      const epoch = Date.now() - 1000;
      const memory = store.getOrCreateManualSession(project);
      const evidence = `EVIDENCE_FOR_${query}`;
      const expectedId = kind === 'observation'
        ? String(store.storeObservation(memory, project, {
          type: 'decision', title, subtitle: null, narrative: evidence, facts: [], concepts: [], files_read: [], files_modified: [],
        }, 1, 0, epoch).id)
        : `S${store.storeSummary(memory, project, {
          request: title, investigated: evidence, learned: '', completed: '', next_steps: '', notes: null,
        }, 1, 0, epoch).id}`;
      // More recent same-project body-only and other-project title hits must
      // not replace the title evidence at the final one-row boundary.
      store.storeObservation(memory, project, {
        type: 'discovery', title: 'Unrelated title', subtitle: null, narrative: `DECOY_BODY ${query}`,
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, 2, 0, epoch + 1);
      const foreign = store.getOrCreateManualSession('other-project');
      store.storeObservation(foreign, 'other-project', {
        type: 'discovery', title, subtitle: null, narrative: 'FOREIGN_BODY', facts: [], concepts: [], files_read: [], files_modified: [],
      }, 1, 0, epoch + 2);
      const rows = await manager.search({ query, project, limit: 20, format: 'json' });
      expect((kind === 'observation' ? rows.observations : rows.sessions).some(row => String(row.id) === expectedId.replace(/^S/, ''))).toBe(true);
      const app = express();
      app.use(express.json());
      new SearchRoutes(manager).setupRoutes(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server.once('listening', resolve));
      try {
        const port = (server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}/api/dumb-search`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, project, limit: 1, maxDetails: 1, depthBefore: 0, depthAfter: 0 }),
        });
        expect(response.status).toBe(200);
        const result = await response.json() as { content: Array<{ type: string; text: string }> };
        const text = result.content[0].text;
        expect(text).toStartWith('dumb-search — selected details');
        expect(text).toContain(`### [${expectedId}]`);
        expect(text).toContain(evidence);
        expect(text).not.toContain('DECOY_BODY');
        expect(text).not.toContain('FOREIGN_BODY');
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        db.close();
      }
    });
  }

  for (const [query, title] of [
    ['用户身份认证成功', '用户身份认证失败'],
    ['ข้อมูล', 'แก้ไขสภาพแวดล้อม'],
  ]) it(`does not select an incomplete title fragment for ${query}`, async () => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
      const memory = store.getOrCreateManualSession('prefix-fixture');
      store.storeObservation(memory, 'prefix-fixture', {
        type: 'decision', title, subtitle: null, narrative: `${query} is a different outcome.`,
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, 1);
      const result = progressiveSearchToolResult(await new ProgressiveMemorySearch(manager, store).run({ query, project: 'prefix-fixture', depthBefore: 0, depthAfter: 0 }));
      expect(result.content[0].text).toStartWith('dumb-search — index');
      expect(result.content[0].text).not.toContain('is a different outcome.');
    } finally { db.close(); }
  });
});

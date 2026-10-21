import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { withCheckoutProjects } from '../../src/servers/checkout-search-scope.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

const project = 'repo/current-worktree';
const parent = 'repo';
const source = 'repo/merged-worktree';
const epoch = Date.UTC(2026, 9, 20);
const text = (result: { content: Array<{ text?: string }> }) => result.content.map(item => item.text ?? '').join('\n');
const ids = (body: string) => [...body.matchAll(/^\|\s*#(\d+)\s*\|/gm)].map(match => Number(match[1]));

describe('Smart search project scope across index, timeline, and selected details', () => {
  let store: SessionStore;
  let manager: SearchManager;
  let server: Server;
  let base: string;
  let sequence: number;
  let anchor: number;
  let summary: number;
  let foreign: number;
  let partialAdopted: number;
  let partialUnmerged: number;
  let otherPlatform: number;

  function seed(key: string, title: string, merge?: string, platform = 'claude') {
    const session = `scope-session-${++sequence}`;
    const sid = store.createSDKSession(session, key, 'scope fixture');
    store.ensureMemorySessionIdRegistered(sid, session);
    store.db.prepare('UPDATE sdk_sessions SET platform_source = ? WHERE id = ?').run(platform, sid);
    const observation = store.storeObservation(session, key, {
      type: 'discovery', title, subtitle: null, narrative: `${title} selected details`,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    if (merge) store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run(merge, observation.id);
    return { id: observation.id, session, sid };
  }

  beforeEach(async () => {
    ModeManager.getInstance().loadMode('code');
    store = new SessionStore(':memory:');
    sequence = 0;
    seed(project, 'Current worktree');
    seed(parent, 'Parent memory');
    const merged = seed(source, 'Needle merged decision', parent);
    anchor = merged.id;
    const mergedPrompt = store.saveUserPrompt(merged.session, 1, 'Allowed merged prompt', merged.sid);
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(epoch, mergedPrompt);
    summary = store.storeSummary(merged.session, source, {
      request: 'Merged session decision', investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, epoch).id;
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE id = ?').run(parent, summary);
    partialAdopted = seed('partial-history', 'Adopted partial memory', parent).id;
    const partial = seed('partial-history', 'Unadopted private memory');
    partialUnmerged = partial.id;
    const partialPrompt = store.saveUserPrompt(partial.session, 1, 'Unadopted private prompt', partial.sid);
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(epoch, partialPrompt);
    foreign = seed('unrelated', 'Unrelated private memory').id;
    otherPlatform = seed(parent, 'Different platform memory', undefined, 'codex').id;
    manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
    const app = express(); app.use(express.json());
    new SearchRoutes(manager).setupRoutes(app);
    new DataRoutes({} as never, { getSessionStore: () => store } as never, {} as never, {} as never, {} as never, Date.now()).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });

  it('keeps the checkout alias list through HTTP index → anchored context → selected details', async () => {
    const scoped = withCheckoutProjects({ project }, { primary: project, allProjects: [project, parent] });
    const query = new URLSearchParams({ ...scoped, query: 'Needle', type: 'observations', limit: '20' } as Record<string, string>);
    const index = await (await fetch(`${base}/api/search?${query}`)).json();
    expect(ids(text(index))).toContain(anchor);
    const context = await (await fetch(`${base}/api/timeline?${new URLSearchParams({ ...scoped, anchor: String(anchor), depth_before: '10', depth_after: '10' } as Record<string, string>)}`)).json();
    expect(context.isError).not.toBe(true);
    expect(ids(text(context))).toContain(anchor);
    const selected = await (await fetch(`${base}/api/observations/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scoped, ids: [anchor, foreign, partialUnmerged] }),
    })).json();
    expect(selected.map((row: { id: number }) => row.id)).toEqual([anchor]);
  });

  it('applies the same scope to session, timestamp, and query timelines', async () => {
    for (const request of [{ anchor: `S${summary}` }, { anchor: new Date(epoch).toISOString() }, { query: 'Needle' }]) {
      const result = await manager.timeline({ ...request, project, projects: [project, parent], depth_before: 10, depth_after: 10 });
      expect(result.isError).not.toBe(true);
      expect(ids(text(result))).toContain(anchor);
      expect(ids(text(result))).toContain(partialAdopted);
      expect(ids(text(result))).not.toContain(foreign);
      expect(ids(text(result))).not.toContain(partialUnmerged);
      expect(text(result)).toContain('Allowed merged prompt');
      expect(text(result)).not.toContain('Unadopted private prompt');
    }
  });

  it('keeps platform filters and rejects unrelated or unadopted anchors', async () => {
    const scope = { project, projects: `${project},${parent}`, platformSource: 'claude', depth_before: 10, depth_after: 10 };
    const result = await manager.timeline({ ...scope, anchor });
    expect(result.isError).not.toBe(true);
    expect(ids(text(result))).toContain(anchor);
    expect(ids(text(result))).not.toContain(otherPlatform);
    expect(ids(text(result))).not.toContain(partialUnmerged);
    for (const id of [foreign, partialUnmerged, otherPlatform]) {
      expect((await manager.timeline({ ...scope, anchor: id })).isError).toBe(true);
    }
  });

  it('hydrates semantic query anchors with the same project aliases before reading context', async () => {
    const localSearch = new SessionSearch(store.db);
    localSearch.searchObservations = () => { throw new Error('Semantic anchor should not need keyword fallback'); };
    const semantic = new SearchManager(localSearch, store, {
      queryChroma: async () => ({ ids: [foreign, anchor], metadatas: [
        { doc_type: 'observation', created_at_epoch: epoch },
        { doc_type: 'observation', created_at_epoch: epoch },
      ] }),
    } as never, new FormattingService(), new TimelineService());
    const result = await semantic.timeline({ query: 'Needle', project, projects: [project, parent], depth_before: 10, depth_after: 10 });
    expect(result.isError).not.toBe(true);
    expect(ids(text(result))).toContain(anchor);
    expect(ids(text(result))).not.toContain(foreign);
  });
});

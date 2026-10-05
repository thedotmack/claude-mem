import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { SearchOrchestrator } from './src/services/worker/search/SearchOrchestrator.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'categories', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const epoch = Date.now();
  const obs = store.storeObservation('memory', 'categories', { type: 'discovery', title: 'Category needle observation', subtitle: null, narrative: 'categoryneedle', facts: [], concepts: [], files_read: [], files_modified: [] }, 1, 0, epoch).id;
  const summary = store.storeSummary('memory', 'categories', { request: 'categoryneedle summary', investigated: '', learned: '', completed: '', next_steps: '', notes: null }, 1, 0, epoch).id;
  const prompt = store.saveUserPrompt('host', 1, 'categoryneedle prompt', sid);
  const doc = (id, doc_type, sqlite_id) => ({ id, metadata: { doc_type, sqlite_id, project: 'categories', created_at_epoch: epoch } });
  const docs = [doc('obs_' + obs + '_narrative', 'observation', obs), doc('summary_' + summary + '_request', 'session_summary', summary), doc('prompt_' + prompt, 'user_prompt', prompt)];
  const matches = (where, meta) => !where || (where.$and ? where.$and.every(w => matches(w, meta)) : where.$or ? where.$or.some(w => matches(w, meta)) : Object.entries(where).every(([key, value]) => typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
  const calls = [];
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    if (tool === 'chroma_create_collection') return {};
    if (tool !== 'chroma_query_documents') throw new Error('unexpected tool ' + tool);
    calls.push(args);
    const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map(() => 0.1)] };
  };
  try {
    const results = [];
    for (const chroma of [null, new ChromaSync('categories')]) {
      const search = new SessionSearch(store.db);
      const manager = new SearchManager(search, store, chroma, new FormattingService(), new TimelineService());
      const orchestrator = new SearchOrchestrator(search, store, chroma);
      for (const type of ['observations,sessions', ['observations', 'sessions']]) {
        results.push(await manager.search({ project: 'categories', type, format: 'json' }));
        results.push(await manager.search({ query: chroma ? 'semantic external request' : 'categoryneedle', project: 'categories', type, format: 'json' }));
        results.push((await orchestrator.search({ query: chroma ? 'semantic external request' : 'categoryneedle', project: 'categories', type })).results);
      }
    }
    const aliases = await new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService()).search({ project: 'categories', type: ['discovery', 'bugfix'], format: 'json' });
    console.log(JSON.stringify({ results, calls, aliases }));
  } finally { store.close(); }
`;

describe('search category arrays', () => {
  it('selects every requested category in filter, FTS and semantic consumers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-categories-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      for (const entry of result.results) {
        expect(entry.observations.map((o: { title: string }) => o.title)).toEqual(['Category needle observation']);
        expect(entry.sessions.map((o: { request: string }) => o.request)).toEqual(['categoryneedle summary']);
        expect(entry.prompts).toEqual([]);
      }
      expect(result.aliases.observations.map((o: { title: string }) => o.title)).toEqual(['Category needle observation']);
      expect(result.aliases.sessions).toEqual([]);
      expect(result.aliases.prompts).toEqual([]);
      const filteredCalls = result.calls.filter((call: { where?: unknown }) => call.where);
      expect(filteredCalls.length).toBeGreaterThan(0);
      for (const call of filteredCalls) {
        const where = JSON.stringify(call.where);
        expect(where).toContain('observation');
        expect(where).toContain('session_summary');
        expect(where).not.toContain('user_prompt');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

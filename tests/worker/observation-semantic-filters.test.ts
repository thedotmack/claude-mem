import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'obs-filters', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const docs = [];
  const make = (title, type, concepts, files_read, epoch) => {
    const id = store.storeObservation('memory', 'obs-filters', { type, title, subtitle: null, narrative: 'nativefilterneedle', facts: [], concepts, files_read, files_modified: [] }, 1, 0, epoch).id;
    docs.push({ id: 'obs_' + id + '_narrative', metadata: { doc_type: 'observation', sqlite_id: id, project: 'obs-filters', created_at_epoch: epoch } });
  };
  make('UNRELATED_CURRENT', 'discovery', ['other-concept'], ['src/other.ts'], Date.now());
  make('WANTED_CURRENT', 'bugfix', ['target-concept'], ['src/target.ts'], Date.now());
  make('WANTED_ARCHIVE', 'bugfix', ['archive-concept'], ['src/archive.ts'], Date.UTC(2020, 5, 1));
  const matches = (where, meta) => !where || (where.$and ? where.$and.every(w => matches(w, meta)) : where.$or ? where.$or.some(w => matches(w, meta)) : Object.entries(where).every(([key, value]) => typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    if (tool === 'chroma_create_collection') return {};
    if (tool !== 'chroma_query_documents') throw new Error('unexpected tool ' + tool);
    const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map(() => 0.1)] };
  };
  try {
    const results = [];
    for (const chroma of [null, new ChromaSync('obs-filters')]) {
      const manager = new SearchManager(new SessionSearch(store.db), store, chroma, new FormattingService(), new TimelineService());
      const handlers = new Map();
      new SearchRoutes(manager).setupRoutes({ use() {}, get(path, handler) { handlers.set(path, handler); }, post() {} });
      for (const filter of [{ type: 'bugfix' }, { concepts: 'target-concept' }, { files: 'src/target.ts' }, { date_from: '2020-01-01', date_to: '2020-12-31' }]) {
        const query = { query: chroma ? 'semantic external request' : 'nativefilterneedle', project: 'obs-filters', limit: '1', ...filter };
        const body = await new Promise((resolve, reject) => {
          const res = { headersSent: false, locals: {}, status() { return res; }, json(body) { resolve(body); return res; } };
          handlers.get('/api/search/observations')({ path: '/api/search/observations', query, body: {}, get() {} }, res, reject);
        });
        results.push({ semantic: !!chroma, filter, text: body.content[0].text });
      }
    }
    console.log(JSON.stringify(results));
  } finally { store.close(); }
`;

describe('observation endpoint semantic row filters', () => {
  it('applies row filters and explicit archive date ranges on both production search paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'observation-filters-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const results = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      for (const entry of results) {
        expect(entry.text, JSON.stringify(entry.filter)).not.toContain('UNRELATED_CURRENT');
        if (entry.filter.date_from) {
          expect(entry.text).toContain('WANTED_ARCHIVE');
          expect(entry.text).not.toContain('WANTED_CURRENT');
        } else {
          expect(entry.text).toContain('WANTED_CURRENT');
          if (!entry.filter.type) expect(entry.text).not.toContain('WANTED_ARCHIVE');
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

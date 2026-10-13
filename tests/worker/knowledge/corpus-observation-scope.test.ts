import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchOrchestrator } from './src/services/worker/search/SearchOrchestrator.ts';
  import { CorpusBuilder } from './src/services/worker/knowledge/CorpusBuilder.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'scope-project', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const epoch = Date.now();
  const make = title => store.storeObservation('memory', 'scope-project', {
    type: 'discovery', title, subtitle: null, narrative: title, facts: [], concepts: [], files_read: [], files_modified: []
  }, 1, 0, epoch).id;
  const first = make('One meaning-related finding'); const second = make('Another meaning-related finding');
  const doc = (id, doc_type, sqlite_id) => ({ id, metadata: { doc_type, sqlite_id, project: 'scope-project', created_at_epoch: epoch } });
  const docs = [doc('obs_' + first + '_narrative', 'observation', first)];
  for (let i = 0; i < 150; i++) {
    const id = store.saveUserPrompt('host', i + 1, 'A related opening task ' + i, sid);
    docs.push(doc('prompt_' + id, 'user_prompt', id));
  }
  docs.push(doc('obs_' + second + '_narrative', 'observation', second));
  const matches = (where, meta) => !where || (where.$and ? where.$and.every(w => matches(w, meta)) : where.$or ? where.$or.some(w => matches(w, meta)) : Object.entries(where).every(([key, value]) => typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
  const calls = [];
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    if (tool === 'chroma_create_collection') return {};
    if (tool !== 'chroma_query_documents') throw new Error('unexpected tool ' + tool);
    calls.push(args);
    const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map((d, i) => i / 1000)] };
  };
  try {
    const builder = new CorpusBuilder(store, new SearchOrchestrator(new SessionSearch(store.db), store, new ChromaSync('scope-project')), {});
    const corpus = await builder.build('semantic', '', { project: 'scope-project', query: 'unindexed semantic request', limit: 10 }, { writeFile: false });
    console.log(JSON.stringify({ titles: corpus.observations.map(o => o.title), calls }));
  } finally { store.close(); }
`;

describe('corpus observation-only semantic selection', () => {
  it('keeps prompts from consuming the observation candidate budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-scope-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.titles.sort()).toEqual(['Another meaning-related finding', 'One meaning-related finding']);
      expect(result.calls.some((call: { where?: unknown }) => JSON.stringify(call.where ?? {}).includes('observation'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

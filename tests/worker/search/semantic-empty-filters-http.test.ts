import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', 'filter-project', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const epoch = Date.now();
  const id = store.storeObservation('memory', 'filter-project', {
    type:'discovery',title:'Saved module contract',subtitle:null,narrative:'Captures a durable finding',
    facts:[],concepts:['problem-solution'],files_read:['src/feature.ts'],files_modified:[]
  },1,0,epoch).id;
  // Only vector ranking is controlled. Request normalization, hydration and
  // empty-category handling use the real manager and persisted SQLite row.
  const chroma = Object.create(ChromaSync.prototype);
  chroma.queryChroma = async () => ({ids:[id],distances:[0.1],metadatas:[{
    doc_type:'observation',sqlite_id:id,project:'filter-project',created_at_epoch:epoch
  }]});
  const manager = new SearchManager(new SessionSearch(store.db),store,chroma,new FormattingService(),new TimelineService());
  const app = express(); new SearchRoutes(manager).setupRoutes(app);
  const server = app.listen(0,'127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening',resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/search';
  const field = process.env.EMPTY_FILTER_FIELD;
  const results = [];
  try {
    for (const params of [
      {project:'filter-project',type:'observations',format:'json',[field]:' , , '},
      {query:'unindexed meaning request',project:'filter-project',type:'observations',format:'json',limit:'1'},
      {query:'unindexed meaning request',project:'filter-project',type:'observations',format:'json',limit:'1',[field]:' , , '},
      {query:'unindexed meaning request',project:'filter-project',type:'observations',format:'json',limit:'1',[field]:process.env.MATCHING_FILTER},
      {query:'unindexed meaning request',project:'filter-project',type:'observations',format:'json',limit:'1',[field]:'not-present'}
    ]) {
      const response = await fetch(url + '?' + new URLSearchParams(params));
      const body = await response.json();
      results.push({status:response.status,ids:body.observations?.map(o=>o.id)});
    }
    console.log(JSON.stringify({id,results}));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
`;

for (const [field, matching] of [['concepts', 'problem-solution'], ['files', 'src/feature.ts']]) {
  it(`keeps normalized empty ${field} filters equivalent to omitted filters through HTTP search`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'semantic-empty-filter-'));
    try {
      const run = Bun.spawnSync([process.execPath, '--preload', join(import.meta.dir, '../../../tests/preload.ts'), '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'),
          EMPTY_FILTER_FIELD: field, MATCHING_FILTER: matching, DO_NOT_TRACK: '1' },
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.results.map((r: { status: number }) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(result.results[0].ids).toEqual([result.id]);
      expect(result.results[1].ids).toEqual([result.id]);
      expect(result.results[2].ids).toEqual([result.id]);
      expect(result.results[3].ids).toEqual([result.id]);
      expect(result.results[4].ids).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

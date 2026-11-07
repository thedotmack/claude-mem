import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A separate process owns settings, SQLite and MCP: no installed worker or
// shared module mocks can turn this into a resolver-only test.
const fixture = String.raw`
import express from 'express';
import { join } from 'node:path';
import { SessionStore } from './src/services/sqlite/SessionStore.ts';
import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
import { SearchManager } from './src/services/worker/SearchManager.ts';
import { FormattingService } from './src/services/worker/FormattingService.ts';
import { TimelineService } from './src/services/worker/TimelineService.ts';
import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
import { MemoryRoutes } from './src/services/worker/http/routes/MemoryRoutes.ts';
import { ModeManager } from './src/services/domain/ModeManager.ts';
import { contextCacheKeys, contextCacheVariantId } from './src/shared/context-cache.ts';
import { scopedProjects } from './src/services/sqlite/project-read-keys.ts';
import { withCheckoutProjects } from './src/servers/checkout-search-scope.ts';
import { projectsQueryString } from './src/shared/project-list.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
ModeManager.getInstance().loadMode('code');
const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
const manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
const app = express(); app.use(express.json());
app.get('/api/health', (_req,res) => res.json({status:'ok'}));
new SearchRoutes(manager).setupRoutes(app);
new MemoryRoutes({ getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null }, 'default').setupRoutes(app);
const server = app.listen(0,'127.0.0.1');
await new Promise(resolve => server.once('listening',resolve));
const port = server.address().port;
const url = 'http://127.0.0.1:' + port;
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/servers/mcp-server.ts'], cwd:process.cwd(), stderr:'pipe', env:{...process.env, CLAUDE_MEM_WORKER_PORT:String(port), CLAUDE_MEM_WORKER_HOST:'127.0.0.1', CLAUDE_MEM_WORKER_AUTOSTART:'false', CLAUDE_MEM_RUNTIME:'worker'} });
transport.stderr?.on('data',()=>{});
const client = new Client({name:'whitespace-recall',version:'1'});
const text = result => result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
const results=[];
try {
  await client.connect(transport);
  for (const key of ['topic ', ' topic', 'topic\t', 'topic\n']) {
    const index = results.length;
    const native = 'WHITESPACE_NATIVE_' + index;
    const sibling = 'PLAIN_SIBLING';
    for (const [project,title] of [[key,native],['topic',sibling]]) {
      const host = 'host-' + index + '-' + title;
      const sid = store.createSDKSession(host, project, 'prompt');
      const memory = store.ensureMemorySessionIdRegistered(sid, 'memory-' + host);
      store.storeObservation(memory,project,{ type:'discovery',title,subtitle:null,narrative:title,facts:[],concepts:['how-it-works'],files_read:[],files_modified:[] },1,0,Date.now());
    }
    const response = await fetch(url+'/api/context/inject?'+new URLSearchParams({projects:key,full:'true'}));
    const body = await response.text();
    const mcp=[];
    for (const arguments_ of [{project:key},{projects:key},{projects:[key]}]) {
      mcp.push(text(await client.callTool({name:'session_start_context',arguments:arguments_})));
    }
    const search = text(await client.callTool({name:'dumb_search',arguments:{query:'WHITESPACE',project:key}}));
    // A checkout whose key carries whitespace, read together with its parent: the hook's and the MCP server's list form.
    const parent = 'PARENT_' + index;
    const parentHost = 'host-' + index + '-parent';
    const parentMemory = store.ensureMemorySessionIdRegistered(store.createSDKSession(parentHost, parent, 'prompt'), 'memory-' + parentHost);
    store.storeObservation(parentMemory,parent,{ type:'discovery',title:'PARENT_ROW_'+index,subtitle:null,narrative:'PARENT_ROW_'+index,facts:[],concepts:['how-it-works'],files_read:[],files_modified:[] },1,0,Date.now());
    const withParent = await (await fetch(url+'/api/context/inject?full=true&'+projectsQueryString([parent,key]))).text();
    const withParentMcp = text(await client.callTool({name:'session_start_context',arguments:{projects:[parent,key]}}));
    const save = await fetch(url+'/api/memory/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:key,text:'MANUAL_WHITESPACE_'+index})});
    const saved = await save.json();
    results.push({key,native,parentRow:'PARENT_ROW_'+index,withParent,withParentMcp,status:response.status,body,mcp,search,saved,readKeys:store.getProjectReadKeys([key]),cache:contextCacheKeys([key],undefined,false).projects,distinctCache:contextCacheVariantId(contextCacheKeys([key],undefined,false))!==contextCacheVariantId(contextCacheKeys(['topic'],undefined,false)),expanded:withCheckoutProjects({project:key},{primary:key,allProjects:['legacy',key]}).projects,foreign:withCheckoutProjects({project:'topic'},{primary:key,allProjects:['legacy',key]}).projects});
  }
  // Hand-typed comma lists keep their forgiving spacing.
  const handTypedHost = 'host-hand-typed';
  const handTypedMemory = store.ensureMemorySessionIdRegistered(store.createSDKSession(handTypedHost, 'web', 'prompt'), 'memory-' + handTypedHost);
  store.storeObservation(handTypedMemory,'web',{ type:'discovery',title:'HAND_TYPED_ROW',subtitle:null,narrative:'HAND_TYPED_ROW',facts:[],concepts:['how-it-works'],files_read:[],files_modified:[] },1,0,Date.now());
  const handTyped = {
    http: await (await fetch(url+'/api/context/inject?full=true&projects='+encodeURIComponent('api, web'))).text(),
    mcp: text(await client.callTool({name:'session_start_context',arguments:{projects:'api, web'}})),
  };
  console.log(JSON.stringify({results,handTyped,blank:scopedProjects({projects:['',' ','\t\n']})}));
} finally { await client.close(); server.close(); store.close(); }
`;

describe('whitespace project capture and recall', () => {
  it('recalls saved rows through HTTP and source MCP without reading the trimmed sibling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-whitespace-recall-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_WELCOME_HINT_ENABLED:'false', CLAUDE_MEM_WORK_STATE_ENABLED:'false', CLAUDE_MEM_SHOW_LAST_MESSAGE:'false' },
        stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.blank).toEqual([]);
      expect(result.handTyped.http).toContain('HAND_TYPED_ROW');
      expect(result.handTyped.mcp).toContain('HAND_TYPED_ROW');
      for (const row of result.results) {
        expect(row.status).toBe(200);
        for (const text of [row.body, ...row.mcp, row.search]) {
          expect(text).toContain(row.native);
          expect(text).not.toContain('PLAIN_SIBLING');
        }
        expect(row.readKeys).toEqual([row.key]);
        expect(row.cache).toEqual([row.key]);
        expect(row.distinctCache).toBe(true);
        expect(row.expanded).toEqual(['legacy', row.key]);
        for (const text of [row.withParent, row.withParentMcp]) {
          expect(text).toContain(row.native);
          expect(text).toContain(row.parentRow);
          expect(text).not.toContain('PLAIN_SIBLING');
        }
        expect(row.foreign).toBeUndefined();
        expect(row.saved.project).toBe(row.key);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 70_000);
});

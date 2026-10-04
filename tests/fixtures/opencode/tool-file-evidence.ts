import { strict as assert } from 'node:assert';
import { spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
// Primary host schemas: anomalyco/opencode@907b3bc packages/opencode/src/tool/{read,write,edit,apply_patch}.ts
// Hook input.args contract: packages/plugin/src/index.ts. Values here are owned fixtures.
const kind = process.argv[2];
const cleanup: Array<() => void | Promise<unknown>> = [];
let port = 0;
try {
 const cwd = join(process.env.CLAUDE_MEM_DATA_DIR!, 'owned-project'); mkdirSync(join(cwd,'src'),{recursive:true});
 const oldRelative = 'src/owned.ts'; const newRelative = kind === 'patch-move' ? 'src/moved.ts' : oldRelative;
 const filePath = join(cwd,oldRelative); writeFileSync(filePath,'old\n');
 if (kind === 'patch-move') renameSync(filePath,join(cwd,newRelative));
 if (!['read','legacy-read','custom-control'].includes(kind)) writeFileSync(join(cwd,newRelative),'new\n');
 const tool = kind === 'legacy-read' ? 'Read' : kind === 'custom-control' ? 'read_custom' : kind.startsWith('patch-') ? 'apply_patch' : kind;
 const args = tool === 'apply_patch' ? { patchText: `*** Begin Patch\n*** Update File: ${oldRelative}\n${kind === 'patch-move' ? `*** Move to: ${newRelative}\n` : ''}@@\n-old\n+new\n*** End Patch` }
   : kind === 'edit' ? { filePath,oldString:'old',newString:'new' } : kind === 'write' ? { filePath,content:'new\n' } : { filePath,offset:1,limit:3 };
 const originalArgs = JSON.stringify(args);
 const settings = spyOn(SettingsDefaultsManager,'loadFromFile').mockImplementation(()=>({...SettingsDefaultsManager.getAllDefaults(),
  CLAUDE_MEM_WORKER_PORT:String(port),CLAUDE_MEM_GEMINI_API_KEY:'owned-key',CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:'false',
  CLAUDE_MEM_OBSERVE_BARE_PROMPTS:'false',CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:'false'})); cleanup.push(()=>settings.mockRestore());
 const mode = ModeManager.getInstance() as any; const priorMode=mode.activeMode,priorId=mode.activeModeId;
 cleanup.push(()=>{mode.activeMode=priorMode;mode.activeModeId=priorId});mode.loadMode('code');
 const store = new SessionStore(':memory:');cleanup.push(()=>store.close());
 const db:any={getSessionStore:()=>store,getSessionById:(id:number)=>store.getSessionById(id),getChromaSync:()=>null,getCloudSync:()=>null};
 const manager = new SessionManager(db);setIngestContext({dbManager:db,sessionManager:manager,eventBroadcaster:{broadcastObservationQueued(){}} as any,ensureGeneratorRunning:async()=>{}});
 let captured:any;
 const realFetch=globalThis.fetch;
 const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const url=new URL(req.url);const body:any=await req.json();
  if(url.pathname==='/api/sessions/observations'){
   captured=body;const result=await ingestObservation({contentSessionId:body.contentSessionId,cwd:body.cwd,platformSource:body.platform_source,
    toolName:body.tool_name,toolInput:body.tool_input,toolResponse:body.tool_response});return Response.json(result);
  }
  return Response.json({candidates:[{content:{parts:[{text:'<observation><type>discovery</type><title>Owned OpenCode tool</title></observation>'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120}});
 }});port=server.port;cleanup.push(()=>server.stop(true));
 writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR!, 'settings.json'), JSON.stringify({
  ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_WORKER_PORT: String(port),
 }));
 const pluginPath = process.argv[3] ?? new URL('../../../src/integrations/opencode-plugin/index.js', import.meta.url).href;
 const {default:factory}=await import(pluginPath);
 const hooks=await factory({client:{},project:{},directory:cwd,worktree:cwd,serverUrl:new URL('http://127.0.0.1'),$:null});
 await hooks['tool.execute.after']({tool,sessionID:'owned-session',callID:'owned-call',args},{title:'Owned tool',output:readFileSync(join(cwd,newRelative),'utf8'),metadata:{}});
 assert.ok(captured);
 const sid=(store.db.query('SELECT id FROM sdk_sessions').get() as any).id;
 const session=manager.initializeSession(sid);cleanup.push(()=>{session.abortController.abort();manager.removeSessionImmediate(sid)});
 const fetchSpy=spyOn(globalThis,'fetch').mockImplementation((url,init)=>realFetch(String(url).startsWith('http://127.0.0.1:')?url:`http://127.0.0.1:${port}/generate`,init));cleanup.push(()=>fetchSpy.mockRestore());
 const broadcasts:any[]=[];await new GeminiProvider(db,manager).startSession(session,{sseBroadcaster:{broadcast(event:any){broadcasts.push(event)}} as any,broadcastProcessingStatus(){if(manager.getTotalQueueDepth()===0)session.abortController.abort()}});
 const rows:any[]=store.db.query('SELECT id,files_read,files_modified FROM observations').all();
 const readExpected=['read','legacy-read'].includes(kind)?[filePath]:[];
 const writeExpected=['write','edit'].includes(kind)?[filePath]:kind==='patch-move'?[oldRelative,newRelative]:kind==='patch-update'?[oldRelative]:[];
 const lookup=new SessionSearch(store.db).findByFile(newRelative).observations;
 console.log(JSON.stringify({kind,tool,capturedInput:captured.tool_input,rows,lookupIds:lookup.map(row=>row.id),readExpected,writeExpected}));
 assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].files_read),readExpected);assert.deepEqual(JSON.parse(rows[0].files_modified),writeExpected);
 assert.deepEqual(lookup.map(row=>row.id),kind==='custom-control'?[]:[rows[0].id]);
 const live=broadcasts.find(event=>event.type==='new_observation').observation;assert.deepEqual(JSON.parse(live.files_read),readExpected);assert.deepEqual(JSON.parse(live.files_modified),writeExpected);
 for (const [key,value] of Object.entries(args)) assert.deepEqual(captured.tool_input[key],value);
 assert.equal(JSON.stringify(args),originalArgs);
}finally{for(const release of cleanup.reverse())await release()}

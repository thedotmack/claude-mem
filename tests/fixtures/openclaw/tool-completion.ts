import { strict as assert } from 'node:assert';
import { spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
// OpenClaw PluginHookAfterToolCallEvent carries toolName, params and result.
// Values and workspace below are owned fixtures; no real host or account is contacted.
const kind = process.argv[2];
const cleanup: Array<() => void | Promise<unknown>> = [];
let port = 0;
try {
 const cwd = join(process.env.CLAUDE_MEM_DATA_DIR!, 'owned-project'); mkdirSync(join(cwd,'src'),{recursive:true});
 const relative = 'src/owned.ts'; const filePath = join(cwd,relative);
 const operation = ['read','string-result','canonical-read'].includes(kind) ? 'read' : kind;
 writeFileSync(filePath,operation === 'read' ? 'old\n' : 'new\n');
 const tool = kind === 'memory-control' ? 'memory_search' : operation;
 const params = kind === 'edit' ? {path:filePath,oldText:'old',newText:'new'}
   : kind === 'write' ? {path:filePath,content:'new\n'} : {path:filePath,offset:1,limit:3};
 if(kind === 'canonical-read') {params.path=join(cwd,'src/ignored.ts');(params as any).file_path=filePath;}
 const originalParams = JSON.stringify(params);
 const settings = spyOn(SettingsDefaultsManager,'loadFromFile').mockImplementation(()=>({...SettingsDefaultsManager.getAllDefaults(),
  CLAUDE_MEM_WORKER_PORT:String(port),CLAUDE_MEM_GEMINI_API_KEY:'owned-key',CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:'false',
  CLAUDE_MEM_OBSERVE_BARE_PROMPTS:'false',CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:'false'})); cleanup.push(()=>settings.mockRestore());
 const mode = ModeManager.getInstance() as any; const priorMode=mode.activeMode,priorId=mode.activeModeId;
 cleanup.push(()=>{mode.activeMode=priorMode;mode.activeModeId=priorId});mode.loadMode('code');
 const store = new SessionStore(':memory:');cleanup.push(()=>store.close());
 const db:any={getSessionStore:()=>store,getSessionById:(id:number)=>store.getSessionById(id),getChromaSync:()=>null,getCloudSync:()=>null};
 const manager = new SessionManager(db);setIngestContext({dbManager:db,sessionManager:manager,eventBroadcaster:{broadcastObservationQueued(){}} as any,ensureGeneratorRunning:async()=>{}});
 let captured:any;
 // Resolves once the worker has ingested the fire-and-forget POST, so the checks below wait for ingestion itself rather than a guessed delay.
 let markIngested=()=>{};const ingested=new Promise<void>(resolve=>{markIngested=resolve;});
 const realFetch=globalThis.fetch;
 const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const url=new URL(req.url);const body:any=await req.json();
  if(url.pathname==='/api/sessions/observations'){
   captured=body;const result=await ingestObservation({contentSessionId:body.contentSessionId,cwd:body.cwd,platformSource:body.platform_source,
    toolName:body.tool_name,toolInput:body.tool_input,toolResponse:body.tool_response});markIngested();return Response.json(result);
  }
  return Response.json({candidates:[{content:{parts:[{text:'<observation><type>discovery</type><title>Owned OpenClaw tool</title></observation>'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120}});
 }});port=server.port;cleanup.push(()=>server.stop(true));
 const {default:register}=await import(process.env.CLAUDE_MEM_OPENCLAW_MODULE || '../../../openclaw/src/index.ts');
 const hooks = new Map<string,Function>();
 register({id:'owned',name:'owned',source:'owned',config:{},pluginConfig:{workerPort:port,workerHost:'127.0.0.1',syncMemoryFile:false},
  logger:{info(){},warn(){},error(){}},runtime:{channel:{}},registerService(){},registerCommand(){},on(name:string,callback:Function){hooks.set(name,callback)}} as any);
 const result = kind === 'string-result' ? readFileSync(filePath,'utf8') : {content:[{type:'text',text:readFileSync(filePath,'utf8')}]};
 if(kind !== 'memory-control') assert.ok(hooks.get('after_tool_call'),'actual completion hook must be registered');
 const event={toolName:tool,params,result,toolCallId:'owned-call'};
 const originalCwd=process.cwd();cleanup.push(()=>process.chdir(originalCwd));process.chdir(cwd);
 await hooks.get('after_tool_call')?.(event,{sessionKey:'owned-session',agentId:'owned',toolName:tool,toolCallId:'owned-call'});
 if(kind === 'memory-control') {
  await Bun.sleep(40);
  assert.equal(captured,undefined,'memory tools must not produce observations');
  assert.equal((store.db.query('SELECT COUNT(*) AS count FROM observations').get() as any).count,0);
  console.log(JSON.stringify({kind,observations:0}));
 } else {
  const ingestedInTime=await Promise.race([ingested.then(()=>true),Bun.sleep(5000).then(()=>false)]);
  assert.ok(ingestedInTime && captured,'completion hook must reach actual worker ingestion');
  assert.equal(captured.tool_name,operation[0].toUpperCase()+operation.slice(1));
  for(const [key,value] of Object.entries(params)) assert.deepEqual(captured.tool_input[key],value);
  if(operation === 'read') assert.equal(captured.tool_input.file_path,filePath);
  assert.equal(captured.tool_response,typeof result === 'string' ? result : result.content[0].text);
 const sid=(store.db.query('SELECT id FROM sdk_sessions').get() as any).id;
 const session=manager.initializeSession(sid);cleanup.push(()=>{session.abortController.abort();manager.removeSessionImmediate(sid)});
 const fetchSpy=spyOn(globalThis,'fetch').mockImplementation((url,init)=>realFetch(String(url).startsWith('http://127.0.0.1:')?url:`http://127.0.0.1:${port}/generate`,init));cleanup.push(()=>fetchSpy.mockRestore());
 const broadcasts:any[]=[];await new GeminiProvider(db,manager).startSession(session,{sseBroadcaster:{broadcast(event:any){broadcasts.push(event)}} as any,broadcastProcessingStatus(){if(manager.getTotalQueueDepth()===0)session.abortController.abort()}});
 const rows:any[]=store.db.query('SELECT id,files_read,files_modified FROM observations').all();
 const readExpected=operation==='read'?[filePath]:[];
 const writeExpected=['write','edit'].includes(kind)?[filePath]:[];
 const lookup=new SessionSearch(store.db).findByFile(relative).observations;
 console.log(JSON.stringify({kind,tool,capturedInput:captured.tool_input,rows,lookupIds:lookup.map(row=>row.id),readExpected,writeExpected}));
 assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].files_read),readExpected);assert.deepEqual(JSON.parse(rows[0].files_modified),writeExpected);
 assert.deepEqual(lookup.map(row=>row.id),[rows[0].id]);
 const live=broadcasts.find(event=>event.type==='new_observation').observation;assert.deepEqual(JSON.parse(live.files_read),readExpected);assert.deepEqual(JSON.parse(live.files_modified),writeExpected);
 assert.equal(JSON.stringify(params),originalParams);
 }
}finally{for(const release of cleanup.reverse())await release()}

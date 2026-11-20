import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
const scenario=process.argv[2];
const host=scenario.startsWith('ipv6')?'::1':scenario==='default'?'127.0.0.1':'0.0.0.0';
if(scenario.endsWith('-env')||scenario==='env-over-file')process.env.CLAUDE_MEM_WORKER_HOST=host;
else delete process.env.CLAUDE_MEM_WORKER_HOST;
const store=new SessionStore(':memory:');
const db:any={getSessionStore:()=>store,getSessionById:(id:number)=>store.getSessionById(id),getChromaSync:()=>null,getCloudSync:()=>null};
const manager=new SessionManager(db);
setIngestContext({dbManager:db,sessionManager:manager,eventBroadcaster:{broadcastObservationQueued(){}} as any,ensureGeneratorRunning:async()=>{}});
let posts=0;const urls:string[]=[];
const server=Bun.serve({hostname:host,port:0,async fetch(request){
 const url=new URL(request.url);urls.push(url.hostname);
 if(url.pathname==='/api/context/inject')return new Response('owned endpoint memory');
 const body:any=await request.json();posts++;
 return Response.json(await ingestObservation({contentSessionId:body.contentSessionId,toolName:body.tool_name,toolInput:body.tool_input,toolResponse:body.tool_response,cwd:body.cwd,platformSource:body.platform_source}));
}});
writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR!,'settings.json'),JSON.stringify({...SettingsDefaultsManager.getAllDefaults(),CLAUDE_MEM_WORKER_PORT:String(server.port),CLAUDE_MEM_WORKER_HOST:scenario==='env-over-file'?'127.0.0.1':host,CLAUDE_MEM_OBSERVE_BARE_PROMPTS:'false'}));
try{
 const {default:definition}=await import(process.env.CLAUDE_MEM_OPENCODE_MODULE || '../../../src/integrations/opencode-plugin/index.ts');
 // V1 hosts (1.3.4+) read `server`; V2 reads `id` + `setup`. This fixture
 // exercises the V1 hook contract.
 const hooks=await definition.server({client:{},project:{},directory:process.env.CLAUDE_MEM_DATA_DIR!,worktree:process.env.CLAUDE_MEM_DATA_DIR!,serverUrl:new URL('http://127.0.0.1'),$:null});
 await hooks['tool.execute.after']({tool:'ownedTool',sessionID:'owned-endpoint-session',callID:'owned-call',args:{owned:true}},{title:'owned',output:'owned output',metadata:{}});
 const output={system:[] as string[]};await hooks['experimental.chat.system.transform']({sessionID:'owned-endpoint-session'},output);
 const sessions:any[]=store.db.query('SELECT content_session_id,platform_source FROM sdk_sessions').all();
 console.log(JSON.stringify({scenario,host,posts,system:output.system,sessions,urls}));
 assert.equal(posts,1,'configured worker endpoint must receive the observation');
 assert.deepEqual(urls,[host.includes(':')?`[${host}]`:host,host.includes(':')?`[${host}]`:host],'requests must use the configured host');
 assert.deepEqual(output.system,['owned endpoint memory']);
 assert.equal(sessions.length,1);assert.equal(sessions[0].platform_source,'opencode');
 assert.equal(manager.getTotalQueueDepth(),1);
}finally{for(const row of store.db.query('SELECT id FROM sdk_sessions').all() as {id:number}[])manager.removeSessionImmediate(row.id);server.stop(true);store.close()}

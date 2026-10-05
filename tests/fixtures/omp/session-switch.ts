import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { ingestObservation, ingestSummarize, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

const eventName=process.argv[2];
const delayed=process.argv[3]==='delayed';
const dataDir=process.env.CLAUDE_MEM_DATA_DIR!;
const cwd=join(dataDir,'owned-project');mkdirSync(cwd,{recursive:true});
const store=new SessionStore(':memory:');
const db:any={getSessionStore:()=>store,getSessionById:(id:number)=>store.getSessionById(id),getChromaSync:()=>null,getCloudSync:()=>null};
const manager=new SessionManager(db);
const broadcaster=new Proxy({},{get:()=>()=>{}}) as any;
const route=new SessionRoutes(manager,db,{} as any,{} as any,{} as any,broadcaster,{} as any,{} as any) as any;
route.ensureGeneratorRunning=async()=>{};
setIngestContext({dbManager:db,sessionManager:manager,eventBroadcaster:broadcaster,ensureGeneratorRunning:async()=>{}});
const requests:Array<{path:string,body:any}>=[];
let contextFetches=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==='/api/context/inject')return new Response(`owned memory ${++contextFetches}`);
 const body=await request.json() as any;requests.push({path,body});
 if(path==='/api/sessions/init')return new Promise<Response>((resolve)=>{
  let status=200;
  route.handleSessionInitByClaudeId({body,query:{},get(){return undefined}}, {headersSent:false,status(code:number){status=code;return this},json(value:any){resolve(Response.json(value,{status}))}});
 });
 if(path==='/api/sessions/observations'){if(delayed)await Bun.sleep(100);return Response.json(await ingestObservation({contentSessionId:body.contentSessionId,platformSource:body.platformSource,cwd:body.cwd,toolName:body.tool_name,toolInput:body.tool_input,toolResponse:body.tool_response}));}
 if(path==='/api/sessions/summarize')return Response.json(await ingestSummarize({contentSessionId:body.contentSessionId,platformSource:body.platformSource,lastAssistantMessage:body.last_assistant_message}));
 throw new Error(`Unexpected route ${path}`);
}});
writeFileSync(join(dataDir,'settings.json'),JSON.stringify({...SettingsDefaultsManager.getAllDefaults(),CLAUDE_MEM_WORKER_PORT:String(server.port),CLAUDE_MEM_WORKER_HOST:'127.0.0.1',CLAUDE_MEM_OBSERVE_BARE_PROMPTS:'false'}));
const hooks=new Map<string,Function>();
const nowSpy=spyOn(Date,'now').mockReturnValue(1_795_000_000_000);
async function waitFor(path:string,count:number){const deadline=performance.now()+3000;while(requests.filter(r=>r.path===path).length<count&&performance.now()<deadline)await Bun.sleep(5);assert.equal(requests.filter(r=>r.path===path).length,count);await Bun.sleep(5)}
try{
 const {default:register}=await import(process.env.CLAUDE_MEM_OMP_MODULE || '../../../omp/hooks/claude-mem.ts');
 register({on(name:string,handler:Function){hooks.set(name,handler)}} as any);
 await hooks.get('session_start')?.({}, {cwd});
 await hooks.get('before_agent_start')?.({prompt:'first owned prompt'},{cwd});
 await hooks.get('tool_result')?.({toolName:'read',input:{path:'first.ts'},content:'first owned file'},{cwd});
 if(!delayed)await waitFor('/api/sessions/observations',1);
 else await waitFor('/api/sessions/init',1);
 const firstContext=await hooks.get('context')?.({messages:[]},{cwd});assert.equal(firstContext.messages[0].content,'owned memory 1');
 await hooks.get('agent_end')?.({messages:[{role:'assistant',content:'first owned answer'}]},{cwd});
 await hooks.get(eventName)?.(eventName==='session_switch'?{reason:'new',previousSessionFile:'owned-old.jsonl'}:{reason:'branch',entryId:'owned-entry',previousSessionFile:'owned-old.jsonl'},{cwd});
 await hooks.get('before_agent_start')?.({prompt:'second owned prompt'},{cwd});
 await hooks.get('tool_result')?.({toolName:'read',input:{path:'second.ts'},content:'second owned file'},{cwd});
 await waitFor('/api/sessions/observations',2);
 const secondContext=await hooks.get('context')?.({messages:[]},{cwd});
 await hooks.get('session_shutdown')?.();
 const rows:any[]=store.db.query('SELECT id,content_session_id,user_prompt,platform_source FROM sdk_sessions ORDER BY id').all();
 console.log(JSON.stringify({eventName,rows,requests,contextFetches}));
 assert.equal(rows.length,2,'host session transitions need distinct worker sessions');
 assert.deepEqual(rows.map(r=>r.user_prompt),['first owned prompt','second owned prompt']);
 assert.equal(secondContext.messages[0].content,'owned memory 2','session transition must refresh context');
 await waitFor('/api/sessions/summarize',2);
 const summaries=requests.filter(r=>r.path==='/api/sessions/summarize');
 assert.deepEqual(summaries.map(r=>r.body.last_assistant_message),['first owned answer','']);
 const drainDeadline=performance.now()+3000;
 while(manager.getTotalQueueDepth()<4 && performance.now()<drainDeadline)await Bun.sleep(5);
 const queued=manager.getMessageBuffer().peekTypes(rows[0].id).map(message=>message.message_type);
 console.log('oldQueue',JSON.stringify(queued));
 assert.deepEqual(queued,['observation','summarize'],'summary must wait for outstanding tool observations');
 const prompts:any[]=store.db.query('SELECT prompt_number,prompt_text FROM user_prompts ORDER BY id').all();
 assert.deepEqual(prompts.map(r=>r.prompt_number),[1,1]);
 assert.ok(rows.every(r=>r.platform_source==='omp'));
}finally{nowSpy.mockRestore();for(const row of store.db.query('SELECT id FROM sdk_sessions').all() as Array<{id:number}>)manager.removeSessionImmediate(row.id);server.stop(true);store.close()}

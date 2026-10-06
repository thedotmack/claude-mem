import { afterEach, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
const original = process.env.CLAUDE_MEM_DATA_DIR;
afterEach(async () => { await settleHookSpoolNudges(); if (original === undefined) delete process.env.CLAUDE_MEM_DATA_DIR; else process.env.CLAUDE_MEM_DATA_DIR = original; });
const schema = { name: 'spool', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
  { name: 'end', match: { path: 'type', equals: 'end' }, action: 'session_end' },
] } as any;
it('retries a disk-rejected result after restart and spools summary behind it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-standalone-retry-'));
  process.env.CLAUDE_MEM_DATA_DIR = root;
  const file = join(root, 'session.jsonl'); const state = join(root, 'state.json');
  const use = JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'a' } }) + '\n';
  writeFileSync(file, use + JSON.stringify({ session: 's', type: 'result', id: 't', output: 'contents' }) + '\n' + JSON.stringify({ session: 's', type: 'end' }) + '\n');
  const obstruction = join(root, 'state'); writeFileSync(obstruction, 'blocks spool directory');
  const watch = { name: 'spool', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool');
  let second: TranscriptWatcher | undefined;
  try {
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    first.stop();
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.offsets[file]).toBe(Buffer.byteLength(use));
    expect(saved.pendingTools[file]['spool:s'].t.toolName).toBe('Read');
    rmSync(obstruction);
    second = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool');
    await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask;
    const entries: any[] = [];
    await new HookSpool().drain(entry => { entries.push(entry); return true; });
    expect(entries.map(entry => entry.kind)).toEqual(['observation', 'summarize']);
    expect(entries[0].payload).toMatchObject({ toolName: 'Read', toolInput: { path: 'a' }, toolResponse: 'contents' });
    expect(JSON.parse(readFileSync(state, 'utf8')).offsets[file]).toBe(Buffer.byteLength(readFileSync(file)));
  } finally { first.stop(); second?.stop(); await settleHookSpoolNudges(); rmSync(root, { recursive: true, force: true }); }
});
it('keeps same-session summaries behind a declined observation while other sessions progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-spool-order-')); process.env.CLAUDE_MEM_DATA_DIR = root;
  try {
    const spool = new HookSpool();
    spool.enqueue('observation', { contentSessionId: 'a', platformSource: 'claude', toolName: 'Read', toolInput: null, toolResponse: 'contents', toolUseId: 'a1' });
    spool.enqueue('summarize', { contentSessionId: 'a', platformSource: 'claude', lastAssistantMessage: 'done' });
    spool.enqueue('observation', { contentSessionId: 'b', platformSource: 'claude', toolName: 'Read', toolInput: null, toolResponse: 'other', toolUseId: 'b1' });
    const seen: string[] = [];
    const first = await spool.drain(entry => { seen.push(entry.payload.contentSessionId + ':' + entry.kind); return entry.payload.contentSessionId !== 'a'; });
    expect(seen).toEqual(['a:observation', 'b:observation']); expect(first.retained).toBe(2);
    seen.length = 0;
    await spool.drain(entry => { seen.push(entry.payload.contentSessionId + ':' + entry.kind); return true; });
    expect(seen).toEqual(['a:observation', 'a:summarize']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`does not spool stale tool metadata after a file replacement${restart ? ' across restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-standalone-replaced-')); process.env.CLAUDE_MEM_DATA_DIR = root;
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'old-long-enough-file-metadata' } }) + '\n');
  const watch = { name: 'spool', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool'); let second: TranscriptWatcher | undefined;
  try {
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    if (restart) first.stop();
    const replacement = join(root, 'new.jsonl'); writeFileSync(replacement, JSON.stringify({ session: 's', type: 'result', id: 't', output: 'new' }) + '\n'); renameSync(replacement, file);
    if (restart) { second = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool'); await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask; }
    else await (first as any).tailers.get(file).readNewData();
    const entries: unknown[] = []; await new HookSpool().drain(entry => { entries.push(entry); return true; }); expect(entries).toHaveLength(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]).toEqual({});
  } finally { first.stop(); second?.stop(); await settleHookSpoolNudges(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`retires unmatched tools when their transcript is no longer tracked${restart ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-retired-tools-'));
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { token: 'fake-secret' } }) + '\n');
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state); let second: TranscriptWatcher | undefined;
  try {
    await first.start(); await (first as any).tailers.get(file).readTask;
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].t.toolInput.token).toBe('fake-secret');
    if (restart) first.stop(); rmSync(file);
    if (restart) { second = new TranscriptWatcher({ version: 1, watches: [watch] }, state); await second.start(); }
    else (first as any).handleRootWatchEvent(root, file, watch, schema, 'session.jsonl');
    await new Promise(resolve => setTimeout(resolve, 1150));
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.pendingTools[file]).toBeUndefined(); expect(saved.pendingToolFileIdentities[file]).toBeUndefined();
    expect(readFileSync(state, 'utf8')).not.toContain('fake-secret');
    expect(saved.offsets[file]).toBeUndefined(); expect(saved.cwds?.[file]).toBeUndefined(); expect((first as any).missingFiles.size).toBe(0);
  } finally { first.stop(); second?.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`clears pending metadata on same-inode truncation${restart ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-truncate-tools-')); process.env.CLAUDE_MEM_DATA_DIR = root;
  const file = join(root, 'session.jsonl'); const state = join(root, 'checkpoint.json');
  writeFileSync(file, JSON.stringify({ session: 's', type: 'use', id: 't', name: 'Read', input: { path: 'old-long-enough-metadata-file' } }) + '\n');
  const inode = statSync(file).ino;
  const watch = { name: 'retry', path: file, workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool'); let second: TranscriptWatcher | undefined;
  try {
    
    await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask;
    if (restart) first.stop();
    writeFileSync(file, JSON.stringify({ session: 's', type: 'result', id: 't', output: 'new' }) + '\n');
    expect(statSync(file).ino).toBe(inode);
    if (restart) { second = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool'); await (second as any).addTailer(file, watch, schema); await (second as any).tailers.get(file).readTask; }
    else await (first as any).tailers.get(file).readNewData();
    const entries: any[] = []; await new HookSpool().drain(entry => { entries.push(entry); return true; }); expect(entries).toHaveLength(0);
    expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]).toEqual({});
  } finally { first.stop(); second?.stop(); await settleHookSpoolNudges(); rmSync(root, { recursive: true, force: true }); }
});
for (const restart of [false, true]) for (const sameId of [false, true]) it(`preserves other files' pending tools when one is replaced (${restart ? 'restart' : 'live'}, ${sameId ? 'shared' : 'distinct'} ID)`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-shared-tools-')); process.env.CLAUDE_MEM_DATA_DIR = root;
  const a = join(root, 'a.jsonl'); const b = join(root, 'b.jsonl'); const state = join(root, 'checkpoint.json');
  const idB = sameId ? 'a' : 'b';
  writeFileSync(a, JSON.stringify({ session: 's', type: 'use', id: 'a', name: 'Read', input: { path: 'A' } }) + '\n');
  writeFileSync(b, JSON.stringify({ session: 's', type: 'use', id: idB, name: 'Write', input: { path: 'B' } }) + '\n');
  const watch = { name: 'retry', path: join(root, '*.jsonl'), workspace: '/repo', schema };
  const first = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool'); let second: TranscriptWatcher | undefined;
  try {
    
    for (const file of [a,b]) { await (first as any).addTailer(file, watch, schema); await (first as any).tailers.get(file).readTask; }
    // A later event must not copy B's pending tool into A's durable snapshot.
    appendFileSync(a, JSON.stringify({ session: 's', type: 'result', id: 'unmatched', output: 'ignored' }) + '\n');
    await (first as any).tailers.get(a).readNewData();
    if (restart) first.stop();
    const replacement = join(root, 'replacement'); writeFileSync(replacement, JSON.stringify({ session: 's', type: 'use', id: 'new-a', name: 'Edit', input: { path: 'new-A' } }) + '\n');
    const { renameSync } = await import('node:fs'); renameSync(replacement, a);
    const current = restart ? (second = new TranscriptWatcher({ version: 1, watches: [watch] }, state, 'spool')) : first;
    if (restart) for (const file of [a,b]) { await (current as any).addTailer(file, watch, schema); await (current as any).tailers.get(file).readTask; }
    else await (current as any).tailers.get(a).readNewData();
    appendFileSync(b, JSON.stringify({ session: 's', type: 'result', id: idB, output: 'B done' }) + '\n');
    await (current as any).tailers.get(b).readNewData();
    const entries: any[] = []; await new HookSpool().drain(entry => { entries.push(entry); return true; }); expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({ toolName: 'Write', toolInput: { path: 'B' }, toolResponse: 'B done' });
  } finally { first.stop(); second?.stop(); await settleHookSpoolNudges(); rmSync(root, { recursive: true, force: true }); }
});
it('does not retire saved retry metadata when stop cancels asynchronous start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cancel-metadata-')); const state = join(root, 'checkpoint.json'); const file = join(root, 'session.jsonl');
  writeFileSync(state, JSON.stringify({ offsets: { [file]: 0 }, pendingTools: { [file]: { 'retry:s': { t: { toolName: 'Read', toolInput: 'saved' } } } } }));
  const watcher = new TranscriptWatcher({ version: 1, watches: [{ name: 'retry', path: file, workspace: '/repo', schema }] }, state, 'spool');
  let release!: () => void; (watcher as any).setupWatch = () => new Promise<void>(resolve => { release = resolve; });
  try { const start = watcher.start(); watcher.stop(); release(); await start; expect(JSON.parse(readFileSync(state, 'utf8')).pendingTools[file]['retry:s'].t.toolInput).toBe('saved'); }
  finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) it(`matches a unique cross-file tool result${restart ? ' after restart' : ''}`, async () => {
 const root=mkdtempSync(join(tmpdir(),'cm-cross-result-')); process.env.CLAUDE_MEM_DATA_DIR=root;
 const a=join(root,'z-source.jsonl'),b=join(root,'a-result.jsonl'),state=join(root,'checkpoint.json');
 writeFileSync(a,JSON.stringify({session:'s',type:'use',id:'t',name:'Read',input:{path:'A'}})+'\n'); writeFileSync(b,'');
 const watch={name:'spool',path:join(root,'*.jsonl'),workspace:'/repo',schema};
 const first=new TranscriptWatcher({version:1,watches:[watch]},state,'spool'); let second:TranscriptWatcher|undefined;
 try {
  await first.start(); for(const t of (first as any).tailers.values()) await t.readTask;
  if(restart){first.stop();second=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');await second.start();for(const t of(second as any).tailers.values())await t.readTask;}
  const current=second??first; appendFileSync(b,JSON.stringify({session:'s',type:'result',id:'t',output:'B result'})+'\n');await(current as any).tailers.get(b).readNewData();
  const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(1);expect(entries[0].payload).toMatchObject({toolName:'Read',toolInput:{path:'A'},toolResponse:'B result'});
  expect(JSON.parse(readFileSync(state,'utf8')).pendingTools[a]['spool:s']?.t).toBeUndefined();
 }finally{first.stop();second?.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});
it('does not guess between ambiguous same-ID tools from other files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-ambiguous-result-'));process.env.CLAUDE_MEM_DATA_DIR=root;
 const files=['a','b','c'].map(n=>join(root,n+'.jsonl'));const state=join(root,'checkpoint.json');
 for(const [i,file]of files.entries())writeFileSync(file,i===2?'':JSON.stringify({session:'s',type:'use',id:'t',name:i===0?'Read':'Write',input:{path:i===0?'A':'B'}})+'\n');
 const watch={name:'spool',path:join(root,'*.jsonl'),workspace:'/repo',schema};const watcher=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');
 try{await watcher.start();for(const t of(watcher as any).tailers.values())await t.readTask;appendFileSync(files[2],JSON.stringify({session:'s',type:'result',id:'t',output:'ambiguous'})+'\n');await(watcher as any).tailers.get(files[2]).readNewData();const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(0);}
 finally{watcher.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});
it('preserves tools/checkpoint across a brief same-inode disappearance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-returned-file-'));process.env.CLAUDE_MEM_DATA_DIR=root;
 const file=join(root,'session.jsonl'),away=join(root,'away'),state=join(root,'checkpoint.json');
 writeFileSync(file,JSON.stringify({session:'s',type:'use',id:'t',name:'Read',input:{path:'A'}})+'\n');const inode=statSync(file).ino;
 const watch={name:'spool',path:file,workspace:'/repo',schema};const watcher=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');
 try{await watcher.start();await(watcher as any).tailers.get(file).readTask;renameSync(file,away);(watcher as any).handleRootWatchEvent(root,file,watch,schema,'session.jsonl');await new Promise(r=>setTimeout(r,20));renameSync(away,file);appendFileSync(file,JSON.stringify({session:'s',type:'result',id:'t',output:'returned'})+'\n');expect(statSync(file).ino).toBe(inode);await(watcher as any).addTailer(file,watch,schema,true);await(watcher as any).tailers.get(file).readTask;const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(1);expect(entries[0].payload.toolName).toBe('Read');}
 finally{watcher.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});
it('starts a larger replacement at zero with its new cwd after disappearance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-recreated-file-'));process.env.CLAUDE_MEM_DATA_DIR=root;
 const file=join(root,'session.jsonl'),state=join(root,'checkpoint.json');
 const localSchema={...schema,events:[{name:'context',match:{path:'type',equals:'ctx'},action:'session_context',fields:{cwd:'cwd'}},...schema.events]} as any;
 const line=(v:unknown)=>JSON.stringify(v)+'\n';writeFileSync(file,line({session:'s',type:'ctx',cwd:'/old'})+line({session:'s',type:'use',id:'old',name:'Read',input:{path:'old'}}));
 const watch={name:'spool',path:file,schema:localSchema};const watcher=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');
 try{await watcher.start();await(watcher as any).tailers.get(file).readTask;const prior=statSync(file).size;rmSync(file);(watcher as any).handleRootWatchEvent(root,file,watch,localSchema,'session.jsonl');
  const replacement=line({session:'s',type:'ctx',cwd:'/new'})+line({session:'s',type:'use',id:'new',name:'Write',input:{path:'X'.repeat(300)}})+line({session:'s',type:'result',id:'new',output:'new contents'});expect(Buffer.byteLength(replacement)).toBeGreaterThan(prior);writeFileSync(file,replacement);await(watcher as any).addTailer(file,watch,localSchema,true);await(watcher as any).tailers.get(file).readTask;
  const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(1);expect(entries[0].payload).toMatchObject({toolName:'Write',cwd:'/new'});
 }finally{watcher.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});

it('does not borrow tools from a source excluded by the current watch configuration',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-excluded-tool-'));process.env.CLAUDE_MEM_DATA_DIR=root;
 const a=join(root,'source.jsonl'),b=join(root,'result.jsonl'),state=join(root,'checkpoint.json');writeFileSync(a,JSON.stringify({session:'s',type:'use',id:'t',name:'Read',input:{path:'excluded'}})+'\n');writeFileSync(b,'');
 const watch={name:'spool',path:a,workspace:'/repo',schema};const first=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');let second:TranscriptWatcher|undefined;
 try{await first.start();await(first as any).tailers.get(a).readTask;first.stop();appendFileSync(b,JSON.stringify({session:'s',type:'result',id:'t',output:'ignored'})+'\n');const selected={...watch,path:b};second=new TranscriptWatcher({version:1,watches:[selected]},state,'spool');await second.start();await(second as any).tailers.get(b).readTask;const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(0);await new Promise(r=>setTimeout(r,1150));expect(JSON.parse(readFileSync(state,'utf8')).pendingTools[a]).toBeUndefined();}
 finally{first.stop();second?.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});
it('cancels bounded retirement timers on stop without deleting valid retry state',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-stop-retirement-'));const file=join(root,'session.jsonl'),state=join(root,'checkpoint.json');
 writeFileSync(state,JSON.stringify({offsets:{[file]:20},pendingTools:{[file]:{'spool:s':{t:{toolName:'Read'}}}}}));const watcher=new TranscriptWatcher({version:1,watches:[]},state);
 try{await watcher.start();expect((watcher as any).missingFiles.size).toBe(1);watcher.stop();expect((watcher as any).missingFiles.size).toBe(0);await new Promise(r=>setTimeout(r,1100));expect(JSON.parse(readFileSync(state,'utf8')).offsets[file]).toBe(20);}
 finally{watcher.stop();rmSync(root,{recursive:true,force:true});}
});
it('does not lend truncated source metadata to an earlier-enumerated result after restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-truncated-cross-'));const source=join(root,'z-source.jsonl'),result=join(root,'a-result.jsonl'),state=join(root,'checkpoint.json');
 writeFileSync(source,JSON.stringify({session:'s',type:'use',id:'t',name:'Read',input:{path:'retired-original-input'}})+'\n');writeFileSync(result,'');const watch={name:'spool',path:join(root,'*.jsonl'),workspace:'/repo',schema};
 const first=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');let second:TranscriptWatcher|undefined;
 try{process.env.CLAUDE_MEM_DATA_DIR=root;await first.start();for(const t of(first as any).tailers.values())await t.readTask;first.stop();const inode=statSync(source).ino;writeFileSync(source,'{}\n');expect(statSync(source).ino).toBe(inode);appendFileSync(result,JSON.stringify({session:'s',type:'result',id:'t',output:'new'})+'\n');second=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');const add=(second as any).addTailer.bind(second);(second as any).addTailer=async(file:string,...args:any[])=>{if(file===source)await new Promise(r=>setTimeout(r,50));return add(file,...args);};await second.start();for(const t of(second as any).tailers.values())await t.readTask;const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(0);}
 finally{first.stop();second?.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});

it('rewinds a replacement that returns after disappearing before tailer attachment',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-attach-replacement-'));process.env.CLAUDE_MEM_DATA_DIR=root;
 const file=join(root,'session.jsonl'),away=join(root,'away'),state=join(root,'checkpoint.json');writeFileSync(file,JSON.stringify({session:'s',type:'use',id:'old',name:'Read',input:{path:'old'}})+'\n');const watch={name:'spool',path:file,workspace:'/repo',schema};
 const first=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');let second:TranscriptWatcher|undefined;
 try{await first.start();await(first as any).tailers.get(file).readTask;first.stop();renameSync(file,away);second=new TranscriptWatcher({version:1,watches:[watch]},state,'spool');await(second as any).addTailer(file,watch,schema);await(second as any).tailers.get(file).readTask;
  writeFileSync(file,JSON.stringify({session:'s',type:'use',id:'new',name:'Write',input:{path:'x'.repeat(300)}})+'\n'+JSON.stringify({session:'s',type:'result',id:'new',output:'returned new'})+'\n');await(second as any).tailers.get(file).readNewData();const entries:any[]=[];await new HookSpool().drain(e=>{entries.push(e);return true;});expect(entries).toHaveLength(1);expect(entries[0].payload.toolName).toBe('Write');
 }finally{first.stop();second?.stop();await settleHookSpoolNudges();rmSync(root,{recursive:true,force:true});}
});

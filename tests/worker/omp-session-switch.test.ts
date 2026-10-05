import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
for (const event of ['session_switch','session_branch']) {
 it(`starts a distinct worker session after OMP ${event}`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'owned-omp-switch-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   child=Bun.spawn([process.execPath,'tests/fixtures/omp/session-switch.ts',event],{env:{...process.env,CLAUDE_MEM_DATA_DIR:dataDir},stdout:'pipe',stderr:'pipe'});
   const exit=await Promise.race([child.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned OMP fixture exceeded 8 seconds')),8000)})]);
   const out=await new Response(child.stdout).text()+await new Response(child.stderr).text();
   expect(exit,out).toBe(0);
  }finally{if(timer)clearTimeout(timer);if(child&&child.exitCode===null){child.kill();await child.exited}rmSync(dataDir,{recursive:true,force:true})}
 });
}

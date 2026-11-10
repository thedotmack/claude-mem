import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const event = 'session_switch';
for (const timing of ['settled','delayed']) {
 it(`starts a distinct worker session after OMP ${event} (${timing})`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'owned-omp-switch-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
   child=Bun.spawn([process.execPath,'tests/fixtures/omp/session-switch.ts',event,timing],{env:{...process.env,CLAUDE_MEM_DATA_DIR:dataDir},stdout:'pipe',stderr:'pipe'});
   const exit=await child.exited;
   const out=await new Response(child.stdout).text()+await new Response(child.stderr).text();
   expect(exit,out).toBe(0);
  }finally{if(child&&child.exitCode===null){child.kill();await child.exited}rmSync(dataDir,{recursive:true,force:true})}
 });
}

import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
for(const scenario of ['file-host','ipv6-file','ipv6-env','env-over-file','default']){
 it(`uses the configured OpenCode worker endpoint for ${scenario}`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'owned-opencode-endpoint-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   child=Bun.spawn([process.execPath,'tests/fixtures/opencode/worker-endpoint.ts',scenario],{env:{...process.env,CLAUDE_MEM_DATA_DIR:dataDir},stdout:'pipe',stderr:'pipe'});
   const exit=await Promise.race([child.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned endpoint fixture exceeded 8 seconds')),8000)})]);
   const out=await new Response(child.stdout).text()+await new Response(child.stderr).text();expect(exit,out).toBe(0);
  }finally{if(timer)clearTimeout(timer);if(child&&child.exitCode===null){child.kill();await child.exited}rmSync(dataDir,{recursive:true,force:true})}
 });
}

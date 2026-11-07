import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Probe the fixture's Bun listener. The three IPv4 controls still run when
// this host cannot bind IPv6 loopback.
const ipv6Available = (() => {
  try {
    const server = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('owned probe') });
    server.stop(true);
    return true;
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
})();

for(const scenario of ['file-host','ipv6-file','ipv6-env','env-over-file','default']){
 it.skipIf(scenario.startsWith('ipv6') && !ipv6Available)(`uses the configured OpenCode worker endpoint for ${scenario}`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'owned-opencode-endpoint-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   child=Bun.spawn([process.execPath,'tests/fixtures/opencode/worker-endpoint.ts',scenario],{env:{...process.env,CLAUDE_MEM_DATA_DIR:dataDir},stdout:'pipe',stderr:'pipe'});
   const exit=await Promise.race([child.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned endpoint fixture exceeded 8 seconds')),8000)})]);
   const out=await new Response(child.stdout).text()+await new Response(child.stderr).text();expect(exit,out).toBe(0);
  }finally{if(timer)clearTimeout(timer);if(child&&child.exitCode===null){child.kill();await child.exited}rmSync(dataDir,{recursive:true,force:true})}
 });
}

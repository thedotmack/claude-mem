import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome or Chromium for viewer regressions.');
(chrome ? it : it.skip)('retains valid facts, concepts and files from mixed and plain-text stored metadata', async () => {
  const esbuild = createRequire(import.meta.url).resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`);
  const bundle = execFileSync(esbuild, ['--bundle','--loader=tsx','--platform=browser','--format=iife','--define:process.env.NODE_ENV="production"','--log-level=error'], {
    cwd: resolve(import.meta.dir, '../../..'), timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding:'utf8',
    input: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ObservationCard} from './src/ui/viewer/components/ObservationCard';
      const mixed = value => JSON.stringify([null,4,{invalid:true},value]);
      // The second card stores CJK facts and concepts as plain text, not JSON (#3423).
      createRoot(document.getElementById('root')).render(<><ObservationCard observation={{id:1,project:'owned',type:'discovery',title:'OWNED CARD',created_at_epoch:1,
        facts:mixed('VALID FACT'),concepts:mixed('VALID CONCEPT'),files_read:mixed('/owned/src/read.ts'),files_modified:mixed('/owned/src/changed.ts')}} onDeleted={()=>{}}/>
        <ObservationCard observation={{id:2,project:'owned',type:'discovery',title:'CJK CARD',created_at_epoch:2,
        facts:'用户身份定位',concepts:'记忆检索',files_read:'[]',files_modified:'[]'}} onDeleted={()=>{}}/></>);
      (async()=>{try {
        const deadline=Date.now()+6000;
        let buttons=[];
        while((buttons=[...document.querySelectorAll('button')].filter(b=>b.textContent==='facts')).length<2){if(Date.now()>deadline) throw new Error('Facts controls absent: found '+buttons.length+' of 2');await new Promise(r=>setTimeout(r,10));}
        for(const button of buttons) button.click();
        for(let i=0;i<4;i++) await new Promise(requestAnimationFrame);
        await fetch('/result',{method:'POST',body:JSON.stringify({facts:[...document.querySelectorAll('.facts-list li')].map(n=>n.textContent),text:document.body.textContent})});
      }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();`
  });
  let report!: (value:any)=>void;
  const result = new Promise<any>(resolve=>{report=resolve;});
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/') return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
    if(path==='/fixture.js') return new Response(bundle,{headers:{'Content-Type':'application/javascript'}});
    if(path==='/result'){report(await request.json());return new Response('received');}
    return new Response('',{status:404});
  }});
  const profile=mkdtempSync(join(tmpdir(),'cm-metadata-browser-'));
  const child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run',`--user-data-dir=${profile}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed=await Promise.race([result,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned browser timed out')),30000);})]);
    expect(observed.failure).toBeUndefined();
    expect(observed.facts).toEqual(['VALID FACT', '用户身份定位']);
    expect(observed.text).toContain('VALID CONCEPT');
    expect(observed.text).toContain('记忆检索');
    expect(observed.text).toContain('src/read.ts');
    expect(observed.text).toContain('src/changed.ts');
    expect(observed.text).not.toContain('[object Object]');
  } finally {
    if(timer) clearTimeout(timer);child.kill();await child.exited;server.stop(true);rmSync(profile,{recursive:true,force:true});
  }
},80000);

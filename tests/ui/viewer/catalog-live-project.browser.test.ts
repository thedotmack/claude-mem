import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for native viewer regressions.');
(chrome ? it : it.skip)('keeps unrelated live sessions out of a project-filtered catalog', async () => {
  const esbuild = createRequire(import.meta.url).resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`);
  const bundle = execFileSync(esbuild, ['--bundle', '--loader=tsx', '--platform=browser', '--format=iife', '--define:process.env.NODE_ENV="production"', '--log-level=error'], {
    cwd: resolve(import.meta.dir, '../../..'), encoding: 'utf8', timeout: 20000,
    input: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {useSessionCatalog} from './src/ui/viewer/hooks/useSessionCatalog';
      let catalog; function Fixture(){ catalog=useSessionCatalog(); return <div>{catalog.sessions.map(s=>s.project+':'+s.content_session_id).join(',')}</div>; }
      createRoot(document.getElementById('root')).render(<Fixture/>);
      async function settle(){for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);}
      (async()=>{try{await settle(); await catalog.refresh('alpha'); await settle();
        catalog.touch({session:{platformSource:'claude',contentSessionId:'foreign'}, project:'beta',createdAtEpoch:1});
        catalog.touch({session:{platformSource:'claude',contentSessionId:'local'}, project:'alpha',createdAtEpoch:2});
        await settle(); const filtered=catalog.sessions.map(s=>s.project);
        await catalog.refresh(''); await settle();
        catalog.touch({session:{platformSource:'claude',contentSessionId:'all-projects'},project:'beta',createdAtEpoch:3});
        await settle(); await fetch('/result',{method:'POST',body:JSON.stringify({filtered,all:catalog.sessions.map(s=>s.project)})});
      }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();`,
  });
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: {'Content-Type':'text/html'} });
    if (url.pathname === '/fixture.js') return new Response(bundle, { headers: {'Content-Type':'application/javascript'} });
    if (url.pathname === '/result') { report(await request.json()); return new Response('ok'); }
    return Response.json({sessions:[],hasMore:false});
  }});
  const profile=mkdtempSync(join(tmpdir(),'cm-catalog-project-'));
  const child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run',`--user-data-dir=${profile}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
  let timeout: ReturnType<typeof setTimeout>;
  try { const reported=await Promise.race([result,new Promise(resolve=>{timeout=setTimeout(()=>resolve({failure:'Browser timed out'}),45000);})]);
    expect(reported).toEqual({filtered:['alpha'],all:['beta']});
  } finally {clearTimeout(timeout!);child.kill();await child.exited;server.stop(true);rmSync(profile,{recursive:true,force:true});}
},80000);

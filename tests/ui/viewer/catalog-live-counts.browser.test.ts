import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for live catalog request-order tests');

for (const scenario of ['stale', 'fresh', 'placeholder', 'removed', 'overlap', 'item-deleted'] as const) {
  (chrome ? it : it.skip)(`catalog refresh preserves live changes: ${scenario}`, async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let releaseFirst!:()=>void;
    const firstReady = new Promise<void>(resolve=>{releaseFirst=resolve});
    let finish!: (result: any) => void;
    const result = new Promise<any>(resolve => { finish = resolve; });
    const bundle = await build({ write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React, {useEffect} from 'react';
        import {createRoot} from 'react-dom/client';
        import {useSessionCatalog} from './src/ui/viewer/hooks/useSessionCatalog';
        const ref={platformSource:'claude',contentSessionId:'owned-session'};
        function Fixture() {
          const state=useSessionCatalog();
          useEffect(()=>{state.refresh('owned-project')},[]);
          return <><output id="rows">{JSON.stringify(state.sessions)}</output>
            <output id="loading">{String(state.isLoading)}</output>
            <button id="refresh" onClick={()=>state.refresh('owned-project')}>Refresh</button>
            <button id="touch" onClick={()=>state.touch({session:ref,project:'owned-project',createdAtEpoch:1})}>Touch</button>
            <button id="remove" onClick={()=>state.remove(ref)}>Remove</button>
            <button id="delete-item" onClick={()=>state.noteItemRemoved(ref)}>Delete item</button></>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
        async function run() {
          const wait=async(predicate)=>{const deadline=Date.now()+12000;while(!predicate()){
            if(Date.now()>deadline)throw Error('Fixture timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
          await wait(()=>document.getElementById('loading')?.textContent==='false' && ${scenario === 'placeholder' ? 'true' : "document.getElementById('rows').textContent.includes('owned-session')"});
          document.getElementById('refresh').click();
          await wait(()=>document.getElementById('loading').textContent==='true');
          for(let i=0;i<2;i++){document.getElementById('touch').click();await new Promise(requestAnimationFrame);}
          if(${JSON.stringify(scenario)}==='overlap'){
            document.getElementById('refresh').click();
            // Browsers may serialize identical concurrent GETs. Let the
            // superseded response finish before waiting for the newest GET.
            await fetch('/release-first');
            await fetch('/latest-requested');
          }
          if(${JSON.stringify(scenario)}==='item-deleted'){
            document.getElementById('delete-item').click();await new Promise(requestAnimationFrame);
            document.getElementById('delete-item').click();await new Promise(requestAnimationFrame);
          }
          if(${JSON.stringify(scenario)}==='removed')document.getElementById('remove').click();
          await fetch('/release');
          await wait(()=>document.getElementById('loading').textContent==='false');
          await fetch('/result',{method:'POST',body:document.getElementById('rows').textContent});
        }
        run().catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({error:String(error)})}));
      ` } });
    let requests=0;
    let latestStarted!:()=>void;
    const latestRequested=new Promise<void>(resolve=>{latestStarted=resolve});
    const entry={content_session_id:'owned-session',platform_source:'claude',project:'owned-project',custom_title:'Server title',started_at_epoch:1,item_count:5};
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      const path=new URL(request.url).pathname;
      if(path==='/fixture.js')return new Response(bundle.outputFiles[0].text,{headers:{'Content-Type':'application/javascript'}});
      if(path==='/api/sessions'){
        const page=++requests;
        if(page===3)latestStarted();
        if(page===2 && scenario==='overlap')await firstReady;
        else if(page>1)await ready;
        return Response.json({sessions:scenario==='placeholder'?[]:[{...entry,item_count:page>1 && scenario==='fresh'?8:5}],hasMore:false});
      }
      if(path==='/release-first'){releaseFirst();return new Response('ok');}
      if(path==='/latest-requested'){await latestRequested;return new Response('ok');}
      if(path==='/release'){release();return new Response('ok');}
      if(path==='/result'){finish(await request.json());return new Response('ok');}
      return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
    }});
    const profile=mkdtempSync(join(tmpdir(),'claude-mem-catalog-count-'));
    const child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking',
      '--no-first-run',`--user-data-dir=${profile}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const actual:any=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser result timed out')),25000);})]);
      if(scenario==='removed')expect(actual).toEqual([]);
      else{
        expect(actual).toHaveLength(1);
        expect(actual[0].item_count).toBe(scenario==='placeholder'?2:scenario==='fresh'?8:scenario==='item-deleted'?5:7);
        expect(actual[0].custom_title).toBe(scenario==='placeholder'?null:'Server title');
      }
    }finally{
      clearTimeout(timer);releaseFirst();release();child.kill();await child.exited;server.stop(true);rmSync(profile,{recursive:true,force:true});
    }
  },30000);
}

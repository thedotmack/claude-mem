import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome=Bun.which('google-chrome')??Bun.which('chromium')
  ??(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':null);
if(process.env.CI&&!chrome)throw Error('CI requires Chrome for loaded catalog refresh tests');

(chrome?it:it.skip)('an unloaded item deletion refreshes counts without dropping older catalog pages',async()=>{
  const owned=mkdtempSync(join(tmpdir(),'cm-catalog-loaded-refresh-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let server:ReturnType<typeof Bun.serve>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
  let report!:(value:unknown)=>void;
  const result=new Promise(resolve=>{report=resolve});
  let releaseOlder!:()=>void;
  const olderGate=new Promise<void>(resolve=>{releaseOlder=resolve});
  const esbuild=createRequire(import.meta.url).resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform==='win32'?'esbuild.exe':'bin/esbuild'}`);
  const offsets:number[]=[];const limits:number[]=[];
  try{
    const bundle=execFileSync(esbuild,['--bundle','--loader=tsx','--platform=browser','--format=iife','--define:process.env.NODE_ENV="production"','--log-level=error'],{
      cwd:resolve(import.meta.dir,'../../..'),encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,input:`
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {App} from './src/ui/viewer/App';
        import {setStoredWelcomeDismissed} from './src/ui/viewer/components/WelcomeCard';
        setStoredWelcomeDismissed(true);location.hash='#/sessions';
        createRoot(document.getElementById('root')).render(<App/>);
        async function until(test){const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('Browser state timed out: '+document.querySelectorAll('.session-card').length+' cards');await new Promise(r=>setTimeout(r,10));}}
        (async()=>{try{
          await until(()=>document.querySelectorAll('.session-card').length===100);
          document.querySelector('.session-list-content')?.lastElementChild?.scrollIntoView({block:'end'});
          const end=Date.now()+6000;
          while(document.querySelectorAll('.session-card').length<140&&Date.now()<end){
            document.querySelector('.session-list-content').lastElementChild.scrollIntoView({block:'end'});
            await new Promise(r=>setTimeout(r,20));
          }
          await until(()=>document.querySelectorAll('.session-card').length===140);
          await fetch('/delete-unloaded');
          await until(()=>document.querySelector('.session-card-count')?.textContent==='0 memories');
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          await fetch('/result',{method:'POST',body:JSON.stringify({cards:document.querySelectorAll('.session-card').length,
            olderVisible:[...document.querySelectorAll('.session-card-name')].some(x=>x.textContent==='Older140')})});
        }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
      `});
    const html=readFileSync(resolve(import.meta.dir,'../../../src/ui/viewer-template.html'),'utf8').replace('src="viewer-bundle.js"','src="/fixture.js"');
    let deleted=false;
    server=Bun.serve({idleTimeout:0,hostname:'127.0.0.1',port:0,async fetch(request){
      const url=new URL(request.url);
      if(url.pathname==='/')return new Response(html,{headers:{'Content-Type':'text/html'}});
      if(url.pathname==='/fixture.js'){
        clearTimeout(timer);timer=setTimeout(()=>report({failure:'Page timed out'}),20000);
        return new Response(bundle,{headers:{'Content-Type':'application/javascript'}});
      }
      if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'initial_load',projects:['alpha']})+'\n\n'))}}),{headers:{'Content-Type':'text/event-stream'}});
      if(url.pathname==='/api/sessions'){
        const offset=Number(url.searchParams.get('offset'));const limit=Number(url.searchParams.get('limit'));
        offsets.push(offset);limits.push(limit);
        // A replacement refresh must not discard the older page while its
        // automatically requested replacement is still crossing the network.
        if(deleted&&offset===100)await olderGate;
        const rows=Array.from({length:140},(_,i)=>({content_session_id:'session-'+i,platform_source:'claude',project:'alpha',custom_title:i===139?'Older140':'Session'+i,started_at_epoch:140-i,item_count:deleted?0:1}));
        return Response.json({sessions:rows.slice(offset,offset+Math.min(1000,limit)),hasMore:offset+Math.min(1000,limit)<140});
      }
      if(url.pathname==='/delete-unloaded'){
        deleted=true;controller!.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'item_deleted',itemType:'observation',id:999})+'\n\n'));return new Response('deleted');
      }
      if(['/api/observations','/api/summaries','/api/prompts'].includes(url.pathname))return Response.json({items:[],hasMore:false});
      if(url.pathname==='/api/projects')return Response.json({projects:['alpha'],sources:['claude'],projectsBySource:{claude:['alpha']}});
      if(url.pathname==='/result'){report(await request.json());return new Response('received');}
      return Response.json({});
    }});
    timer=setTimeout(()=>report({failure:'Chrome startup timed out'}),30000);
    child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${join(owned,'browser')}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
    expect(await result).toEqual({cards:140,olderVisible:true});
    expect(offsets).toEqual([0,100,0]);expect(limits).toEqual([100,100,140]);
  }finally{
    releaseOlder();clearTimeout(timer);if(child){child.kill();await child.exited;}server?.stop(true);rmSync(owned,{recursive:true,force:true});
  }
},60000);

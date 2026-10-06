import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome=Bun.which('google-chrome')??Bun.which('chromium')
  ??(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':null);
if(process.env.CI&&!chrome)throw Error('CI requires Chrome for deletion confirmation tests');
for(const scenario of ['existence-fails','rows-fail','later-live'] as const){
  (chrome?it:it.skip)(`successful deletion survives failed view confirmation: ${scenario}`,async()=>{
    const owned=mkdtempSync(join(tmpdir(),'cm-delete-confirmation-'));
    let child:ReturnType<typeof Bun.spawn>|undefined;
    let server:ReturnType<typeof Bun.serve>|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
    let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
    let report!:(value:unknown)=>void;const result=new Promise(resolve=>{report=resolve});
    let deleteCalls=0,deleted=false,recreated=false,laterSent=false;
    const send=(event:unknown)=>controller!.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));
    const row={id:1,memory_session_id:'memory-owned',content_session_id:'owned',platform_source:'claude',project:'alpha',type:'discovery',title:'OLD_CAPTURE',narrative:'Owned fixture',facts:'[]',concepts:'[]',files_read:'[]',files_modified:'[]',created_at_epoch:1,created_at:'2026-10-05T00:00:00Z'};
    const session={content_session_id:'owned',platform_source:'claude',project:'alpha',custom_title:'Owned',started_at_epoch:1,item_count:1};
    try{
      const esbuild=createRequire(import.meta.url).resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform==='win32'?'esbuild.exe':'bin/esbuild'}`);
      const bundle=execFileSync(esbuild,['--bundle','--loader=tsx','--platform=browser','--format=iife','--define:process.env.NODE_ENV="production"','--log-level=error'],{cwd:resolve(import.meta.dir,'../../..'),encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,input:`
        import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./src/ui/viewer/App';
        import{setStoredWelcomeDismissed}from'./src/ui/viewer/components/WelcomeCard';setStoredWelcomeDismissed(true);location.hash='#/sessions';createRoot(document.getElementById('root')).render(<App/>);
        async function until(test){const end=Date.now()+12000;while(!test()){if(Date.now()>end)throw Error('Browser state timeout: '+document.body.textContent.slice(-300));await new Promise(r=>setTimeout(r,10));}}
        async function paint(){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
        (async()=>{try{
          await until(()=>document.querySelector('.session-card-count')?.textContent==='1 memory'&&performance.getEntriesByName(location.origin+'/api/observations?offset=0&limit=50').length>0);await paint();
          window.confirm=()=>true;document.querySelector('.session-card-menu-trigger').click();await paint();document.querySelector('.session-card-menu-item--danger').click();
          await fetch('/activity');await until(()=>document.querySelector('.session-card-count')?.textContent==='2 memories');
          await fetch('/acknowledge');await until(()=>document.querySelector('[role="alert"]'));
          await paint();const notice=document.querySelector('[role="alert"]')?.textContent??'';
          const cards=document.querySelectorAll('.session-card').length;const deleting=!!document.querySelector('.session-card--deleting');
          location.hash='';await paint();
          const names=[...document.querySelectorAll('.card-title')].map(x=>x.textContent);const text=document.body.textContent;
          await fetch('/result',{method:'POST',body:JSON.stringify({noticeSuccess:notice.includes('Session deleted'),old:text.includes('OLD_CAPTURE'),preAck:text.includes('PRE_ACK_CAPTURE'),later:text.includes('POST_ACK_RECREATION'),cards,deleting})});
        }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
      `});
      const html=readFileSync(resolve(import.meta.dir,'../../../src/ui/viewer-template.html'),'utf8').replace('src="viewer-bundle.js"','src="/fixture.js"');
      server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
        const url=new URL(request.url);
        if(url.pathname==='/')return new Response(html,{headers:{'Content-Type':'text/html'}});
        if(url.pathname==='/fixture.js'){clearTimeout(timer);timer=setTimeout(()=>report({failure:'Page timed out'}),25000);return new Response(bundle,{headers:{'Content-Type':'application/javascript'}})}
        if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){controller=c;send({type:'initial_load',projects:['alpha']})}}),{headers:{'Content-Type':'text/event-stream'}});
        if(url.pathname==='/api/sessions/claude/owned'&&request.method==='DELETE'){
          deleteCalls++;await held;deleted=true;recreated=scenario==='rows-fail';return Response.json({success:true});
        }
        if(url.pathname==='/activity'){send({type:'new_observation',observation:{...row,id:2,title:'PRE_ACK_CAPTURE'}});return new Response('activity')}
        if(url.pathname==='/acknowledge'){release();return new Response('released')}
        if(url.pathname==='/api/sessions'){
          if(deleted&&url.searchParams.get('limit')==='1000'&&scenario!=='rows-fail'){
            if(scenario==='later-live'&&!laterSent){laterSent=true;recreated=true;send({type:'new_observation',observation:{...row,id:3,title:'POST_ACK_RECREATION'}})}
            return new Response('Confirmation unavailable',{status:503});
          }
          return Response.json({sessions:!deleted||recreated?[{...session,custom_title:recreated?'Recreated':'Owned'}]:[],hasMore:false});
        }
        if(url.pathname==='/api/observations'){
          if(deleted&&url.searchParams.has('contentSessionId'))return new Response('Rows unavailable',{status:503});
          return Response.json({items:deleted?[]:[row],hasMore:false});
        }
        if(['/api/summaries','/api/prompts'].includes(url.pathname))return Response.json({items:[],hasMore:false});
        if(url.pathname==='/api/projects')return Response.json({projects:['alpha'],sources:['claude'],projectsBySource:{claude:['alpha']}});
        if(url.pathname==='/result'){report(await request.json());return new Response('received')}
        return Response.json({});
      }});
      timer=setTimeout(()=>report({failure:'Chrome startup timeout'}),30000);
      child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${join(owned,'browser')}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
      expect(await result).toEqual({noticeSuccess:true,old:false,preAck:false,later:scenario==='later-live',cards:scenario==='existence-fails'?0:1,deleting:false});expect(deleteCalls).toBe(1);
    }finally{release();clearTimeout(timer);if(child){child.kill();await child.exited;}server?.stop(true);rmSync(owned,{recursive:true,force:true})}
  },70000);
}

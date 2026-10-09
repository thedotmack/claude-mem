import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UI } from '../../../src/ui/viewer/constants/ui';

const chrome=Bun.which('google-chrome')??Bun.which('chromium')
  ??(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':null);
if(process.env.CI&&!chrome)throw Error('CI requires Chrome for viewer deletion lifecycle tests');

for(const scenario of ['item','recreated-visible','recreated-session','late-delete-response','catalog-recreated','live-before-delete'] as const) {
  (chrome?it:it.skip)(`viewer preserves deletion identity across pending pages: ${scenario}`,async()=>{
    const owned=mkdtempSync(join(tmpdir(),'cm-viewer-deletion-'));
    let child:ReturnType<typeof Bun.spawn>|undefined;
    let server:ReturnType<typeof Bun.serve>|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve});
    let releaseDelete!:()=>void;
    const deleteGate=new Promise<void>(resolve=>{releaseDelete=resolve});
    let markReady!:()=>void;
    const ready=new Promise<void>(resolve=>{markReady=resolve});
    let started!:()=>void;
    const snapshotStarted=new Promise<void>(resolve=>{started=resolve});
    let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
    let finish!:(report:unknown)=>void;
    const result=new Promise(resolve=>{finish=resolve});
    const esbuild=createRequire(import.meta.url).resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform==='win32'?'esbuild.exe':'bin/esbuild'}`);
    try {
      const bundle=execFileSync(esbuild,['--bundle','--loader=tsx','--platform=browser','--format=iife',
        '--define:process.env.NODE_ENV="production"','--log-level=error'],{
        cwd:resolve(import.meta.dir,'../../..'),encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,input:`
          import React from 'react';import {createRoot} from 'react-dom/client';
          import {App} from './src/ui/viewer/App';
          import {setStoredWelcomeDismissed} from './src/ui/viewer/components/WelcomeCard';
          setStoredWelcomeDismissed(true);location.hash='#/sessions';
          createRoot(document.getElementById('root')).render(<App/>);
          async function until(predicate) {
            const deadline=Date.now()+6000;
            while(!predicate()) {
              if(Date.now()>deadline)throw Error('Browser state timed out: '+document.body.textContent.slice(-250));
              await new Promise(resolve=>setTimeout(resolve,10));
            }
          }
          async function paint(){for(let i=0;i<4;i++)await new Promise(requestAnimationFrame)}
          (async()=>{try{
            await fetch('/ready');
            await until(()=>document.querySelector('.session-card-count')?.textContent==='1 memory');
            await fetch('/snapshot-started');
            if(['late-delete-response','live-before-delete'].includes(${JSON.stringify(scenario)})) {
              window.confirm=()=>true;
              document.querySelector('.session-card-menu-trigger').click();await paint();
              document.querySelector('.session-card-menu-item--danger').click();
            } else await fetch('/delete');
            await paint();
            if(${JSON.stringify(scenario)}!=='item') {
              if(!['live-before-delete'].includes(${JSON.stringify(scenario)})) await until(()=>document.querySelectorAll('.session-card').length===0);
              await fetch('/recreate');
              if(${JSON.stringify(scenario)}==='catalog-recreated') {
                location.hash='';await paint();location.hash='#/sessions';
                await until(()=>document.querySelector('.session-card-count')?.textContent==='1 memory');
                document.querySelector('.session-card').click();
                await until(()=>document.body.textContent.includes('RECREATED_CAPTURE')||document.body.textContent.includes('No items to display'));
                await fetch('/result',{method:'POST',body:JSON.stringify({detailFresh:document.body.textContent.includes('RECREATED_CAPTURE')})});return;
              }
              await until(()=>document.querySelector('.session-card-count')?.textContent===(${JSON.stringify(scenario)}==='live-before-delete'?'2 memories':'1 memory'));
              if(['late-delete-response','live-before-delete'].includes(${JSON.stringify(scenario)})) {await fetch('/release-delete');await new Promise(resolve=>setTimeout(resolve,250));}
              if(${JSON.stringify(scenario)}==='recreated-session') {await fetch('/delete');await paint();}
            } else await new Promise(resolve=>setTimeout(resolve,150));
            const count=document.querySelector('.session-card-count')?.textContent??null;
            await fetch('/release');
            await new Promise(resolve=>setTimeout(resolve,150));
            location.hash='';await paint();
            await until(()=>document.body.textContent.includes('CONTROL_VISIBLE'));
            const end=Date.now()+3000;
            while(!document.body.textContent.includes('NEXT_CURSOR_CONTROL')&&Date.now()<end) {
              document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({block:'end'});
              await new Promise(resolve=>setTimeout(resolve,20));
            }
            const offsets=await(await fetch('/offsets')).json();
            await fetch('/result',{method:'POST',body:JSON.stringify({count,
              ghost:document.body.textContent.includes('DELETED_CAPTURE'),
              recreatedGhost:document.body.textContent.includes('RECREATED_CAPTURE'),
              control:document.body.textContent.includes('CONTROL_VISIBLE'),
              next:document.body.textContent.includes('NEXT_CURSOR_CONTROL'),offsets})});
          }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
        `});
      const html=readFileSync(resolve(import.meta.dir,'../../../src/ui/viewer-template.html'),'utf8')
        .replace('src="viewer-bundle.js"','src="/fixture.js"');
      const session={content_session_id:'owned-session',platform_source:'claude',project:'alpha',
        custom_title:'Owned',started_at_epoch:1,item_count:1};
      const row={id:1,memory_session_id:'memory-owned',content_session_id:'owned-session',platform_source:'claude',
        project:'alpha',type:'discovery',title:'DELETED_CAPTURE',narrative:'Owned fixture',facts:'[]',concepts:'[]',
        files_read:'[]',files_modified:'[]',created_at_epoch:1,created_at:'2026-10-05T00:00:00Z'};
      const send=(event:unknown)=>controller!.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));
      let deleted=false;
      let observationRequests=0;
      const offsets:number[]=[];
      server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
        const url=new URL(request.url);
        if(url.pathname==='/')return new Response(html,{headers:{'Content-Type':'text/html'}});
        if(url.pathname==='/fixture.js')return new Response(bundle,{headers:{'Content-Type':'application/javascript'}});
        if(url.pathname==='/ready'){markReady();return new Response('ready')}
        if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){controller=c;send({type:'initial_load',projects:['alpha']})}}),
          {headers:{'Content-Type':'text/event-stream'}});
        if(url.pathname==='/api/sessions/claude/owned-session' && request.method==='DELETE') {
          if(scenario==='live-before-delete')await deleteGate;
          deleted=true;if(scenario==='late-delete-response')send({type:'session_deleted',platformSource:'claude',contentSessionId:'owned-session'});
          if(scenario!=='live-before-delete')await deleteGate;return Response.json({success:true});
        }
        if(url.pathname==='/release-delete'){releaseDelete();return new Response('released')}
        if(url.pathname==='/api/sessions')return Response.json({sessions:scenario==='item'
          ?[{...session,item_count:deleted?0:1}]:deleted?[]:[session],hasMore:false});
        if(url.pathname==='/api/observations') {
          if(url.searchParams.has('contentSessionId'))return Response.json({items:[{...row,id:2,title:'RECREATED_CAPTURE'}],hasMore:false});
          offsets.push(Number(url.searchParams.get('offset')));
          if(++observationRequests===1)return new Response(new ReadableStream({async start(c){
            c.enqueue(new TextEncoder().encode(' '));started();await gate;
            c.enqueue(new TextEncoder().encode(JSON.stringify({items:[row,...Array.from({length:UI.PAGINATION_PAGE_SIZE-1},(_,i)=>({...row,id:3+i,content_session_id:'control-session',title:'CONTROL_VISIBLE_'+i}))],hasMore:true})));c.close();
          }}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
          return Response.json({items:[{...row,id:UI.PAGINATION_PAGE_SIZE+30,content_session_id:'control-session',title:'NEXT_CURSOR_CONTROL'}],hasMore:false});
        }
        if(url.pathname==='/api/summaries'||url.pathname==='/api/prompts')return Response.json({items:[],hasMore:false});
        if(url.pathname==='/api/projects')return Response.json({projects:['alpha'],sources:['claude'],projectsBySource:{claude:['alpha']}});
        if(url.pathname==='/snapshot-started'){await snapshotStarted;return new Response('started')}
        if(url.pathname==='/delete') {
          deleted=true;
          send(scenario==='item'?{type:'item_deleted',itemType:'observation',id:1}
            :{type:'session_deleted',platformSource:'claude',contentSessionId:'owned-session'});
          return new Response('deleted');
        }
        if(url.pathname==='/recreate'){deleted=false;if(!['catalog-recreated'].includes(scenario))send({type:'new_observation',observation:{...row,id:2,title:'RECREATED_CAPTURE'}});return new Response('recreated')}
        if(url.pathname==='/offsets')return Response.json(offsets);
        if(url.pathname==='/release'){release();return new Response('released')}
        if(url.pathname==='/result'){finish(await request.json());return new Response('received')}
        return Response.json({});
      }});
      child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking',
        '--disable-background-timer-throttling','--disable-renderer-backgrounding',
        '--no-first-run',`--user-data-dir=${join(owned,'browser')}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
      // Chrome's cold start gets its own window; the page's phases start at /ready.
      await Promise.race([ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Viewer did not become ready')),30000)})]);
      clearTimeout(timer);
      const received=await Promise.race([result,new Promise(resolve=>{timer=setTimeout(()=>resolve({failure:'Browser page timed out'}),25000)})]);
      if(scenario==='catalog-recreated'){expect(received).toEqual({detailFresh:true});return;}
      // item: the deleted row was never loaded, so this tab cannot attribute it
      // to a session and the card count stays stale until the server names the
      // owning session in item_deleted.
      expect(received).toEqual({count:['recreated-session','live-before-delete'].includes(scenario)?null:'1 memory',ghost:false,recreatedGhost:scenario!=='item'&&!['recreated-session','live-before-delete'].includes(scenario),control:true,next:true,offsets:[0,UI.PAGINATION_PAGE_SIZE-1]});
    }finally{
      release();releaseDelete();clearTimeout(timer);
      if(child){child.kill();await child.exited;}
      server?.stop(true);rmSync(owned,{recursive:true,force:true});
    }
  },80000);
}

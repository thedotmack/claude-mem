import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for session-list recovery tests');

for (const [scenario, slow] of [['first-page', false], ['older-page', false], ['project-switch', false], ['project-switch', true]] as const) {
  (chrome ? it : it.skip)(`session catalog recovers ${scenario}${slow ? " after slow responses" : ""} failures by explicit retry`, async () => {
    const owned = mkdtempSync(join(tmpdir(), 'claude-mem-session-retry-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let requests = 0;
    const offsets: number[] = [];
    let report!: (value: unknown) => void;
    const result = new Promise(resolve => { report = resolve; });
    const esbuild = createRequire(import.meta.url).resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`);
    try {
      const bundle = execFileSync(esbuild, ['--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
        '--define:process.env.NODE_ENV="production"', '--log-level=error'], {
        cwd: resolve(import.meta.dir, '../../..'), encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, input: `
          import React, {useEffect} from 'react';
          import {createRoot} from 'react-dom/client';
          import {SessionList} from './src/ui/viewer/components/SessionList';
          import {useSessionCatalog} from './src/ui/viewer/hooks/useSessionCatalog';
          function Fixture() {
            const state=useSessionCatalog();
            useEffect(()=>{state.refresh('owned-project')},[]);
            return <SessionList header={<button id="switch-project" onClick={()=>state.refresh('new-project')}>Switch project</button>} sessions={state.sessions} isLoading={state.isLoading}
              hasMore={state.hasMore} loadError={state.loadError} onLoadMore={state.loadMore}
              onOpen={()=>{}} onDelete={async()=>{}} />;
          }
          createRoot(document.getElementById('root')).render(<Fixture/>);
          async function run() {
            const deadline=Date.now()+6000;
            if(${JSON.stringify(scenario)}==='project-switch') {
              while(!document.querySelector('.session-card-name')) {
                if(Date.now()>deadline)throw Error('No initial session');
                await new Promise(resolve=>setTimeout(resolve,10));
              }
              document.getElementById('switch-project').click();
            }
            const alertDeadline=Date.now()+6000;
            while(!document.querySelector('[role="alert"]')) {
              if(Date.now()>alertDeadline)throw Error('No load failure shown');
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            await new Promise(resolve=>setTimeout(resolve,150));
            const before=await (await fetch('/count')).json();
            const retry=[...document.querySelectorAll('button')].find(x=>x.textContent==='Retry');
            if(retry) retry.click();
            const end=Date.now()+2000;
            while(retry && !document.querySelector('.session-card-name')?.textContent.includes('Recovered') && Date.now()<end)
              await new Promise(resolve=>setTimeout(resolve,10));
            await fetch('/result',{method:'POST',body:JSON.stringify({before,hasRetry:!!retry,
              names:[...document.querySelectorAll('.session-card-name')].map(x=>x.textContent),
              recovered:[...document.querySelectorAll('.session-card-name')].some(x=>x.textContent==='Recovered')})});
          }
          run().catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})}));
        ` });
      const session={content_session_id:'owned-session',platform_source:'claude',project:'owned-project',
        custom_title:'Seed',started_at_epoch:1,item_count:1};
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if(path==='/') return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
        if(path==='/fixture.js') {
          clearTimeout(timeout);
          timeout=setTimeout(()=>report({failure:'Browser page timed out'}),15000);
          return new Response(bundle,{headers:{'Content-Type':'application/javascript'}});
        }
        if(path==='/api/sessions') {
          const n=++requests;
          const params=new URL(request.url).searchParams;
          offsets.push(Number(params.get('offset')));
          if(slow && n<=2) await Bun.sleep(n===1 ? 4000 : 3000);
          if(scenario!=='first-page' && n===1) return Response.json({sessions:[session],hasMore:scenario==='older-page'});
          if(n===(scenario==='first-page'?1:2)) return new Response('Temporary failure',{status:503});
          return Response.json({sessions:[{...session,content_session_id:'recovered-session',project:params.get('project')!,custom_title:'Recovered'}],hasMore:false});
        }
        if(path==='/count') return Response.json(requests);
        if(path==='/result') {report(await request.json());return new Response('received');}
        return new Response('not found',{status:404});
      }});
      timeout=setTimeout(()=>report({failure:'Chrome startup timed out'}),30000);
      child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking',
        '--no-first-run',`--user-data-dir=${join(owned,'browser')}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
      const received=await result;
      expect(received).toEqual({before:scenario==='first-page'?1:2,hasRetry:true,recovered:true,names:scenario==='older-page'?['Seed','Recovered']:['Recovered']});
      if(scenario==='project-switch') expect(offsets).toEqual([0,0,0]);
      expect(requests).toBe(scenario==='first-page'?2:3);
    } finally {
      clearTimeout(timeout);
      if(child){child.kill();await child.exited;}
      server?.stop(true);
      rmSync(owned,{recursive:true,force:true});
    }
  },60000);
}

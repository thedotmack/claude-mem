import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for log request-order tests');

// The one-shot compiler exits before Chrome starts, keeping the browser
// phase free of shared esbuild service handles.
const esbuildBinary = createRequire(import.meta.url).resolve(
  `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`
);
function compileFixture(source: string): string {
  return execFileSync(esbuildBinary, ['--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
    '--define:process.env.NODE_ENV="production"', '--log-level=error'], {
    cwd: resolve(import.meta.dir, '../../..'), input: source, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
  });
}

// The page's 5 s abort timers must fire on time on a loaded runner.
function spawnChrome(profile: string, url: string) {
  return Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run',
    `--user-data-dir=${profile}`, url], { stdout: 'ignore', stderr: 'ignore' });
}

// Chrome's cold start gets its own 30 s window. The page's own phases start
// only once its script fetches /ready, so a slow start cannot eat into them.
async function reportAfterReady(ready: Promise<void>, result: Promise<unknown>, resultWindowMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Chrome did not become ready')), 30000);
    })]);
    clearTimeout(timer);
    return await Promise.race([result, new Promise(resolve => {
      timer = setTimeout(() => resolve({ failure: 'Browser timed out' }), resultWindowMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

(chrome ? it : it.skip)('a late auto-refresh response cannot restore logs after clearing them', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'claude-mem-log-clear-race-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let requests = 0;
  const line = (message: string) => `[2026-10-05 12:00:00] [INFO ] [WORKER ] ${message}`;
  try {
    const bundle = compileFixture(`
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { LogsDrawer } from './src/ui/viewer/components/LogsModal';
        createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={() => {}} />);
        async function waitFor(test) {
          const deadline = Date.now() + 9000;
          while (!test()) {
            if (Date.now() > deadline) throw new Error('Timed out waiting for browser state');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        function messages() { return [...document.querySelectorAll('.log-message')].map(x => x.textContent); }
        window.confirm = () => true;
        (async () => {
          try {
            await fetch('/ready');
            await waitFor(() => messages().includes('INITIAL'));
            document.querySelector('.console-auto-refresh input').click();
            await waitFor(() => messages().includes('LATEST'));
            document.querySelector('.console-auto-refresh input').click();
            const clear = document.querySelector('[title="Clear logs"]');
            await waitFor(() => !clear.disabled);
            clear.click();
            await waitFor(() => !clear.disabled && messages().length === 0);
            const completed=performance.getEntriesByName(location.origin + '/api/logs').map(entry=>entry.startTime).sort((a,b)=>a-b);
            const initialStart=completed[0], latestStart=completed[1];
            await fetch('/release');
            await waitFor(() => performance.getEntriesByName(location.origin + '/api/logs').some(entry=>entry.startTime>initialStart && entry.startTime<latestStart));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await fetch('/result', { method: 'POST', body: JSON.stringify({ messages: messages() }) });
          } catch (error) {
            await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) });
          }
        })();
      `);
    let report!: (value: unknown) => void;
    const result = new Promise(resolve => { report = resolve; });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>',
        { headers: { 'Content-Type': 'text/html' } });
      if (path === '/fixture.js') return new Response(bundle,
        { headers: { 'Content-Type': 'application/javascript' } });
      if (path === '/ready') { markReady(); return new Response('ready'); }
      if (path === '/api/logs') {
        const number = ++requests;
        if (number === 2) return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"logs":'));
            await held;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(line('STALE')) + '}'));
            controller.close();
          }
        }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        return Response.json({ logs: line(number === 1 ? 'INITIAL' : 'LATEST') });
      }
      if (path === '/api/logs/clear') return Response.json({ success: true });
      if (path === '/release') { release(); return new Response('released'); }
      if (path === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('not found', { status: 404 });
    } });
    child = spawnChrome(join(owned, 'browser'), server.url.href);
    const received = await reportAfterReady(ready, result, 25000);
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(received).toEqual({ messages: [] });
  } finally {
    release();
    if (child) { child.kill(); await child.exited; }
    server?.stop(true);
    rmSync(owned, { recursive: true, force: true });
  }
}, 80000);

(chrome ? it : it.skip)('a stalled clear request times out and releases log polling', async () => {
  const owned=mkdtempSync(join(tmpdir(),'claude-mem-clear-timeout-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let server:ReturnType<typeof Bun.serve>|undefined;
  let markReady!:()=>void;
  const ready=new Promise<void>(resolve=>{markReady=resolve});
  let requests=0;
  let report!:(value:unknown)=>void;
  const result=new Promise(resolve=>{report=resolve});
  try {
    const bundle=compileFixture(`
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {LogsDrawer} from './src/ui/viewer/components/LogsModal';
        createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={()=>{}}/>);
        window.confirm=()=>true;
        async function waitFor(test){const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('Browser state timeout');await new Promise(r=>setTimeout(r,10));}}
        (async()=>{try{
          await fetch('/ready');
          await waitFor(()=>document.querySelector('.log-message'));
          document.querySelector('.console-auto-refresh input').click();
          document.querySelector('[title="Clear logs"]').click();
          await waitFor(()=>!document.querySelector('[title="Clear logs"]').disabled);
          await waitFor(()=>[...document.querySelectorAll('.log-message')].some(x=>x.textContent==='RECOVERED'));
          await fetch('/result',{method:'POST',body:JSON.stringify({recovered:true})});
        }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
      `);
    server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
      const path=new URL(request.url).pathname;
      if(path==='/')return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
      if(path==='/fixture.js')return new Response(bundle,{headers:{'Content-Type':'application/javascript'}});
      if(path==='/ready'){markReady();return new Response('ready');}
      if(path==='/api/logs')return Response.json({logs:`[2026-10-05 12:00:00] [INFO ] [WORKER ] ${++requests===1?'INITIAL':'RECOVERED'}`});
      if(path==='/api/logs/clear')return new Promise<Response>(()=>{});
      if(path==='/result')return request.json().then(value=>{report(value);return new Response('received')});
      return new Response('missing',{status:404});
    }});
    child=spawnChrome(join(owned,'browser'),server.url.href);
    const received=await reportAfterReady(ready,result,25000);
    expect(received).toEqual({recovered:true});expect(requests).toBeGreaterThan(1);
  }finally{
    if(child){child.kill();await child.exited;}server?.stop(true);rmSync(owned,{recursive:true,force:true});
  }
},80000);

for(const scenario of ['reconciled','read-hung'] as const) {
(chrome ? it : it.skip)(`a clear with a lost acknowledgment reconciles current logs while auto-refresh is off: ${scenario}`, async () => {
  const owned=mkdtempSync(join(tmpdir(),'claude-mem-clear-reconcile-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let server:ReturnType<typeof Bun.serve>|undefined;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve});
  let markReady!:()=>void;
  const ready=new Promise<void>(resolve=>{markReady=resolve});
  let cleared=false;
  let requests=0;
  let report!:(value:unknown)=>void;
  const result=new Promise(resolve=>{report=resolve});
  try {
    const bundle=compileFixture(`
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {LogsDrawer} from './src/ui/viewer/components/LogsModal';
        createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={()=>{}}/>);
        window.confirm=()=>true;
        async function waitFor(test){const end=Date.now()+13000;while(!test()){if(Date.now()>end)throw Error('Browser state timeout');await new Promise(r=>setTimeout(r,10));}}
        (async()=>{try{
          await fetch('/ready');
          await waitFor(()=>document.querySelector('.log-message'));
          const clear=document.querySelector('[title="Clear logs"]');clear.click();
          await waitFor(()=>clear.disabled);await waitFor(()=>!clear.disabled);
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          await fetch('/result',{method:'POST',body:JSON.stringify({messages:[...document.querySelectorAll('.log-message')].map(row=>row.textContent),unknown:document.querySelector('.console-error')?.textContent.includes('outcome is unknown')??false,autoRefresh:document.querySelector('.console-auto-refresh input').checked})});
        }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
      `);
    server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      const path=new URL(request.url).pathname;
      if(path==='/')return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
      if(path==='/fixture.js')return new Response(bundle,{headers:{'Content-Type':'application/javascript'}});
      if(path==='/ready'){markReady();return new Response('ready');}
      if(path==='/api/logs'){requests++;if(scenario==='read-hung'&&requests>1)await held;return Response.json({logs:cleared?'':'[2026-10-05 12:00:00] [INFO ] [WORKER ] OLD_BEFORE_CLEAR'});}
      if(path==='/api/logs/clear'){cleared=true;await held;return Response.json({success:true});}
      if(path==='/result'){report(await request.json());return new Response('received');}
      return new Response('missing',{status:404});
    }});
    child=spawnChrome(join(owned,'browser'),server.url.href);
    // The read-hung path waits out two 5 s aborts: the clear, then its reconciliation read.
    const received=await reportAfterReady(ready,result,30000);
    expect(received).toEqual({messages:scenario==='read-hung'?['OLD_BEFORE_CLEAR']:[],unknown:true,autoRefresh:false});expect(requests).toBe(2);
  }finally{
    release();if(child){child.kill();await child.exited;}server?.stop(true);rmSync(owned,{recursive:true,force:true});
  }
},80000);

}

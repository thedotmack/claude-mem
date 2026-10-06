import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for log request-order tests');

(chrome ? it : it.skip)('a late auto-refresh response cannot restore logs after clearing them', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'claude-mem-log-clear-race-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const line = (message: string) => `[2026-10-05 12:00:00] [INFO ] [WORKER ] ${message}`;
  try {
    const bundle = await build({ write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
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
      ` } });
    let report!: (value: unknown) => void;
    const result = new Promise(resolve => { report = resolve; });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>',
        { headers: { 'Content-Type': 'text/html' } });
      if (path === '/fixture.js') return new Response(bundle.outputFiles[0].text,
        { headers: { 'Content-Type': 'application/javascript' } });
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
    child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', `--user-data-dir=${join(owned, 'browser')}`, server.url.href],
      { stdout: 'ignore', stderr: 'ignore' });
    const received = await Promise.race([result, new Promise(resolve => {
      timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 15000);
    })]);
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(received).toEqual({ messages: [] });
  } finally {
    release(); clearTimeout(timeout);
    if (child) { child.kill(); await child.exited; }
    server?.stop(true);
    rmSync(owned, { recursive: true, force: true });
  }
}, 20000);

(chrome ? it : it.skip)('a stalled clear request times out and releases log polling', async () => {
  const owned=mkdtempSync(join(tmpdir(),'claude-mem-clear-timeout-'));
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let server:ReturnType<typeof Bun.serve>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let requests=0;
  let report!:(value:unknown)=>void;
  const result=new Promise(resolve=>{report=resolve});
  try {
    const bundle=await build({write:false,bundle:true,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'},
      stdin:{resolveDir:resolve(import.meta.dir,'../../..'),loader:'tsx',contents:`
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {LogsDrawer} from './src/ui/viewer/components/LogsModal';
        createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={()=>{}}/>);
        window.confirm=()=>true;
        async function waitFor(test){const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('Browser state timeout');await new Promise(r=>setTimeout(r,10));}}
        (async()=>{try{
          await waitFor(()=>document.querySelector('.log-message'));
          document.querySelector('.console-auto-refresh input').click();
          document.querySelector('[title="Clear logs"]').click();
          await waitFor(()=>!document.querySelector('[title="Clear logs"]').disabled);
          await waitFor(()=>[...document.querySelectorAll('.log-message')].some(x=>x.textContent==='RECOVERED'));
          await fetch('/result',{method:'POST',body:JSON.stringify({recovered:true})});
        }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
      `}});
    server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
      const path=new URL(request.url).pathname;
      if(path==='/')return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
      if(path==='/fixture.js')return new Response(bundle.outputFiles[0].text,{headers:{'Content-Type':'application/javascript'}});
      if(path==='/api/logs')return Response.json({logs:`[2026-10-05 12:00:00] [INFO ] [WORKER ] ${++requests===1?'INITIAL':'RECOVERED'}`});
      if(path==='/api/logs/clear')return new Promise<Response>(()=>{});
      if(path==='/result')return request.json().then(value=>{report(value);return new Response('received')});
      return new Response('missing',{status:404});
    }});
    child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${join(owned,'browser')}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
    const received=await Promise.race([result,new Promise(resolve=>{timer=setTimeout(()=>resolve({failure:'Browser timed out'}),20000)})]);
    expect(received).toEqual({recovered:true});expect(requests).toBeGreaterThan(1);
  }finally{
    clearTimeout(timer);if(child){child.kill();await child.exited;}server?.stop(true);rmSync(owned,{recursive:true,force:true});
  }
},25000);

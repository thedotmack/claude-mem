import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for settings request-order tests');

for (const saveSucceeds of [true, false]) {
  (chrome ? it : it.skip)(`late initial settings load respects a ${saveSucceeds ? 'successful' : 'failed'} save`, async () => {
    let releaseLoad!: () => void;
    const loadReady = new Promise<void>(resolve => { releaseLoad = resolve; });
    let finish!: (result: any) => void;
    const result = new Promise<any>(resolve => { finish = resolve; });
    const bundle = await build({ write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useSettings } from './src/ui/viewer/hooks/useSettings';
        function Fixture() {
          const state = useSettings();
          return <><output id="model">{state.settings.CLAUDE_MEM_CODEX_MODEL}</output>
            <output id="status">{state.saveStatus}</output>
            <button id="save" onClick={() => state.saveSettings({...state.settings, CLAUDE_MEM_CODEX_MODEL: 'saved-new'})}>Save</button></>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
        async function run() {
          const wait = async (predicate) => { const deadline=Date.now()+12000;
            while(!predicate()) { if(Date.now()>deadline) throw Error('Fixture timed out');
              await new Promise(resolve => setTimeout(resolve, 10)); } };
          await wait(() => document.getElementById('save'));
          document.getElementById('save').click();
          await wait(() => document.getElementById('status').textContent !== '' && document.getElementById('status').textContent !== 'Saving...');
          await fetch('/release-load');
          await fetch('/load-returned');
          for(let i=0;i<6;i++) await new Promise(requestAnimationFrame);
          await fetch('/result', {method:'POST',body:JSON.stringify({model:document.getElementById('model').textContent})});
        }
        run().catch(error => fetch('/result',{method:'POST',body:JSON.stringify({error:String(error)})}));
      ` } });
    let markLoaded!: () => void;
    const loaded = new Promise<void>(resolve => { markLoaded = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if(path === '/fixture.js') return new Response(bundle.outputFiles[0].text, {headers:{'Content-Type':'application/javascript'}});
      if(path === '/api/settings' && request.method === 'POST') return Response.json(saveSucceeds ? {success:true} : {error:'owned rejection'}, {status:saveSucceeds?200:400});
      if(path === '/api/settings') { await loadReady; markLoaded(); return Response.json({CLAUDE_MEM_CODEX_MODEL:'loaded-old'}); }
      if(path === '/release-load') { releaseLoad(); return new Response('ok'); }
      if(path === '/load-returned') { await loaded; return new Response('ok'); }
      if(path === '/result') { finish(await request.json()); return new Response('ok'); }
      return new Response('<div id="root"></div><script src="/fixture.js"></script>', {headers:{'Content-Type':'text/html'}});
    } });
    const profile=mkdtempSync(join(tmpdir(),'claude-mem-settings-order-'));
    const child=Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
      '--no-first-run', `--user-data-dir=${profile}`, server.url.href], {stdout:'ignore',stderr:'ignore'});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const actual=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser result timed out')),25000);})]);
      expect(actual).toEqual({model:saveSucceeds?'saved-new':'loaded-old'});
    } finally {
      clearTimeout(timer); releaseLoad(); child.kill(); await child.exited; server.stop(true);
      rmSync(profile,{recursive:true,force:true});
    }
  },30000);
}

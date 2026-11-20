import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for processing-status recovery tests');

for (const scenario of ['focus', 'reconnect', 'stale-response'] as const) {
  (chromeExecutablePath ? it : it.skip)(`viewer reconciles processing status: ${scenario}`, async () => {
    let finish!: (result: any) => void;
    const result = new Promise<any>(resolve => { finish = resolve; });
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {useSSE} from './src/ui/viewer/hooks/useSSE';
      let stream, release, requested=false, settled=false, reads=0;
      window.EventSource=class { constructor(){stream=this;} close(){} };
      const originalFetch=window.fetch.bind(window);
      window.fetch=async (url,options)=>{
        if(url!='/api/processing-status')return originalFetch(url,options);
        reads++;requested=true;
        if(${JSON.stringify(scenario)}==='stale-response'){
          await new Promise(resolve=>{release=resolve});settled=true;
          return new Response(JSON.stringify({isProcessing:true,queueDepth:399}));
        }
        return new Response(JSON.stringify({isProcessing:false,queueDepth:0}));
      };
      function Fixture(){
        const status=useSSE({onItemDeleted(){},onSessionDeleted(){},onLiveItem(){}});
        return <output id="status">{JSON.stringify({processing:status.isProcessing,depth:status.queueDepth})}</output>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
      const wait=async predicate=>{const end=Date.now()+10000;while(!predicate()){
        if(Date.now()>end)throw Error('Status fixture timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
      const current=()=>JSON.parse(document.getElementById('status').textContent);
      const emit=depth=>stream.onmessage({data:JSON.stringify({type:'processing_status',isProcessing:depth>0,queueDepth:depth})});
      async function run(){
        await wait(()=>stream?.onmessage && requested);
        if(${JSON.stringify(scenario)}==='stale-response'){
          emit(0);release();await wait(()=>settled);
          await new Promise(resolve=>setTimeout(resolve,50));
        }else{
          await wait(()=>current().depth===0);
          emit(399);await wait(()=>current().depth===399);
          if(${JSON.stringify(scenario)}==='focus')window.dispatchEvent(new Event('focus'));
          else stream.onopen();
          await wait(()=>reads>1 && current().depth===0);
        }
        await originalFetch('/result',{method:'POST',body:JSON.stringify({status:current(),reads})});
      }
      run().catch(error=>originalFetch('/result',{method:'POST',body:JSON.stringify({error:String(error)})}));
    `);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture.js') return scriptResponse(bundle);
      if (path === '/result') { finish(await request.json()); return new Response('ok'); }
      return htmlResponse(FIXTURE_PAGE_HTML);
    } });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-processing-status-' });
      const actual = await withTimeout(result, 30000, 'Processing-status browser did not finish');
      expect(actual.error).toBeUndefined();
      expect(actual.status).toEqual({ processing: false, depth: 0 });
      if (scenario !== 'stale-response') expect(actual.reads).toBeGreaterThan(1);
    } finally {
      await chrome?.close();
      server.stop(true);
    }
  }, 75000);
}

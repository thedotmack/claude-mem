import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';
failOnCiWithoutChrome('CI requires Chrome for native viewer regressions.');
(chromeExecutablePath ? it : it.skip)('keeps unrelated live sessions out of a project-filtered catalog', async () => {
  const bundle = compileBrowserFixture(`import React from 'react'; import {createRoot} from 'react-dom/client';
      import {useSessionCatalog} from './src/ui/viewer/hooks/useSessionCatalog';
      let catalog; function Fixture(){ catalog=useSessionCatalog(); return <div>{catalog.sessions.map(s=>s.project+':'+s.content_session_id).join(',')}</div>; }
      createRoot(document.getElementById('root')).render(<Fixture/>);
      async function settle(){for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);}
      (async()=>{try{await settle(); await catalog.refresh('alpha'); await settle();
        catalog.touch({session:{platformSource:'claude',contentSessionId:'foreign'}, project:'beta',createdAtEpoch:1});
        catalog.touch({session:{platformSource:'claude',contentSessionId:'local'}, project:'alpha',createdAtEpoch:2});
        await settle();
        catalog.touch({session:{platformSource:'claude',contentSessionId:'local'}, project:'beta',createdAtEpoch:3});
        await settle(); const filtered=catalog.sessions.map(s=>s.project); const itemCount=catalog.sessions[0].item_count;
        await catalog.refresh(''); await settle();
        catalog.touch({session:{platformSource:'claude',contentSessionId:'all-projects'},project:'beta',createdAtEpoch:3});
        await settle(); await fetch('/result',{method:'POST',body:JSON.stringify({filtered,itemCount,all:catalog.sessions.map(s=>s.project)})});
      }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();`);
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/result') { report(await request.json()); return new Response('ok'); }
    return Response.json({sessions:[],hasMore:false});
  }});
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'cm-catalog-project-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 45000, 'Browser timed out')).toEqual({filtered:['alpha'],itemCount:2,all:['beta']});
  } finally { await chrome?.close(); server.stop(true); }
},80000);

import { expect, it } from 'bun:test';
import { chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, FIXTURE_PAGE_HTML, htmlResponse,
  launchChrome, scriptResponse, withTimeout, type OwnedChrome } from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for retained session catalog refresh.');

for (const tied of [false, true]) {
  (chromeExecutablePath ? it : it.skip)(`retains loaded catalog history through remote changes (tied timestamps=${tied})`, async () => {
    const bundle=compileBrowserFixture(`
      import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{useSessionCatalog}from'./src/ui/viewer/hooks/useSessionCatalog';
      function Probe(){const catalog=useSessionCatalog();useEffect(()=>{window.catalog=catalog;},[catalog]);return <div>{catalog.sessions.map(s=><p key={s.content_session_id}>{s.custom_title}</p>)}</div>;}
      createRoot(document.getElementById('root')).render(<Probe/>);
      async function until(check,label){const end=Date.now()+6000;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,10));}}
      (async()=>{try{await fetch('/ready');await until(()=>window.catalog,'mount');await window.catalog.refresh('A');await until(()=>window.catalog.sessions.length===100,'first');
        await window.catalog.loadMore();await until(()=>window.catalog.sessions.length===200,'second');await fetch('/mutate',{method:'POST'});
        await window.catalog.refreshLoaded('A');await until(()=>!window.catalog.isLoading,'refresh');
        const retained=window.catalog.sessions.map(s=>s.content_session_id);const renamed=window.catalog.sessions.find(s=>s.content_session_id==='s50').custom_title;
        await window.catalog.loadMore();await until(()=>!window.catalog.isLoading,'older');const all=window.catalog.sessions.map(s=>s.content_session_id);
        await fetch('/fail',{method:'POST'});await window.catalog.refreshLoaded('A');await until(()=>!!window.catalog.loadError,'failed');const afterFailure=window.catalog.sessions.map(s=>s.content_session_id);
        await fetch('/recover',{method:'POST'});await window.catalog.refresh('A');await until(()=>!window.catalog.isLoading&&!window.catalog.loadError,'latest');
        await fetch('/result',{method:'POST',body:JSON.stringify({retained,renamed,all,afterFailure,latestCount:window.catalog.sessions.length})});
      }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();
    `);
    let rows=Array.from({length:300},(_,index)=>({content_session_id:`s${index+1}`,platform_source:'claude',project:'A',custom_title:`TITLE_${index+1}`,started_at_epoch:tied?10_000:10_000-index,item_count:1}));
    let fail=false;
    let readyResolve!:()=>void;const ready=new Promise<void>(r=>{readyResolve=r;});
    let report!:(value:any)=>void;const result=new Promise<any>(r=>{report=r;});
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url);
      if(url.pathname==='/')return htmlResponse(FIXTURE_PAGE_HTML);if(url.pathname==='/fixture.js')return scriptResponse(bundle);
      if(url.pathname==='/ready'){readyResolve();return new Response('ready');}
      if(url.pathname==='/mutate'){rows=[...Array.from({length:3},(_,i)=>({content_session_id:`new${i}`,platform_source:'claude',project:'A',custom_title:`NEW_${i}`,started_at_epoch:20_000-i,item_count:1})),...rows.filter(r=>r.content_session_id!=='s200').map(r=>r.content_session_id==='s50'?{...r,custom_title:'UPDATED_TITLE'}:r)];return new Response('changed');}
      if(url.pathname==='/fail'){fail=true;return new Response('failed');}if(url.pathname==='/recover'){fail=false;return new Response('recovered');}
      if(url.pathname==='/api/sessions'){const offset=Number(url.searchParams.get('offset'));if(fail&&offset===100)return new Response('unavailable',{status:503});return Response.json({sessions:rows.slice(offset,offset+100),hasMore:rows.length>offset+100});}
      if(url.pathname==='/result'){report(await request.json());return new Response('received');}return Response.json({});
    }});
    let chrome:OwnedChrome|undefined;
    try{chrome=launchChrome(server.url.href,{profilePrefix:'claude-mem-catalog-retention-'});await withTimeout(ready,30000,'Browser startup');const value=await withTimeout(result,15000,'Catalog refresh');
      expect(value.failure).toBeUndefined();expect(value.renamed).toBe('UPDATED_TITLE');
      expect(value.retained).toHaveLength(tied?302:202);expect(value.retained).toContain('s199');expect(value.retained).not.toContain('s200');
      expect(value.all).toContain('s201');expect(new Set(value.all).size).toBe(value.all.length);expect(value.afterFailure).toEqual(value.all);expect(value.latestCount).toBe(100);
    }finally{await chrome?.close();server.stop(true);}
  });
}

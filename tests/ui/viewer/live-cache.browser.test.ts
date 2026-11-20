import { expect, it } from 'bun:test';
import { chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, FIXTURE_PAGE_HTML, htmlResponse,
  launchChrome, scriptResponse, withTimeout, type OwnedChrome } from '../../helpers/chrome-devtools';
import { LIVE_ITEMS_PER_KIND } from '../../../src/ui/viewer/utils/live-cache';

failOnCiWithoutChrome('CI requires Chrome for live-cache ownership.');

(chromeExecutablePath ? it : it.skip)('bounds actual SSE caches and preserves newer live rows during authoritative replacement', async () => {
  const bundle = compileBrowserFixture(`
    import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{useSSE}from'./src/ui/viewer/hooks/useSSE';
    const root=createRoot(document.getElementById('root'));
    function Probe(){const live=useSSE({onItemDeleted(){},onSessionDeleted(){},onLiveItem(){}});
      useEffect(()=>{window.capture=live.captureLiveVersion;window.clear=version=>live.clearLiveThrough('observation',version);},[live]);
      return <pre>{JSON.stringify(live.observations.map(row=>({id:row.id,title:row.title})))}</pre>;
    }root.render(<Probe/>);
    const rows=()=>JSON.parse(document.querySelector('pre').textContent);
    async function until(predicate){const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('cache timeout');await new Promise(r=>setTimeout(r,10));}}
    (async()=>{try{await fetch('/ready');await fetch('/burst');await until(()=>rows()[0]?.id===500);
      const bounded=rows().length;const version=window.capture();await fetch('/next');await until(()=>rows()[0]?.id===501);
      window.clear(version);await until(()=>rows().length===1);await fetch('/update');await until(()=>rows()[0]?.title==='updated');
      const result={bounded,kept:rows()};root.unmount();await fetch('/result',{method:'POST',body:JSON.stringify(result)});
    }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();
  `);
  let stream:ReadableStreamDefaultController<Uint8Array>|null=null;
  let readyResolve!:()=>void;const ready=new Promise<void>(r=>{readyResolve=r;});
  let streamResolve!:()=>void;const streamReady=new Promise<void>(r=>{streamResolve=r;});
  let report!:(value:any)=>void;const result=new Promise<any>(r=>{report=r;});
  const send=(id:number,title=String(id))=>stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:'new_observation',observation:{id,title,project:'A',created_at_epoch:id}})}\n\n`));
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url);
    if(url.pathname==='/')return htmlResponse(FIXTURE_PAGE_HTML);
    if(url.pathname==='/fixture.js')return scriptResponse(bundle);
    if(url.pathname==='/ready'){readyResolve();return new Response('ready');}
    if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){stream=c;streamResolve();c.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["A"]}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}});
    if(url.pathname==='/burst'){await streamReady;for(let id=1;id<=500;id++)send(id);return new Response('sent');}
    if(url.pathname==='/next'){send(501);return new Response('sent');}
    if(url.pathname==='/update'){send(501,'updated');return new Response('sent');}
    if(url.pathname==='/result'){report(await request.json());return new Response('received');}
    return Response.json({});
  }});
  let chrome:OwnedChrome|undefined;
  try{chrome=launchChrome(server.url.href,{profilePrefix:'claude-mem-live-cache-'});await withTimeout(ready,30000,'Browser startup');
    expect(await withTimeout(result,15000,'Live cache')).toEqual({bounded:LIVE_ITEMS_PER_KIND,kept:[{id:501,title:'updated'}]});
  }finally{await chrome?.close();server.stop(true);}
});

import { expect, it } from 'bun:test';
import { chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, withTimeout, type OwnedChrome } from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for stale remote refresh ownership.');

(chromeExecutablePath ? it : it.skip)('a held remote refresh cannot restore the previous project or its error', async () => {
  const bundle=compileBrowserFixture(`
    import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./src/ui/viewer/App';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    let aLoaded=0;const original=window.fetch.bind(window);
    window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/observations?')&&String(args[0]).includes('project=A')){const json=response.json.bind(response);response.json=async()=>{const data=await json();aLoaded++;return data;};}return response;};
    createRoot(document.getElementById('root')).render(<App/>);
    const has=text=>document.body.textContent.includes(text);
    async function until(check,label){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,10));}}
    function project(value){const select=document.querySelector('select[aria-label="Filter memories by project"]');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));}
    (async()=>{try{
      await original('/ready');await until(()=>has('A_1_END'),'initial');project('A');await until(()=>aLoaded>0&&!has('Loading more...'),'A baseline');
      await original('/begin',{method:'POST'});await original('/held');project('B');
      await until(()=>has('B_1_END')&&!has('A_1_END')&&!has('Loading more...'),'B baseline');
      await original('/release',{method:'POST'});await new Promise(r=>setTimeout(r,100));
      await original('/result',{method:'POST',body:JSON.stringify({b:has('B_1_END'),a:has('A_1_END'),error:!!document.querySelector('[role="alert"]'),loading:has('Loading more...')})});
    }catch(error){await original('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();
  `);
  let stream:ReadableStreamDefaultController<Uint8Array>|null=null;
  let readyResolve!:()=>void;const ready=new Promise<void>(r=>{readyResolve=r;});
  let heldResolve!:()=>void;const held=new Promise<void>(r=>{heldResolve=r;});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  let report!:(value:any)=>void;const result=new Promise<any>(r=>{report=r;});
  let hold=false;let aborted=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/')return htmlResponse(readViewerTemplateHtml());
    if(url.pathname==='/viewer-bundle.js')return scriptResponse(bundle);
    if(url.pathname==='/ready'){readyResolve();return new Response('ready');}
    if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){stream=c;c.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["A","B"]}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}});
    if(url.pathname==='/begin'){hold=true;stream?.enqueue(new TextEncoder().encode('data: {"type":"data_changed","kinds":["observation"]}\n\n'));return new Response('started');}
    if(url.pathname==='/held'){await held;return new Response('held');}
    if(url.pathname==='/release'){release();return new Response('released');}
    if(url.pathname==='/api/observations'){
      const project=url.searchParams.get('project')||'A';
      if(hold&&project==='A'){heldResolve();request.signal.addEventListener('abort',()=>{aborted=true;},{once:true});await gate;return new Response('invalid old JSON',{headers:{'Content-Type':'application/json'}});}
      return Response.json({items:[{id:project==='A'?1:2,title:project+'_1_END',project,platform_source:'claude',content_session_id:project,created_at_epoch:10000,created_at:new Date(10000).toISOString(),type:'discovery',narrative:'',facts:'[]',concepts:'[]',files_read:'[]',files_modified:'[]'}],hasMore:false});
    }
    if(url.pathname==='/api/summaries'||url.pathname==='/api/prompts')return Response.json({items:[],hasMore:false});
    if(url.pathname==='/api/projects')return Response.json({projects:['A','B']});
    if(url.pathname==='/api/sessions')return Response.json({sessions:[],hasMore:false});
    if(url.pathname==='/result'){report(await request.json());return new Response('received');}
    return Response.json({});
  }});
  let chrome:OwnedChrome|undefined;
  try{
    chrome=launchChrome(server.url.href,{profilePrefix:'claude-mem-resync-selection-'});
    await withTimeout(ready,30000,'Browser startup');
    expect(await withTimeout(result,25000,'Selection fixture')).toEqual({b:true,a:false,error:false,loading:false});
    expect(aborted).toBe(true);
  }finally{release();await chrome?.close();server.stop(true);}
});

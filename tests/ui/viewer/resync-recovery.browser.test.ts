import { expect, it } from 'bun:test';
import { chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, withTimeout, type OwnedChrome } from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for bounded resync recovery.');

(chromeExecutablePath ? it : it.skip)('retains shown history after bounded refresh failure and offers a usable latest reset', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {App} from './src/ui/viewer/App';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    createRoot(document.getElementById('root')).render(<App/>);
    const has = text => document.body.textContent.includes(text);
    async function until(predicate,label) { const end=Date.now()+15000; while(!predicate()) {if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,10));} }
    (async()=>{try {
      await fetch('/ready'); await until(()=>has('OLD_1_END'),'initial');
      await fetch('/burst',{method:'POST'});
      await until(()=>has('Refresh latest memories') && !!document.querySelector('[role="alert"]'),'bounded failure');
      const keptOld = has('OLD_1_END');
      [...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh latest memories').click();
      await until(()=>has('NEW_1200_END') && has('Showing the newest memories.') && !document.querySelector('[role="alert"]'),'reset');
      const resetWorked = !has('OLD_1_END');
      document.querySelector('.feed-content').lastElementChild.scrollIntoView({block:'end'});
      await until(()=>has('NEW_1150_END'),'older after reset');
      await fetch('/result',{method:'POST',body:JSON.stringify({keptOld,resetWorked,older:true})});
    }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();
  `);
  const makeRow=(id:number,title:string,at:number)=>({id,title,project:'A',platform_source:'claude',content_session_id:'s',created_at_epoch:at,created_at:new Date(at).toISOString(),type:'discovery',facts:'[]',concepts:'[]',files_read:'[]',files_modified:'[]',narrative:''});
  const old = Array.from({length:150},(_,i)=>makeRow(i+1,`OLD_${i+1}_END`,1000-i));
  let rows=old;
  let stream: ReadableStreamDefaultController<Uint8Array> | null=null;
  let markReady!:()=>void; const ready=new Promise<void>(r=>{markReady=r;});
  let report!:(value:any)=>void; const result=new Promise<any>(r=>{report=r;});
  let refreshReads=0; let bursting=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/')return htmlResponse(readViewerTemplateHtml());
    if(url.pathname==='/viewer-bundle.js')return scriptResponse(bundle);
    if(url.pathname==='/ready'){markReady();return new Response('ready');}
    if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){stream=c;c.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["A"]}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}});
    if(url.pathname==='/burst'){
      bursting=true;rows=[...Array.from({length:1200},(_,i)=>makeRow(10_000+1200-i,`NEW_${1200-i}_END`,10_000+1200-i)),...old];
      stream?.enqueue(new TextEncoder().encode('data: {"type":"data_changed","kinds":["observation"]}\n\n'));
      return new Response('burst');
    }
    if(url.pathname==='/api/observations'){
      if(bursting)refreshReads++;
      const offset=Number(url.searchParams.get('offset')); const limit=Number(url.searchParams.get('limit'));
      return Response.json({items:rows.slice(offset,offset+limit),hasMore:rows.length>offset+limit});
    }
    if(url.pathname==='/api/summaries'||url.pathname==='/api/prompts')return Response.json({items:[],hasMore:false});
    if(url.pathname==='/api/projects')return Response.json({projects:['A']});
    if(url.pathname==='/api/sessions')return Response.json({sessions:[],hasMore:false});
    if(url.pathname==='/result'){report(await request.json());return new Response('received');}
    return Response.json({});
  }});
  let chrome:OwnedChrome|undefined;
  try{
    chrome=launchChrome(server.url.href,{profilePrefix:'claude-mem-bounded-resync-',extraFlags:['--window-size=900,700']});
    await withTimeout(ready,30000,'Browser startup');
    expect(await withTimeout(result,25000,'Browser recovery')).toEqual({keptOld:true,resetWorked:true,older:true});
    expect(refreshReads).toBeLessThanOrEqual(25);
  }finally{await chrome?.close();server.stop(true);}
});

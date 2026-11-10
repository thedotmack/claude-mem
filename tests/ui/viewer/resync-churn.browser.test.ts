import { expect, it } from 'bun:test';
import { chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, withTimeout, type OwnedChrome } from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for shared recovery ownership.');

(chromeExecutablePath ? it : it.skip)('recovers cancelled initial siblings and bounds repeated in-flight invalidation', async () => {
  const bundle=compileBrowserFixture(`
    import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./src/ui/viewer/App';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);createRoot(document.getElementById('root')).render(<App/>);
    const has=text=>document.body.textContent.includes(text);
    async function until(check,label){const end=Date.now()+12000;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,10));}}
    (async()=>{try{
      await fetch('/ready');await until(()=>has('BASE_END'),'initial observation');
      await fetch('/single-change',{method:'POST'});
      await until(()=>has('NEW_SUMMARY_END')&&has('NEW_PROMPT_END')&&!has('Loading more...'),'cancelled sibling recovery');
      const siblings=!has('OLD_SUMMARY_END')&&!has('OLD_PROMPT_END');
      await fetch('/churn',{method:'POST'});
      await until(()=>has('Memories are changing faster')&&has('Refresh latest memories'),'bounded churn');
      const retained=has('STABLE_END');
      await new Promise(r=>setTimeout(r,900));
      const stats=await (await fetch('/stop',{method:'POST'})).json();
      [...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh latest memories').click();
      await until(()=>has('LATEST_END')&&!document.querySelector('[role="alert"]'),'manual recovery');
      await fetch('/result',{method:'POST',body:JSON.stringify({siblings,retained,requests:stats.requests,recovered:true})});
    }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();
  `);
  let stream:ReadableStreamDefaultController<Uint8Array>|null=null;
  let firstSummary=true,firstPrompt=true,singleChanged=false,churning=false,afterChurn=false;
  let releaseInitial!:()=>void;const initialGate=new Promise<void>(r=>{releaseInitial=r;});
  let timer:ReturnType<typeof setInterval>|undefined;let requests=0;
  let readyResolve!:()=>void;const ready=new Promise<void>(r=>{readyResolve=r;});
  let report!:(value:any)=>void;const result=new Promise<any>(r=>{report=r;});
  const common={id:1,project:'A',content_session_id:'s',platform_source:'claude',created_at_epoch:10000,created_at:new Date(10000).toISOString()};
  const invalidation=()=>stream?.enqueue(new TextEncoder().encode('data: {"type":"data_changed","kinds":["observation"]}\n\n'));
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url);
    if(url.pathname==='/')return htmlResponse(readViewerTemplateHtml());
    if(url.pathname==='/viewer-bundle.js')return scriptResponse(bundle);
    if(url.pathname==='/ready'){readyResolve();return new Response('ready');}
    if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){stream=c;c.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["A"]}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}});
    if(url.pathname==='/single-change'){singleChanged=true;invalidation();return new Response('changed');}
    if(url.pathname==='/churn'){churning=true;invalidation();timer=setInterval(invalidation,400);return new Response('started');}
    if(url.pathname==='/stop'){if(timer)clearInterval(timer);churning=false;afterChurn=true;releaseInitial();return Response.json({requests});}
    if(url.pathname==='/api/observations'){
      if(churning){requests++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(' '));}}),{headers:{'Content-Type':'application/json'}});}
      return Response.json({items:[{...common,title:afterChurn?'LATEST_END':singleChanged?'STABLE_END':'BASE_END',type:'discovery',narrative:'',facts:'[]',concepts:'[]',files_read:'[]',files_modified:'[]'}],hasMore:false});
    }
    if(url.pathname==='/api/summaries'||url.pathname==='/api/prompts'){
      const summary=url.pathname==='/api/summaries';
      const first=summary?firstSummary:firstPrompt;
      if(summary)firstSummary=false;else firstPrompt=false;
      if(first)return new Response(new ReadableStream({async start(c){c.enqueue(new TextEncoder().encode(' '));await initialGate;try{c.enqueue(new TextEncoder().encode(JSON.stringify({items:[summary?{...common,request:'OLD_SUMMARY_END'}:{...common,prompt_text:'OLD_PROMPT_END'}],hasMore:false})));c.close();}catch{}}}),{headers:{'Content-Type':'application/json'}});
      return Response.json({items:[summary?{...common,request:'NEW_SUMMARY_END',learned:'',investigated:null,completed:null,next_steps:null}:{...common,prompt_text:'NEW_PROMPT_END',prompt_number:1}],hasMore:false});
    }
    if(url.pathname==='/api/projects')return Response.json({projects:['A']});
    if(url.pathname==='/api/sessions')return Response.json({sessions:[],hasMore:false});
    if(url.pathname==='/result'){report(await request.json());return new Response('received');}
    return Response.json({});
  }});
  let chrome:OwnedChrome|undefined;
  try{
    chrome=launchChrome(server.url.href,{profilePrefix:'claude-mem-resync-churn-'});await withTimeout(ready,30000,'Browser startup');
    const value=await withTimeout(result,25000,'Recovery fixture');
    expect(value).toEqual({siblings:true,retained:true,requests:3,recovered:true});
  }finally{if(timer)clearInterval(timer);releaseInitial();await chrome?.close();server.stop(true);}
},60000);

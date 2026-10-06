import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const chrome=Bun.which('google-chrome')??Bun.which('chromium')??(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':null);
if(process.env.CI&&!chrome)throw Error('CI requires Chrome for catalog chunk tests');
for(const scenario of ['control','delete-between-chunks','repeated-deletes'] as const){
  (chrome?it:it.skip)(`catalog prefix remains coherent across chunks: ${scenario}`,async()=>{
    const owned=mkdtempSync(join(tmpdir(),'cm-catalog-chunks-'));
    let child:ReturnType<typeof Bun.spawn>|undefined,server:ReturnType<typeof Bun.serve>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    let report!:(data:unknown)=>void;const result=new Promise(resolve=>{report=resolve});
    let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
    let removed=new Set<number>(),refreshing=false,interventions=0;
    const queries:{offset:number,limit:number}[]=[];
    try{
      const bundle=await build({write:false,bundle:true,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'},stdin:{resolveDir:resolve(import.meta.dir,'../../..'),loader:'tsx',contents:`
        import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{useSessionCatalog}from'./src/ui/viewer/hooks/useSessionCatalog';
        function Fixture(){const catalog=useSessionCatalog();useEffect(()=>{catalog.refresh('alpha');const source=new EventSource('/stream');source.onmessage=event=>{const data=JSON.parse(event.data);catalog.remove(data)};return()=>source.close()},[]);
          return <><button id="next" disabled={catalog.isLoading} onClick={()=>catalog.loadMore()}>Next</button><button id="refresh" onClick={()=>{window.finishedRefresh=catalog.refreshLoaded('alpha')}}>Refresh</button><output id="loading">{String(catalog.isLoading)}</output><output id="error">{catalog.loadError}</output><output id="count">{catalog.sessions.length}</output><output id="boundary">{String(catalog.sessions.some(x=>x.content_session_id==='session-1000'))}</output></>}
        createRoot(document.getElementById('root')).render(<Fixture/>);
        async function until(test){const end=Date.now()+12000;while(!test()){if(Date.now()>end)throw Error('Browser state timeout');await new Promise(r=>setTimeout(r,10))}}
        (async()=>{try{
          await until(()=>document.getElementById('count')?.textContent==='100');
          for(let target=200;target<=1100;target+=100){await until(()=>!document.getElementById('next').disabled);document.getElementById('next').click();await until(()=>Number(document.getElementById('count').textContent)>=target)}
          await fetch('/begin-refresh');document.getElementById('refresh').click();await window.finishedRefresh;
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          await fetch('/result',{method:'POST',body:JSON.stringify({boundary:document.getElementById('boundary').textContent==='true',count:Number(document.getElementById('count').textContent),error:document.getElementById('error').textContent})});
        }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})})}})();
      `}});
      server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url);
        if(url.pathname==='/')return new Response('<div id="root"></div><script src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
        if(url.pathname==='/fixture.js'){clearTimeout(timer);timer=setTimeout(()=>report({failure:'Page timeout'}),35000);return new Response(bundle.outputFiles[0].text,{headers:{'Content-Type':'application/javascript'}})}
        if(url.pathname==='/stream')return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(': ready\n\n'))}}),{headers:{'Content-Type':'text/event-stream'}});
        if(url.pathname==='/begin-refresh'){refreshing=true;return new Response('ready')}
        if(url.pathname==='/api/sessions'){
          const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));queries.push({offset,limit});
          if(refreshing&&offset>0&&scenario!=='control'&&(scenario==='repeated-deletes'||interventions===0)){
            const index=50+interventions++;removed.add(index);controller!.enqueue(new TextEncoder().encode('data: '+JSON.stringify({platformSource:'claude',contentSessionId:'session-'+index})+'\n\n'));await Bun.sleep(40);
          }
          const rows=Array.from({length:1100},(_,i)=>({content_session_id:'session-'+i,platform_source:'claude',project:'alpha',custom_title:'Session'+i,item_count:1,started_at_epoch:1100-i})).filter((_,i)=>!removed.has(i));
          return Response.json({sessions:rows.slice(offset,offset+Math.min(1000,limit)),hasMore:offset+limit<rows.length});
        }
        if(url.pathname==='/result'){report(await request.json());return new Response('received')}
        return new Response('missing',{status:404});
      }});
      timer=setTimeout(()=>report({failure:'Chrome startup timeout'}),30000);
      child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${join(owned,'browser')}`,server.url.href],{stdout:'ignore',stderr:'ignore'});
      const received=await result;
      if(scenario==='repeated-deletes')expect(received).toEqual({boundary:true,count:1097,error:'Could not load sessions: Session catalog changed repeatedly. Retry the refresh.'});
      else expect(received).toEqual({boundary:true,count:scenario==='control'?1100:1099,error:''});
      expect(queries.every(q=>q.limit<=1000)).toBe(true);expect(interventions).toBe(scenario==='control'?0:scenario==='repeated-deletes'?3:1);
    }finally{clearTimeout(timer);if(child){child.kill();await child.exited}server?.stop(true);rmSync(owned,{recursive:true,force:true})}
  },80000);
}

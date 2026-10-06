import { expect, it } from 'bun:test';
import { confirmSessionExists, confirmSessionRowIds } from '../../../src/ui/viewer/utils/sessions';

it('confirms session existence beyond the loaded prefix without a project filter',async()=>{
  const queries:URLSearchParams[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    const params=new URL(request.url).searchParams;queries.push(params);
    const offset=Number(params.get('offset'));
    return Response.json(offset===0?{
      sessions:Array.from({length:1000},(_,i)=>({content_session_id:'control-'+i,platform_source:'claude'})),hasMore:true
    }:{sessions:[{content_session_id:'target',platform_source:'claude'}],hasMore:false});
  }});
  try{
    // A real HTTP consumer forwards relative API requests to this owned server.
    const consumer:typeof fetch=(input,init)=>fetch(new URL(String(input),server.url),init);
    expect(await confirmSessionExists({platformSource:'claude',contentSessionId:'target'},consumer)).toBe(true);
    expect(await confirmSessionExists({platformSource:'claude',contentSessionId:'absent'},consumer)).toBe(false);
    expect(queries.map(params=>Number(params.get('offset')))).toEqual([0,1000,0,1000]);
    expect(queries.every(params=>params.get('limit')==='1000'&&params.get('platformSource')==='claude'&&!params.has('project'))).toBe(true);
  }finally{server.stop(true);}
});

it('confirms captured row IDs against fresh scoped pages, including summaries and prompts',async()=>{
  const requests:string[]=[];
  const ref={platformSource:'claude',contentSessionId:'target'};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    const url=new URL(request.url);requests.push(url.pathname+url.search);
    const offset=Number(url.searchParams.get('offset'));
    if(url.pathname==='/api/observations')return Response.json(offset===0?{
      items:Array.from({length:1000},(_,i)=>({id:i+10,content_session_id:'target',platform_source:'claude'})),hasMore:true
    }:{items:[{id:2,content_session_id:'target',platform_source:'claude'}],hasMore:false});
    if(url.pathname==='/api/summaries')return Response.json({items:[{id:3,session_id:'target',platform_source:'claude'},{id:4,session_id:'other',platform_source:'claude'}],hasMore:false});
    return Response.json({items:[{id:5,content_session_id:'target',platform_source:'other'},{id:6,content_session_id:'target',platform_source:'claude'}],hasMore:false});
  }});
  try{
    const consumer:typeof fetch=(input,init)=>fetch(new URL(String(input),server.url),init);
    const confirmed=await confirmSessionRowIds(ref,{observation:new Set([1,2]),summary:new Set([3,4]),prompt:new Set([5,6])},consumer);
    expect([...confirmed.observation]).toEqual([2]);expect([...confirmed.summary]).toEqual([3]);expect([...confirmed.prompt]).toEqual([6]);
    expect(requests.length).toBe(4);
    expect(requests.every(path=>{const params=new URL(path,server.url).searchParams;return params.get('platformSource')==='claude'&&params.get('contentSessionId')==='target'&&params.get('limit')==='1000'&&!params.has('project')})).toBe(true);
    requests.length=0;
    expect(await confirmSessionRowIds(ref,{observation:new Set(),summary:new Set(),prompt:new Set()},consumer)).toEqual({observation:new Set(),summary:new Set(),prompt:new Set()});
    expect(requests.length).toBe(0);
  }finally{server.stop(true);}
});

for(const result of ['http-error','invalid-items','empty-continuation'] as const){
  it(`refuses unconfirmed row state: ${result}`,async()=>{
    const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){
      if(result==='http-error')return new Response('unavailable',{status:503});
      return Response.json(result==='invalid-items'?{items:null}:{items:[],hasMore:true});
    }});
    try{
      const consumer:typeof fetch=(input,init)=>fetch(new URL(String(input),server.url),init);
      await expect(confirmSessionRowIds({platformSource:'claude',contentSessionId:'target'},{observation:new Set([1]),summary:new Set(),prompt:new Set()},consumer)).rejects.toThrow('Could not confirm');
    }finally{server.stop(true);}
  });
}

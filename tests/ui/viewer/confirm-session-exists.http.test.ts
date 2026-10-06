import { expect, it } from 'bun:test';
import { confirmSessionExists } from '../../../src/ui/viewer/utils/sessions';

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

import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';
failOnCiWithoutChrome('CI requires Chrome or Chromium for viewer regressions.');
(chromeExecutablePath ? it : it.skip)('retains valid facts, concepts and files from mixed and plain-text stored metadata', async () => {
  const bundle = compileBrowserFixture(`import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ObservationCard} from './src/ui/viewer/components/ObservationCard';
      const mixed = value => JSON.stringify([null,4,{invalid:true},value]);
      // The second card stores CJK facts and concepts as plain text, not JSON (#3423).
      createRoot(document.getElementById('root')).render(<><ObservationCard observation={{id:1,project:'owned',type:'discovery',title:'OWNED CARD',created_at_epoch:1,
        facts:mixed('VALID FACT'),concepts:mixed('VALID CONCEPT'),files_read:mixed('/owned/src/read.ts'),files_modified:mixed('/owned/src/changed.ts')}} onDeleted={()=>{}}/>
        <ObservationCard observation={{id:2,project:'owned',type:'discovery',title:'CJK CARD',created_at_epoch:2,
        facts:'用户身份定位',concepts:'记忆检索',files_read:'[]',files_modified:'[]'}} onDeleted={()=>{}}/></>);
      (async()=>{try {
        const deadline=Date.now()+6000;
        let buttons=[];
        while((buttons=[...document.querySelectorAll('button')].filter(b=>b.textContent==='facts')).length<2){if(Date.now()>deadline) throw new Error('Facts controls absent: found '+buttons.length+' of 2');await new Promise(r=>setTimeout(r,10));}
        for(const button of buttons) button.click();
        for(let i=0;i<4;i++) await new Promise(requestAnimationFrame);
        await fetch('/result',{method:'POST',body:JSON.stringify({facts:[...document.querySelectorAll('.facts-list li')].map(n=>n.textContent),text:document.body.textContent})});
      }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({failure:String(error)})});}})();`);
  let report!: (value:any)=>void;
  const result = new Promise<any>(resolve=>{report=resolve;});
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/') return htmlResponse(FIXTURE_PAGE_HTML);
    if(path==='/fixture.js') return scriptResponse(bundle);
    if(path==='/result'){report(await request.json());return new Response('received');}
    return new Response('',{status:404});
  }});
  let chrome: OwnedChrome | undefined;
  try {
    chrome=launchChrome(server.url.href,{profilePrefix:'cm-metadata-browser-',extraFlags:UNTHROTTLED_TIMER_FLAGS});
    const observed=await withTimeout(result,30000,'Owned browser timed out');
    expect(observed.failure).toBeUndefined();
    expect(observed.facts).toEqual(['VALID FACT', '用户身份定位']);
    expect(observed.text).toContain('VALID CONCEPT');
    expect(observed.text).toContain('记忆检索');
    expect(observed.text).toContain('src/read.ts');
    expect(observed.text).toContain('src/changed.ts');
    expect(observed.text).not.toContain('[object Object]');
  } finally {
    await chrome?.close();server.stop(true);
  }
},80000);

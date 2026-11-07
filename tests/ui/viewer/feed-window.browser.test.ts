import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome,
  htmlResponse, launchChrome, readViewerTemplateStyles, scriptResponse, UNTHROTTLED_TIMER_FLAGS,
  withTimeout, type OwnedChrome, type DevToolsPage,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for long memory-feed scrolling.');

(chromeExecutablePath ? it : it.skip)('windows loaded history while preserving scroll, disclosure state and keyboard focus', async () => {
  const script = compileBrowserFixture(`
    import React, {useState,useLayoutEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {Feed} from './src/ui/viewer/components/Feed';
    const observation = id => ({itemType:'observation', id, project:'fixture', platform_source:'claude', type:'discovery',
      title:'Observation '+id, subtitle:'Short summary', narrative:'Expanded narrative '.repeat(600),
      facts:'["First fact","Second fact"]', concepts:'[]', files_read:'[]', files_modified:'[]', created_at_epoch:1793800000000-id});
    const initial = Array.from({length:5000},(_,i)=>observation(i+1));
    initial[1]={itemType:'prompt',id:2,project:'fixture',platform_source:'claude',prompt_text:'Long user prompt '.repeat(150),created_at_epoch:1793800000000};
    function App(){
      const [items,setItems]=useState(initial);
      useLayoutEffect(()=>{void fetch('/ready');},[]);
      window.prepend=()=>setItems(old=>[observation(6001),observation(6002),observation(6003),...old]);
      window.remove=id=>setItems(old=>old.filter(item=>item.id!==id));
      window.small=()=>setItems(initial.slice(0,20));
      window.repaint=()=>flushSync(()=>setItems(old=>[...old]));
      return <Feed items={items} header={<button id="outside">Header action</button>} onLoadMore={()=>{}} onDeleted={()=>{}} isLoading={false} hasMore={true}/>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  const styles = readViewerTemplateStyles();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture.js') return scriptResponse(script);
    if (path === '/ready') { markReady(); return new Response('ok'); }
    return htmlResponse(`<style>${styles}</style><div id="root"></div><script src="/fixture.js"></script>`);
  }});
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-feed-window-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Windowed feed browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.settle();
    expect(await page.evaluate(`({windowed:document.querySelector('[data-windowed]').dataset.windowed,cards:document.querySelectorAll('.card').length,total:document.querySelector('[aria-setsize]').getAttribute('aria-setsize'),header:!!document.querySelector('#outside')})`))
      .toEqual({ windowed: 'true', cards: expect.any(Number), total: '5000', header: true });
    expect(await page.evaluate(`document.querySelectorAll('.card').length`)).toBeLessThan(30);

    await page.evaluate(`[...document.querySelectorAll('[data-feed-key="observation-1"] button[aria-pressed]')].find(button=>button.textContent.includes('narrative')).click(); document.querySelector('[data-feed-key="prompt-2"] .prompt-show-more').click(); document.querySelector('#outside').focus();`);
    await page.settle();
    expect(await page.evaluate(`document.querySelector('[data-feed-key="observation-1"] .narrative')!==null`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-feed-key="prompt-2"] .prompt-show-more').getAttribute('aria-expanded')`)).toBe('true');

    await page.evaluate(`document.querySelector('.feed').scrollTop=400000;`);
    await page.settle();
    expect(await page.evaluate(`document.querySelectorAll('.card').length`)).toBeLessThan(30);
    expect(await page.evaluate(`document.querySelector('[data-feed-key="observation-1"]')===null`)).toBe(true);
    await page.evaluate(`document.querySelector('.feed').scrollTop=0;`);
    await page.settle();
    expect(await page.evaluate(`document.querySelector('[data-feed-key="observation-1"] .narrative')!==null`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-feed-key="prompt-2"] .prompt-show-more').getAttribute('aria-expanded')`)).toBe('true');

    await page.evaluate(`document.querySelector('.feed').scrollTop=300000;`);
    await page.settle();
    const anchor = await page.evaluate(`(()=>{const f=document.querySelector('.feed');const top=f.getBoundingClientRect().top;const row=[...document.querySelectorAll('[data-feed-key]')].find(r=>r.getBoundingClientRect().bottom>top);return {key:row.dataset.feedKey,top:row.getBoundingClientRect().top-top};})()`);
    await page.evaluate(`window.prepend()`);
    await page.settle();
    const afterPrepend = await page.evaluate(`(()=>{const r=document.querySelector('[data-feed-key="${anchor.key}"]');return r.getBoundingClientRect().top-document.querySelector('.feed').getBoundingClientRect().top;})()`);
    expect(Math.abs(afterPrepend - anchor.top)).toBeLessThan(2);
    await page.evaluate(`window.remove(6001)`);
    await page.settle();
    const afterDelete = await page.evaluate(`(()=>{const r=document.querySelector('[data-feed-key="${anchor.key}"]');return r.getBoundingClientRect().top-document.querySelector('.feed').getBoundingClientRect().top;})()`);
    expect(Math.abs(afterDelete - anchor.top)).toBeLessThan(2);

    const deletedAnchorId = Number(anchor.key.split('-').at(-1));
    await page.evaluate(`window.remove(${deletedAnchorId})`);
    await page.settle();
    const replacementTop = await page.evaluate(`document.querySelector('[data-feed-key="observation-${deletedAnchorId + 1}"]').getBoundingClientRect().top-document.querySelector('.feed').getBoundingClientRect().top`);
    expect(Math.abs(replacementTop)).toBeLessThan(2);

    const focusedKey = await page.evaluate(`(()=>{const f=document.querySelector('.feed');const top=f.getBoundingClientRect().top;const row=[...document.querySelectorAll('[data-feed-key]')].find(r=>r.getBoundingClientRect().bottom>top);row.querySelector('button').focus();return row.dataset.feedKey;})()`);
    await page.settle();
    const focusedPosition = await page.evaluate(`document.activeElement.closest('[data-feed-key]').getAttribute('aria-posinset')`);
    await page.evaluate(`document.querySelector('.feed').scrollTop=700000;`);
    await page.settle();
    expect(await page.evaluate(`document.activeElement.closest('[data-feed-key]')?.dataset.feedKey`)).toBe(focusedKey);
    expect(await page.evaluate(`document.querySelectorAll('.card').length`)).toBeLessThan(50);
    for (let index = 0; index < 3; index++) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.settle();
    }
    expect(await page.evaluate(`document.activeElement.closest('[data-feed-key]')?.getAttribute('aria-posinset')`)).toBe(String(Number(focusedPosition) + 1));

    await page.evaluate(`document.querySelector('#outside').focus(); document.querySelector('.scroll-to-top').click();`);
    expect(await page.evaluate(`new Promise(resolve=>{const deadline=performance.now()+3000;function check(){if(document.querySelector('.feed').scrollTop<2)return resolve(true);if(performance.now()>deadline)return resolve(false);requestAnimationFrame(check);}check();})`)).toBe(true);

    await page.evaluate(`document.querySelector('#outside').focus(); document.querySelector('.feed').scrollTop=0; window.small();`);
    await page.settle();
    expect(await page.evaluate(`({windowed:document.querySelector('[data-windowed]').dataset.windowed,cards:document.querySelectorAll('.card').length,sentinel:document.querySelector('.feed-content').lastElementChild.getBoundingClientRect().height})`))
      .toEqual({ windowed: 'false', cards: 20, sentinel: 20 });
    await page.evaluate(`document.querySelector('.feed').scrollTop=1000;`);
    await page.settle();
    const requestedScroll = await page.evaluate(`(()=>{document.querySelector('.feed-content').lastElementChild.scrollIntoView({block:'end'});const requested=document.querySelector('.feed').scrollTop;window.repaint();return requested;})()`);
    await page.settle();
    expect(await page.evaluate(`document.querySelector('.feed').scrollTop`)).toBeCloseTo(requestedScroll, 1);
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('preserves a scrolled variable-height anchor, disclosure and focus across both window thresholds', async () => {
  const script = compileBrowserFixture(`
    import React, {useState,useLayoutEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Feed} from './src/ui/viewer/components/Feed';
    const observation = id => ({itemType:'observation', id, project:'fixture', platform_source:'claude', type:'discovery',
      title:'Observation '+id, subtitle:'Variable-height summary content. '.repeat(id%9+1),
      narrative:'Expanded narrative content. '.repeat(120), facts:'["First fact","Second fact"]',
      concepts:'[]', files_read:'[]', files_modified:'[]', created_at_epoch:1793800000000-id});
    function App(){
      const [items,setItems]=useState(()=>Array.from({length:501},(_,i)=>observation(i+1)));
      useLayoutEffect(()=>{void fetch('/ready');},[]);
      window.shrink=()=>setItems(old=>old.filter(item=>item.id!==1));
      window.grow=()=>setItems(old=>[observation(1),...old]);
      window.compact=()=>setItems(old=>old.map(item=>({...item,subtitle:'Short summary'})));
      return <Feed items={items} header={<button id="outside">Header action</button>} onLoadMore={()=>{}} onDeleted={()=>{}} isLoading={false} hasMore={true}/>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const styles = readViewerTemplateStyles();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture.js') return scriptResponse(script);
    if (path === '/ready') { markReady(); return new Response('ok'); }
    return htmlResponse(`<style>${styles}</style><div id="root"></div><script src="/fixture.js"></script>`);
  }});
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-feed-threshold-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Threshold browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.settle();
    await page.evaluate(`document.querySelector('.feed').scrollTop=60000;`);
    await page.settle();
    expect(await page.evaluate(`new Set([...document.querySelectorAll('[data-feed-key]')].map(row=>row.getBoundingClientRect().height)).size`)).toBeGreaterThan(1);
    await page.evaluate(`(()=>{const top=document.querySelector('.feed').getBoundingClientRect().top;const row=[...document.querySelectorAll('[data-feed-key]')].find(row=>row.getBoundingClientRect().bottom>top);window.thresholdKey=row.dataset.feedKey;const button=[...row.querySelectorAll('button[aria-pressed]')].find(button=>button.textContent.includes('narrative'));button.click();button.focus({preventScroll:true});window.thresholdFocused=button;})()`);
    await page.settle();
    const originalTop = await page.evaluate(`document.querySelector('[data-feed-key="'+window.thresholdKey+'"]').getBoundingClientRect().top-document.querySelector('.feed').getBoundingClientRect().top`);
    expect(await page.evaluate(`document.querySelector('.feed').scrollTop`)).toBeGreaterThan(10000);
    for (const focusInside of [true, false]) {
      // An external focused control ensures focus pinning cannot mask a lost
      // visible anchor when the full list starts windowing again.
      await page.evaluate(`window.expectedFocus=${focusInside ? 'window.thresholdFocused' : 'document.querySelector("#outside")'};window.expectedFocus.focus({preventScroll:true});`);
      await page.settle();
      for (const [operation, windowed, count] of [['shrink', 'false', 500], ['grow', 'true', 501]] as const) {
        await page.evaluate(`window.${operation}()`);
        await page.settle();
        expect(await page.evaluate(`({windowed:document.querySelector('[data-windowed]').dataset.windowed,total:Number(document.querySelector('[aria-setsize]').getAttribute('aria-setsize')),focused:document.activeElement===window.expectedFocus,expanded:!!document.querySelector('[data-feed-key="'+window.thresholdKey+'"] .narrative')})`))
          .toEqual({ windowed, total: count, focused: true, expanded: true });
        const after = await page.evaluate(`document.querySelector('[data-feed-key="'+window.thresholdKey+'"]').getBoundingClientRect().top-document.querySelector('.feed').getBoundingClientRect().top`);
        expect(Math.abs(after - originalTop)).toBeLessThan(2);
        // Allow a second batch of observer/animation frames; a later height
        // correction must not undo the threshold transition's anchor restore.
        await page.settle();
        await page.settle();
        const settled = await page.evaluate(`document.querySelector('[data-feed-key="'+window.thresholdKey+'"]').getBoundingClientRect().top-document.querySelector('.feed').getBoundingClientRect().top`);
        expect(Math.abs(settled - originalTop)).toBeLessThan(2);
      }
    }
    await page.evaluate(`window.compact();`);
    await page.settle();
    await page.evaluate(`document.querySelector('.feed').scrollTop=document.querySelector('.feed').scrollHeight;`);
    await page.settle();
    const beforeClamp = await page.evaluate(`(()=>{const f=document.querySelector('.feed');const top=f.getBoundingClientRect().top;const row=[...document.querySelectorAll('[data-feed-key]')].find(row=>row.getBoundingClientRect().bottom>top);window.clampKey=row.dataset.feedKey;return {scroll:f.scrollTop,top:row.getBoundingClientRect().top-top};})()`);
    await page.evaluate(`window.shrink()`);
    await page.settle();
    const afterClamp = await page.evaluate(`(()=>{const f=document.querySelector('.feed');return {max:f.scrollHeight-f.clientHeight,top:document.querySelector('[data-feed-key="'+window.clampKey+'"]').getBoundingClientRect().top-f.getBoundingClientRect().top};})()`);
    expect(afterClamp.max).toBeLessThan(beforeClamp.scroll);
    expect(Math.abs(afterClamp.top - beforeClamp.top)).toBeLessThan(2);
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 60_000);

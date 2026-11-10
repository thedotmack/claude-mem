import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for remote memory reconciliation.');

for (const scope of ['project', 'session']) {
  (chromeExecutablePath ? it : it.skip)(`reconciles remote changes, retained history and missed events in ${scope} view`, async () => {
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from './src/ui/viewer/App';
      import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
      setStoredWelcomeDismissed(true);
      import { TIMING } from './src/ui/viewer/constants/timing';
      TIMING.SSE_RECONNECT_DELAY_MS = 50;
      if (${JSON.stringify(scope)} === 'session') location.hash = '#/sessions/claude/owned-session';
      let aLoaded = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]).includes('/api/observations?') && String(args[0]).includes('project=A')) {
          const json = response.json.bind(response);
          response.json = async () => { const data = await json(); aLoaded++; return data; };
        }
        return response;
      };
      createRoot(document.getElementById('root')).render(<App />);
      async function until(predicate, label) {
        const deadline = Date.now() + 10000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('Timed out: ' + label);
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      }
      const has = text => document.body.textContent.includes(text);
      const scrollBottom = () => document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({block:'end'});
      (async () => {
        try {
          await fetch('/ready');
          await until(() => has('MEMORY_1_END'), 'first page');
          if (${JSON.stringify(scope)} === 'project') {
            const select = document.querySelector('select[aria-label="Filter memories by project"]');
            select.value = 'A'; select.dispatchEvent(new Event('change', {bubbles:true}));
            await until(() => aLoaded > 0 && has('MEMORY_1_END') && !has('Loading more...'), 'project read');
          }
          scrollBottom();
          await until(() => has('MEMORY_100_END'), 'second page');
          await fetch('/mutate', {method:'POST'});
          await until(() => has('UPDATED_1_END') && has('NEW_1001_END') && !has('MEMORY_2_END')
            && (${JSON.stringify(scope)} === 'session' || !has('MEMORY_3_END')) && !has('Loading more...'), 'remote reconciliation');
          const retained = has('MEMORY_100_END');
          // The catalog refresh follows the feed refresh and completes independently.
          if (${JSON.stringify(scope)} === 'session') await until(() => has('UPDATED_SESSION_TITLE'), 'refreshed session title');
          const refreshedTitle = ${JSON.stringify(scope)} !== 'session' || has('UPDATED_SESSION_TITLE');
          scrollBottom();
          await until(() => has('MEMORY_150_END'), 'older history after rebase');
          await fetch('/disconnect', {method:'POST'});
          await fetch('/offline-change', {method:'POST'});
          await until(() => has('OFFLINE_4_END') && !has('MEMORY_5_END') && !has('Loading more...'), 'reconnect catchup');
          const titles = [...document.querySelectorAll('.card-title')].map(element => element.textContent);
          await fetch('/result', {method:'POST', body:JSON.stringify({
            retained, refreshedTitle, older:has('MEMORY_150_END'), recovered:has('OFFLINE_4_END'),
            noDuplicates:titles.length >= 100 && titles.length === new Set(titles).size,
          })});
        } catch (error) { await fetch('/result', {method:'POST', body:JSON.stringify({failure:String(error)})}); }
      })();
    `);
    let rows = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1, project: 'A', content_session_id: 'owned-session', platform_source: 'claude',
      title: `MEMORY_${index + 1}_END`, type: 'discovery', created_at_epoch: 100_000 - index,
      created_at: new Date(100_000 - index).toISOString(), narrative: '', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
    }));
    let title = 'INITIAL_SESSION_TITLE';
    let streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    let report!: (value: any) => void;
    const result = new Promise<any>(resolve => { report = resolve; });
    let afterMutationReads = 0;
    let delayedCatalogResponses = 0;
    let mutating = false;
    let countedMutation = false;
    const encoder = new TextEncoder();
    const emit = (value: unknown) => { for (const stream of streams) { try { stream.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { streams.delete(stream); } } };
    const server = Bun.serve({ hostname:'127.0.0.1', port:0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return htmlResponse(readViewerTemplateHtml());
      if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
      if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
      if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
        streams.add(controller);
        controller.enqueue(encoder.encode('data: {"type":"initial_load","projects":["A","B"]}\n\n'));
        request.signal.addEventListener('abort', () => streams.delete(controller), {once:true});
      } }), { headers:{'Content-Type':'text/event-stream'} });
      if (url.pathname === '/api/projects') return Response.json({ projects:['A','B'] });
      if (url.pathname === '/api/sessions') {
        // Keep the title response behind the feed response so the assertion
        // cannot accidentally rely on their completion order.
        if (scope === 'session' && mutating) {
          delayedCatalogResponses++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return Response.json({ sessions:[{content_session_id:'owned-session',platform_source:'claude',project:'A',custom_title:title,started_at_epoch:100_000,item_count:rows.length}],hasMore:false });
      }
      if (['/api/observations','/api/summaries','/api/prompts'].includes(url.pathname)) {
        if (mutating && !countedMutation) afterMutationReads++;
        if (url.pathname !== '/api/observations') return Response.json({items:[],hasMore:false});
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        const project = url.searchParams.get('project');
        const session = url.searchParams.get('contentSessionId');
        const visible = rows.filter(row => (!project || row.project === project) && (!session || row.content_session_id === session));
        return Response.json({items:visible.slice(offset,offset+limit),hasMore:visible.length>offset+limit});
      }
      if (url.pathname === '/mutate') {
        rows = rows.filter(row => row.id !== 2).map(row => row.id === 1 ? {...row,title:'UPDATED_1_END'} : row.id === 3 ? {...row,project:'B'} : row);
        rows.unshift({...rows[0],id:1001,title:'NEW_1001_END',created_at_epoch:200_000});
        title = 'UPDATED_SESSION_TITLE'; mutating = true;
        for (let i=0;i<20;i++) emit({type:'data_changed',kinds:['observation','mutation'],projects:['B']});
        return new Response('mutated');
      }
      if (url.pathname === '/disconnect') {
        countedMutation = true;
        for (const stream of streams) { try { stream.close(); } catch {} } streams = new Set();
        return new Response('disconnected');
      }
      if (url.pathname === '/offline-change') {
        rows = rows.filter(row => row.id !== 5).map(row => row.id === 4 ? {...row,title:'OFFLINE_4_END'} : row);
        return new Response('changed');
      }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return Response.json({});
    } });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix:'claude-mem-remote-resync-', extraFlags:['--window-size=900,700'] });
      await withTimeout(ready, 30000, 'Browser did not start');
      expect(await withTimeout(result, 30000, 'Remote reconciliation timed out')).toEqual({retained:true,refreshedTitle:true,older:true,recovered:true,noDuplicates:true});
      expect(afterMutationReads).toBeLessThanOrEqual(9);
      if (scope === 'session') expect(delayedCatalogResponses).toBeGreaterThan(0);
    } finally { await chrome?.close(); server.stop(true); }
  }, 80000);
}

import { expect, it } from 'bun:test';
import { UI } from '../../../src/ui/viewer/constants/ui';
import {
  chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome, htmlResponse, launchChrome, readViewerTemplateHtml,
  scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for feed visit regressions.');

for (const scope of ['project', 'session']) {
  for (const staleOutcome of ['success', 'failure']) {
    (chromeExecutablePath ? it : it.skip)(`ignores an earlier ${scope} visit ${staleOutcome} after A to B to A`, async () => {
      const bundle = compileBrowserFixture(`
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { App } from './src/ui/viewer/App';
        import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
        setStoredWelcomeDismissed(true);
        const originalFetch = window.fetch.bind(window);
        let oldReading = 0, oldSettled = 0;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (response.headers.get('X-Owned-Visit') === 'old') {
            const read = response.json.bind(response);
            response.json = async () => {
              oldReading++;
              try { return await read(); } finally { oldSettled++; }
            };
          }
          return response;
        };
        createRoot(document.getElementById('root')).render(<App />);
        async function until(predicate, stage = 'unknown') {
          const deadline = Date.now() + 8000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Owned browser condition did not settle: ' + stage + ' body=' + document.body.textContent.slice(-500));
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        async function paint() { for (let i=0; i<4; i++) await new Promise(requestAnimationFrame); }
        function select(value) {
          if (${JSON.stringify(scope)} === 'session') location.hash = '#/sessions/claude/' + value;
          else {
            const select = document.querySelector('.header select');
            select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        (async () => {
          try {
            await originalFetch('/ready');
            await until(() => [...document.querySelectorAll('.header select option')].some(o => o.value === 'A'), 'projects');
            select('A');
            await originalFetch('/await-old');
            await until(() => oldReading === 3, 'old bodies started');
            select('B');
            await until(() => ['OBSERVATION', 'SUMMARY', 'PROMPT'].every(type => document.body.textContent.includes('B_CURRENT_' + type)), 'B feed');
            select('A');
            await until(() => document.body.textContent.includes('A_CURRENT_OBSERVATION')
              && document.body.textContent.includes('A_CURRENT_SUMMARY')
              && document.body.textContent.includes('A_CURRENT_PROMPT'), 'A current feed');
            await paint();
            await originalFetch('/release-old', { method: 'POST' });
            await until(() => oldSettled === 3, 'old requests'); await paint();
            const report = {
              staleRows: document.body.textContent.includes('A_OLD_'),
              staleAlert: !!document.querySelector('[role="alert"]'),
              currentRows: ['OBSERVATION', 'SUMMARY', 'PROMPT'].every(type => document.body.textContent.includes('A_CURRENT_' + type)),
              continued: false,
            };
            const deadline = Date.now() + 2500;
            while (!document.body.textContent.includes('A_NEXT_PAGE') && Date.now() < deadline) {
              document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({ block: 'end' });
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            report.continued = document.body.textContent.includes('A_NEXT_PAGE');
            await originalFetch('/result', { method: 'POST', body: JSON.stringify(report) });
          } catch (error) { await originalFetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      `);
      // The real viewer page, which loads the fixture as its own bundle.
      const html = readViewerTemplateHtml();
      let releaseOld!: () => void;
      const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
      let oldStarted!: () => void;
      const oldReady = new Promise<void>(resolve => { oldStarted = resolve; });
      let markReady!: () => void;
      const ready = new Promise<void>(resolve => { markReady = resolve; });
      let report!: (value: unknown) => void;
      const result = new Promise<unknown>(resolve => { report = resolve; });
      const attempts = new Map<string, number>();
      const aOffsets: number[] = [];
      let oldRequests = 0;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/') return htmlResponse(html);
        if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
        if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
        if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["A","B"]}\n\n'));
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
        if (url.pathname === '/await-old') { await oldReady; return new Response('started'); }
        if (url.pathname === '/release-old') { releaseOld(); return new Response('released'); }
        if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) {
          const selected = url.searchParams.get(scope === 'project' ? 'project' : 'contentSessionId');
          if (!selected) return Response.json({ items: [], hasMore: false });
          const key = selected + url.pathname;
          const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
          const old = selected === 'A' && attempt === 1;
          if (old) {
            if (++oldRequests === 3) oldStarted();
          }
          const offset = Number(url.searchParams.get('offset'));
          if (selected === 'A' && !old && url.pathname === '/api/observations') aOffsets.push(offset);
          const next = selected === 'A' && !old && offset === UI.PAGINATION_PAGE_SIZE;
          const prefix = selected + (old ? '_OLD_' : '_CURRENT_');
          const common = { id: old ? 1000 : selected === 'B' ? 2000 : next ? 3000 : 1,
            project: selected, content_session_id: selected, platform_source: 'claude',
            created_at_epoch: Date.now(), created_at: new Date().toISOString() };
          const items = url.pathname === '/api/observations' ? Array.from({ length: old || selected === 'B' || next ? 1 : UI.PAGINATION_PAGE_SIZE }, (_, i) => ({
            ...common, id: common.id + i, type: 'discovery', title: next ? 'A_NEXT_PAGE' : prefix + 'OBSERVATION_' + i,
            narrative: 'Owned ABA fixture', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
          })) : url.pathname === '/api/summaries' ? [{ ...common, request: prefix + 'SUMMARY', learned: 'Owned fixture', investigated: null, completed: null, next_steps: null }]
            : [{ ...common, prompt_text: prefix + 'PROMPT', prompt_number: 1 }];
          const data = { items, hasMore: selected === 'A' && !old && !next && url.pathname === '/api/observations' };
          if (old) {
            // Flush uncached headers, holding the real JSON body while another
            // visit requests this URL. Chromium may serialize pending cacheable
            // requests if the first response has not delivered headers yet.
            return new Response(new ReadableStream({ async start(controller) {
              controller.enqueue(new TextEncoder().encode(' '));
              await oldGate;
              controller.enqueue(new TextEncoder().encode(staleOutcome === 'failure' ? 'owned invalid JSON' : JSON.stringify(data)));
              controller.close();
            } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Owned-Visit': 'old' } });
          }
          return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
        return Response.json({});
      } });
      let chrome: OwnedChrome | undefined;
      try {
        chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-feed-visit-', extraFlags: ['--window-size=800,600'] });
        await withTimeout(ready, 30000, 'Owned browser deadline exceeded');
        expect(await withTimeout(result, 18000, 'Owned browser deadline exceeded')).toEqual({ staleRows: false, staleAlert: false, currentRows: true, continued: true });
        expect(aOffsets).toEqual([0, UI.PAGINATION_PAGE_SIZE]);
      } finally {
        releaseOld(); await chrome?.close(); server.stop(true);
      }
    }, 75000);
  }
}

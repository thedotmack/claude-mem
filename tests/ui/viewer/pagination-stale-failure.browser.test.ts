import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, chromeExecutablePath, compileBrowserFixture, htmlResponse, launchChrome, scriptResponse, withTimeout,
  type OwnedChrome,
} from '../../helpers/chrome-devtools';

(chromeExecutablePath ? it : it.skip)('an old session network failure cannot block the new session feed', async () => {
  const bundle = compileBrowserFixture(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from './src/ui/viewer/App';
      localStorage.setItem('claude-mem-welcome-dismissed', 'true');
      location.hash = '#/sessions/claude/session-a';
      let aStarted = false, aFailed = false, bSettled = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = String(args[0]);
        const page = /\\/api\\/(observations|summaries|prompts)\\?/.test(url);
        if (page && url.includes('session-a')) aStarted = true;
        try {
          const response = await originalFetch(...args);
          if (page && url.includes('session-b')) {
            const read = response.json.bind(response);
            response.json = async () => { const data = await read(); bSettled++; return data; };
          }
          return response;
        } catch (error) { if (page && url.includes('session-a')) aFailed = true; throw error; }
      };
      createRoot(document.getElementById('root')).render(<App />);
      async function until(predicate) {
        const deadline = Date.now() + 7000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('Fixture did not settle');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      async function paint() { for (let i=0; i<6; i++) await new Promise(requestAnimationFrame); }
      (async () => {
        try {
          await until(() => aStarted);
          location.hash = '#/sessions/claude/session-b';
          await until(() => bSettled >= 3 && document.body.textContent.includes('B_FIRST_0'));
          await paint();
          await originalFetch('/release-stale', { method: 'POST' });
          await until(() => aFailed); await paint();
          const staleAlert = !!document.querySelector('[role="alert"]');
          document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({ block: 'end' }); await paint();
          // Use bounded real observer/HTTP settling, not a mock intersection callback.
          const deadline = Date.now() + 1500;
          while (!document.body.textContent.includes('B_SECOND_PAGE') && Date.now() < deadline) {
            document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({ block: 'end' });
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          await originalFetch('/result', { method: 'POST', body: JSON.stringify({
            staleAlert, recovered: document.body.textContent.includes('B_SECOND_PAGE'),
            sessionView: !!document.querySelector('.session-detail-header'), aFailed
          }) });
        } catch (error) { await originalFetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
      })();
    `);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["owned-project"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) {
      if (url.searchParams.get('contentSessionId') === 'session-a' && url.pathname === '/api/observations') {
        await gate;
        // Chromium rejects this redirect to a forbidden port as a real network error.
        return Response.redirect('http://127.0.0.1:1/owned-network-failure', 302);
      }
      if (url.searchParams.get('contentSessionId') !== 'session-b' || url.pathname !== '/api/observations') return Response.json({ items: [], hasMore: false });
      const first = url.searchParams.get('offset') === '0';
      const items = Array.from({ length: first ? 20 : 1 }, (_, i) => ({
        id: first ? i + 1 : 100, project: 'owned-project', content_session_id: 'session-b', platform_source: 'claude',
        created_at_epoch: Date.now() - i, created_at: new Date().toISOString(), type: 'discovery',
        title: first ? 'B_FIRST_' + i : 'B_SECOND_PAGE', narrative: 'Owned native fixture',
        facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
      }));
      return Response.json({ items, hasMore: first });
    }
    if (url.pathname === '/release-stale') { release(); return new Response('released'); }
    if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-stale-feed-', extraFlags: ['--window-size=800,600'] });
    const reported = await withTimeout(result, 25000, 'Browser timed out');
    expect(reported).toEqual({ staleAlert: false, recovered: true, sessionView: true, aFailed: true });
  } finally {
    release(); await chrome?.close(); server.stop(true);
  }
}, 40000);

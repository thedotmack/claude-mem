import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the pagination browser regressions.');

// Real App, React state/effects, HTTP and SSE; no mocked hook dispatcher.
for (const scenario of ['partial', 'empty-timeline', 'empty-session']) {
  (chromeExecutablePath ? it : it.skip)(`recovers ${scenario} page failures without dropping successful rows`, async () => {
    const bundle = compileBrowserFixture(`
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { App } from './src/ui/viewer/App';
        localStorage.setItem('claude-mem-welcome-dismissed', 'true');
        if (${JSON.stringify(scenario)} === 'empty-session') location.hash = '#/sessions/claude/owned-session';
        let settled = 0;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (/\\/api\\/(observations|summaries|prompts)\\?/.test(String(args[0]))) {
            if (!response.ok) settled++;
            else {
              const read = response.json.bind(response);
              response.json = async () => { const data = await read(); settled++; return data; };
            }
          }
          return response;
        };
        createRoot(document.getElementById('root')).render(<App />);
        async function until(predicate) {
          const deadline = Date.now() + 6000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Fixture did not settle');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        (async () => {
          try {
            await fetch('/ready');
            // Wait for the observable React commit. Animation frames can be
            // suspended in a background headless tab on the CI runner.
            await until(() => settled >= 3 && [...document.querySelectorAll('button')].some(b => b.textContent === 'Retry'));
            const initial = document.body.textContent;
            const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry');
            const report = { retainedObservation: initial.includes('OWNED_OBSERVATION'),
              retainedSummary: initial.includes('OWNED_SUMMARY'), loading: initial.includes('Loading more...'),
              retry: !!button, recovered: false, sessionView: !!document.querySelector('.session-detail-header') };
            if (button) {
              button.click(); await until(() => settled >= ${scenario === 'partial' ? 4 : 6}
                && document.body.textContent.includes(${scenario === 'partial' ? "'OWNED_PROMPT'" : "'OWNED_OBSERVATION'"})
                && !document.body.textContent.includes('Loading more...')
                && !document.querySelector('[role="alert"]'));
              report.recovered = document.body.textContent.includes(${scenario === 'partial' ? "'OWNED_PROMPT'" : "'OWNED_OBSERVATION'"})
                && !document.body.textContent.includes('Loading more...')
                && !document.querySelector('[role="alert"]');
            }
            await fetch('/result', { method: 'POST', body: JSON.stringify(report) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      `);
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const attempts = new Map<string, number>();
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const common = { id: 1, project: 'owned-project', content_session_id: 'owned-session',
      platform_source: 'claude', created_at_epoch: Date.now(), created_at: new Date().toISOString() };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
      if (url.pathname === '/fixture.js') return scriptResponse(bundle);
      if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
      if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["owned-project"]}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) {
        const attempt = (attempts.get(url.pathname) ?? 0) + 1; attempts.set(url.pathname, attempt);
        if (attempt === 1 && (scenario !== 'partial' || url.pathname === '/api/prompts')) return new Response('owned outage', { status: 503 });
        const items = url.pathname === '/api/observations' ? [{ ...common, type: 'discovery', title: 'OWNED_OBSERVATION', narrative: 'Owned fixture', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' }]
          : url.pathname === '/api/summaries' ? [{ ...common, request: 'OWNED_SUMMARY', learned: 'Owned fixture', investigated: null, completed: null, next_steps: null }]
          : [{ ...common, prompt_text: 'OWNED_PROMPT', prompt_number: 1 }];
        return Response.json({ items, hasMore: false });
      }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return Response.json({});
    } });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-pagination-browser-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
      // Separate Chrome startup from the two rendered-page settlement phases.
      await withTimeout(ready, 30000, 'Owned pagination browser did not become ready');
      const reported = await withTimeout(result, 25000, 'Browser fixture timed out');
      expect(reported).toEqual({ retainedObservation: scenario === 'partial', retainedSummary: scenario === 'partial', loading: false, retry: true, recovered: true, sessionView: scenario === 'empty-session' });
    } finally {
      await chrome?.close(); server.stop(true);
    }
  }, 80000);
}

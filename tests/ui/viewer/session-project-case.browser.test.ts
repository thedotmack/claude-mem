import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the session project-case regression.');

(chromeExecutablePath ? it : it.skip)('keeps fetched and live sessions in the same case-insensitive project filter', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    localStorage.setItem('claude-mem-welcome-dismissed', 'true');
    location.hash = '#/sessions';
    let selectedPages = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).startsWith('/api/sessions?') && String(args[0]).includes('project=')) {
        const read = response.json.bind(response);
        response.json = async () => { const data = await read(); selectedPages++; return data; };
      }
      return response;
    };
    createRoot(document.getElementById('root')).render(<App />);
    const pause = () => new Promise(resolve => setTimeout(resolve, 20));
    async function until(predicate) {
      const deadline = Date.now() + 6000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Session fixture did not settle');
        await pause();
      }
    }
    const ids = () => [...document.querySelectorAll('.session-card-id')].map(node => node.textContent).sort();
    (async () => {
      try {
        await until(() => document.querySelectorAll('.session-card').length === 2
          && document.querySelector('select[aria-label="Filter memories by project"] option[value="Widget"]'));
        const select = document.querySelector('select[aria-label="Filter memories by project"]');
        select.value = 'Widget'; select.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => selectedPages >= 1 && !document.body.textContent.includes('Loading sessions'));
        await pause();
        const fetched = ids();
        await fetch('/emit?project=wIdGeT&id=live-case');
        await until(() => document.querySelector('option[value="wIdGeT"]'));
        const live = ids();
        await fetch('/emit?project=Widget-other&id=unrelated');
        await until(() => document.querySelector('option[value="Widget-other"]'));
        const unrelated = ids();
        select.value = 'Äpp'; select.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => selectedPages >= 2 && !document.body.textContent.includes('Loading sessions'));
        await fetch('/emit?project=%C3%A4pp&id=unicode-other');
        await until(() => document.querySelector('option[value="äpp"]'));
        await fetch('/result', { method: 'POST', body: JSON.stringify({ fetched, live, unrelated,
          unicode: ids(), selected: select.value }) });
      } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
    })();
  `);
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  const now = Date.now();
  const sessions = ['Widget', 'widget'].map((project, index) => ({
    content_session_id: `saved-${index}`, platform_source: 'claude', project,
    custom_title: `Saved ${index}`, started_at_epoch: now - index, item_count: 1,
  }));
  let nextObservationId = 100;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["Widget","Äpp"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname === '/api/sessions') return Response.json({
      sessions: url.searchParams.get('project') === 'Äpp' ? [] : sessions, hasMore: false,
    });
    if (url.pathname === '/api/processing-status') return Response.json({ isProcessing: false, queueDepth: 0 });
    if (url.pathname === '/api/projects') return Response.json({ projects: ['Widget', 'Äpp'], sources: ['claude'],
      projectsBySource: { claude: ['Widget', 'Äpp'] } });
    if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) return Response.json({ items: [], hasMore: false });
    if (url.pathname === '/emit') {
      if (!stream) throw new Error('Owned SSE connection not ready');
      const observation = { id: nextObservationId++, project: url.searchParams.get('project'),
        content_session_id: url.searchParams.get('id'), platform_source: 'claude', created_at_epoch: now,
        type: 'discovery', title: 'Owned live row', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' };
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'new_observation', observation })}\n\n`));
      return new Response('emitted');
    }
    if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-session-case-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    const actual = await withTimeout(result, 30000, 'Owned session project-case fixture timed out');
    console.log('SESSION_PROJECT_CASE_PROOF', JSON.stringify(actual));
    expect(actual).toEqual({ fetched: ['saved-0', 'saved-1'], live: ['live-case', 'saved-0', 'saved-1'],
      unrelated: ['live-case', 'saved-0', 'saved-1'], unicode: [], selected: 'Äpp' });
  } finally {
    await chrome?.close(); server.stop(true);
  }
}, 80000);

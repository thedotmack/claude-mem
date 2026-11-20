import { expect, it } from 'bun:test';
import { UI } from '../../../src/ui/viewer/constants/ui';
import { PAGINATION_REQUEST_TIMEOUT_MS } from '../../../src/ui/viewer/hooks/usePagination';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the load-more timeout regression (B2).');

// B2: while other agents kept the worker busy, a "load older" page timed out and
// the list just stopped growing; the reason showed only in the console. The
// timeout line with Retry appeared, then the next refresh of the newest rows
// (memory changes all the time on a busy worker) cleared it. A failed page must
// stay in the list, with Retry, until a load succeeds.
(chromeExecutablePath ? it : it.skip)('a timed-out "load older" keeps its Retry line in the list after the newest rows refresh', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    let newestReads = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (/\\/api\\/observations\\?/.test(String(args[0])) && /offset=0\\b/.test(String(args[0]))) {
        const read = response.json.bind(response);
        response.json = async () => { const data = await read(); newestReads++; return data; };
      }
      return response;
    };
    createRoot(document.getElementById('root')).render(<App />);
    async function until(predicate, label, ms = 8000) {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Did not settle: ' + label + ' | ' + document.body.textContent.slice(-300));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const retryLine = () => document.querySelector('.feed-ending--failed');
    const retryButton = () => [...document.querySelectorAll('.feed-ending--failed button')].find(button => button.textContent === 'Retry');
    const loaded = () => Number(document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0);
    (async () => {
      try {
        await originalFetch('/ready');
        await until(() => loaded() === ${UI.PAGINATION_PAGE_SIZE} && newestReads === 1, 'first page');
        // Reach the end of the list: the next page is requested and the worker never answers it.
        // The end-of-list marker is drawn only once the summaries and prompts pages have answered too (App.tsx
        // isLoading), which on a busy machine can come after the observation rows show.
        await until(() => !!document.querySelector('.feed-sentinel'), 'end-of-list marker');
        document.querySelector('.feed-sentinel').scrollIntoView({ block: 'end' });
        await until(() => !!retryButton(), 'timeout line', ${PAGINATION_REQUEST_TIMEOUT_MS + 6000});
        const timedOut = retryLine().textContent;
        // Memory changes on the busy worker; the newest rows refresh successfully.
        await originalFetch('/emit-change');
        await until(() => newestReads >= 2 && !document.body.textContent.includes('Loading more...'), 'refresh of the newest rows');
        await new Promise(resolve => setTimeout(resolve, 300));
        const afterRefresh = { line: !!retryLine(), retry: !!retryButton(), loaded: loaded() };
        retryButton()?.click();
        await until(() => loaded() === ${UI.PAGINATION_PAGE_SIZE + 10} && !retryLine(), 'retried page');
        await originalFetch('/result', { method: 'POST', body: JSON.stringify({ timedOut, afterRefresh, afterRetry: loaded() }) });
      } catch (error) { await originalFetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
    })();
  `);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let olderPageAttempts = 0;
  const row = (id: number) => ({ id, project: 'owned', content_session_id: 'owned-session', platform_source: 'claude', type: 'discovery',
    title: `OWNED_${id}_END`, subtitle: null, narrative: null, facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
    created_at_epoch: 1_793_800_000_000 - id * 1000, created_at: new Date(1_793_800_000_000 - id * 1000).toISOString() });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["owned"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname === '/emit-change') {
      stream?.enqueue(new TextEncoder().encode('data: {"type":"data_changed","kinds":["observation"]}\n\n'));
      return new Response('sent');
    }
    if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
    if (url.pathname === '/api/observations') {
      const offset = Number(url.searchParams.get('offset'));
      if (offset === 0) return Response.json({ items: Array.from({ length: UI.PAGINATION_PAGE_SIZE }, (_, i) => row(i + 1)), hasMore: true });
      // The first request for older rows never answers (the client gives up after its timeout); Retry gets them.
      if (++olderPageAttempts === 1) return new Promise<Response>(() => {});
      return Response.json({ items: Array.from({ length: 10 }, (_, i) => row(UI.PAGINATION_PAGE_SIZE + i + 1)), hasMore: false });
    }
    if (url.pathname === '/api/summaries' || url.pathname === '/api/prompts') return Response.json({ items: [], hasMore: false });
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-load-more-timeout-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Timeout browser did not become ready');
    const received = await withTimeout(result, PAGINATION_REQUEST_TIMEOUT_MS + 40_000, 'Timeout fixture did not report') as Record<string, unknown>;
    expect(received.failure).toBeUndefined();
    expect(received.timedOut).toContain('Loading observations timed out. Try again.');
    expect(received.afterRefresh).toEqual({ line: true, retry: true, loaded: UI.PAGINATION_PAGE_SIZE });
    expect(received.afterRetry).toBe(UI.PAGINATION_PAGE_SIZE + 10);
  } finally { await chrome?.close(); server.stop(true); }
}, PAGINATION_REQUEST_TIMEOUT_MS + 60_000);

// A "load older" page in flight when memory changes is not lost and its late error is
// not shown: the change stops waiting for that page (its rows would be stale), the
// newest rows refresh, and the end of the list asks for the page again. When the page
// fails then, the failure stays in the list with Retry, through later refreshes too.
(chromeExecutablePath ? it : it.skip)('a page that fails while memory changes mid-request is asked again, and its failure stays with Retry', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    const originalFetch = window.fetch.bind(window);
    createRoot(document.getElementById('root')).render(<App />);
    async function until(predicate, label, ms = 8000) {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Did not settle: ' + label + ' | ' + document.body.textContent.slice(-300));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const failedLine = () => document.querySelector('.feed-ending--failed');
    const retryButton = () => [...document.querySelectorAll('.feed-ending--failed button')].find(button => button.textContent === 'Retry');
    const loaded = () => Number(document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0);
    const state = async () => (await originalFetch('/state')).json();
    (async () => {
      try {
        await originalFetch('/ready');
        await until(() => loaded() === ${UI.PAGINATION_PAGE_SIZE}, 'first page');
        // Reach the end: the older page is asked for, and the worker holds it.
        // The end-of-list marker is drawn only once the summaries and prompts pages have answered too (App.tsx
        // isLoading), which on a busy machine can come after the observation rows show.
        await until(() => !!document.querySelector('.feed-sentinel'), 'end-of-list marker');
        document.querySelector('.feed-sentinel').scrollIntoView({ block: 'end' });
        for (let tries = 0; tries < 400 && (await state()).olderPageAttempts < 1; tries++) await new Promise(resolve => setTimeout(resolve, 20));
        // Memory changes while that page is on its way; then its late error arrives.
        await originalFetch('/emit-change');
        for (let tries = 0; tries < 400 && !(await state()).firstAborted; tries++) await new Promise(resolve => setTimeout(resolve, 20));
        await originalFetch('/fail-held-page');
        // The end of the list asks again; that page fails too, and the failure shows with Retry.
        await until(() => !!retryButton(), 'failure line after the page was asked again');
        const failed = failedLine().textContent;
        // G17: the plain sentence shows; the server's reason is folded under Details, in monospace.
        const details = failedLine().querySelector('details');
        const parts = { plain: failedLine().querySelector('.feed-ending-plain')?.textContent ?? null, visible: failedLine().innerText,
          folded: details ? !details.open : null, summary: details?.querySelector('summary')?.textContent ?? null,
          reason: details?.querySelector('pre')?.textContent ?? null, font: details ? getComputedStyle(details.querySelector('pre')).fontFamily : null };
        // A later change refreshes the newest rows; the failure stays.
        await originalFetch('/emit-change');
        await new Promise(resolve => setTimeout(resolve, 600));
        const afterRefresh = { line: !!failedLine(), retry: !!retryButton(), loaded: loaded() };
        await originalFetch('/heal');
        retryButton()?.click();
        await until(() => loaded() === ${UI.PAGINATION_PAGE_SIZE + 10} && !failedLine(), 'retried page');
        await originalFetch('/result', { method: 'POST', body: JSON.stringify({ failed, parts, afterRefresh, afterRetry: loaded(), ...(await state()) }) });
      } catch (error) { await originalFetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error), ...(await state()) }) }); }
    })();
  `);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let olderPageAttempts = 0;
  let firstAborted = false;
  let healed = false;
  let failHeld: (() => void) | null = null;
  const row = (id: number) => ({ id, project: 'owned', content_session_id: 'owned-session', platform_source: 'claude', type: 'discovery',
    title: `OWNED_${id}_END`, subtitle: null, narrative: null, facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
    created_at_epoch: 1_793_800_000_000 - id * 1000, created_at: new Date(1_793_800_000_000 - id * 1000).toISOString() });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/state') return Response.json({ olderPageAttempts, firstAborted });
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["owned"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname === '/emit-change') {
      stream?.enqueue(new TextEncoder().encode('data: {"type":"data_changed","kinds":["observation"]}\n\n'));
      return new Response('sent');
    }
    if (url.pathname === '/fail-held-page') { failHeld?.(); return new Response('failed'); }
    if (url.pathname === '/heal') { healed = true; return new Response('healed'); }
    if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
    if (url.pathname === '/api/observations') {
      const offset = Number(url.searchParams.get('offset'));
      if (offset === 0) return Response.json({ items: Array.from({ length: UI.PAGINATION_PAGE_SIZE }, (_, i) => row(i + 1)), hasMore: true });
      if (++olderPageAttempts === 1) {
        request.signal.addEventListener('abort', () => { firstAborted = true; });
        return new Promise<Response>(resolve => { failHeld = () => resolve(new Response('busy', { status: 500, statusText: 'Internal Server Error' })); });
      }
      if (!healed) return new Response('busy', { status: 500, statusText: 'Internal Server Error' });
      return Response.json({ items: Array.from({ length: 10 }, (_, i) => row(UI.PAGINATION_PAGE_SIZE + i + 1)), hasMore: false });
    }
    if (url.pathname === '/api/summaries' || url.pathname === '/api/prompts') return Response.json({ items: [], hasMore: false });
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-load-more-change-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Mid-change browser did not become ready');
    const received = await withTimeout(result, 40_000, 'Mid-change fixture did not report') as Record<string, unknown>;
    expect(received.failure).toBeUndefined();
    // The change stopped waiting for the page in flight; the page was asked for again, failed, then loaded on Retry.
    expect(received.firstAborted).toBe(true);
    expect(received.failed).toContain('Failed to load observations: Internal Server Error');
    const parts = received.parts as Record<string, string | boolean | null>;
    expect(parts).toEqual({ plain: 'Could not load more memories.', visible: expect.any(String), folded: true, summary: 'Details',
      reason: 'Failed to load observations: Internal Server Error', font: expect.stringContaining('monospace') });
    expect(parts.visible).toContain('Could not load more memories.');
    expect(parts.visible).not.toContain('Internal Server Error');
    expect(received.afterRefresh).toEqual({ line: true, retry: true, loaded: UI.PAGINATION_PAGE_SIZE });
    expect(received.afterRetry).toBe(UI.PAGINATION_PAGE_SIZE + 10);
    expect(received.olderPageAttempts as number).toBeGreaterThanOrEqual(3);
  } finally { await chrome?.close(); server.stop(true); }
}, 60_000);

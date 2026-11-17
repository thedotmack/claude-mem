import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the jump-to-end crash regression (B1).');

// B1: jumping the timeline to its end several times in a row (what the End key
// does) crashed the viewer with React error 185 once the list was windowed. The
// anchor restore moved rows between estimated and real heights inside one commit
// until React's nested-update limit stopped it. Same steps as the review's
// F-crash.mjs: set scrollTop to scrollHeight about 700ms apart.
const PER_KIND = 400;
const JUMPS = 14;

function words(seed: number, count: number): string {
  const pool = ['memory', 'timeline', 'worker', 'session', 'summary', 'prompt', 'observation', 'cursor', 'offset', 'window',
    'render', 'layout', 'anchor', 'scroll', 'height', 'estimate', 'viewer', 'release', 'branch', 'merge', 'queue'];
  return Array.from({ length: count }, (_, index) => pool[(seed * 7 + index * 13) % pool.length]).join(' ');
}

(chromeExecutablePath ? it : it.skip)('jumping to the end of a long timeline again and again never crashes the viewer', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    window.__errors = [];
    window.__warnings = [];
    window.addEventListener('error', event => window.__errors.push(String(event.message)));
    const originalError = console.error.bind(console);
    // React render failures only: the page also logs unrelated network noise (the stream, GitHub's star count).
    console.error = (...args) => { const text = args.map(String).join(' '); if (/React error|Maximum update depth|ErrorBoundary/.test(text)) window.__errors.push(text.slice(0, 300)); originalError(...args); };
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => { window.__warnings.push(args.map(String).join(' ').slice(0, 300)); originalWarn(...args); };
    createRoot(document.getElementById('root')).render(<ErrorBoundary withHeader><App /></ErrorBoundary>);
    fetch('/ready');
  `);
  const html = readViewerTemplateHtml();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const base = Date.UTC(2026, 10, 15, 23, 0, 0);
  const kinds = ['observations', 'summaries', 'prompts'] as const;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(html);
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["fixture"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const kind = kinds.find(name => url.pathname === `/api/${name}`);
    if (kind) {
      // A little latency, as from a busy worker, so pages land while the reader keeps jumping.
      await Bun.sleep(60);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const kindIndex = kinds.indexOf(kind);
      const items = [];
      for (let index = offset; index < Math.min(PER_KIND, offset + limit); index++) {
        const id = index + 1;
        const at = base - (index * 3 + kindIndex) * 47_000;
        const common = { id, project: 'fixture', platform_source: 'claude', content_session_id: 'session-' + Math.floor(index / 20),
          memory_session_id: 'memory-' + Math.floor(index / 20), created_at_epoch: at, created_at: new Date(at).toISOString() };
        // Heights vary a lot (one-line prompts, long prompts, summaries with long sections), like real history.
        if (kind === 'observations') items.push({ ...common, type: ['discovery', 'change', 'feature', 'decision'][index % 4],
          title: 'Observation ' + id + ' ' + words(id, 4 + (id % 9)), subtitle: words(id + 1, 10 + (id % 5) * 14),
          narrative: words(id + 2, 80), text: null, facts: JSON.stringify([words(id, 8), words(id + 3, 12)]), concepts: '[]',
          files_read: '[]', files_modified: '[]', prompt_number: 1 });
        else if (kind === 'summaries') items.push({ ...common, session_id: common.content_session_id, request: 'Summary ' + id + ' ' + words(id, 10),
          investigated: words(id, 20 + (id % 7) * 30), learned: words(id + 1, 30 + (id % 5) * 40), completed: words(id + 2, 20 + (id % 3) * 25),
          next_steps: words(id + 3, 15 + (id % 4) * 60), notes: id % 2 ? words(id + 4, 40) : null });
        else items.push({ ...common, prompt_number: id, prompt_text: id % 5 === 0 ? words(id, 220) : 'use the plan ' + id });
      }
      return Response.json({ items, hasMore: offset + limit < PER_KIND }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  const states: Array<Record<string, unknown>> = [];
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-feed-jump-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1440,900'] });
    await withTimeout(ready, 30_000, 'Jump-to-end browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.evaluate(`new Promise(resolve => { const check = () => document.querySelectorAll('.card').length ? resolve(true) : setTimeout(check, 50); check(); })`);
    for (let jump = 0; jump < JUMPS; jump++) {
      await page.evaluate(`(() => { const feed = document.querySelector('.feed'); if (feed) feed.scrollTop = feed.scrollHeight; })()`);
      await Bun.sleep(700);
      const state = await page.evaluate(`({
        feed: !!document.querySelector('.feed'),
        boundary: !!document.querySelector('.viewer-error-card'),
        windowed: document.querySelector('[data-windowed]')?.dataset.windowed ?? null,
        rows: Number(document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0),
        ended: !!document.querySelector('.feed-ending--end'),
        errors: window.__errors.slice(0, 3),
        warnings: window.__warnings.filter(text => text.includes('did not settle')).slice(0, 1),
      })`);
      states.push(state);
      if (!state.feed || state.boundary || state.errors.length) break;
    }
    const last = states.at(-1)!;
    expect({ feed: last.feed, boundary: last.boundary, errors: last.errors }).toEqual({ feed: true, boundary: false, errors: [] });
    // The height measurement settles the list by itself; the next-frame fallback is never needed here.
    expect(last.warnings).toEqual([]);
    expect(last.windowed).toBe('true');
    // Every page loaded while the reader kept jumping: the list reached its end.
    expect(last.ended).toBe(true);
    expect(last.rows as number).toBeGreaterThan(PER_KIND * 2);
  } catch (error) {
    console.log('FEED_JUMP_STATES', JSON.stringify(states));
    throw error;
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 120_000);

(chromeExecutablePath ? it : it.skip)('a row whose height changes on every render stops the list after the cap, says so, and does not loop every frame', async () => {
  // A pathological row that never settles: each render flips its height, so every
  // layout pass measures a change. The list must stop after its pass cap, say so in
  // the console, and stay stopped until the reader acts, instead of nesting updates
  // until React gives up (error 185) or re-running ten passes on every frame.
  const bundle = compileBrowserFixture(`
    import React, { useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { WindowedFeed, feedItemKey } from './src/ui/viewer/components/WindowedFeed';
    import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
    window.__errors = [];
    window.__warnings = [];
    window.__renders = 0;
    window.addEventListener('error', event => window.__errors.push(String(event.message)));
    const originalError = console.error.bind(console);
    console.error = (...args) => { window.__errors.push(args.map(String).join(' ').slice(0, 300)); originalError(...args); };
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => { window.__warnings.push(args.map(String).join(' ').slice(0, 300)); originalWarn(...args); };
    const items = Array.from({ length: 300 }, (_, i) => ({ itemType: 'prompt', id: i + 1, project: 'p', platform_source: 'claude',
      content_session_id: 's', prompt_number: i + 1, prompt_text: 'x', created_at_epoch: 1793800000000 - i }));
    // Every row flips between two heights on each render (the counter counts every row render).
    function Row({ index }) { window.__renders++; return <div style={{ height: 80 + (window.__renders % 2) * 70 }}>row {index}</div>; }
    function Page() {
      const ref = useRef(null);
      return <main className="feed" ref={ref} style={{ height: '600px', overflowY: 'auto' }}>
        <WindowedFeed items={items} itemKey={feedItemKey} scrollRef={ref} renderItem={(item, index) => <Row index={index} />} />
      </main>;
    }
    createRoot(document.getElementById('root')).render(<ErrorBoundary><Page /></ErrorBoundary>);
    fetch('/ready');
  `);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/ready') { markReady(); return new Response('ok'); }
    return htmlResponse('<div id="root"></div><script src="/fixture.js"></script>');
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-feed-churn-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Churn browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    for (const top of [4000, 20000, 999999, 0, 999999]) {
      await page.evaluate(`document.querySelector('.feed').scrollTop = ${top}`);
      await page.settle();
    }
    const frames = (count: number) => page!.evaluate(`new Promise(async resolve => { for (let i = 0; i < ${count}; i++) await new Promise(requestAnimationFrame); resolve(true); })`);
    await frames(10);
    const before = await page.evaluate(`window.__renders`);
    // Sixty frames (one second) with nobody touching the page: a stopped list draws nothing more.
    await frames(60);
    const after = await page.evaluate(`window.__renders`);
    const state = await page.evaluate(`({ feed: !!document.querySelector('.feed'), boundary: !!document.querySelector('.viewer-error-card'),
      errors: window.__errors.slice(0, 2), stops: window.__warnings.filter(text => text.includes('did not settle')).length })`);
    expect({ feed: state.feed, boundary: state.boundary, errors: state.errors }).toEqual({ feed: true, boundary: false, errors: [] });
    // Said, but at most once per episode the reader started (the load and five scrolls), never once per pass or per frame.
    expect(state.stops).toBeGreaterThanOrEqual(1);
    expect(state.stops).toBeLessThanOrEqual(6);
    expect(after - before).toBe(0);
    // The reader scrolling starts it again, and it stops again within the cap: rows are drawn where the reader is.
    await page.evaluate(`document.querySelector('.feed').scrollTop = 30000`);
    await frames(10);
    expect(await page.evaluate(`[...document.querySelectorAll('[data-feed-key]')].some(row => { const r = row.getBoundingClientRect(); return r.bottom > 0 && r.top < 600; })`)).toBe(true);
    const settledAgain = await page.evaluate(`window.__renders`);
    await frames(60);
    expect(await page.evaluate(`window.__renders`)).toBe(settledAgain);
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('ordinary updates in a background tab never count as an unsettled list', async () => {
  // A hidden tab runs no animation frames and no resize observations. Live rows still
  // arrive, each as its own update; they must not add up to the pass cap (which would
  // print a false warning and leave every later update waiting for a frame that never comes).
  const bundle = compileBrowserFixture(`
    import React, { useRef, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { WindowedFeed, feedItemKey } from './src/ui/viewer/components/WindowedFeed';
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.__warnings = [];
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => { window.__warnings.push(args.map(String).join(' ').slice(0, 300)); originalWarn(...args); };
    const prompt = id => ({ itemType: 'prompt', id, project: 'p', platform_source: 'claude', content_session_id: 's',
      prompt_number: id, prompt_text: 'row ' + id, created_at_epoch: 1793800000000 + id });
    function Page() {
      const ref = useRef(null);
      const [items, setItems] = useState(() => Array.from({ length: 120 }, (_, i) => prompt(120 - i)));
      window.addRow = () => setItems(old => [prompt(old[0].id + 1), ...old]);
      return <main className="feed" ref={ref} style={{ height: '600px', overflowY: 'auto' }}>
        <WindowedFeed items={items} itemKey={feedItemKey} scrollRef={ref} renderItem={item => <div style={{ height: 40 + (item.id % 4) * 30 }}>{item.prompt_text}</div>} />
      </main>;
    }
    createRoot(document.getElementById('root')).render(<Page />);
    fetch('/ready');
  `);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/ready') { markReady(); return new Response('ok'); }
    return htmlResponse('<div id="root"></div><script src="/fixture.js"></script>');
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-feed-hidden-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Background-tab browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.evaluate(`document.querySelector('.feed').scrollTop = 2000`);
    // Thirty live rows, each its own task, as stream events arrive.
    await page.evaluate(`new Promise(resolve => { let left = 30; const next = () => { window.addRow(); if (--left) setTimeout(next, 0); else setTimeout(resolve, 50); }; next(); })`);
    const state = await page.evaluate(`({ warnings: window.__warnings.filter(text => text.includes('did not settle')),
      newest: document.querySelector('[data-feed-key]')?.dataset.feedKey ?? null, total: document.querySelector('[aria-setsize]').getAttribute('aria-setsize') })`);
    expect(state).toEqual({ warnings: [], newest: expect.any(String), total: '150' });
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 60_000);

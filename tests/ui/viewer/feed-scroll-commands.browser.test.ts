import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the timeline scroll commands (Top, Home, End).');

// A windowed list re-pinned its anchor row on every scroll frame. Writing scrollTop
// cancels a smooth scroll, so the pinned bar's Top and the floating Top moved a line
// and stopped, and Home and End stopped short while estimated row heights were
// replaced by real ones (Phase 9 review, finding 1). Each command must land in one
// press, with smooth scrolling and with reduced motion, on a short and a long list.

function words(seed: number, count: number): string {
  const pool = ['memory', 'timeline', 'worker', 'session', 'summary', 'prompt', 'observation', 'cursor', 'offset', 'window',
    'render', 'layout', 'anchor', 'scroll', 'height', 'estimate', 'viewer', 'release', 'branch', 'merge', 'queue'];
  return Array.from({ length: count }, (_, index) => pool[(seed * 7 + index * 13) % pool.length]).join(' ');
}

const kinds = ['observations', 'summaries', 'prompts'] as const;
const BASE = Date.UTC(2026, 10, 15, 23, 0, 0);
// 47 minutes apart: a long list spans many days, so the day rail has marks to merge.
const SPACING_MS = 47 * 60_000;

/** Rows of very different heights (one-line prompts, long prompts, summaries with long sections), as in real history. */
function row(kind: typeof kinds[number], index: number) {
  const id = index + 1;
  const at = BASE - (index * 3 + kinds.indexOf(kind)) * SPACING_MS;
  const common = { id, project: 'fixture', platform_source: 'claude', content_session_id: 'session-' + Math.floor(index / 20),
    memory_session_id: 'memory-' + Math.floor(index / 20), created_at_epoch: at, created_at: new Date(at).toISOString() };
  if (kind === 'observations') return { ...common, type: ['discovery', 'change', 'feature', 'decision'][index % 4],
    title: 'Observation ' + id + ' ' + words(id, 4 + (id % 9)), subtitle: words(id + 1, 10 + (id % 5) * 14),
    narrative: words(id + 2, 80), text: null, facts: JSON.stringify([words(id, 8), words(id + 3, 12)]), concepts: '[]',
    files_read: '[]', files_modified: '[]', prompt_number: 1 };
  if (kind === 'summaries') return { ...common, session_id: common.content_session_id, request: 'Summary ' + id + ' ' + words(id, 10),
    investigated: words(id, 20 + (id % 7) * 30), learned: words(id + 1, 30 + (id % 5) * 40), completed: words(id + 2, 20 + (id % 3) * 25),
    next_steps: words(id + 3, 15 + (id % 4) * 60), notes: id % 2 ? words(id + 4, 40) : null };
  return { ...common, prompt_number: id, prompt_text: id % 5 === 0 ? words(id, 220) : 'use the plan ' + id };
}

const CAPTURE = `
  window.__errors = [];
  window.__warnings = [];
  window.addEventListener('error', event => window.__errors.push(String(event.message)));
  const originalError = console.error.bind(console);
  console.error = (...args) => { const text = args.map(String).join(' '); if (/React error|Maximum update depth|ErrorBoundary/.test(text)) window.__errors.push(text.slice(0, 300)); originalError(...args); };
  const originalWarn = console.warn.bind(console);
  console.warn = (...args) => { window.__warnings.push(args.map(String).join(' ').slice(0, 300)); originalWarn(...args); };
`;

type Sample = { top: number; max: number };
const sample = (page: DevToolsPage) => page.evaluate(`(() => { const f = document.querySelector('.feed'); return { top: f.scrollTop, max: f.scrollHeight - f.clientHeight }; })()`) as Promise<Sample>;

/** Waits until the list has not moved for 600ms (or 10s pass), then returns where it stopped. */
async function settled(page: DevToolsPage): Promise<Sample> {
  const deadline = Date.now() + 10_000;
  let last = await sample(page);
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    const now = await sample(page);
    if (Math.abs(now.top - last.top) > 0.5 || Math.abs(now.max - last.max) > 0.5) { last = now; stillSince = Date.now(); continue; }
    if (Date.now() - stillSince >= 600) return now;
  }
  return last;
}

async function clickAt(page: DevToolsPage, selector: string) {
  const point = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function press(page: DevToolsPage, key: 'Home' | 'End') {
  const code = key === 'Home' ? 36 : 35;
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

async function jumpTo(page: DevToolsPage, where: 'bottom' | 'middle') {
  await page.evaluate(`(() => { const f = document.querySelector('.feed'); f.scrollTop = ${where === 'bottom' ? 'f.scrollHeight' : 'f.scrollHeight / 2'}; })()`);
  // Let the window settle where it was put (rows drawn and measured) before the command under test.
  await settled(page);
  if (where === 'bottom') {
    await page.evaluate(`(() => { const f = document.querySelector('.feed'); f.scrollTop = f.scrollHeight; })()`);
    await settled(page);
  }
}

/** Click inside a card's left padding (nothing focusable there), the way a reader puts the page's keys on the list. */
async function clickIntoList(page: DevToolsPage) {
  const point = await page.evaluate(`(() => {
    const feed = document.querySelector('.feed').getBoundingClientRect();
    const card = [...document.querySelectorAll('.card')].find(c => { const r = c.getBoundingClientRect(); return r.bottom > feed.top + 100 && r.top < feed.bottom - 100; });
    const r = card.getBoundingClientRect();
    return { x: r.left + 8, y: Math.max(r.top, feed.top + 100) + 10 };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function runCommands(page: DevToolsPage, label: string) {
  const results: Record<string, unknown> = {};
  for (const motion of ['smooth', 'reduce'] as const) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion === 'reduce' ? 'reduce' : 'no-preference' }] });

    await jumpTo(page, 'bottom');
    await clickAt(page, '.feed-position-top');
    results[`${motion} pinned Top`] = (await settled(page)).top;

    await jumpTo(page, 'bottom');
    await clickAt(page, '.scroll-to-top');
    results[`${motion} floating Top`] = (await settled(page)).top;

    await jumpTo(page, 'bottom');
    await clickIntoList(page);
    await press(page, 'Home');
    results[`${motion} Home`] = (await settled(page)).top;

    await jumpTo(page, 'middle');
    await clickIntoList(page);
    await press(page, 'End');
    const end = await settled(page);
    results[`${motion} End short by`] = Math.max(0, end.max - end.top);
    results[`${motion} End line in view`] = await page.evaluate(`(() => { const e = document.querySelector('.feed-ending--end'); if (!e) return false; const r = e.getBoundingClientRect(), f = document.querySelector('.feed').getBoundingClientRect(); return r.top < f.bottom && r.bottom > f.top; })()`);
  }
  const health = await page.evaluate(`({ boundary: !!document.querySelector('.viewer-error-card'), errors: window.__errors.slice(0, 3),
    stopped: window.__warnings.filter(text => text.includes('did not settle')).slice(0, 1) })`);
  console.log(`SCROLL_COMMANDS ${label}`, JSON.stringify({ ...results, ...health }));
  for (const motion of ['smooth', 'reduce']) {
    expect(results[`${motion} pinned Top`] as number).toBeLessThanOrEqual(1);
    expect(results[`${motion} floating Top`] as number).toBeLessThanOrEqual(1);
    expect(results[`${motion} Home`] as number).toBeLessThanOrEqual(1);
    expect(results[`${motion} End short by`] as number).toBeLessThanOrEqual(1);
    expect(results[`${motion} End line in view`]).toBe(true);
  }
  expect(health).toEqual({ boundary: false, errors: [], stopped: [] });
}

(chromeExecutablePath ? it : it.skip)('Top, Home and End land in one press on the first page of the timeline (150 rows)', async () => {
  const PER_KIND = 50;
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    ${CAPTURE}
    createRoot(document.getElementById('root')).render(<ErrorBoundary withHeader><App /></ErrorBoundary>);
    fetch('/ready');
  `);
  const html = readViewerTemplateHtml();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(html);
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["fixture"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const kind = kinds.find(name => url.pathname === `/api/${name}`);
    if (kind) {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const items = [];
      for (let index = offset; index < Math.min(PER_KIND, offset + limit); index++) items.push(row(kind, index));
      return Response.json({ items, hasMore: offset + limit < PER_KIND }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-scroll-150-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1440,900'] });
    await withTimeout(ready, 30_000, 'Scroll-command browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.evaluate(`new Promise(resolve => { const check = () => document.querySelector('.feed-ending--end') ? resolve(true) : setTimeout(check, 50); check(); })`);
    expect(await page.evaluate(`({ rows: Number(document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0), windowed: document.querySelector('[data-windowed]').dataset.windowed })`))
      .toEqual({ rows: PER_KIND * 3, windowed: 'true' });
    await runCommands(page, '150 rows');
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 180_000);

(chromeExecutablePath ? it : it.skip)('Top, Home and End land in one press on a long history (4,200 rows)', async () => {
  const PER_KIND = 1400;
  const items = kinds.flatMap(kind => Array.from({ length: PER_KIND }, (_, index) => ({ ...row(kind, index),
    itemType: kind === 'observations' ? 'observation' : kind === 'summaries' ? 'summary' : 'prompt' })))
    .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  const bundle = compileBrowserFixture(`
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Feed } from './src/ui/viewer/components/Feed';
    import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
    ${CAPTURE}
    function Page() {
      const [items, setItems] = useState([]);
      useEffect(() => { fetch('/items.json').then(response => response.json()).then(setItems); }, []);
      return <Feed items={items} onLoadMore={() => {}} onDeleted={() => {}} isLoading={items.length === 0} hasMore={false} />;
    }
    createRoot(document.getElementById('root')).render(<ErrorBoundary withHeader><Page /></ErrorBoundary>);
    fetch('/ready');
  `);
  const html = readViewerTemplateHtml();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(html);
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/items.json') return Response.json(items);
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-scroll-4200-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1440,900'] });
    await withTimeout(ready, 30_000, 'Long scroll-command browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.evaluate(`new Promise(resolve => { const check = () => document.querySelector('.feed-ending--end') ? resolve(true) : setTimeout(check, 50); check(); })`);
    expect(await page.evaluate(`Number(document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0)`)).toBe(PER_KIND * 3);
    // Days too close together on the rail are merged into one mark that says how many it holds.
    const rail = await page.evaluate(`[...document.querySelectorAll('.feed-day-rail-mark')].map(mark => ({ text: mark.textContent, name: mark.getAttribute('aria-label') }))`);
    expect(rail.length).toBeGreaterThan(1);
    expect(rail.some((mark: { text: string; name: string | null }) => /\+\d+$/.test(mark.text) && /and \d+ more days$/.test(mark.name ?? ''))).toBe(true);
    await runCommands(page, '4,200 rows');
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 240_000);

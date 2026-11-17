import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the classic viewer App wiring checks.');

// The real App against a fake worker: the wiring that a component fixture cannot prove. "Show all in the timeline"
// under a shortened Settings preview (F24), Top and Memory logs at 1024px (decision c), the session page's
// "← Back to sessions" with the browser's Back (F21), its heading at 390px, its time span on focus and tap (L15),
// and a timeline search that keeps "<n> times in a row" true (G2).

const PROJECT = 'acme-project';
const SESSION = { platformSource: 'claude', contentSessionId: 'session-1' };
const SHORTENED_PREVIEW = 'Recent context\n\n\x1b[0m\n\n[Terminal preview truncated. The model received the full selected context; additional observations are not shown here.]\n  #1  5:21 PM  kept row\n';

const bundle = () => compileBrowserFixture(`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { App } from './src/ui/viewer/App';
  import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
  import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
  setStoredWelcomeDismissed(true);
  window.confirm = () => { throw new Error('The viewer must not use the browser confirm box'); };
  createRoot(document.getElementById('root')).render(<ErrorBoundary withHeader><App /></ErrorBoundary>);
  fetch('/ready');
`);

function serve(script: string) {
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const requests: string[] = [];
  const base = Date.UTC(2026, 10, 15, 20, 0, 0);
  const common = (id: number) => ({ id, project: PROJECT, platform_source: 'claude', content_session_id: SESSION.contentSessionId,
    memory_session_id: 'memory', created_at_epoch: base - id * 60_000, created_at: new Date(base - id * 60_000).toISOString() });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/') return htmlResponse(readViewerTemplateHtml());
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(script);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'initial_load', projects: [PROJECT, 'other-project'] })}\n\n`));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    // 60 observations, enough to scroll a 1024px window; none of them says "continue".
    if (url.pathname === '/api/observations') return Response.json({ items: Array.from({ length: 60 }, (_, i) => ({ ...common(i + 1), type: 'discovery',
      title: `Observation ${i + 1}`, subtitle: 'One line under the title', narrative: 'The narrative', text: null, facts: '["One fact"]',
      concepts: '[]', files_read: '[]', files_modified: '[]', prompt_number: 1 })), hasMore: false });
    if (url.pathname === '/api/summaries') return Response.json({ items: [{ ...common(70), session_id: SESSION.contentSessionId, request: 'Ship the session page',
      investigated: 'Looked around', learned: 'Learned a thing', completed: 'Did a thing', next_steps: 'Do the next thing', notes: null }], hasMore: false });
    // "continue", then another prompt, then "continue" again: typed twice, but not in a row. The newest rows, so
    // they are drawn at the top of the windowed list (64 rows, past its 50).
    const newest = (id: number, minutesAfter: number) => ({ ...common(id), created_at_epoch: base + minutesAfter * 60_000,
      created_at: new Date(base + minutesAfter * 60_000).toISOString() });
    if (url.pathname === '/api/prompts') return Response.json({ items: [
      { ...newest(80, 3), prompt_number: 3, prompt_text: 'continue' },
      { ...newest(81, 2), prompt_number: 2, prompt_text: 'run tests' },
      { ...newest(82, 1), prompt_number: 1, prompt_text: 'continue' },
    ], hasMore: false });
    if (url.pathname === '/api/sessions') return Response.json({ sessions: [{ content_session_id: SESSION.contentSessionId, platform_source: 'claude',
      project: PROJECT, custom_title: null, summary_title: 'Ship the session page', started_at_epoch: base - 90 * 60_000, item_count: 64 }], hasMore: false });
    if (url.pathname === '/api/projects') return Response.json({ projects: [PROJECT], sources: ['claude'], projectsBySource: { claude: [PROJECT] } });
    if (url.pathname === '/api/context/preview') return new Response(SHORTENED_PREVIEW);
    if (url.pathname === '/api/logs') return Response.json({ logs: '[2026-11-16 18:00:00.000] [INFO ] [WORKER] one line', path: '/x/claude-mem.log', totalLines: 1 });
    return Response.json({});
  } });
  return { server, ready, requests };
}

interface Opened { server: ReturnType<typeof Bun.serve>; chrome: OwnedChrome; page: DevToolsPage; requests: string[] }

async function openApp(width: number, height: number, profile: string): Promise<Opened> {
  const { server, ready, requests } = serve(bundle());
  const chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: profile,
    extraFlags: [...UNTHROTTLED_TIMER_FLAGS, `--window-size=${Math.max(width, 500)},${height}`] });
  try {
    await withTimeout(ready, 30_000, 'Viewer did not become ready');
    const page = await connectToPage(chrome, server.url.href);
    // Headless Chrome hides the page on a native Escape, which stops the frames settle() waits for.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Top scrolls at once instead of smoothly, so the test reads where it ends.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    if (width < 500) await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await until(page, `document.querySelectorAll('.card').length >= 8`, 'the timeline cards');
    return { server, chrome, page, requests };
  } catch (error) { await chrome.close(); server.stop(true); throw error; }
}

async function close(opened: Opened | undefined) {
  opened?.page.close();
  await opened?.chrome.close();
  opened?.server.stop(true);
}

async function until(page: DevToolsPage, expression: string, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await page.evaluate(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const clickByText = (selector: string, text: string) =>
  `(() => { const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.textContent.trim() === ${JSON.stringify(text)}); target.click(); return true; })()`;

(chromeExecutablePath ? it : it.skip)('"Show all in the timeline" under a shortened preview closes Settings and shows that project\'s timeline', async () => {
  let opened: Opened | undefined;
  try {
    opened = await openApp(1440, 900, 'claude-mem-app-show-all-');
    const { page, requests } = opened;
    await page.evaluate(`document.querySelector('.settings-btn').click()`);
    await until(page, `[...document.querySelectorAll('.terminal-note button')].some(button => button.textContent === 'Show all in the timeline')`,
      'the shortened note with its Show all');
    expect(await page.evaluate(`document.querySelector('.terminal-note').textContent.includes('Preview shortened.')`)).toBe(true);
    await page.evaluate(clickByText('.terminal-note button', 'Show all in the timeline'));
    await until(page, `!document.querySelector('.context-settings-modal')`, 'Settings to close');
    await until(page, `document.querySelector('.project-picker-trigger')?.textContent.includes(${JSON.stringify(PROJECT)})`, 'the header filter on the project');
    expect(await page.evaluate(`({ hash: location.hash, timeline: !!document.querySelector('main.feed') })`)).toEqual({ hash: '', timeline: true });
    const deadline = Date.now() + 10_000;
    while (!requests.some(line => line.startsWith('GET /api/observations') && line.includes(`project=${PROJECT}`))) {
      if (Date.now() > deadline) throw new Error('The timeline did not ask for the project');
      await Bun.sleep(25);
    }
  } finally { await close(opened); }
}, 90_000);

(chromeExecutablePath ? it : it.skip)('at 1024px Top is in the pinned bar and Memory logs in "…", with the floating buttons hidden', async () => {
  let opened: Opened | undefined;
  try {
    opened = await openApp(1024, 800, 'claude-mem-app-1024-');
    const { page } = opened;
    expect(await page.evaluate(`({ width: innerWidth, logs: getComputedStyle(document.querySelector('.console-toggle-btn')).display })`))
      .toEqual({ width: 1024, logs: 'none' });
    // Scrolled down, the floating Top is drawn but hidden at this width; the pinned bar shows the position and its
    // own Top, which goes back to the start.
    await page.evaluate(`document.querySelector('main.feed').scrollTop = 2400`);
    await until(page, `!document.querySelector('.feed-position-bar').hidden && !!document.querySelector('.scroll-to-top')`, 'the pinned bar');
    expect(await page.evaluate(`({ floatingTop: getComputedStyle(document.querySelector('.scroll-to-top')).display,
      barTop: document.querySelector('.feed-position-top').getBoundingClientRect().height })`)).toEqual({ floatingTop: 'none', barTop: expect.any(Number) });
    expect(await page.evaluate(`document.querySelector('.feed-position-top').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(24);
    await page.evaluate(`document.querySelector('.feed-position-top').click()`);
    await until(page, `document.querySelector('main.feed').scrollTop === 0`, 'Top to reach the start');
    // "…" holds Memory logs, which opens the drawer.
    await page.evaluate(`document.querySelector('.header-more').click()`);
    await until(page, `[...document.querySelectorAll('.header-menu [role="menuitem"]')].some(item => item.textContent.trim() === 'Memory logs' && item.getClientRects().length)`,
      'Memory logs in the menu');
    await page.evaluate(clickByText('.header-menu [role="menuitem"]', 'Memory logs'));
    await until(page, `!!document.querySelector('.console-drawer')`, 'the logs drawer');
  } finally { await close(opened); }
}, 90_000);

for (const width of [1440, 390]) {
  (chromeExecutablePath ? it : it.skip)(`the session page says "← Back to sessions", the browser's Back works, and its heading leads (${width}px)`, async () => {
    let opened: Opened | undefined;
    try {
      opened = await openApp(width, width === 390 ? 844 : 900, `claude-mem-app-session-${width}-`);
      const { page } = opened;
      await page.evaluate(`location.hash = '#/sessions/claude/session-1'`);
      await until(page, `!!document.querySelector('.session-detail-title') && document.querySelector('.session-detail-title').textContent === 'Ship the session page'`,
        'the session page');
      await until(page, `document.querySelectorAll('main.feed .card-title').length > 0`, 'the session\'s cards');
      const head = await page.evaluate(`(() => {
        const back = document.querySelector('.session-detail-back');
        const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
        const box = back.getBoundingClientRect();
        return { words: back.textContent, arrow: !!back.querySelector('svg'), href: back.getAttribute('href'), visible: box.width > 0 && box.height >= 24,
          breadcrumb: !!document.querySelector('.session-breadcrumb'), heading: size('.session-detail-title'), card: size('main.feed .card-title') };
      })()`);
      expect(head).toEqual({ words: 'Back to sessions', arrow: true, href: '#/sessions', visible: true, breadcrumb: true,
        heading: expect.any(Number), card: expect.any(Number) });
      // F21: the page's heading is larger than a card title at every width.
      expect(head.heading).toBeGreaterThan(head.card);

      // L15: the time span's full stamps open on focus and on tap too, not only on hover.
      const span = `document.querySelector('.session-detail-span .short-time')`;
      await page.evaluate(`${span}.focus()`);
      const focused = await page.evaluate(`({ tag: ${span}.tagName, full: ${span}.getAttribute('aria-label'), shown: ${span}.textContent,
        tooltip: getComputedStyle(${span}, '::after').content })`);
      expect(focused.tag).toBe('BUTTON');
      expect(focused.full).toContain(' – ');
      expect(focused.tooltip).toBe(JSON.stringify(focused.full));
      await page.evaluate(`${span}.click()`);
      expect(await page.evaluate(`({ pressed: ${span}.getAttribute('aria-pressed'), shown: ${span}.textContent })`)).toEqual({ pressed: 'true', shown: focused.full });

      // "← Back to sessions" goes to the list; the browser's Back returns to the session and Back again to the list.
      await page.evaluate(`document.querySelector('.session-detail-back').click()`);
      await until(page, `location.hash === '#/sessions' && !!document.querySelector('.session-list')`, 'the Sessions list');
      await page.evaluate(`history.back()`);
      await until(page, `location.hash === '#/sessions/claude/session-1' && !!document.querySelector('.session-detail-title')`, 'the session page after Back');
      await page.evaluate(`history.back()`);
      await until(page, `location.hash === '' && !!document.querySelector('main.feed') && !document.querySelector('.session-detail-title')`, 'the timeline after Back again');
    } finally { await close(opened); }
  }, 90_000);
}

(chromeExecutablePath ? it : it.skip)('a timeline search keeps "<n> times in a row" true: prompts another prompt separated stay apart', async () => {
  let opened: Opened | undefined;
  try {
    opened = await openApp(1440, 900, 'claude-mem-app-search-fold-');
    const { page } = opened;
    // Unfiltered: "continue", "run tests", "continue" are three rows, none folded.
    await until(page, `document.querySelectorAll('.prompt-card').length === 3`, 'the three prompts');
    expect(await page.evaluate(`document.querySelectorAll('.prompt-repeat-chip').length`)).toBe(0);
    await page.evaluate(`document.querySelector('.timeline-search input').focus()`);
    await page.send('Input.insertText', { text: 'continue' });
    await until(page, `document.querySelector('.timeline-search-note')?.textContent.startsWith('2 of the')`, 'the search note');
    expect(await page.evaluate(`({ rows: [...document.querySelectorAll('.prompt-card .prompt-text')].map(text => text.textContent),
      chips: document.querySelectorAll('.prompt-repeat-chip').length })`)).toEqual({ rows: ['continue', 'continue'], chips: 0 });
  } finally { await close(opened); }
}, 90_000);

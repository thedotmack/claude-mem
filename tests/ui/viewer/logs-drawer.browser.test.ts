import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { MIN_DRAWER_HEIGHT } from '../../../src/ui/viewer/components/LogsModal';

failOnCiWithoutChrome('CI requires Chrome for the logs drawer checks.');

// The Memory logs drawer (F4, F14, B3) inside the real viewer stylesheet, against a fake worker:
// loading before the first read, counts per level, Find in logs, recycled rows, the in-page clear
// question, keyboard and button resizing, no emoji, and nothing past the drawer edge at 390px.

const FILE_PATH = '/Users/someone/.claude-mem/logs/claude-mem-2026-11-16.log';
const record = (index: number, level: string, component: string, message: string) =>
  `[2026-11-16 18:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index % 1000).padStart(3, '0')}] [${level.padEnd(5)}] [${component.padEnd(6)}] ${message}`;

/** 1,000 lines: 1 debug, 3 warnings, 2 errors (one with two stack lines under it), one very long line, the rest info. */
function sampleLines(): { text: string; counts: Record<string, number> } {
  const lines: string[] = [];
  const counts: Record<string, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  const add = (level: string, component: string, message: string) => { counts[level] += 1; lines.push(record(lines.length, level, component, message)); };
  add('DEBUG', 'SDK', 'LINE-FIRST debug line');
  for (let index = 0; lines.length < 990; index++) {
    if (index === 100) add('WARN', 'QUEUE', 'queue depth 69 needle');
    else if (index === 200) add('WARN', 'HTTP', 'GET /api/observations took 7,412 ms');
    else if (index === 300) add('WARN', 'SESSION', 'session slow');
    else if (index === 400) { add('ERROR', 'WORKER', 'reviews: database is locked'); lines.push('  Error: database is locked', '    at step (db.ts:1:1)'); }
    else if (index === 500) add('INFO', 'DB', `LONG-LINE ${'x'.repeat(5000)} END-OF-LONG-LINE`);
    else add('INFO', 'WORKER', `LINE-${String(index).padStart(4, '0')} plain info filler`);
  }
  while (lines.length < 999) add('INFO', 'HOOK', `LINE-TAIL-${lines.length}`);
  add('ERROR', 'DB', 'LINE-LAST media convert failed needle');
  return { text: lines.join('\n'), counts };
}

interface Worker {
  server: ReturnType<typeof Bun.serve>;
  release: () => void;
  setLogs: (body: object) => void;
  reads: () => number;
  clears: () => number;
}

function startWorker(script: string, holdFirstRead: boolean, initialBody: object): { worker: Worker; ready: Promise<void> } {
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let release!: () => void;
  const held = holdFirstRead ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  if (!holdFirstRead) release = () => {};
  let body = initialBody;
  let reads = 0;
  let clears = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(readViewerTemplateHtml());
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(script);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/api/logs') {
      reads += 1;
      if (reads === 1) await held;
      return Response.json(body);
    }
    if (url.pathname === '/api/logs/clear' && request.method === 'POST') {
      clears += 1;
      body = { logs: '', path: FILE_PATH, exists: true, totalLines: 0, returnedLines: 0 };
      return Response.json({ success: true });
    }
    return Response.json({});
  } });
  return { worker: { server, release: () => release(), setLogs: next => { body = next; }, reads: () => reads, clears: () => clears }, ready };
}

const bundle = () => compileBrowserFixture(`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { LogsDrawer } from './src/ui/viewer/components/LogsModal';
  window.confirm = () => { throw new Error('the logs drawer must not use the browser confirm box'); };
  createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={() => { window.closed = true; }} />);
  fetch('/ready');
`);

async function openDrawer(width: number, height: number, holdFirstRead: boolean, initialBody: object) {
  const { worker, ready } = startWorker(bundle(), holdFirstRead, initialBody);
  const pageUrl = worker.server.url.href;
  const chrome = launchChrome(pageUrl, { remoteDebugging: true, profilePrefix: 'claude-mem-logs-drawer-',
    extraFlags: [...UNTHROTTLED_TIMER_FLAGS, `--window-size=${width},${height}`] });
  await withTimeout(ready, 30_000, 'Logs drawer browser did not become ready');
  const page = await connectToPage(chrome, pageUrl);
  // Headless Chrome will not make a window narrower than 500px; a phone width is emulated instead.
  if (width < 500) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    // Mount the drawer again at the phone width, so it opens the way it does on a phone.
    await page.send('Page.reload', {});
    await waitFor(page, `document.readyState === 'complete' && !!document.querySelector('.console-drawer')`, 'the reload at phone width');
  }
  // Headless Chrome hides the page on a native Escape, which stops the frames settle() waits for.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.settle();
  return { worker, chrome, page };
}

async function waitFor(page: DevToolsPage, expression: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await page.evaluate(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

async function press(page: DevToolsPage, key: string, code: string, keyCode: number): Promise<void> {
  const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  await page.settle();
}

const listWords = `document.querySelector('.console-content .log-line-empty')?.textContent ?? null`;
const drawerHeight = `Math.round(document.querySelector('.console-drawer').getBoundingClientRect().height)`;

(chromeExecutablePath ? it : it.skip)('loads before it says "No logs available yet.", then counts, finds, recycles and resizes (1440px)', async () => {
  let opened: Awaited<ReturnType<typeof openDrawer>> | undefined;
  try {
    opened = await openDrawer(1440, 900, true, { logs: '', path: FILE_PATH, exists: true, totalLines: 0, returnedLines: 0 });
    const { worker, page } = opened;

    // B3: while the first read is on its way the list says it is loading, never that there are no logs.
    await waitFor(page, `!!document.querySelector('.console-content .log-line-empty')`, 'the list area');
    expect(await page.evaluate(`({ words: ${listWords}, role: document.querySelector('.console-content .log-line-empty').getAttribute('role'),
      chips: [...document.querySelectorAll('.console-filter-section--levels .console-filter-chip')].map(chip => chip.textContent.trim()) })`))
      // No counts yet: a 0 before the first read would be a number nobody measured.
      .toEqual({ words: 'Loading logs…', role: 'status', chips: ['Debug', 'Info', 'Warn', 'Error'] });
    worker.release();
    await waitFor(page, `${listWords} === 'No logs available yet.'`, 'the empty words after an empty read');

    // A read with lines: counts per level over all of them, with the window they cover.
    const { text, counts } = sampleLines();
    worker.setLogs({ logs: text, path: FILE_PATH, exists: true, totalLines: 72095, returnedLines: 1000 });
    await page.evaluate(`document.querySelector('[title="Refresh logs"]').click()`);
    await waitFor(page, `!!document.querySelector('.console-row')`, 'rows after Refresh');
    await page.settle();
    const summary = await page.evaluate(`(() => {
      const drawer = document.querySelector('.console-drawer');
      const levels = document.querySelector('.console-filter-section--levels');
      return {
        region: { tag: drawer.tagName, name: document.getElementById(drawer.getAttribute('aria-labelledby'))?.textContent },
        chips: [...levels.querySelectorAll('.console-filter-chip')].map(chip => chip.textContent.trim()),
        pressed: [...levels.querySelectorAll('.console-filter-chip')].map(chip => chip.getAttribute('aria-pressed')),
        checks: levels.querySelectorAll('.console-filter-chip svg').length,
        note: document.getElementById(levels.getAttribute('aria-describedby'))?.textContent,
        meta: document.querySelector('.console-meta').textContent.split(' · ')[0],
        emoji: (drawer.innerText.match(/\\p{Extended_Pictographic}/gu) ?? []).length,
        glyphs: (drawer.innerText.match(/[↻⬇🗑✕○●⚠]/gu) ?? []).length,
        filters: drawer.querySelectorAll('.console-filter-chip').length,
        selectWords: [...drawer.querySelectorAll('.console-filter-action')].map(button => button.textContent),
        rowsDrawn: drawer.querySelectorAll('.console-row').length,
        setSize: drawer.querySelector('[role="listitem"]').getAttribute('aria-setsize'),
        elements: drawer.querySelectorAll('*').length,
        rowHeight: Math.round(drawer.querySelector('.console-row-toggle').getBoundingClientRect().height),
        lastShown: [...drawer.querySelectorAll('.log-message')].some(message => message.textContent.includes('LINE-LAST')),
      };
    })()`);
    expect(summary).toEqual({
      region: { tag: 'SECTION', name: 'Memory logs' },
      chips: [`Debug ${counts.DEBUG}`, `Info ${counts.INFO}`, `Warn ${counts.WARN}`, `Error ${counts.ERROR}`],
      pressed: ['true', 'true', 'true', 'true'],
      checks: 4,
      note: 'in the last 1,000 lines',
      meta: '1,000 lines',
      emoji: 0,
      glyphs: 0,
      // Alignment, the four levels and the ten components: all fifteen filters stay.
      filters: 15,
      selectWords: ['Select none', 'Select none'],
      rowsDrawn: expect.any(Number),
      setSize: '1000',
      elements: expect.any(Number),
      rowHeight: 36,
      // The drawer opens on the newest lines.
      lastShown: true,
    });
    // 1,000 lines hold 998 entries: the error's two stack lines are not entries of their own.
    expect(counts).toEqual({ DEBUG: 1, INFO: 992, WARN: 3, ERROR: 2 });
    // Recycled rows: a window of rows, not 1,000 (the review counted 5,522 elements for 1,000 lines).
    expect(summary.rowsDrawn).toBeLessThan(60);
    expect(summary.elements).toBeLessThan(700);

    // Scrolling to the top draws the first line.
    await page.evaluate(`document.querySelector('.console-content').scrollTop = 0`);
    await page.settle();
    expect(await page.evaluate(`[...document.querySelectorAll('.log-message')].some(message => message.textContent.includes('LINE-FIRST'))`)).toBe(true);

    // Find in logs filters the loaded lines and says so.
    await page.evaluate(`document.getElementById('console-search-input').focus()`);
    await page.send('Input.insertText', { text: 'needle' });
    await page.settle();
    expect(await page.evaluate(`({ note: document.querySelector('.console-search-note').textContent,
      rows: [...document.querySelectorAll('.console-drawer .log-message')].map(message => message.textContent) })`)).toEqual({
      note: '2 of the last 1,000 lines match. Older lines in the log file are not searched.',
      rows: ['queue depth 69 needle', 'LINE-LAST media convert failed needle'],
    });
    await page.send('Input.insertText', { text: ' nothing-has-this' });
    await page.settle();
    expect(await page.evaluate(listWords)).toBe('No loaded line has these words. Change the search or clear it.');
    await page.evaluate(`document.getElementById('console-search-input').select()`);
    await press(page, 'Backspace', 'Backspace', 8);
    await waitFor(page, `document.querySelector('.console-drawer [role="listitem"]')?.getAttribute('aria-setsize') === '1000'`, 'every line back after clearing the search');

    // The reader scrolled to the top earlier, so the list stays there; "Jump to newest" goes to the end.
    expect(await page.evaluate(`[...document.querySelectorAll('.log-message')].some(message => message.textContent.includes('LINE-LAST'))`)).toBe(false);
    await page.evaluate(`document.querySelector('[title="Jump to newest"]').click()`);
    await page.settle();
    // A row opens on click, with its whole line and Copy line.
    await page.evaluate(`[...document.querySelectorAll('.console-row-toggle')].find(row => row.textContent.includes('LINE-LAST')).click()`);
    await page.settle();
    expect(await page.evaluate(`(() => {
      const row = document.querySelector('.console-row--open');
      return { expanded: row.querySelector('.console-row-toggle').getAttribute('aria-expanded'),
        full: row.querySelector('.console-row-full').textContent.includes('LINE-LAST media convert failed needle'),
        copy: row.querySelector('.copy-button')?.textContent };
    })()`)).toEqual({ expanded: 'true', full: true, copy: 'Copy line' });

    // Resizing without dragging: the bar takes arrow keys, Home and End; "Full height" toggles.
    const tallest = await page.evaluate(`window.innerHeight - 100`);
    const start = await page.evaluate(drawerHeight);
    await page.evaluate(`document.querySelector('.console-resize-handle').focus()`);
    await press(page, 'ArrowUp', 'ArrowUp', 38);
    expect(await page.evaluate(drawerHeight)).toBe(start + 36);
    await press(page, 'ArrowDown', 'ArrowDown', 40);
    expect(await page.evaluate(drawerHeight)).toBe(start);
    await press(page, 'Home', 'Home', 36);
    expect(await page.evaluate(drawerHeight)).toBe(MIN_DRAWER_HEIGHT);
    // At its smallest the drawer still shows its bar, its header and a row of logs; the filter rows scroll in the rest.
    expect(await page.evaluate(`(() => {
      const drawer = document.querySelector('.console-drawer').getBoundingClientRect();
      const header = document.querySelector('.console-header').getBoundingClientRect();
      const content = document.querySelector('.console-content').getBoundingClientRect();
      const row = document.querySelector('.console-row-toggle').getBoundingClientRect();
      return { headerInside: header.top >= drawer.top && header.bottom <= drawer.bottom, rowRoom: content.height >= row.height - 0.5 };
    })()`)).toEqual({ headerInside: true, rowRoom: true });
    await press(page, 'End', 'End', 35);
    expect(await page.evaluate(drawerHeight)).toBe(tallest);
    expect(await page.evaluate(`document.querySelector('.console-resize-handle').getAttribute('aria-valuenow')`)).toBe(String(tallest));
    await press(page, 'Home', 'Home', 36);
    const fullHeight = `[...document.querySelectorAll('.console-controls .console-btn')].find(button => button.textContent.includes('Full height'))`;
    await page.evaluate(`${fullHeight}.click()`);
    await page.settle();
    expect(await page.evaluate(`({ pressed: ${fullHeight}.getAttribute('aria-pressed'), height: ${drawerHeight} })`)).toEqual({ pressed: 'true', height: tallest });
    await page.evaluate(`${fullHeight}.click()`);
    await page.settle();
    expect(await page.evaluate(`({ pressed: ${fullHeight}.getAttribute('aria-pressed'), height: ${drawerHeight} })`)).toEqual({ pressed: 'false', height: MIN_DRAWER_HEIGHT });
    expect(worker.clears()).toBe(0);
  } finally {
    opened?.page.close();
    await opened?.chrome.close();
    opened?.worker.server.stop(true);
  }
}, 90_000);

(chromeExecutablePath ? it : it.skip)('keeps the focused row drawn while the list scrolls, so keyboard focus never falls to the page', async () => {
  let opened: Awaited<ReturnType<typeof openDrawer>> | undefined;
  try {
    const { text } = sampleLines();
    opened = await openDrawer(1440, 900, false, { logs: text, path: FILE_PATH, exists: true, totalLines: 1000, returnedLines: 1000 });
    const { page } = opened;
    await waitFor(page, `[...document.querySelectorAll('.console-row-toggle')].some(row => row.textContent.includes('LINE-TAIL-995'))`, 'the newest rows');
    await page.evaluate(`[...document.querySelectorAll('.console-row-toggle')].find(row => row.textContent.includes('LINE-TAIL-995')).focus()`);
    // Scrolled to the far start (the wheel or PageUp does the same): row 996 is 900 rows away from what is drawn.
    await page.evaluate(`document.querySelector('.console-content').scrollTop = 0`);
    await page.settle();
    await page.settle();
    const focused = `(() => { const active = document.activeElement; return { row: active?.classList.contains('console-row-toggle') ?? false,
      words: active?.textContent.includes('LINE-TAIL-995') ?? false, inDrawer: !!active?.closest('.console-drawer'),
      firstDrawn: [...document.querySelectorAll('.log-message')].some(message => message.textContent.includes('LINE-FIRST')) }; })()`;
    expect(await page.evaluate(focused)).toEqual({ row: true, words: true, inDrawer: true, firstDrawn: true });
    // Shift+Tab goes to the line before it, which is drawn beside it, not to the far start of the list or the page.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await page.settle();
    expect(await page.evaluate(`(document.activeElement?.closest('.console-row')?.textContent ?? document.activeElement?.tagName ?? '').slice(0, 80)`)).toContain('LINE-TAIL-994');
  } finally {
    opened?.page.close();
    await opened?.chrome.close();
    opened?.worker.server.stop(true);
  }
}, 90_000);

(chromeExecutablePath ? it : it.skip)('asks in the page what Clear logs… erases, and clears only on its red button', async () => {
  let opened: Awaited<ReturnType<typeof openDrawer>> | undefined;
  try {
    const { text } = sampleLines();
    opened = await openDrawer(1440, 900, false, { logs: text, path: FILE_PATH, exists: true, totalLines: 72095, returnedLines: 1000 });
    const { worker, page } = opened;
    await waitFor(page, `!!document.querySelector('.console-row')`, 'rows');
    const clear = `document.querySelector('.console-clear-btn')`;

    // The question names the file and says the whole file goes, not only the lines on screen; Cancel has focus.
    await page.evaluate(`${clear}.click()`);
    await waitFor(page, `!!document.querySelector('.console-clear-question .inline-confirm')`, 'the clear question');
    expect(await page.evaluate(`({
      question: document.querySelector('.console-clear-question .inline-confirm-question').textContent,
      focus: document.activeElement.textContent,
      expanded: ${clear}.getAttribute('aria-expanded'),
      clearWords: ${clear}.textContent,
    })`)).toEqual({
      question: 'Clear the whole log file claude-mem-2026-11-16.log? About 72,095 lines are erased, not only the 1,000 shown here. This cannot be undone.',
      focus: 'Cancel',
      expanded: 'true',
      clearWords: 'Clear logs…',
    });

    // Escape leaves it: nothing is sent and focus returns to Clear logs….
    await press(page, 'Escape', 'Escape', 27);
    expect(await page.evaluate(`({ open: !!document.querySelector('.console-clear-question'), back: document.activeElement === ${clear} })`))
      .toEqual({ open: false, back: true });
    expect(worker.clears()).toBe(0);

    // Its red button sends one clear; the list then says there are no logs.
    await page.evaluate(`${clear}.click()`);
    await waitFor(page, `!!document.querySelector('.console-clear-question .inline-confirm-danger')`, 'the clear question again');
    await page.evaluate(`document.querySelector('.console-clear-question .inline-confirm-danger').click()`);
    await waitFor(page, `${listWords} === 'No logs available yet.'`, 'the empty list after clearing');
    expect(worker.clears()).toBe(1);
    expect(await page.evaluate(`document.activeElement === ${clear}`)).toBe(true);
  } finally {
    opened?.page.close();
    await opened?.chrome.close();
    opened?.worker.server.stop(true);
  }
}, 90_000);

(chromeExecutablePath ? it : it.skip)('keeps every line and control inside the drawer at 390px, with 44px touch targets', async () => {
  let opened: Awaited<ReturnType<typeof openDrawer>> | undefined;
  try {
    const { text } = sampleLines();
    opened = await openDrawer(390, 844, false, { logs: text, path: FILE_PATH, exists: true, totalLines: 1000, returnedLines: 1000 });
    const { page } = opened;
    await waitFor(page, `!!document.querySelector('.console-row')`, 'rows');
    await page.settle();
    // PR #6229 review: a touch screen's rows measure 44px, not the 36px assumed until the first row is drawn, and the
    // drawer still opens on the newest line (it opened about 8,000px above it, no longer following the end).
    expect(await page.evaluate(`(() => {
      const content = document.querySelector('.console-content'); const box = content.getBoundingClientRect();
      const last = [...content.querySelectorAll('.console-row')].find(row => row.textContent.includes('LINE-LAST'))?.getBoundingClientRect();
      return { rowHeight: Math.round(content.querySelector('.console-row-toggle').getBoundingClientRect().height),
        lastInView: !!last && last.top >= box.top - 0.5 && last.bottom <= box.bottom + 0.5,
        atEnd: content.scrollHeight - content.scrollTop - content.clientHeight < 2 };
    })()`)).toEqual({ rowHeight: 44, lastInView: true, atEnd: true });
    // Find the 5,000-character line and open it: it wraps inside the drawer.
    await page.evaluate(`document.getElementById('console-search-input').focus()`);
    await page.send('Input.insertText', { text: 'LONG-LINE' });
    await page.settle();
    await page.evaluate(`document.querySelector('.console-row-toggle').click()`);
    await page.settle();
    const layout = await page.evaluate(`(() => {
      const drawer = document.querySelector('.console-drawer');
      const right = drawer.getBoundingClientRect().right;
      const visible = element => element.getClientRects().length > 0;
      const pastEdge = [...drawer.querySelectorAll('.console-cell, .console-row-toggle, .console-row-details, .console-row-full, .console-header > *, .console-filters > *, .console-search-note')]
        .filter(visible).filter(element => element.getBoundingClientRect().right > right + 0.5).map(element => element.className);
      const controls = [...drawer.querySelectorAll('.console-resize-handle, .console-btn, .console-filter-chip, .console-filter-action, .console-search, .console-row-toggle')]
        .filter(visible).map(element => Math.round(element.getBoundingClientRect().height));
      const content = drawer.querySelector('.console-content');
      return {
        pastEdge,
        sideways: content.scrollWidth > content.clientWidth + 1,
        page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        smallest: Math.min(...controls),
        fullWraps: drawer.querySelector('.console-row-full').scrollWidth <= drawer.querySelector('.console-row-full').clientWidth + 1,
        drawerWidth: Math.round(drawer.getBoundingClientRect().width),
      };
    })()`);
    expect(layout).toEqual({ pastEdge: [], sideways: false, page: false, smallest: 44, fullWraps: true, drawerWidth: 390 });

    // At its smallest on a phone, where the header's controls take a second row, the drawer still holds its bar, its
    // header and one row of logs inside its own box (MIN_DRAWER_HEIGHT's measurement).
    const smallest = `(() => {
      const drawerNode = document.querySelector('.console-drawer');
      const drawer = drawerNode.getBoundingClientRect();
      const header = document.querySelector('.console-header').getBoundingClientRect();
      const content = document.querySelector('.console-content').getBoundingClientRect();
      return { height: Math.round(drawer.height), headerInside: header.top >= drawer.top - 0.5 && header.bottom <= drawer.bottom + 0.5,
        rowInside: content.height >= 43.5 && content.bottom <= drawer.bottom + 0.5 };
    })()`;
    await page.evaluate(`document.getElementById('console-search-input').select()`);
    await press(page, 'Backspace', 'Backspace', 8);
    await page.evaluate(`document.querySelector('.console-resize-handle').focus()`);
    await press(page, 'Home', 'Home', 36);
    expect(await page.evaluate(smallest)).toEqual({ height: MIN_DRAWER_HEIGHT, headerInside: true, rowInside: true });
    // A search's note line is not counted in the minimum: it makes the drawer itself scroll, and the row stays reachable.
    await page.evaluate(`document.getElementById('console-search-input').focus()`);
    await page.send('Input.insertText', { text: 'LONG-LINE' });
    await page.settle();
    expect(await page.evaluate(`(() => { const drawer = document.querySelector('.console-drawer');
      drawer.scrollTop = drawer.scrollHeight; return drawer.scrollHeight > drawer.clientHeight; })()`)).toBe(true);
    await page.settle();
    expect((await page.evaluate(smallest)).rowInside).toBe(true);
    await page.evaluate(`document.querySelector('.console-drawer').scrollTop = 0`);
    await page.evaluate(`document.querySelector('.console-resize-handle').focus()`);
    await press(page, 'End', 'End', 35);

    // M3: each chip group is one sideways row with its scrollbar hidden; the edge with more chips past it fades,
    // so the Error chip past the right edge still shows it is there. Scrolled to its end, the fade moves to the start.
    const chipRow = (group: string) => `document.querySelector('.console-filter-section--${group} .console-filter-chips')`;
    for (const group of ['levels', 'components']) {
      const start = await page.evaluate(`(() => { const row = ${chipRow(group)}; const style = getComputedStyle(row);
        return { cut: row.scrollWidth > row.clientWidth, className: row.className, mask: style.maskImage || style.webkitMaskImage }; })()`);
      expect({ group, cut: start.cut, after: start.className.includes('scroll-more-after'), masked: start.mask !== 'none' })
        .toEqual({ group, cut: true, after: true, masked: true });
      await page.evaluate(`(() => { const row = ${chipRow(group)}; row.scrollLeft = row.scrollWidth; })()`);
      await page.settle();
      const end = await page.evaluate(`${chipRow(group)}.className`);
      expect({ group, before: end.includes('scroll-more-before'), after: end.includes('scroll-more-after') }).toEqual({ group, before: true, after: false });
    }
  } finally {
    opened?.page.close();
    await opened?.chrome.close();
    opened?.worker.server.stop(true);
  }
}, 90_000);

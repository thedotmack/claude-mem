import { expect, it } from 'bun:test';
import { composeViewerSyncStatus, type ViewerSyncStatus } from '../../../src/shared/viewer-sync-status';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the viewer header, menu and touch-size checks.');

const bundle = () => compileBrowserFixture(`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { App } from './src/ui/viewer/App';
  import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
  import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
  setStoredWelcomeDismissed(true);
  createRoot(document.getElementById('root')).render(<ErrorBoundary withHeader><App /></ErrorBoundary>);
  fetch('/ready');
`);

function serve(script: string, sync?: ViewerSyncStatus) {
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const projects = Array.from({ length: 120 }, (_, index) => `project-${String(index).padStart(3, '0')}`);
  const base = Date.UTC(2026, 10, 15, 20, 0, 0);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(readViewerTemplateHtml());
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(script);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'initial_load', projects, sync })}\n\n`));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname === '/api/settings') return Response.json({ CLAUDE_MEM_PRO_PLAN: 'none' });
    const common = (id: number) => ({ id, project: 'project-001', platform_source: 'claude', content_session_id: 'session', memory_session_id: 'memory',
      created_at_epoch: base - id * 60_000, created_at: new Date(base - id * 60_000).toISOString() });
    // Six kinds of observation, so a phone's chip row runs past the edge.
    const kinds = ['discovery', 'change', 'feature', 'decision', 'bugfix', 'refactor'];
    if (url.pathname === '/api/observations') return Response.json({ items: Array.from({ length: 6 }, (_, i) => ({ ...common(i + 1), type: kinds[i],
      title: `Observation ${i + 1}`, subtitle: 'One line under the title', narrative: 'The narrative', text: null, facts: '["One fact","Two facts"]',
      concepts: '[]', files_read: '["/repo/src/a.ts"]', files_modified: '[]', prompt_number: 1 })), hasMore: false });
    if (url.pathname === '/api/summaries') return Response.json({ items: [{ ...common(20), session_id: 'session', request: 'A summary title',
      investigated: 'Looked around', learned: 'Learned a thing', completed: 'Did a thing', next_steps: 'Do the next thing', notes: null }], hasMore: false });
    if (url.pathname === '/api/prompts') return Response.json({ items: [{ ...common(30), prompt_number: 1, prompt_text: 'continue' }], hasMore: false });
    return Response.json({});
  } });
  return { server, ready };
}

async function openViewer(width: number, height: number, profile: string, sync?: ViewerSyncStatus) {
  const { server, ready } = serve(bundle(), sync);
  const chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: profile, extraFlags: [...UNTHROTTLED_TIMER_FLAGS, `--window-size=${width},${height}`] });
  await withTimeout(ready, 30_000, 'Viewer did not become ready');
  const page = await connectToPage(chrome, server.url.href);
  await page.evaluate(`new Promise(resolve => { const check = () => document.querySelectorAll('.card').length >= 8 ? resolve(true) : setTimeout(check, 30); check(); })`);
  return { server, chrome, page };
}

async function key(page: DevToolsPage, keyName: string, code = keyName, keyCode = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
  await page.settle();
}

/** Enter as a keyboard sends it, with its "\r" character, which is what presses a focused button. */
async function enter(page: DevToolsPage) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.settle();
}

async function pressAt(page: DevToolsPage, x: number, y: number) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await page.settle();
}

(chromeExecutablePath ? it : it.skip)('the header is one row with one accessible "…" menu, a searchable Project filter and neutral hover', async () => {
  let opened: Awaited<ReturnType<typeof openViewer>> | undefined;
  try {
    opened = await openViewer(1440, 900, 'claude-mem-viewer-shell-');
    const { page } = opened;
    // One row: every visible control's vertical middle sits inside the header's middle band.
    expect(await page.evaluate(`(() => {
      const header = document.querySelector('.header').getBoundingClientRect();
      const middles = [...document.querySelectorAll('.header > a, .header > button, .header .menu-trigger, .header .project-picker-trigger, .header > .header-sync')]
        .filter(element => element.getClientRects().length).map(element => { const r = element.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
      return { height: Math.round(header.height), oneRow: middles.every(middle => Math.abs(middle - (header.top + header.bottom) / 2) < 14) };
    })()`)).toEqual({ height: expect.any(Number), oneRow: true });

    // C12 on a laptop: chips, card buttons and fold rows 36px tall; text links and time stamps at least 24px (WCAG 2.5.8).
    const desktopSizes = await page.evaluate(`(() => {
      const tall = selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length)
        .map(element => Math.round(element.getBoundingClientRect().height));
      return { controls: tall('.kind-chip, .view-mode-toggle, .card-menu-trigger, .summary-chip, .fold-row'), links: tall('.feed .link-button, .short-time') };
    })()`);
    expect(desktopSizes.controls.length).toBeGreaterThan(10);
    expect(desktopSizes.controls.filter((size: number) => size !== 36)).toEqual([]);
    expect(desktopSizes.links.filter((size: number) => size < 24)).toEqual([]);

    // Hovering a plain control gives the neutral hover surface, never the blue button fill.
    const hover = await page.evaluate(`(() => { const r = document.querySelector('.view-mode-toggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y });
    await page.settle();
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.view-mode-toggle')).backgroundColor`)).not.toBe('rgb(9, 105, 218)');

    // The star count sits inside the closed menu, so GitHub is not asked for it while the page loads.
    expect(await page.evaluate(`performance.getEntriesByType('resource').some(entry => entry.name.includes('api.github.com'))`)).toBe(false);

    // The "…" menu: menu role, opened from the keyboard, Arrow/Home/End movement, Escape back to the button.
    await page.evaluate(`document.querySelector('.header-more').focus()`);
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    const menu = await page.evaluate(`({ role: document.querySelector('.header-menu [role="menu"]')?.getAttribute('role'),
      expanded: document.querySelector('.header-more').getAttribute('aria-expanded'),
      focused: document.activeElement.textContent, items: [...document.querySelectorAll('.header-menu [role^="menuitem"]')].filter(e => e.getClientRects().length).length })`);
    expect(menu).toEqual({ role: 'menu', expanded: 'true', focused: 'Documentation', items: expect.any(Number) });
    expect(menu.items).toBeGreaterThanOrEqual(12);
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Follow us on X');
    await key(page, 'End', 'End', 35);
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Memory logs');
    await key(page, 'Home', 'Home', 36);
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Documentation');
    expect(await page.evaluate(`[...document.querySelectorAll('.header-menu [role="menuitemradio"]')].map(item => item.getAttribute('aria-checked') + ':' + item.textContent).slice(0, 3)`))
      .toEqual(['true:System', 'false:Light mode', 'false:Dark mode']);
    await key(page, 'Escape', 'Escape', 27);
    expect(await page.evaluate(`({ expanded: document.querySelector('.header-more').getAttribute('aria-expanded'), back: document.activeElement === document.querySelector('.header-more') })`))
      .toEqual({ expanded: 'false', back: true });

    // A menu link that opens another tab gives focus back to "…" (the WAI-ARIA menu button pattern).
    await page.evaluate(`document.addEventListener('click', event => { if (event.target.closest('a[target="_blank"]')) event.preventDefault(); }, true)`);
    await page.evaluate(`document.querySelector('.header-more').focus()`);
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Documentation');
    await key(page, 'Enter', 'Enter', 13);
    expect(await page.evaluate(`({ expanded: document.querySelector('.header-more').getAttribute('aria-expanded'), back: document.activeElement === document.querySelector('.header-more') })`))
      .toEqual({ expanded: 'false', back: true });

    // "Show welcome card" gives focus back too: into the card while it is open, and to "…" once it closes.
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    await key(page, 'End', 'End', 35);
    await key(page, 'ArrowUp', 'ArrowUp', 38);
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Show welcome card');
    await enter(page);
    expect(await page.evaluate(`({ inCard: !!document.activeElement.closest('.welcome-modal[role="dialog"]'), expanded: document.querySelector('.header-more').getAttribute('aria-expanded') })`))
      .toEqual({ inCard: true, expanded: 'false' });
    await key(page, 'Escape', 'Escape', 27);
    expect(await page.evaluate(`({ card: !!document.querySelector('.welcome-modal'), back: document.activeElement === document.querySelector('.header-more') })`))
      .toEqual({ card: false, back: true });

    // "Memory logs" opens the logs and leaves focus on "…" (the drawer is not a dialog, so it takes none).
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    await key(page, 'End', 'End', 35);
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Memory logs');
    await enter(page);
    expect(await page.evaluate(`({ logs: !!document.querySelector('.console-drawer'), expanded: document.querySelector('.header-more').getAttribute('aria-expanded'),
      back: document.activeElement === document.querySelector('.header-more') })`)).toEqual({ logs: true, expanded: 'false', back: true });
    await page.evaluate(`document.querySelector('.console-toggle-btn').click()`);
    await page.settle();
    expect(await page.evaluate(`!!document.querySelector('.console-drawer')`)).toBe(false);

    // The sync state's full words open on keyboard focus and on a click, and Escape closes them (not hover only).
    await page.evaluate(`document.querySelector('.header-sync').focus()`);
    await page.settle();
    const syncOnFocus = await page.evaluate(`({ open: !document.querySelector('.header-sync-detail').hidden, expanded: document.querySelector('.header-sync').getAttribute('aria-expanded'),
      words: document.querySelector('.header-sync-detail').textContent })`);
    expect(syncOnFocus).toEqual({ open: true, expanded: 'true', words: expect.stringContaining('This worker has not reported synchronization freshness.') });
    await key(page, 'Escape', 'Escape', 27);
    expect(await page.evaluate(`document.querySelector('.header-sync-detail').hidden`)).toBe(true);
    await page.evaluate(`document.activeElement.blur()`);
    const syncButton = await page.evaluate(`(() => { const r = document.querySelector('.header-sync').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: syncButton.x, y: syncButton.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: syncButton.x, y: syncButton.y, button: 'left', clickCount: 1 });
    await page.settle();
    expect(await page.evaluate(`!document.querySelector('.header-sync-detail').hidden`)).toBe(true);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 600, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 600, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 600 });
    await page.settle();
    expect(await page.evaluate(`document.querySelector('.header-sync-detail').hidden`)).toBe(true);

    // "Show all <n>" is the last option of the Project list, so the keyboard reaches the projects past the first 50.
    await page.evaluate(`document.querySelector('.project-picker-trigger').click()`);
    await page.settle();
    await key(page, 'End', 'End', 35);
    expect(await page.evaluate(`({ active: document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).textContent,
      options: document.querySelectorAll('.project-picker [role="option"]').length })`)).toEqual({ active: 'Show all 120', options: 52 });
    await key(page, 'Enter', 'Enter', 13);
    expect(await page.evaluate(`({ options: document.querySelectorAll('.project-picker [role="option"]').length, focus: document.activeElement.getAttribute('role'),
      active: document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).textContent })`))
      .toEqual({ options: 121, focus: 'combobox', active: 'project-050' });
    await key(page, 'Escape', 'Escape', 27);

    // The Project filter narrows 120 projects as you type; Arrow keys and Enter choose.
    await page.evaluate(`document.querySelector('.project-picker-trigger').click()`);
    await page.settle();
    expect(await page.evaluate(`document.activeElement.getAttribute('role')`)).toBe('combobox');
    await page.send('Input.insertText', { text: 'project-11' });
    await page.settle();
    expect(await page.evaluate(`[...document.querySelectorAll('.project-picker [role="option"]')].map(option => option.textContent)`))
      .toEqual(Array.from({ length: 10 }, (_, index) => `project-11${index}`));
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    await key(page, 'Enter', 'Enter', 13);
    expect(await page.evaluate(`({ value: document.querySelector('.project-picker-value').textContent, open: document.querySelector('.project-picker-trigger').getAttribute('aria-expanded') })`))
      .toEqual({ value: 'project-111', open: 'false' });

    // The chosen project is past the first 50, and it is still listed, first and checked, when the list opens again.
    const pickerOptions = `(() => { const options = [...document.querySelectorAll('.project-picker [role="option"]')];
      return { count: options.length, first: options.slice(0, 3).map(option => option.textContent), last: options.at(-1).textContent,
        selected: options.filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.textContent),
        query: document.querySelector('.project-picker-search input').value }; })()`;
    await page.evaluate(`document.querySelector('.project-picker-trigger').click()`);
    await page.settle();
    expect(await page.evaluate(pickerOptions))
      .toEqual({ count: 53, first: ['All Projects', 'project-111', 'project-000'], last: 'Show all 120', selected: ['project-111'], query: '' });
    // "Show all" still moves to the first project that was hidden, and the chosen one goes back to its own place.
    await key(page, 'End', 'End', 35);
    await key(page, 'Enter', 'Enter', 13);
    expect(await page.evaluate(`({ count: document.querySelectorAll('.project-picker [role="option"]').length,
      active: document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).textContent,
      chosenAt: [...document.querySelectorAll('.project-picker [role="option"]')].findIndex(option => option.textContent === 'project-111') })`))
      .toEqual({ count: 121, active: 'project-050', chosenAt: 112 });
    await key(page, 'Escape', 'Escape', 27);

    // A click outside closes the list and forgets the search, as Escape and Tab do, so it opens on every project.
    await page.evaluate(`document.querySelector('.project-picker-trigger').click()`);
    await page.settle();
    await page.send('Input.insertText', { text: 'project-02' });
    await page.settle();
    expect(await page.evaluate(`document.querySelectorAll('.project-picker [role="option"]').length`)).toBe(10);
    await pressAt(page, 700, 600);
    expect(await page.evaluate(`document.querySelector('.project-picker-trigger').getAttribute('aria-expanded')`)).toBe('false');
    await page.evaluate(`document.querySelector('.project-picker-trigger').click()`);
    await page.settle();
    expect(await page.evaluate(pickerOptions))
      .toEqual({ count: 53, first: ['All Projects', 'project-111', 'project-000'], last: 'Show all 120', selected: ['project-111'], query: '' });
    await key(page, 'Escape', 'Escape', 27);

    // In Chinese the sync panel's feed sentence ends with the Chinese full stop, with no English period after it.
    await page.evaluate(`document.querySelector('.header-more').click()`);
    await page.settle();
    await page.evaluate(`document.querySelector('.header-menu [role="menuitemradio"][lang="zh-CN"]').click()`);
    await page.settle();
    await key(page, 'Escape', 'Escape', 27);
    await page.evaluate(`document.querySelector('.header-sync').focus()`);
    await page.settle();
    const chinesePanel = await page.evaluate(`({ feed: document.querySelector('.header-sync-detail strong').textContent,
      words: document.querySelector('.header-sync-detail').textContent })`);
    expect(['实时流已连接。', '实时流已断开。']).toContain(chinesePanel.feed);
    expect(chinesePanel.words).not.toContain('.');
  } finally { opened?.page.close(); await opened?.chrome.close(); opened?.server.stop(true); }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('on a 390px phone the header is one 56px row and every control is at least 44px tall', async () => {
  let opened: Awaited<ReturnType<typeof openViewer>> | undefined;
  try {
    opened = await openViewer(390, 844, 'claude-mem-viewer-phone-', composeViewerSyncStatus(null, null, null));
    const { page } = opened;
    await withTimeout(page.evaluate(`new Promise(resolve => {
      const check = () => document.querySelector('.timeline-gift') ? resolve(true) : setTimeout(check, 30);
      check();
    })`), 5_000, 'Eligible timeline gift did not appear');
    expect(await page.evaluate(`(() => {
      const gift = document.querySelector('.timeline-gift');
      const firstCard = document.querySelector('.card');
      return {
        links: [...document.querySelectorAll('a[href="https://cmem.ai/sync"]')].map(link => ({
          inGift: gift.contains(link), opensIn: link.target,
        })),
        firstObservation: firstCard.querySelector('.card-title').textContent,
        giftBeforeCard: Boolean(gift.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    })()`)).toEqual({ links: [{ inGift: true, opensIn: '_blank' }], firstObservation: 'Observation 1', giftBeforeCard: true });
    const sizes = await page.evaluate(`(() => {
      const header = document.querySelector('.header').getBoundingClientRect();
      const visible = selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
      const short = visible('.header a, .header button, .timeline-gift a, .timeline-gift button, .view-tab, .kind-chip, .view-mode-toggle, .card-menu-trigger, .summary-chip, .fold-row, .card-subtitle-more, .short-time, .timeline-search')
        .map(element => ({ name: element.className || element.tagName, height: Math.round(element.getBoundingClientRect().height) }))
        .filter(control => control.height < 44);
      return { headerHeight: Math.round(header.height), short, scrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
    })()`);
    expect(sizes.headerHeight).toBeLessThanOrEqual(60);
    expect(sizes.short).toEqual([]);
    expect(sizes.scrollsSideways).toBe(false);
    // Kind chips past the right edge fade there, so the row reads as one to swipe; at its end the fade moves to the start.
    expect(await page.evaluate(`document.querySelector('.kind-chips').className`)).toContain('scroll-more-after');
    await page.evaluate(`(() => { const row = document.querySelector('.kind-chips'); row.scrollLeft = row.scrollWidth; })()`);
    await page.settle();
    const chipRow = await page.evaluate(`document.querySelector('.kind-chips').className`);
    expect(chipRow).toContain('scroll-more-before');
    expect(chipRow).not.toContain('scroll-more-after');
    // Sync remains the first mobile menu item. The timeline carries the offer beside the memories.
    await page.evaluate(`document.querySelector('.header-more').focus()`);
    await key(page, 'ArrowDown', 'ArrowDown', 40);
    expect(await page.evaluate(`({ first: document.activeElement.classList.contains('menu-sync'),
      words: document.activeElement.textContent.includes('Cloud sync is not configured.'),
      trial: !!document.querySelector('.header-menu [role="menuitem"][href="https://cmem.ai/pro?from=viewer"]') })`))
      .toEqual({ first: true, words: true, trial: false });
    // The chip row is still scrolled to its end. French words make the chips wider while the row keeps its own
    // size, so there are chips past the end again, and the end fades again.
    const chipRowSizes = `(() => { const row = document.querySelector('.kind-chips'); return { width: row.clientWidth, content: row.scrollWidth, className: row.className }; })()`;
    const english = await page.evaluate(chipRowSizes);
    await page.evaluate(`document.querySelector('.header-menu [role="menuitemradio"][lang="fr"]').click()`);
    await page.settle();
    const french = await page.evaluate(chipRowSizes);
    expect(french.width).toBe(english.width);
    expect(french.content).toBeGreaterThan(english.content);
    expect(french.className).toContain('scroll-more-before');
    expect(french.className).toContain('scroll-more-after');
  } finally { opened?.page.close(); await opened?.chrome.close(); opened?.server.stop(true); }
}, 60_000);

import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the card delete flow.');

// A card's delete is asked in the page and sent once. While it is on its way the
// reader can still Cancel or press Escape (which stops waiting for it), and a delete
// that did not finish says so on its card, even when the card scrolled out of the
// list's window while the worker was answering (Phase 9 review, finding 4).
const PER_PAGE = 50;
const TOTAL = 150;

(chromeExecutablePath ? it : it.skip)('a delete can be stopped while it runs, a refused one is shown even after its card scrolled away, and Try again sends it again', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
    setStoredWelcomeDismissed(true);
    window.confirm = () => { throw new Error('The viewer must not use the browser confirm box'); };
    createRoot(document.getElementById('root')).render(<App />);
    fetch('/ready');
  `);
  const html = readViewerTemplateHtml();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const base = Date.UTC(2026, 10, 15, 20, 0, 0);
  // The worker's answers to DELETE, decided by the test: held until released, then the given status.
  const deletes: Array<{ id: number; aborted: boolean; answer: (status: number) => void }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(html);
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["fixture"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const deleted = /^\/api\/observation\/(\d+)$/.exec(url.pathname);
    if (deleted && request.method === 'DELETE') {
      return new Promise<Response>(resolve => {
        const entry = { id: Number(deleted[1]), aborted: false, answer: (status: number) => resolve(Response.json({ error: 'refused' }, { status })) };
        request.signal.addEventListener('abort', () => { entry.aborted = true; });
        deletes.push(entry);
      });
    }
    if (url.pathname === '/api/observations') {
      const offset = Number(url.searchParams.get('offset'));
      const items = Array.from({ length: Math.max(0, Math.min(PER_PAGE, TOTAL - offset)) }, (_, index) => {
        const id = offset + index + 1;
        return { id, project: 'fixture', platform_source: 'claude', content_session_id: 'session', memory_session_id: 'memory',
          created_at_epoch: base - id * 60_000, created_at: new Date(base - id * 60_000).toISOString(), type: 'discovery',
          title: `Observation ${id}`, subtitle: 'One line under the title', narrative: 'The narrative', text: null,
          facts: '["One fact"]', concepts: '[]', files_read: '[]', files_modified: '[]', prompt_number: 1 };
      });
      return Response.json({ items, hasMore: offset + PER_PAGE < TOTAL });
    }
    if (url.pathname === '/api/summaries' || url.pathname === '/api/prompts') return Response.json({ items: [], hasMore: false });
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  const card = (id: number) => `document.querySelector('[data-feed-key="observation-${id}"]')`;
  const until = async (expression: string, message: string) => {
    const deadline = Date.now() + 8000;
    while (!(await page!.evaluate(expression))) {
      if (Date.now() > deadline) throw new Error(message);
      await Bun.sleep(30);
    }
  };
  const key = async (name: string, code: number) => {
    await page!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
    await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
    await page!.settle();
  };
  /** Opens card <id>'s "…" menu, picks its delete item, and presses the red Delete in the question. */
  const askAndConfirm = async (id: number) => {
    await page!.evaluate(`${card(id)}.querySelector('.card-menu-trigger').click()`);
    await page!.settle();
    const item = await page!.evaluate(`(() => { const item = [...${card(id)}.querySelectorAll('[role="menuitem"]')].find(element => element.textContent.includes('Delete')); item.click(); return item.textContent; })()`);
    await page!.settle();
    await page!.evaluate(`${card(id)}.querySelector('.inline-confirm-danger').focus(); ${card(id)}.querySelector('.inline-confirm-danger').click()`);
    return item as string;
  };
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-card-delete-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1280,900'] });
    await withTimeout(ready, 30_000, 'Delete-flow browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    // Load every page, so the list recycles rows (past 50).
    for (let jump = 0; jump < 10 && !(await page.evaluate(`!!document.querySelector('.feed-ending--end')`)); jump++) {
      await page.evaluate(`(() => { const feed = document.querySelector('.feed'); feed.scrollTop = feed.scrollHeight; })()`);
      await Bun.sleep(300);
    }
    expect(await page.evaluate(`document.querySelector('[data-windowed]').dataset.windowed`)).toBe('true');
    await page.evaluate(`document.querySelector('.feed').scrollTop = 0`);
    await page.settle();

    // The delete item says what it deletes.
    expect(await askAndConfirm(1)).toBe('Delete observation…');
    await until(`${card(1)}.querySelector('.inline-confirm-danger')?.textContent === 'Deleting…'`, 'Delete did not start');
    await withTimeout((async () => { while (!deletes.length) await Bun.sleep(10); })(), 5000, 'The DELETE never reached the worker');

    // The reader moves on (focus leaves the card) and scrolls far away while the worker is answering;
    // the card stays drawn and the refusal lands on it.
    await page.evaluate(`document.querySelector('.timeline-search input').focus()`);
    await page.evaluate(`document.querySelector('.feed').scrollTop = document.querySelector('.feed').scrollHeight`);
    await page.settle();
    await page.settle();
    expect(await page.evaluate(`(() => { const row = ${card(1)}; const feed = document.querySelector('.feed').getBoundingClientRect(); return !!row && row.getBoundingClientRect().bottom < feed.top; })()`)).toBe(true);
    deletes[0].answer(503);
    await until(`!!${card(1)}?.querySelector('.card-delete-error[role="alert"]')`, 'The refusal was not shown on the card that scrolled away');
    await page.evaluate(`document.querySelector('.feed').scrollTop = 0`);
    await page.settle();
    expect(await page.evaluate(`${card(1)}.querySelector('.card-delete-error').textContent`)).toContain('cloud sync is unavailable');
    expect(await page.evaluate(`${card(1)}.querySelector('.card-title').textContent`)).toBe('Observation 1');

    // Escape while the delete runs stops waiting for it; the card says what that means.
    await askAndConfirm(2);
    await withTimeout((async () => { while (deletes.length < 2) await Bun.sleep(10); })(), 5000, 'The second DELETE never reached the worker');
    expect(await page.evaluate(`document.activeElement.className`)).toBe('inline-confirm-danger');
    await key('Escape', 27);
    await until(`!!${card(2)}.querySelector('.card-delete-error')`, 'Escape did not stop the delete');
    expect(await page.evaluate(`${card(2)}.querySelector('.card-delete-error').textContent`)).toContain('Stopped waiting for the delete');
    await withTimeout((async () => { while (!deletes[1].aborted) await Bun.sleep(10); })(), 5000, 'The stopped DELETE was not cancelled');
    // Focus stays on the card (Try again), and Escape there dismisses the line and returns to "…".
    expect(await page.evaluate(`document.activeElement.textContent`)).toBe('Try again');
    await key('Escape', 27);
    expect(await page.evaluate(`({ line: !!${card(2)}.querySelector('.card-delete-error'), focus: document.activeElement === ${card(2)}.querySelector('.card-menu-trigger') })`))
      .toEqual({ line: false, focus: true });

    // Cancel works while it runs too.
    await askAndConfirm(3);
    await withTimeout((async () => { while (deletes.length < 3) await Bun.sleep(10); })(), 5000, 'The third DELETE never reached the worker');
    await page.evaluate(`${card(3)}.querySelector('.inline-confirm-cancel').click()`);
    await until(`!!${card(3)}.querySelector('.card-delete-error')`, 'Cancel did not stop the delete');
    await withTimeout((async () => { while (!deletes[2].aborted) await Bun.sleep(10); })(), 5000, 'The cancelled DELETE was not stopped');

    // Each delete was sent once, and every card is still there.
    expect(deletes.map(entry => entry.id)).toEqual([1, 2, 3]);
    expect(await page.evaluate(`[1, 2, 3].every(id => !!document.querySelector('[data-feed-key="observation-' + id + '"]'))`)).toBe(true);

    // Try again on the refused card sends its delete once more and says it is deleting; when the worker
    // deletes it this time, the card leaves the list.
    await page.evaluate(`[...${card(1)}.querySelectorAll('.card-delete-error button')].find(button => button.textContent === 'Try again').click()`);
    await withTimeout((async () => { while (deletes.length < 4) await Bun.sleep(10); })(), 5000, 'Try again never sent the delete');
    await until(`${card(1)}?.querySelector('.inline-confirm-danger')?.textContent === 'Deleting…'`, 'Try again did not show the delete running');
    expect(await page.evaluate(`!!${card(1)}.querySelector('.card-delete-error')`)).toBe(false);
    deletes[3].answer(200);
    await until(`!${card(1)}`, 'The card did not leave the list after its delete went through');
    expect(deletes.map(entry => entry.id)).toEqual([1, 2, 3, 1]);
    expect(await page.evaluate(`[2, 3].every(id => !!document.querySelector('[data-feed-key="observation-' + id + '"]'))`)).toBe(true);
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 90_000);

import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for selected category clearing.');

(chromeExecutablePath ? it : it.skip)('can clear the selected category after deleting its last memory', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { App } from './src/ui/viewer/App';
    localStorage.setItem('claude-mem-welcome-dismissed', 'true');
    window.confirm = () => true;
    location.hash = '#/sessions/claude/owned-session';
    createRoot(document.getElementById('root')).render(<App />);
    async function until(predicate) {
      const deadline = Date.now() + 6000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Category fixture did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const titles = () => [...document.querySelectorAll('.card-title')].map(node => node.textContent);
    (async () => {
      try {
        await until(() => titles().length === 2);
        document.querySelector('[title="Filter to Bugfix"]').click();
        await until(() => titles().length === 1 && titles()[0] === 'OWNED_BUGFIX');
        document.querySelector('[title="Delete observation"]').click();
        await until(() => !document.body.textContent.includes('OWNED_BUGFIX'));
        const afterDelete = titles();
        const chip = document.querySelector('[title="Filter to Bugfix"]');
        const selected = chip?.getAttribute('aria-pressed') === 'true';
        const zeroLabel = chip?.textContent === 'Bugfix (0)';
        const unrelatedEmptyChip = !!document.querySelector('[title="Filter to Feature"]');
        if (chip) {
          chip.click();
          await until(() => titles().includes('OWNED_DISCOVERY'));
        }
        await fetch('/result', { method: 'POST', body: JSON.stringify({ afterDelete, selected, zeroLabel,
          unrelatedEmptyChip, afterClear: titles() }) });
      } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
    })();
  `);
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  let deletes = 0;
  const common = { project: 'owned-project', content_session_id: 'owned-session', platform_source: 'claude',
    created_at: new Date().toISOString(), created_at_epoch: Date.now(), narrative: 'Owned fixture',
    facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' };
  const observations = [{ ...common, id: 1, type: 'bugfix', title: 'OWNED_BUGFIX' },
    { ...common, id: 2, type: 'discovery', title: 'OWNED_DISCOVERY' }];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["owned-project"]}\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname === '/api/observations') return Response.json({ items: observations, hasMore: false });
    if (url.pathname === '/api/summaries' || url.pathname === '/api/prompts') return Response.json({ items: [], hasMore: false });
    if (url.pathname === '/api/observation/1' && request.method === 'DELETE') {
      deletes++; return Response.json({ success: true });
    }
    if (url.pathname === '/api/processing-status') return Response.json({ isProcessing: false, queueDepth: 0 });
    if (url.pathname === '/api/projects') return Response.json({ projects: ['owned-project'], sources: ['claude'],
      projectsBySource: { claude: ['owned-project'] } });
    if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-category-clear-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    const actual = await withTimeout(result, 30000, 'Owned selected category fixture timed out');
    console.log('SELECTED_CATEGORY_PROOF', JSON.stringify(actual));
    expect(deletes).toBe(1);
    expect(actual).toEqual({ afterDelete: [], selected: true, zeroLabel: true, unrelatedEmptyChip: false,
      afterClear: ['OWNED_DISCOVERY'] });
  } finally {
    await chrome?.close(); server.stop(true);
  }
}, 80000);

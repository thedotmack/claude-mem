import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the live catalog title test');

// The quality review's race: a catalog page is in flight (Sessions opened, the project changed, or a resync), a live
// summary names a loaded session, and the page's query ran before that summary was stored. The live title must win;
// before this fix the page's older title came back and the row read "No summary yet" until the next fetch.
(chromeExecutablePath ? it : it.skip)('a live summary title survives a catalog page that was read before it', async () => {
  const bundle = compileBrowserFixture(`
    import React, { useEffect } from 'react';
    import { createRoot } from 'react-dom/client';
    import { useSessionCatalog } from './src/ui/viewer/hooks/useSessionCatalog';
    function Fixture() {
      const state = useSessionCatalog();
      window.catalog = state;
      useEffect(() => { void state.refresh(''); }, []);
      return <><output id="rows">{JSON.stringify(state.sessions)}</output><output id="loading">{String(state.isLoading)}</output></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `);
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const row = { content_session_id: 'live-session', platform_source: 'claude', project: 'acme', custom_title: null,
    summary_title: null, started_at_epoch: Date.UTC(2026, 10, 16, 12), item_count: 1 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/api/sessions') {
      reads += 1;
      // The second page is held: its query ran before the live summary below was stored.
      if (reads === 2) await held;
      return Response.json({ sessions: [row], hasMore: false });
    }
    return htmlResponse(FIXTURE_PAGE_HTML);
  } });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  const until = async (expression: string, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!await page!.evaluate(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  };
  const title = `JSON.parse(document.getElementById('rows').textContent)[0]?.summary_title ?? null`;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-catalog-title-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
    page = await connectToPage(chrome, server.url.href);
    await until(`document.getElementById('loading')?.textContent === 'false' && document.getElementById('rows').textContent.includes('live-session')`, 'the first page');
    expect(await page.evaluate(title)).toBeNull();

    await page.evaluate(`void window.catalog.refresh('')`);
    await until(`document.getElementById('loading').textContent === 'true'`, 'the second page to start');
    const deadline = Date.now() + 10_000;
    while (reads < 2) { if (Date.now() > deadline) throw new Error('The second page was never asked for'); await Bun.sleep(20); }

    await page.evaluate(`window.catalog.touch({ session: { platformSource: 'claude', contentSessionId: 'live-session' }, project: 'acme',
      createdAtEpoch: Date.now(), summaryTitle: 'The live summary' })`);
    await until(`${title} === 'The live summary'`, 'the live title on the row');

    release();
    await until(`document.getElementById('loading').textContent === 'false'`, 'the held page to land');
    expect(await page.evaluate(`({ title: ${title}, count: JSON.parse(document.getElementById('rows').textContent)[0].item_count })`))
      .toEqual({ title: 'The live summary', count: 2 });
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 60_000);

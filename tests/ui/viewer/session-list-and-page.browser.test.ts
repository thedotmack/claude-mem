import { expect, it } from 'bun:test';
import {
  UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse,
  launchChrome, readViewerTemplateStyles, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the Sessions list and session page tests');

/** A page with the viewer's real stylesheet and a bounded scrolling column, so rows recycle as in the app. */
function stylePage(): string {
  return `<!doctype html><html><head><style>${readViewerTemplateStyles()}</style>
    <style>#root { height: 800px; display: flex; flex-direction: column; }</style></head>
    <body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
}

async function withFixture(bundle: string, run: (page: DevToolsPage) => Promise<void>): Promise<void> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    return new URL(request.url).pathname === '/fixture.js' ? scriptResponse(bundle) : htmlResponse(stylePage());
  } });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-sessions-ui-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
    page = await connectToPage(chrome, server.url.href);
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await run(page);
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}

async function until(page: DevToolsPage, expression: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await page.evaluate(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** Types into a React-controlled field the way a reader does (the native setter, then an input event). */
const typeInto = (selector: string, value: string) => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

(chromeExecutablePath ? it : it.skip)('the Sessions list titles rows, groups days, recycles past 50 and finds loaded sessions', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionList } from './src/ui/viewer/components/SessionList';
    window.confirm = () => { throw new Error('The viewer must not use the browser confirm box'); };
    window.loads = 0;
    const now = Date.now();
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      content_session_id: '0000000' + String(index).padStart(3, '0') + '-aaaa-bbbb', platform_source: 'claude', project: 'acme/repo',
      custom_title: null, summary_title: index === 110 ? 'Calibrate the zebra telescope' : index % 3 === 0 ? null : 'Session title ' + index,
      started_at_epoch: now - index * 30 * 60 * 1000, item_count: index + 1,
    }));
    createRoot(document.getElementById('root')).render(<SessionList header={<h2>Sessions</h2>} sessions={sessions} isLoading={false}
      hasMore={true} loadError={null} onOpen={() => {}} onDelete={async () => {}} onLoadMore={() => { window.loads++; }} />);
  `);
  await withFixture(bundle, async page => {
    const { evaluate, settle } = page;
    await until(page, '!!document.querySelector(".session-row")', 'session rows');
    await settle();
    const list = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.session-list [role="listitem"]')];
      const first = items[0];
      return {
        windowed: document.querySelector('.session-list [role="list"]').getAttribute('data-windowed'),
        setSize: first.getAttribute('aria-setsize'),
        drawnFewer: items.length < 120,
        zebraDrawn: document.body.textContent.includes('zebra telescope'),
        firstDay: first.querySelector('.session-day')?.textContent.startsWith('Today'),
        firstTitle: first.querySelector('.session-card-name').textContent,
        firstUntitled: first.querySelector('.session-card-name').classList.contains('session-card-name--none'),
        secondTitle: items[1].querySelector('.session-card-name').textContent,
        chip: first.querySelector('.session-card-id').textContent,
        chipTitle: first.querySelector('.session-card-id').getAttribute('title'),
        count: first.querySelector('.session-card-count').textContent,
        loaded: document.querySelector('.session-list-loaded')?.textContent,
        olderButton: document.querySelector('.session-list-more button')?.textContent,
        nested: document.querySelectorAll('.session-card button, .session-card a').length,
      };
    })()`);
    expect(list).toEqual({
      windowed: 'true', setSize: '120', drawnFewer: true, zebraDrawn: false, firstDay: true,
      firstTitle: 'No summary yet', firstUntitled: true, secondTitle: 'Session title 1',
      chip: '00000000', chipTitle: '0000000000-aaaa-bbbb', count: '1 memory',
      loaded: '120 sessions loaded', olderButton: 'Load older sessions', nested: 0,
    });

    // "Find a session" searches every loaded row, including rows the window has not drawn, and says so.
    await evaluate(typeInto('#session-search', 'zebra telescope'));
    await settle();
    const found = await evaluate(`({
      rows: [...document.querySelectorAll('.session-list [role="listitem"] .session-card-name')].map(node => node.textContent),
      note: document.querySelector('.timeline-search-note')?.textContent,
    })`);
    expect(found).toEqual({
      rows: ['Calibrate the zebra telescope'],
      note: '1 of the 120 loaded sessions match. Older sessions are not searched until they load.',
    });
    await evaluate(typeInto('#session-search', ''));
    await settle();

    // Delete asks in the row how many memories go; Escape cancels it and focus returns to the row's "…".
    await evaluate('document.querySelector(".session-card-menu-trigger").click()');
    await settle();
    const menu = await evaluate(`({
      role: !!document.querySelector('.session-card-menu:not([hidden]) [role="menu"]'),
      items: [...document.querySelectorAll('.session-card-menu:not([hidden]) [role="menuitem"]')].map(item => item.textContent.trim()),
      separator: !!document.querySelector('.session-card-menu:not([hidden]) [role="separator"]'),
      focused: document.activeElement?.textContent.trim(),
    })`);
    expect(menu).toEqual({ role: true, items: ['Open', 'Delete session…'], separator: true, focused: 'Open' });
    await evaluate('document.querySelector(".session-card-menu:not([hidden]) .session-card-menu-item--danger").click()');
    await settle();
    expect(await evaluate('document.querySelector(".session-row .inline-confirm-question")?.textContent'))
      .toBe('Delete this session and everything captured in it (1 memory)? This cannot be undone.');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await settle();
    expect(await evaluate(`({ question: !!document.querySelector('.session-row .inline-confirm'),
      focus: document.activeElement?.classList.contains('session-card-menu-trigger') })`)).toEqual({ question: false, focus: true });
  });
}, 60_000);

(chromeExecutablePath ? it : it.skip)('a session page heads itself, pins its summary, recycles past 50 and finds within the session', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionDetailPage } from './src/ui/viewer/components/SessionDetailPage';
    window.confirm = () => { throw new Error('The viewer must not use the browser confirm box'); };
    const now = Date.UTC(2026, 10, 15, 22, 0);
    const base = { project: 'acme/repo', platform_source: 'claude', content_session_id: 'session-full-id-0001' };
    const items = Array.from({ length: 120 }, (_, index) => index === 5
      ? { ...base, itemType: 'summary', id: 5, session_id: base.content_session_id, request: 'Pinned request words',
          next_steps: 'Do the next thing', learned: 'Learned a thing', created_at_epoch: now - index * 60000 }
      : { ...base, itemType: 'observation', id: index, memory_session_id: 'm', type: 'discovery',
          title: index === 110 ? 'Quokka migration traced' : 'Observation ' + index, subtitle: null, narrative: null, text: null,
          facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]', prompt_number: 1,
          created_at: new Date(now - index * 60000).toISOString(), created_at_epoch: now - index * 60000 });
    const catalogEntry = { ...base, custom_title: null, summary_title: 'Catalog title', started_at_epoch: now - 200 * 60000, item_count: 300 };
    createRoot(document.getElementById('root')).render(<SessionDetailPage tabs={null} session={{ platformSource: 'claude', contentSessionId: base.content_session_id }}
      catalogEntry={catalogEntry} items={items} isLoading={false} hasMore={true} onLoadMore={() => {}} onDeleted={() => {}} onBack={() => {}} />);
  `);
  await withFixture(bundle, async page => {
    const { evaluate, settle } = page;
    await until(page, '!!document.querySelector(".session-detail-header")', 'the session page');
    await settle();
    const head = await evaluate(`(() => {
      const list = document.querySelector('.feed [role="list"]');
      return {
        crumbHref: document.querySelector('.session-breadcrumb a')?.getAttribute('href'),
        crumbHere: document.querySelector('.session-breadcrumb [aria-current="page"]')?.textContent,
        title: document.querySelector('h2.session-detail-title')?.textContent.trim(),
        titleSize: getComputedStyle(document.querySelector('h2.session-detail-title')).fontSize,
        fullId: document.querySelector('.session-detail-id')?.textContent,
        copy: document.querySelector('.session-detail-meta .copy-button')?.textContent,
        count: document.querySelector('.session-detail-count')?.textContent,
        spanHasTo: / to /.test(document.querySelector('.session-detail-span')?.textContent ?? ''),
        pinned: document.querySelector('.session-pinned-summary .summary-title')?.textContent,
        summariesInList: list.querySelectorAll('.summary-card').length,
        windowed: list.getAttribute('data-windowed'),
        setSize: list.querySelector('[role="listitem"]').getAttribute('aria-setsize'),
        quokkaDrawn: document.body.textContent.includes('Quokka'),
        find: document.querySelector('.session-filters .timeline-search input')?.getAttribute('aria-label'),
      };
    })()`);
    expect(head).toEqual({
      crumbHref: '#/sessions', crumbHere: 'This session', title: 'Catalog title', titleSize: '26px',
      fullId: 'session-full-id-0001', copy: 'Copy id', count: '300 memories', spanHasTo: true,
      pinned: 'Pinned request words', summariesInList: 0, windowed: 'true', setSize: '119', quokkaDrawn: false,
      find: 'Find in this session',
    });

    await evaluate(typeInto('.session-filters .timeline-search input', 'quokka'));
    await settle();
    expect(await evaluate(`({
      rows: [...document.querySelectorAll('.feed [role="listitem"] .card-title')].map(node => node.textContent),
      pinned: !!document.querySelector('.session-pinned-summary'),
      note: document.querySelector('.timeline-search-note')?.textContent,
    })`)).toEqual({
      rows: ['Quokka migration traced'], pinned: false,
      note: '1 of the 120 loaded memories match. Older memories are not searched until they load.',
    });
  });
}, 60_000);

(chromeExecutablePath ? it : it.skip)('live rows keep session titles current, and a 15.x worker without titles keeps its old row titles', async () => {
  for (const workerSendsTitles of [true, false]) {
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from './src/ui/viewer/App';
      import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
      setStoredWelcomeDismissed(true); location.hash = '#/sessions';
      createRoot(document.getElementById('root')).render(<App />);
      const names = () => [...document.querySelectorAll('.session-card-name')].map(node => node.textContent);
      async function until(predicate, what) {
        const deadline = Date.now() + 8000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('Timed out: ' + what + ' ' + JSON.stringify(names()));
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      (async () => {
        try {
          await until(() => names().length === 2, 'two catalog rows');
          const before = names();
          await fetch('/emit?kind=summary&id=untitled-session');
          await until(() => names().includes('Fresh live summary'), 'the live summary title');
          await fetch('/emit?kind=observation&id=brand-new-session');
          await until(() => names().length === 3, 'the new live session');
          await fetch('/result', { method: 'POST', body: JSON.stringify({ before, after: names() }) });
        } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
      })();
    `);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const now = Date.now();
    const sessions = [
      { content_session_id: 'titled-session', platform_source: 'claude', project: 'repo', custom_title: null, summary_title: 'Ship the titles', started_at_epoch: now - 1000, item_count: 3 },
      { content_session_id: 'untitled-session', platform_source: 'claude', project: 'repo', custom_title: null, summary_title: null, started_at_epoch: now - 2000, item_count: 1 },
    ].map(({ summary_title, ...row }) => workerSendsTitles ? { ...row, summary_title } : row);
    let nextId = 500;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return htmlResponse('<div id="root"></div><script src="/fixture.js"></script>');
      if (url.pathname === '/fixture.js') return scriptResponse(bundle);
      if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["repo"]}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (url.pathname === '/api/sessions') return Response.json({ sessions, hasMore: false });
      if (url.pathname === '/api/processing-status') return Response.json({ isProcessing: false, queueDepth: 0 });
      if (url.pathname === '/api/projects') return Response.json({ projects: ['repo'], sources: ['claude'], projectsBySource: { claude: ['repo'] } });
      if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) return Response.json({ items: [], hasMore: false });
      if (url.pathname === '/emit') {
        if (!stream) throw new Error('Owned SSE connection not ready');
        const id = url.searchParams.get('id');
        const event = url.searchParams.get('kind') === 'summary'
          ? { type: 'new_summary', summary: { id: nextId++, session_id: id, project: 'repo', platform_source: 'claude', request: '  Fresh live summary ', created_at_epoch: now } }
          : { type: 'new_observation', observation: { id: nextId++, content_session_id: id, project: 'repo', platform_source: 'claude', type: 'discovery',
            title: 'Live row', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]', created_at_epoch: now } };
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        return new Response('emitted');
      }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return Response.json({});
    } });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-session-titles-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
      const actual = await withTimeout(result, 30_000, 'Session titles fixture timed out');
      expect(actual).toEqual(workerSendsTitles
        ? { before: ['Ship the titles', 'No summary yet'], after: ['No summary yet', 'Ship the titles', 'Fresh live summary'] }
        // A 15.x worker sends no summary_title: rows keep the project as their title, as in 15.x (G19); a live
        // summary still names its row, and a new live session keeps the project rather than "No summary yet".
        : { before: ['repo', 'repo'], after: ['repo', 'repo', 'Fresh live summary'] });
    } finally {
      await chrome?.close(); server.stop(true);
    }
  }
}, 90_000);

// L8: the Sessions list's first load and a search that finds nothing are FeedEnding states worded in
// SESSION_LIST_ENDING_WORDS, like its other endings; the empty list under a project filter offers every project.
(chromeExecutablePath ? it : it.skip)('the Sessions list words its first load, a search with no match and an empty project filter', async () => {
  const bundle = compileBrowserFixture(`
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionList } from './src/ui/viewer/components/SessionList';
    window.cleared = 0;
    const now = Date.now();
    window.sessions = Array.from({ length: 3 }, (_, index) => ({
      content_session_id: 'session-' + index, platform_source: 'claude', project: 'acme/repo', custom_title: null,
      summary_title: 'Session title ' + index, started_at_epoch: now - index * 60 * 1000, item_count: index + 1,
    }));
    function Fixture() {
      const [props, setProps] = useState({ sessions: [], isLoading: true, hasMore: false, projectFilter: '' });
      window.setProps = next => setProps(previous => ({ ...previous, ...next }));
      return <SessionList header={<h2>Sessions</h2>} sessions={props.sessions} isLoading={props.isLoading} hasMore={props.hasMore}
        loadError={null} projectFilter={props.projectFilter} onClearProjectFilter={() => { window.cleared++; }}
        onOpen={() => {}} onDelete={async () => {}} onLoadMore={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `);
  await withFixture(bundle, async page => {
    const { evaluate, settle } = page;
    const ending = `({ loading: document.querySelector('.feed-ending--loading')?.textContent ?? null,
      role: document.querySelector('.feed-ending--loading')?.getAttribute('role') ?? null,
      heading: document.querySelector('.session-list-empty h3')?.textContent ?? null,
      words: [...document.querySelectorAll('.session-list-empty p')].map(node => node.textContent),
      buttons: [...document.querySelectorAll('.session-list-empty button')].map(node => node.textContent) })`;
    await until(page, '!!document.querySelector(".feed-ending--loading")', 'the first load');
    expect(await evaluate(ending)).toEqual({ loading: 'Loading sessions…', role: 'status', heading: null, words: [], buttons: [] });

    // Loading older sessions under loaded rows says so.
    await evaluate('window.setProps({ sessions: window.sessions })');
    await settle();
    expect((await evaluate(ending)).loading).toBe('Loading older sessions…');

    // A search that matches no loaded session: its own words and Clear search.
    await evaluate('window.setProps({ isLoading: false })');
    await settle();
    await evaluate(typeInto('#session-search', 'nothing-matches-this'));
    await settle();
    expect(await evaluate(ending)).toEqual({ loading: null, role: null, heading: 'No session matches',
      words: ['Only loaded sessions are searched.'], buttons: ['Clear search'] });
    await evaluate(`[...document.querySelectorAll('.session-list-empty button')].find(node => node.textContent === 'Clear search').click()`);
    await settle();
    expect(await evaluate(`document.querySelectorAll('.session-list .session-card').length`)).toBe(3);

    // No sessions under a project filter: the filter is named and "Show all projects" clears it.
    await evaluate(`window.setProps({ sessions: [], projectFilter: 'acme/repo' })`);
    await settle();
    expect(await evaluate(ending)).toEqual({ loading: null, role: null, heading: 'No sessions to show',
      words: ['Sessions appear as work is captured. Try another project if a filter is selected.', 'Project filter: acme/repo'],
      buttons: ['Show all projects'] });
    await evaluate(`document.querySelector('.session-list-empty button').click()`);
    expect(await evaluate('window.cleared')).toBe(1);
  });
}, 60_000);

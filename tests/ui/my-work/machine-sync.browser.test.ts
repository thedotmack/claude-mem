import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, FITS_THE_WINDOW, htmlResponse, launchChrome, PAGE_WIDTHS, pageFitsTheWindow, scriptResponse, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the Machine and sync page.');

/**
 * Machine and sync (My Work design pass, Phase 4), on the real page and the app's compiled stylesheet, fed by the live
 * feed the page reads (a fixture worker's SSE stream, never a real worker). It took over the bar's Live chip and its
 * panel, whose connection words it now says (these checks moved here from tests/ui/work-view/live-indicator.browser.test.ts):
 * - the feed's state and the cloud copy's are separate facts: a cloud copy that fails or lags is named while the feed
 *   stays live, at phone width, in the attention colour, with no sideways scroll;
 * - one status region reads the names out when they change, never the sentence behind them, whose count changes on
 *   every poll: a new count reaches the page and nothing more is heard;
 * - every sentence of the cloud copy's detail is said in the reader's language (Turkish here);
 * - nothing asks /api/sync/status: the page reads the feed it already has;
 * - the worker version is the one the page read from GET /api/version, and a read the server refused says so (the
 *   cloud viewer's gate answers 403 with its reason) instead of leaving the row empty or showing a version; on cmem.ai
 *   (its page carries the owner meta), which runs no worker, nothing is asked and the row says why.
 */
let server: ReturnType<typeof Bun.serve> | undefined;
let markReady: () => void = () => {};
let overview: Record<string, unknown> | null = null;
let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
let unexpectedStatusGets = 0;
let versionAnswer: { status: number; body: unknown } = { status: 200, body: { version: '17.0.2' } };
let versionReads = 0;
let bundle = '';
let styles = '';

const source = (at: string) => ({kind:'claude-mem-recorded-agent-activity',mode:'read-only-sqlite',connected:true,
  pollIntervalMs:1000,lastCheckedAt:at,activityCheckedAt:at,lastUpdatedAt:null,error:null,stale:false});
// `message` stands for the worker's own sentence (src/shared/viewer-sync-status.ts) when a test needs a real one.
const sync = (state: string, remaining = '9007199254740993', message?: string) => ({ configured:true,state,mode:'polling',observedAt:Date.now(),checkedAt:Date.now(),
  message:message ?? (state === 'offline' ? 'Incoming cloud download failed.' : state === 'catching-up' ? 'Applying incoming cloud changes.' : 'Shared records are current.'),
  download:{lastSuccessAt:Date.now()},upload:{pending:3},projection:{remaining:state === 'catching-up' ? remaining : '0'},
  completeness:{pushQuarantine:0,pullQuarantine:0,excludedNative:0,scope:'eligible'} });
const emit = (event: string, value: unknown) => controller?.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // Compile the application's real stylesheet and candidates; hand-written fixture CSS could hide a responsive regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());
  bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { MachineAndSync } from './src/ui/my-work/src/pages/machine-sync';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { createLocalSource } from './src/ui/my-work/src/live/local-source';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    import { setLocale } from './src/ui/i18n/core';
    window.React = React;
    window.setLocale = setLocale;
    window.waitForSync = async (state) => {
      const deadline = performance.now() + 6000;
      while (!document.querySelector('[role="status"][data-sync-state="' + state + '"]')) {
        if (performance.now() > deadline) throw new Error('Sync state did not render: ' + state);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const fact = (name) => document.querySelector('[data-fact="' + name + '"] dd');
    // The facts as a person reads them, and the status region a screen reader hears. A fact's colour eases with the
    // theme, so it is read once its transitions end.
    window.readPage = async () => {
      const state = fact('sync-state');
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
      const status = document.querySelector('[role="status"][data-sync-state]');
      return { width: innerWidth, feed: fact('feed')?.textContent ?? null, syncState: state?.textContent ?? null,
        syncColor: state ? getComputedStyle(state).color : null, feedColor: fact('feed') ? getComputedStyle(fact('feed')).color : null,
        upload: fact('upload')?.textContent ?? null, mode: fact('mode')?.textContent ?? null, remaining: fact('remaining')?.textContent ?? null,
        state: status.dataset.syncState, announced: status.textContent, version: fact('version')?.textContent ?? null,
        versionRead: document.querySelector('[data-version-read]')?.dataset.versionRead ?? null };
    };
    // What the page last received about the cloud copy, so a test knows a new sync status has arrived.
    window.syncDetail = () => useStore.getState().work.connection?.sync?.detail ?? null;
    (async () => {
      const { connection, ...model } = await sampleSource.loadWorkModel();
      await fetch('/fixture-model', {method:'POST', body:JSON.stringify({ version:1, revision:'a'.repeat(64),
        model:{...model, sourceKind:'cloud', requests:[], sourceHealth:{...model.sourceHealth,connected:true}} })});
      window.stopSource = useStore.getState().startWorkSource(createLocalSource({hostname:'viewer.example'}));
      function Fixture() {
        const load = useStore(state => state.work.load);
        return load.state === 'loaded' ? <TooltipProvider><main style={{ padding: 16 }}><MachineAndSync /></main></TooltipProvider> : <span>Loading</span>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
      await fetch('/fixture-ready');
    })();
  `);
  server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const url = new URL(request.url);
    // `?owner=1`: the page as cmem.ai serves it, with the meta its /work route adds (claude-mem-pro src/app/work/handlers.ts).
    const ownerMeta = url.searchParams.get('owner') === '1' ? '<meta name="cmem-work-owner" content="fixture-owner">' : '';
    if (url.pathname === '/') return htmlResponse(`<meta name="viewport" content="width=device-width,initial-scale=1">${ownerMeta}<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/app.css') return new Response(styles,{headers:{'Content-Type':'text/css'}});
    if (url.pathname === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/fixture-model') { overview = await request.json() as Record<string,unknown>; return new Response('ready'); }
    // cmem.ai's page (the owner meta) reads the overview by request when the stream says it changed, not from the stream.
    if (url.pathname === '/api/work-view/overview') { const at = new Date().toISOString(); return Response.json({...overview,generatedAt:at,source:source(at),sync:sync('current')}); }
    if (url.pathname === '/api/version') { versionReads++; return Response.json(versionAnswer.body, { status: versionAnswer.status }); }
    if (url.pathname === '/api/work-view/events') return new Response(new ReadableStream({start(value) {
      const at = new Date().toISOString();
      controller = value; emit('work-view-overview',{...overview,generatedAt:at,source:source(at),sync:sync('current')});
    }}), {headers:{'Content-Type':'text/event-stream'}});
    if (url.pathname === '/sync') {
      const at = new Date().toISOString();
      emit('heartbeat',{source:source(at),at});
      emit('sync_status',{sync:sync(url.searchParams.get('state')!, url.searchParams.get('remaining') ?? undefined, url.searchParams.get('message') ?? undefined)});
      return new Response('sent');
    }
    if (url.pathname === '/api/sync/status') unexpectedStatusGets++;
    return Response.json({});
  }});
});

afterAll(() => { server?.stop(true); });

async function openPage(query = ''): Promise<{ chrome: OwnedChrome; page: DevToolsPage }> {
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const address = `${server!.url.href}${query}`;
  const chrome = launchChrome(address,{profilePrefix:'claude-mem-machine-sync-',remoteDebugging:true,extraFlags:UNTHROTTLED_TIMER_FLAGS});
  // The fixture draws in about a second here; 10s is for a cold Chrome on a shared CI runner.
  await withTimeout(ready,10_000,'Machine and sync fixture did not start');
  const page = await connectToPage(chrome,address);
  return { chrome, page };
}

(chromeExecutablePath ? it : it.skip)('names a cloud copy that fails or lags beside a live feed, at phone width, and reads the names out once', async () => {
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    ({ chrome, page } = await openPage());
    await page.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
    await page.evaluate('window.waitForSync("current")');
    const current = await page.evaluate('window.readPage()');
    expect(current.width).toBe(375);
    expect(current.feed).toBe('Live updates');
    expect(current.syncState).toBe('Cloud data current');
    // What waits to upload and how updates arrive are their own facts (the worker counted three records).
    expect([current.upload, current.mode]).toEqual(['3 items', 'HTTP polling']);
    expect(current.announced).toBe('Live updates. Cloud data current');
    expect(pageFitsTheWindow(await page.evaluate(PAGE_WIDTHS), 375, { touch: true })).toMatchObject(FITS_THE_WINDOW);

    // A cloud copy that fails or lags is named on its own fact, beside a feed that stays live, at phone width.
    for (const [state,label] of [['offline','Cloud sync unavailable'],['catching-up','Cloud catching up']]) {
      await fetch(new URL(`/sync?state=${state}`,server!.url));
      await page.evaluate(`window.waitForSync(${JSON.stringify(state)})`);
      const rendered = await page.evaluate('window.readPage()');
      expect(rendered.feed).toBe('Live updates');
      expect(rendered.syncState).toBe(label);
      // It asks for attention: the attention colour, not the feed's.
      expect(rendered.syncColor).not.toBe(current.syncColor);
      expect(rendered.syncColor).not.toBe(rendered.feedColor);
      // A status region takes no name from its words; they are its child text, which is what a reader announces.
      const accessibility = await page.send('Accessibility.getFullAXTree');
      const byId = new Map(accessibility.nodes.map((node: any) => [node.nodeId, node]));
      const textUnder = (node: any): string => [node.name?.value ?? '', ...(node.childIds ?? []).map((id: string) => byId.get(id)).filter(Boolean).map(textUnder)].join(' ');
      expect(accessibility.nodes.some((node: any) => node.role?.value === 'status' && textUnder(node).includes(label))).toBe(true);
      // The status line says the names, never the sentence behind them: that sentence's count changes on every poll,
      // and a status region reads its whole text again at each change.
      expect(rendered.announced).toBe(`Live updates. ${label}`);
      expect(rendered.announced).not.toContain('9007199254740993');
    }
    // The changes still to sync are a fact of their own, as the worker counted them (a decimal string, never rounded).
    expect((await page.evaluate('window.readPage()')).remaining).toBe('9007199254740993');
    // A new count while the cloud catches up reaches the page and changes nothing that is read out: heard once.
    const catchingUp = await page.evaluate('window.readPage()');
    await fetch(new URL('/sync?state=catching-up&remaining=12', server!.url));
    // The fixture's stream is local; 5s is for a cold Chrome on a shared CI runner.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const check = () => window.syncDetail()?.includes('Changes remaining: 12.') ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, 'the new sync count did not arrive');
    await page.settle();
    const counted = await page.evaluate('window.readPage()');
    expect(counted.announced).toBe(catchingUp.announced);
    expect(counted.remaining).toBe('12');

    // In Turkish the cloud copy's label and every sentence of its detail are Turkish: the worker's own sentence, the
    // delivery mode and the changes left (they showed in English in every language).
    await fetch(new URL(`/sync?state=catching-up&remaining=12&message=${encodeURIComponent('Cloud updates are being synchronized.')}`, server!.url));
    // The same local stream as above; 5s is for a cold Chrome on a shared CI runner.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const check = () => window.syncDetail()?.startsWith('Cloud updates are being synchronized.') ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, 'the real sync sentence did not arrive');
    await page.evaluate(`window.setLocale('tr')`);
    await page.settle();
    // The cloud copy's Details: the second Details on the page (This computer's comes first).
    await page.evaluate(`[...document.querySelectorAll('button[aria-expanded]')].filter((button) => button.textContent.trim() === 'Ayrıntılar')[1].click()`);
    // The fold opens within a frame or two; 5s is for a cold Chrome on a shared CI runner.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const check = () => document.querySelector('[data-sync-detail]') ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, 'the Details fold did not open');
    expect(await page.evaluate(`({ label: document.querySelector('[data-fact="sync-state"] dd').textContent, detail: document.querySelector('[data-sync-detail]').textContent,
      sentence: document.querySelector('[data-sync-sentence]').textContent })`))
      .toEqual({ label: 'Bulut yetişiyor', detail: 'Bulut güncellemeleri eşitleniyor. Mod: HTTP yoklama. Kalan değişiklikler: 12.', sentence: 'Bulut güncellemeleri eşitleniyor.' });
    await page.evaluate(`window.setLocale('en')`);
    expect(unexpectedStatusGets).toBe(0);
  } finally {
    await page?.evaluate('window.stopSource?.()').catch(() => {});
    page?.close();
    await chrome?.close();
  }
  // 0.8–0.9s here, Chrome start included (2026-11-28, three runs); 30s for a cold Chrome on a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('shows the worker version it read, and says plainly when the server refused the read', async () => {
  for (const [answer, expected] of [
    [{ status: 200, body: { version: '17.0.2' } }, { versionRead: 'read', version: '17.0.2' }],
    // The cloud viewer's gate refuses reads that would show its own machine (services/viewer-host/src/gate.ts).
    [{ status: 403, body: { error: 'This works only on your own computer.' } }, { versionRead: 'refused', version: 'Not read here: This works only on your own computer.' }],
    [{ status: 502, body: 'Bad gateway' }, { versionRead: 'refused', version: 'Not read: the server answered 502.' }],
  ] as const) {
    versionAnswer = answer;
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      ({ chrome, page } = await openPage());
      // The fixture answers the read at once, within a frame or two; 5s is for a cold Chrome on a shared CI runner.
      await withTimeout(page.evaluate(`new Promise((resolve) => { const check = () => document.querySelector('[data-version-read]:not([data-version-read="reading"])') ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, 'the version read did not answer');
      const shown = await page.evaluate('window.readPage()');
      expect({ versionRead: shown.versionRead, version: shown.version }).toEqual(expected);
    } finally {
      await page?.evaluate('window.stopSource?.()').catch(() => {});
      page?.close();
      await chrome?.close();
    }
  }
  versionAnswer = { status: 200, body: { version: '17.0.2' } };
  // 1.9–2.1s here for its three Chromes (2026-11-28, three runs); 30s for cold Chromes on a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('on cmem.ai, which runs no worker, asks no version and says it is not read there', async () => {
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  versionReads = 0;
  try {
    ({ chrome, page } = await openPage('?owner=1'));
    // The row says so from the start: there is no read to wait for. It draws with the page, within a frame or two of the
    // model; 5s is for a cold Chrome on a shared CI runner.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const check = () => document.querySelector('[data-version-read]') ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, 'the version row did not draw');
    expect(await page.evaluate(`({ versionRead: document.querySelector('[data-version-read]').dataset.versionRead, version: document.querySelector('[data-fact="version"] dd').textContent })`))
      .toEqual({ versionRead: 'not-read-here', version: 'Not read here: cmem.ai shows your synced work and runs no worker.' });
    expect(versionReads).toBe(0);
  } finally {
    await page?.evaluate('window.stopSource?.()').catch(() => {});
    page?.close();
    await chrome?.close();
  }
  // 0.6–0.7s here (2026-11-28, three runs); 30s for a cold Chrome on a slow CI runner.
}, 30_000);

/** Loopback-only viewer acceptance used by the canonical sync matrix. */
import express from 'express';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionStore } from '../src/services/sqlite/SessionStore.js';
import type { CloudSync } from '../src/services/sync/CloudSync.js';
import type { SyncClient } from '../src/services/sync/SyncClient.js';
import { ViewerSyncService } from '../src/services/sync/ViewerSyncService.js';
import { WorkViewRoutes } from '../src/services/worker/http/routes/WorkViewRoutes.js';
import { DataRoutes } from '../src/services/worker/http/routes/DataRoutes.js';
import { PaginationHelper } from '../src/services/worker/PaginationHelper.js';
import { SSEBroadcaster } from '../src/services/worker/SSEBroadcaster.js';
import { MemoryFeedInvalidation } from '../src/services/worker/MemoryFeedInvalidation.js';
import { SharedWorkSync } from '../src/services/work-view/SharedWorkSync.js';
import { createGate, SESSION_COOKIE } from '../services/viewer-host/src/gate.js';
import { signToken } from '../services/viewer-host/src/token.js';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, launchChrome,
  readViewerTemplateHtml, UNTHROTTLED_TIMER_FLAGS,
} from '../tests/helpers/chrome-devtools.js';

/** Actual source/store and all RequestCards; no synthetic model or reduced card count. */
export function compileMatrixWorkBrowser(hosted = false): string {
  return compileBrowserFixture(`
        import React from './src/ui/my-work/node_modules/react';
        import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
        import { createLocalSource } from './src/ui/my-work/src/live/local-source';
        import { useStore } from './src/ui/my-work/src/store';
        import { LiveIndicator } from './src/ui/my-work/src/components/bits';
        import { RequestCard } from './src/ui/my-work/src/components/request-card';
        import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
        window.React = React;
        const started = performance.now();
        window.matrixErrors = []; addEventListener('error', event => window.matrixErrors.push(String(event.message))); addEventListener('unhandledrejection', event => window.matrixErrors.push(String(event.reason)));
        const metrics = window.matrixMetrics = { startedAt: started, overviewHandlerMs: null, sourceReadyMs: null, firstUsefulMs: null, longTasks: 0, longTaskMs: 0 };
        try { new PerformanceObserver(list => { for (const entry of list.getEntries()) { metrics.longTasks++; metrics.longTaskMs += entry.duration; } }).observe({ type: 'longtask', buffered: true }); } catch {}
        window.matrixModel = () => useStore.getState().work.load;
        const source = createLocalSource({ hostname: ${JSON.stringify(hosted ? 'matrix-hosted.invalid' : 'localhost')}, eventSourceFactory: url => {
          const stream = new EventSource(url), add = stream.addEventListener.bind(stream);
          stream.addEventListener = (type, handler, options) => add(type, event => {
            const before = performance.now(); handler(event);
            if (type === 'work-view-overview' && metrics.overviewHandlerMs === null) metrics.overviewHandlerMs = performance.now() - before;
          }, options); return stream;
        } });
        const subscribe = source.subscribeToLiveUpdates;
        source.subscribeToLiveUpdates = (onModel, onConnection) => subscribe(model => { if (metrics.sourceReadyMs === null) metrics.sourceReadyMs = performance.now() - started; onModel(model); }, onConnection);
        window.matrixStop = useStore.getState().startWorkSource(source);
        function Fixture() { const load = useStore(state => state.work.load);
          React.useEffect(() => { if (load.state === 'loaded' && metrics.firstUsefulMs === null) requestAnimationFrame(() => requestAnimationFrame(() => { if (metrics.firstUsefulMs === null) metrics.firstUsefulMs = window.matrixUseful = performance.now() - started; })); }, [load]);
          return load.state === 'loaded' ? <TooltipProvider><LiveIndicator />{load.model.requests.map(request => <article key={request.id} data-matrix-request={request.id}><h2>{request.title}</h2><RequestCard request={request} onOpen={() => {}} onOpenFocus={() => {}} /></article>)}</TooltipProvider> : <p>Loading</p>; }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `);
}

/** The real app CSS produced by the repository build, not hand-written test layout. */
export const MATRIX_WORK_ASSETS = resolve(import.meta.dir, '../plugin/ui/work-view/assets');
export function readMatrixWorkStyles(): string {
  const assets = MATRIX_WORK_ASSETS;
  const html = readFileSync(resolve(assets, '../index.html'), 'utf8');
  const href = html.match(/href="[^"]*\/([^/"]+\.css)"/);
  const css = href ? [href[1]].filter(file => readdirSync(assets).includes(file)) : [];
  if (css.length !== 1) throw new Error('Build the My Work app before the browser matrix');
  return readFileSync(join(assets, css[0]), 'utf8');
}

export interface ViewerDevice {
  dir: string; dbPath: string; deviceId: string; store: SessionStore; cloudSync: CloudSync; client: SyncClient;
}
const SECRET = 'matrix-viewer-secret-at-least-32-characters';

export async function openMatrixViewer(device: ViewerDevice, hosted: boolean, owner: string) {
  const ledger = join(device.dir, 'work-view'); mkdirSync(ledger, { recursive: true });
  const shared = new SharedWorkSync(device.store.db, { databasePath: device.dbPath, directory: ledger,
    deviceId: device.deviceId, enabled: true, notify: () => device.cloudSync.notify(), intervalMs: 60_000 });
  const broadcaster = new SSEBroadcaster();
  const invalidation = new MemoryFeedInvalidation(broadcaster); invalidation.start();
  let routes!: WorkViewRoutes;
  const sync = new ViewerSyncService({ cloud: () => device.cloudSync, pull: () => device.client,
    hasViewers: () => true, refreshMs: 100, onChange: value => {
      routes.publishSyncStatus(value); broadcaster.broadcast({ type: 'sync_status', sync: value });
    } });
  routes = new WorkViewRoutes({ databasePath: device.dbPath, ledgerDir: ledger, reviewPath: join(device.dir, 'reviews.db'),
    settingsPath: join(device.dir, 'settings.json'), setupStatePath: join(device.dir, 'setup.json'),
    humanCopy: null, autoRefresh: null, focusShares: null, hostedIntent: null, homeProject: 'matrix-view', pollIntervalMs: 1000, getLocalDeviceId: () => device.deviceId,
    getSharedStatus: () => shared.status(), getSyncStatus: () => sync.getSnapshot(),
    saveSharedReview: input => shared.saveReview(input), prepareSharedOwnerAction: () => shared.prepareOwnerAction(),
    answerSharedSuggestion: (key, action, hash) => shared.answerSuggestion(key, action, hash),
    saveSharedLedgerFile: (name, value) => shared.saveFile(name, value),
    appendWorkStateEntry: entry => { device.store.appendWorkStateEntry(entry); device.cloudSync.notify(); },
    rulesFilePath: join(device.dir, 'MY-RULES.md'), claudeInstructionsPath: join(device.dir, 'CLAUDE.md'),
    focusSharePublishEveryMs: 0,
  });
  sync.start();
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  // Use the production pagination/data route implementations over this exact replica.
  const manager = { getSessionStore: () => device.store, getCloudSync: () => device.cloudSync };
  const sessions = { getActiveSessionCount: () => 0 };
  new DataRoutes(new PaginationHelper(manager as any), manager as any, sessions as any, broadcaster, {} as any, Date.now()).setupRoutes(app);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/sync/status', async (_req, res) => res.json(await sync.statusWithProbe()));
  app.get('/stream', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    broadcaster.addClient(res);
    broadcaster.broadcast({ type: 'initial_load', ...device.store.getProjectCatalog() });
    broadcaster.broadcast({ type: 'processing_status', isProcessing: false, queueDepth: 0 });
  });
  let workBundle = '', classicBundle = '', workStyles = '';
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><link rel="stylesheet" href="/matrix-work.css"><div id="root"></div><script src="/matrix-work.js"></script>'));
  app.get('/matrix-work.js', (_req, res) => res.type('js').send(workBundle));
  app.get('/matrix-work.css', (_req, res) => res.type('css').send(workStyles));
  app.get('/viewer', (_req, res) => res.type('html').send(readViewerTemplateHtml()));
  app.get('/viewer-bundle.js', (_req, res) => res.type('js').send(classicBundle));
  app.use('/work-view/assets', express.static(MATRIX_WORK_ASSETS, { index: false }));
  app.use(express.static(MATRIX_WORK_ASSETS, { index: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const upstream = `http://127.0.0.1:${(server.address() as any).port}`;
  let gateServer: ReturnType<typeof Bun.serve> | null = null;
  let gateOrigin = upstream;
  if (hosted) {
    gateServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => gate(request) });
    gateOrigin = `http://127.0.0.1:${gateServer.port}`;
  }
  const gate = createGate({ ownerUserId: owner, secret: SECRET, upstreamOrigin: upstream, publicOrigin: gateOrigin,
    signInUrl: `${upstream}/not-a-real-sign-in`, posthogFetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    env: {}, fetchImpl: ((input: any, init: any) => {
      const url = new URL(String(input));
      if (url.origin !== upstream) throw new Error('viewer gate escaped its owned upstream');
      return fetch(input, { ...init, redirect: 'error' });
    }) as typeof fetch });
  let cookie = '';
  if (hosted) {
    const link = signToken(SECRET, { sub: owner, aud: 'link', exp: Math.floor(Date.now() / 1000) + 120 });
    const granted = await fetch(`${gateOrigin}/auth?t=${encodeURIComponent(link)}`, { redirect: 'manual' });
    if (granted.status !== 303) throw new Error('Owned hosted viewer did not accept its grant');
    cookie = granted.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!cookie.startsWith(`${SESSION_COOKIE}=`)) throw new Error('Hosted grant did not issue a session cookie');
    const replay = await fetch(`${gateOrigin}/auth?t=${encodeURIComponent(link)}`, { redirect: 'manual' });
    if (replay.status !== 403) throw new Error('Hosted gate accepted a reused grant');
  }
  const request = (path: string, body?: unknown) => fetch(`${gateOrigin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: gateOrigin, 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { device, shared, routes, sync, origin: gateOrigin, upstream, cookie, request,
    snapshot: async () => { const response = await request('/api/work-view'); if (!response.ok) throw new Error(`viewer read ${response.status}`); return response.json(); },
    notify: async () => { await sync.statusWithProbe(); broadcaster.broadcast({ type: 'data_changed', kinds: ['observation', 'work_state'], projects: [] }); },
    malformedGrant: async () => hosted ? fetch(`${gateOrigin}/auth?t=malformed`, { redirect: 'error' }) : null,
    compileBrowser() {
      workBundle = compileMatrixWorkBrowser(hosted); workStyles = readMatrixWorkStyles();
      classicBundle = compileBrowserFixture(`import React from 'react'; import {createRoot} from 'react-dom/client';
        import {App} from './src/ui/viewer/App'; localStorage.setItem('claude-mem-welcome-dismissed','true');
        createRoot(document.getElementById('root')).render(<App />);`);
    },
    async close() { invalidation.close(); routes.close(); sync.close(); shared.close(); gateServer?.stop(true); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export type MatrixViewer = Awaited<ReturnType<typeof openMatrixViewer>>;

/** Three real browser pages follow the same SQLite replicas and production HTTP/SSE routes. */
export async function runViewerBrowsers(local: MatrixViewer, hosted: MatrixViewer,
  scenario: (pages: { local: any; hosted: any; classic: any }) => Promise<void>) {
  if (!chromeExecutablePath) throw new Error('Chrome is required for viewer matrix acceptance');
  local.compileBrowser(); hosted.compileBrowser();
  // A separate owned profile per page keeps the fixture independent from all user tabs.
  const opened: Array<{ chrome: ReturnType<typeof launchChrome>; page: Awaited<ReturnType<typeof connectToPage>> }> = [];
  try {
    for (const [viewer, suffix] of [[local, '/'], [hosted, '/'], [hosted, '/viewer']] as const) {
      const url = `${viewer.origin}${suffix}`;
      const browser = launchChrome('about:blank', { remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
      const page = await connectToPage(browser, 'about:blank').catch(async error => { await browser.close(); throw error; });
      opened.push({ chrome: browser, page });
      if (viewer.cookie) {
        const [name, value] = viewer.cookie.split('=');
        await page.send('Network.setCookie', { name, value, url: viewer.origin, path: '/', httpOnly: true });
      }
      await page.send('Page.navigate', { url });
    }
    await scenario({ local: opened[0].page, hosted: opened[1].page, classic: opened[2].page });
  } finally { for (const { chrome, page } of opened.reverse()) { page.close(); await chrome.close(); } }
}

/** Four actual pages in one owned Chrome process, for first-useful-view timing. */
export async function measureMatrixBrowserPages(origin: string, options: { tabs?: number; cookie?: string; timeoutMs?: number } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Browser benchmark requires loopback');
  const chrome = launchChrome('about:blank', { remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  const control = await connectToPage(chrome, 'about:blank');
  const pages: Awaited<ReturnType<typeof connectToPage>>[] = [];
  try {
    if (options.cookie) { const [name, value] = options.cookie.split('='); await control.send('Network.setCookie', { name, value, url: origin, path: '/', httpOnly: true }); }
    for (let i = 0; i < (options.tabs ?? 4); i++) {
      const pageUrl = new URL(`/?matrixTab=${i}`, origin).href;
      await control.send('Target.createTarget', { url: pageUrl });
      const page = await connectToPage(chrome, pageUrl); pages.push(page);
      await page.send('Performance.enable');
    }
    const deadline = performance.now() + (options.timeoutMs ?? 60_000);
    while (!(await Promise.all(pages.map(page => page.evaluate('Number.isFinite(window.matrixMetrics?.firstUsefulMs)')))).every(Boolean)) {
      if (performance.now() >= deadline) {
        const diagnostics = await Promise.all(pages.map(page => page.evaluate('({metrics:window.matrixMetrics,errors:window.matrixErrors,modelState:window.matrixModel?.()?.state,visibility:document.visibilityState})')));
        throw new Error('Browser benchmark first useful view timed out: ' + JSON.stringify(diagnostics));
      }
      // Background tabs may suspend rAF even with timer throttling disabled.
      // Foreground each owned tab so first paint is observable; sourceReadyMs
      // remains the independent concurrent-load timing for every tab.
      for (const page of pages) { await page.send('Page.bringToFront'); await page.settle(); }
      await Bun.sleep(25);
    }
    return await Promise.all(pages.map(async (page, index) => {
      const metrics = await page.evaluate('({...window.matrixMetrics, navigationToUsefulMs:window.matrixMetrics.startedAt+window.matrixMetrics.firstUsefulMs, navigation:performance.getEntriesByType("navigation").map(entry=>entry.toJSON()), resources:performance.getEntriesByType("resource").map(entry=>({name:new URL(entry.name).pathname,duration:entry.duration,transferSize:entry.transferSize,decodedBodySize:entry.decodedBodySize})), requests: window.matrixModel().model.requests.length, domNodes:document.getElementsByTagName("*").length, heapBytes: performance.memory?.usedJSHeapSize ?? null})');
      const performanceMetrics = await page.send('Performance.getMetrics');
      return { tab: index, ...metrics, chrome: Object.fromEntries(performanceMetrics.metrics.filter((entry: any) => ['ScriptDuration','LayoutDuration','TaskDuration','JSHeapUsedSize','Nodes'].includes(entry.name)).map((entry: any) => [entry.name,entry.value])) };
    }));
  } finally { for (const page of pages) page.close(); control.close(); await chrome.close(); }
}

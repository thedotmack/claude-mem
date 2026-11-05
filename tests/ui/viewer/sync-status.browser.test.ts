import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the viewer sync-status regression.');

(chromeExecutablePath ? it : it.skip)('keeps feed connection distinct from a failed download and releases hidden-tab activity', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Header } from './src/ui/viewer/components/Header';
    import { useSSE } from './src/ui/viewer/hooks/useSSE';
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => new URL(String(input), location.href).origin !== location.origin
      ? Promise.resolve(Response.json({stargazers_count:0})) : nativeFetch(input, init);
    function Screen() {
      const stream = useSSE({ onItemDeleted() {}, onSessionDeleted() {}, onLiveItem() {} });
      return <Header projects={[]} currentFilter="" onFilterChange={() => {}} isProcessing={false} queueDepth={0}
        themePreference="system" onThemeChange={() => {}} onContextPreviewToggle={() => {}}
        isConnected={stream.isConnected} syncStatus={stream.syncStatus} />;
    }
    createRoot(document.getElementById('root')).render(<Screen />);
    async function until(predicate) {
      const deadline = Date.now() + 6000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Sync view did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    (async () => {
      try {
        await fetch('/ready');
        await until(() => document.querySelector('[data-sync-state="current"]'));
        const current = document.querySelector('[data-sync-state="current"]').textContent;
        await fetch('/fail-download', {method:'POST'});
        await until(() => document.querySelector('[data-sync-state="offline"]'));
        const offline = document.querySelector('[data-sync-state="offline"]').textContent;
        Object.defineProperty(document, 'visibilityState', {configurable:true, get:()=>'hidden'});
        document.dispatchEvent(new Event('visibilitychange'));
        await fetch('/result', {method:'POST', body:JSON.stringify({current, offline})});
      } catch(error) { await fetch('/result', {method:'POST',body:JSON.stringify({failure:String(error)})}); }
    })();
  `);
  let ready!: () => void;
  const pageReady = new Promise<void>(resolve => { ready = resolve; });
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let statusGets = 0;
  const leases: Array<{visible:boolean;sequence:number}> = [];
  const sync = (state: 'current' | 'offline') => ({
    configured: true, state, mode: 'polling', observedAt: Date.now(), checkedAt: Date.now(),
    message: state === 'offline' ? 'Incoming cloud download failed.' : 'Shared records are current.',
    download: {lastSuccessAt:Date.now()}, projection:{remaining:'0'},
    completeness:{pushQuarantine:0,pullQuarantine:0,excludedNative:0,scope:'eligible'},
  });
  const emit = (value: unknown) => controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/ready') { ready(); return new Response('ready'); }
    if (path === '/stream') return new Response(new ReadableStream({start(value) {
      controller = value; emit({type:'initial_load',projects:[],sync:sync('current')});
    }}), {headers:{'Content-Type':'text/event-stream'}});
    if (path === '/fail-download') { emit({type:'sync_status',sync:sync('offline')}); return new Response('sent'); }
    if (path === '/api/work-view/activity') { leases.push(await request.json() as {visible:boolean;sequence:number}); return new Response(null,{status:204}); }
    if (path === '/api/sync/status') statusGets++;
    if (path === '/api/processing-status') return Response.json({isProcessing:false,queueDepth:0});
    if (path === '/result') { report(await request.json()); return new Response('received'); }
    return Response.json({});
  }});
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, {profilePrefix:'claude-mem-sync-status-',extraFlags:UNTHROTTLED_TIMER_FLAGS});
    await withTimeout(pageReady,30_000,'Sync browser did not start');
    const actual = await withTimeout(result,15_000,'Sync browser did not report') as {current?:string;offline?:string;failure?:string};
    expect(actual.failure).toBeUndefined();
    expect(actual.current).toContain('Feed connected');
    expect(actual.current).toContain('Cloud data current');
    expect(actual.offline).toContain('Feed connected');
    expect(actual.offline).toContain('Cloud sync unavailable');
    await withTimeout((async () => {while (!leases.some(lease => !lease.visible)) await Bun.sleep(5);})(),1000,'Hidden lease not released');
    expect(leases[0]?.visible).toBe(true);
    expect(leases.at(-1)?.visible).toBe(false);
    expect(statusGets).toBe(0);
  } finally {await chrome?.close(); server.stop(true);}
},60_000);

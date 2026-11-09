import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the mobile cloud sync indicator regression.');

(chromeExecutablePath ? it : it.skip)('shows cloud failures and lag beside a healthy feed at mobile widths', async () => {
  // Compile the application's real stylesheet and candidates; hand-written fixture CSS could hide a responsive regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  const styles = css.build(scanner.scan());
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { LiveIndicator } from './src/ui/my-work/src/components/bits';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { createLocalSource } from './src/ui/my-work/src/live/local-source';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    window.React = React;
    window.waitForSync = async (state) => {
      const deadline = performance.now() + 6000;
      while (!document.querySelector('[data-sync-state="' + state + '"]')) {
        if (performance.now() > deadline) throw new Error('Sync state did not render: ' + state);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    window.readSync = () => {
      const sync = document.querySelector('[data-sync-state]');
      const icon = sync.querySelector('svg');
      const label = sync.querySelector('span');
      return { width: innerWidth, feed: sync.parentElement.dataset.connectionState,
        state: sync.dataset.syncState, name: sync.getAttribute('aria-label'), role: sync.getAttribute('role'),
        display: getComputedStyle(sync).display, color: getComputedStyle(sync).color,
        iconDisplay: getComputedStyle(icon).display, iconWidth: icon.getBoundingClientRect().width,
        labelPosition: getComputedStyle(label).position, labelWidth: label.getBoundingClientRect().width,
        indicatorWidth: sync.parentElement.getBoundingClientRect().width,
        feedColor: getComputedStyle(sync.parentElement.firstElementChild.lastElementChild).backgroundColor };
    };
    (async () => {
      const { connection, ...model } = await sampleSource.loadWorkModel();
      await fetch('/fixture-model', {method:'POST', body:JSON.stringify({ version:1, revision:'a'.repeat(64),
        model:{...model, sourceKind:'cloud', requests:[], sourceHealth:{...model.sourceHealth,connected:true}} })});
      window.stopSource = useStore.getState().startWorkSource(createLocalSource({hostname:'viewer.example'}));
      function Fixture() {
        const load = useStore(state => state.work.load);
        return load.state === 'loaded' ? <TooltipProvider><LiveIndicator /></TooltipProvider> : <span>Loading</span>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
      await fetch('/fixture-ready');
    })();
  `);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let overview: Record<string, unknown> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unexpectedStatusGets = 0;
  const source = (at: string) => ({kind:'claude-mem-recorded-agent-activity',mode:'read-only-sqlite',connected:true,
    pollIntervalMs:1000,lastCheckedAt:at,activityCheckedAt:at,lastUpdatedAt:null,error:null,stale:false});
  const sync = (state: string) => ({ configured:true,state,mode:'polling',observedAt:Date.now(),checkedAt:Date.now(),
    message:state === 'offline' ? 'Incoming cloud download failed.' : state === 'catching-up' ? 'Applying incoming cloud changes.' : 'Shared records are current.',
    download:{lastSuccessAt:Date.now()},projection:{remaining:state === 'catching-up' ? '9007199254740993' : '0'},
    completeness:{pushQuarantine:0,pullQuarantine:0,excludedNative:0,scope:'eligible'} });
  const emit = (event: string, value: unknown) => controller?.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
    if (url.pathname === '/fixture.js') return scriptResponse(bundle);
    if (url.pathname === '/app.css') return new Response(styles,{headers:{'Content-Type':'text/css'}});
    if (url.pathname === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (url.pathname === '/fixture-model') { overview = await request.json() as Record<string,unknown>; return new Response('ready'); }
    if (url.pathname === '/api/work-view/events') return new Response(new ReadableStream({start(value) {
      const at = new Date().toISOString();
      controller = value; emit('work-view-overview',{...overview,generatedAt:at,source:source(at),sync:sync('current')});
    }}), {headers:{'Content-Type':'text/event-stream'}});
    if (url.pathname === '/sync') {
      const at = new Date().toISOString();
      emit('heartbeat',{source:source(at),at});
      emit('sync_status',{sync:sync(url.searchParams.get('state')!)});
      return new Response('sent');
    }
    if (url.pathname === '/api/sync/status') unexpectedStatusGets++;
    return Response.json({});
  }});
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href,{profilePrefix:'claude-mem-mobile-sync-',remoteDebugging:true,extraFlags:UNTHROTTLED_TIMER_FLAGS});
    await withTimeout(ready,10_000,'Live indicator fixture did not start');
    page = await connectToPage(chrome,server.url.href);
    await page.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
    await page.evaluate('window.waitForSync("current")');
    const current = await page.evaluate('window.readSync()');
    expect(current.width).toBe(375);
    expect(current.feed).toBe('live');
    expect(current.iconWidth).toBeGreaterThan(10);
    expect(current.iconDisplay).not.toBe('none');
    expect(current.labelPosition).toBe('absolute');

    for (const [state,label] of [['offline','Cloud sync unavailable'],['catching-up','Cloud catching up']]) {
      await fetch(new URL(`/sync?state=${state}`,server.url));
      await page.evaluate(`window.waitForSync(${JSON.stringify(state)})`);
      const rendered = await page.evaluate('window.readSync()');
      expect(rendered.feed).toBe('live');
      expect(rendered.feedColor).toBe(current.feedColor);
      expect(rendered.display).not.toBe('none');
      expect(rendered.iconDisplay).not.toBe('none');
      expect(rendered.iconWidth).toBeGreaterThan(10);
      expect(rendered.indicatorWidth).toBeLessThan(80);
      expect(rendered.color).not.toBe(current.color);
      expect(rendered.name).toContain(label);
      expect(rendered.role).toBe('status');
      const accessibility = await page.send('Accessibility.getFullAXTree');
      expect(accessibility.nodes.some((node: any) => node.role?.value === 'status' && node.name?.value.includes(label))).toBe(true);
      if (state === 'catching-up') expect(rendered.name).toContain('9007199254740993');
    }

    await page.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
    await page.settle();
    const desktop = await page.evaluate('window.readSync()');
    expect(desktop.feed).toBe('live');
    expect(desktop.iconDisplay).toBe('none');
    expect(desktop.labelPosition).not.toBe('absolute');
    expect(desktop.labelWidth).toBeGreaterThan(50);
    expect(unexpectedStatusGets).toBe(0);
  } finally {
    await page?.evaluate('window.stopSource?.()').catch(() => {});
    page?.close();
    await chrome?.close();
    server.stop(true);
  }
},60_000);

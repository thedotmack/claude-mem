import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the mobile cloud sync indicator regression.');

(chromeExecutablePath ? it : it.skip)('names cloud failures and lag on the Live chip beside a healthy feed at mobile widths', async () => {
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
      while (!document.querySelector('[role="status"][data-sync-state="' + state + '"]')) {
        if (performance.now() > deadline) throw new Error('Sync state did not render: ' + state);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    // The one chip (c-bits-live-indicator) and the status line read out when its words change. The chip is a Button,
    // which eases its colours, so it is read once those transitions end.
    window.readSync = async () => {
      const chip = document.querySelector('[data-live-chip]');
      await Promise.all(chip.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
      const status = document.querySelector('[role="status"][data-sync-state]');
      const words = [...chip.querySelectorAll('span')].filter((span) => getComputedStyle(span).display !== 'none' && span.textContent.trim());
      return { width: innerWidth, feed: chip.dataset.connectionState, problem: chip.dataset.liveChip,
        state: status.dataset.syncState, role: status.getAttribute('role'), announced: status.textContent,
        shown: words.map((span) => span.textContent.trim()).join(' '), display: getComputedStyle(chip).display,
        color: getComputedStyle(chip).color, chipWidth: chip.getBoundingClientRect().width,
        mark: chip.querySelector('svg') ? 'cloud' : 'dot' };
    };
    // What the page last received about the cloud copy, so a test knows a new sync status has arrived.
    window.syncDetail = () => useStore.getState().work.connection?.sync?.detail ?? null;
    (async () => {
      const { connection, ...model } = await sampleSource.loadWorkModel();
      await fetch('/fixture-model', {method:'POST', body:JSON.stringify({ version:1, revision:'a'.repeat(64),
        model:{...model, sourceKind:'cloud', requests:[], sourceHealth:{...model.sourceHealth,connected:true}} })});
      window.stopSource = useStore.getState().startWorkSource(createLocalSource({hostname:'viewer.example'}));
      // A control after the chip, as the header has (the machines), for Tab out of the panel.
      function Fixture() {
        const load = useStore(state => state.work.load);
        return load.state === 'loaded' ? <TooltipProvider><LiveIndicator /><button type="button">After the chip</button></TooltipProvider> : <span>Loading</span>;
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
  const sync = (state: string, remaining = '9007199254740993') => ({ configured:true,state,mode:'polling',observedAt:Date.now(),checkedAt:Date.now(),
    message:state === 'offline' ? 'Incoming cloud download failed.' : state === 'catching-up' ? 'Applying incoming cloud changes.' : 'Shared records are current.',
    download:{lastSuccessAt:Date.now()},projection:{remaining:state === 'catching-up' ? remaining : '0'},
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
      emit('sync_status',{sync:sync(url.searchParams.get('state')!, url.searchParams.get('remaining') ?? undefined)});
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
    expect(current.problem).toBe('live');
    expect(current.shown).toBe('Live');
    expect(current.announced).toBe('Live');

    // A cloud copy that fails or lags is named on the chip itself, beside a feed that stays live, at phone width.
    for (const [state,label] of [['offline','Cloud sync unavailable'],['catching-up','Cloud catching up']]) {
      await fetch(new URL(`/sync?state=${state}`,server.url));
      await page.evaluate(`window.waitForSync(${JSON.stringify(state)})`);
      const rendered = await page.evaluate('window.readSync()');
      expect(rendered.feed).toBe('live');
      expect(rendered.problem).toBe('cloud-behind');
      expect(rendered.display).not.toBe('none');
      expect(rendered.mark).toBe('cloud');
      expect(rendered.shown).toBe('Cloud behind');
      // The header at 375 has room for the chip beside the machine count and the menu (it was 444px wide in all).
      expect(rendered.chipWidth).toBeLessThan(140);
      expect(rendered.color).not.toBe(current.color);
      expect(rendered.role).toBe('status');
      expect(rendered.announced).toContain(label);
      // A status region takes no name from its words; they are its child text, which is what a reader announces.
      const accessibility = await page.send('Accessibility.getFullAXTree');
      const byId = new Map(accessibility.nodes.map((node: any) => [node.nodeId, node]));
      const textUnder = (node: any): string => [node.name?.value ?? '', ...(node.childIds ?? []).map((id: string) => byId.get(id)).filter(Boolean).map(textUnder)].join(' ');
      expect(accessibility.nodes.some((node: any) => node.role?.value === 'status' && textUnder(node).includes(label))).toBe(true);
      // The status line says the chip's words and the state's name, never the sentence behind them: that sentence's
      // count changes on every poll, and a status region reads its whole text again at each change.
      expect(rendered.announced).toBe(`Cloud behind. ${label}`);
      expect(rendered.announced).not.toContain('9007199254740993');
    }
    // A new count while the cloud catches up reaches the page and changes nothing that is read out: heard once.
    const catchingUp = await page.evaluate('window.readSync()');
    await fetch(new URL('/sync?state=catching-up&remaining=12', server.url));
    // The fixture's stream is local; 5s is for a cold Chrome on a shared CI runner.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const check = () => window.syncDetail()?.includes('Changes remaining: 12.') ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, 'the new sync count did not arrive');
    await page.settle();
    expect((await page.evaluate('window.readSync()')).announced).toBe(catchingUp.announced);

    // Wider screens also say the feed is live.
    await page.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
    await page.settle();
    const desktop = await page.evaluate('window.readSync()');
    expect(desktop.feed).toBe('live');
    expect(desktop.shown).toBe('Live · Cloud behind');

    // G10 by keyboard: Enter opens the panel with focus on the panel itself, not on its "checked" time (whose tooltip
    // would open over the panel and take the first Escape); one Escape closes the panel and gives focus back.
    const key = async (name: 'Enter' | 'Escape', keyCode: number, text?: string) => {
      await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text });
      await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await page!.settle();
    };
    await page.evaluate('document.querySelector("[data-live-chip]").focus()');
    await key('Enter', 13, '\r');
    expect(await page.evaluate(`({ panelFocused: document.activeElement?.dataset.slot === 'popover-content',
      time: !!document.querySelector('[data-slot="popover-content"] time'), tooltip: !!document.querySelector('[data-slot="tooltip-content"]') })`))
      .toEqual({ panelFocused: true, time: true, tooltip: false });
    await key('Escape', 27);
    // The panel fades out for 100ms (ui/popover.tsx) before it leaves the page and hands focus back; 5s is for CI.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const gone = () => document.querySelector('[data-slot="popover-content"]') ? requestAnimationFrame(gone) : resolve(true); gone(); })`), 5_000, 'the Live panel did not close on Escape');
    expect(await page.evaluate(`document.activeElement?.hasAttribute('data-live-chip')`)).toBe(true);

    // Tab leaves the panel as if it sat right after the chip (it is drawn at the end of the page): from its last
    // control on to the next one on the page, and the panel closes; Shift+Tab from the panel goes back to the chip.
    const tab = async (shift = false) => {
      const modifiers = shift ? 8 : 0;
      await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
      await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
      await page!.settle();
    };
    await key('Enter', 13, '\r');
    const stopsInPanel: number = await page.evaluate(`document.querySelector('[data-slot="popover-content"]').querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])').length`);
    expect(stopsInPanel).toBeGreaterThan(0);
    for (let stop = 0; stop < stopsInPanel; stop++) await tab();
    expect(await page.evaluate(`!!document.activeElement?.closest('[data-slot="popover-content"]')`)).toBe(true);
    await tab();
    // The panel fades out for 100ms (ui/popover.tsx); 5s is for CI.
    await withTimeout(page.evaluate(`new Promise((resolve) => { const gone = () => document.querySelector('[data-slot="popover-content"]') ? requestAnimationFrame(gone) : resolve(true); gone(); })`), 5_000, 'the Live panel did not close when Tab left it');
    expect(await page.evaluate('document.activeElement?.textContent')).toBe('After the chip');
    await page.evaluate('document.querySelector("[data-live-chip]").focus()');
    await key('Enter', 13, '\r');
    await tab(true);
    expect(await page.evaluate(`[document.activeElement?.hasAttribute('data-live-chip'), !!document.querySelector('[data-slot="popover-content"]')]`)).toEqual([true, true]);
    expect(unexpectedStatusGets).toBe(0);
  } finally {
    await page?.evaluate('window.stopSource?.()').catch(() => {});
    page?.close();
    await chrome?.close();
    server.stop(true);
  }
},60_000);

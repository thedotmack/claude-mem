import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  DESKTOP_MOUSE_FLAGS, REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { CONTENT_BODY_MAX_BYTES } from '../../../src/shared/cloud-sync-limits';
import { HISTORY_IMPORT_BATCH } from '../../../src/shared/setup-funnel';
import { SETUP_DSH_PROFILE_MAX_CHARACTERS, SETUP_INSTALL_NOTE_MAX_CHARACTERS } from '../../../src/shared/setup-install';

failOnCiWithoutChrome('CI requires Chrome for the setup flow touch-size, type-size and Back regressions.');

/**
 * Plan Phase 8 claims about the setup flow, measured in a real browser on the app's real stylesheets, walking the
 * sample fixtures (`?source=sample`: every button changes the page's own data, nothing is sent):
 * - every screen shows the five-step bar, and Back on every screen but the first;
 * - at most one navy button per screen;
 * - every control on the page is at least 44px tall on a phone (plan rule 6, touch-target-size);
 * - no visible text is under 14px;
 * - a finished scan moves on to the Reveal by itself, and Back goes where the flow says, pressed for real;
 * - the Reveal's pictures stay 64px on a phone, and "Skip the scan" does nothing while "Try again" runs;
 * - "Stop import" ends the upload and returns to Finish Setup, and only the person's press starts it again (E9);
 * - the launch hands over to the workspace when it did before Phase 8, and plays once;
 * - the DeepSeek Harness profile and the signup note keep the worker's limits and say when a paste is cut.
 * Two walks use the page's own source against a fake worker in this process instead (`fakeWorker`): a run found running
 * after a reload, Stop and Continue through the real data path, telemetry, and the event stream's reconnect.
 */
let compiled: { bundle: string; styles: string } | undefined;
async function compileSetupPage() {
  if (compiled) return compiled;
  // Compile the application's real stylesheet and candidates, plus setup's own stylesheet.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  const styles = css.build(scanner.scan()) + '\n' + readFileSync(resolve(app, 'src/setup/setup.css'), 'utf8').replace(/@font-face\s*{[^}]*}/, '');
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import SetupPage from './src/ui/my-work/src/setup/setup-page';
    import { LaunchScreen } from './src/ui/my-work/src/setup/screens/launch-screen';
    import { InstallScreen } from './src/ui/my-work/src/setup/screens/install-screen';
    window.React = React;
    // The install screen alone with DeepSeek Harness picked, which the sample's catalog has not: the profile field.
    window.mountInstall = () => {
      const host = document.createElement('div');
      host.id = 'install-fixture';
      document.body.append(host);
      const defaults = { agents: ['dsh'], skills: ['how-it-works'], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true, claudeModel: 'haiku', dshProfile: 'web' };
      const install = { status: 'waiting', selection: null, error: null, catalog: {
        agents: [{ id: 'dsh', label: 'DeepSeek Harness', hint: 'Plugin integration', detected: true }],
        skills: [{ id: 'how-it-works', label: 'How it works', description: 'Understand how claude-mem remembers your work.', required: true }],
        defaults, reinstall: false } };
      // In the page's own frame, so setup's stylesheet sizes it as on the page. Every install it sends is recorded.
      window.installs = [];
      createRoot(host).render(<div className="cmem-setup"><main className="setup-main step-install"><InstallScreen install={install} onInstall={async (selection) => { window.installs.push(selection); }} onContinue={() => {}} /></main></div>);
    };
    // The launch alone, with \`count\` picked tools: when it hands over to the workspace (ms after it was mounted) and
    // how long its animations run. \`rerender\` gives it a new tools list, as a worker update during the launch does.
    window.mountLaunch = (count) => {
      const host = document.createElement('div');
      host.id = 'launch-fixture';
      document.body.append(host);
      const root = createRoot(host);
      const tools = (n) => Array.from({ length: n }, (_, index) => ({ id: 'tool-' + index, name: 'Tool ' + index, kind: 'local' }));
      const started = performance.now();
      const render = (n) => root.render(<LaunchScreen tools={tools(n)} onDone={() => window.launch.handedOver.push(performance.now() - started)} />);
      window.launch = { handedOver: [], rerender: render, unmount: () => { root.unmount(); host.remove(); } };
      render(count);
    };
    window.launchAnimations = () => document.getAnimations().filter((animation) => animation.effect?.target?.closest?.('#launch-fixture'))
      .map((animation) => ({ end: animation.effect.getComputedTiming().endTime, start: animation.startTime }));
    window.measure = () => {
      const root = document.querySelector('.cmem-setup');
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && !el.closest('.sr-only, [hidden]'); };
      const name = (el) => (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
      const controls = [...root.querySelectorAll('button, a[href], select, summary, input:not([type=checkbox]):not([type=radio]), textarea')].filter(visible);
      const texts = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const el = node.parentElement;
        if (!node.textContent.trim() || !el || !visible(el) || el.closest('option, select')) continue;
        texts.push({ text: node.textContent.trim().slice(0, 40), size: parseFloat(getComputedStyle(el).fontSize) });
      }
      return {
        step: root.dataset.step,
        coarse: matchMedia('(pointer: coarse)').matches,
        barSteps: root.querySelectorAll('nav[aria-label="Setup progress"] li').length,
        back: controls.filter((el) => el.classList.contains('setup-back')).length,
        navy: controls.filter((el) => el.classList.contains('primary')).map(name),
        short: controls.filter((el) => el.getBoundingClientRect().height < 44).map((el) => name(el) + ' ' + Math.round(el.getBoundingClientRect().height)),
        small: texts.filter((entry) => entry.size < 14).map((entry) => entry.size + 'px ' + entry.text),
      };
    };
    // What the bottom row offers: Back (and whether it is dimmed), its waiting line and the forward buttons.
    window.row = () => {
      const row = [...document.querySelectorAll('.setup-actions')].pop();
      const back = row?.querySelector('.setup-back');
      return {
        back: back ? (back.getAttribute('aria-disabled') === 'true' ? 'dimmed' : 'on') : 'none',
        waiting: row?.querySelector('.setup-waiting')?.textContent ?? null,
        forward: [...(row?.querySelectorAll('.setup-actions-forward button') ?? [])].map((el) => el.textContent.trim()),
      };
    };
    window.alerts = () => [...document.querySelectorAll('[role=alert]')].map((el) => el.querySelector('[data-slot=alert-title]')?.textContent.trim() ?? el.textContent.trim());
    window.press = (selector, text) => {
      const target = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim().startsWith(text));
      if (!target) throw new Error('nothing to press: ' + selector + ' ' + (text || ''));
      target.click();
      return true;
    };
    createRoot(document.getElementById('root')).render(<SetupPage onComplete={() => {}} />);
    fetch('/fixture-ready');
  `, ['--loader:.css=empty', '--loader:.webp=dataurl', '--loader:.ttf=empty']);
  compiled = { bundle, styles };
  return compiled;
}

interface SetupWalk {
  browser: DevToolsPage;
  until(expression: string, label: string): Promise<void>;
  atStep(step: string): Promise<void>;
  press(selector: string, text?: string): Promise<void>;
  step(): Promise<string>;
}

/**
 * Opens the setup page with `query` and runs `walk` in it, at the given size: on its sample fixtures, or, given a
 * `worker`, on the page's own source with that fake worker answering `/api/*`.
 */
async function withSetupPage(query: string, viewport: { width: number; height: number; phone: boolean }, walk: (page: SetupWalk) => Promise<void>, worker?: FakeWorker) {
  const { bundle, styles } = await compileSetupPage();
  let markReady!: () => void;
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  // The fake worker's event stream stays open for a whole walk; 120s is past the longest walk (60s), where Bun's default
  // 10s idle limit would drop it mid-walk.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    return await worker?.handle(request) ?? new Response('not found', { status: 404 });
  } });
  const pageUrl = `${server.url.href}?${worker ? '' : 'source=sample&'}setup=1${query}`;
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    // A desktop walk gets a mouse on every platform (DESKTOP_MOUSE_FLAGS): without one, Linux's headless Chrome keeps
    // the 44px touch sizes that setup.css lifts only under (pointer: fine), and the Reveal's bottom row ended at 932px
    // of 900 on CI. A phone walk turns touch emulation on instead.
    chrome = launchChrome(pageUrl, { profilePrefix: 'claude-mem-setup-', remoteDebugging: true,
      extraFlags: [...UNTHROTTLED_TIMER_FLAGS, ...(viewport.phone ? [] : DESKTOP_MOUSE_FLAGS)] });
    // Same allowance as the primitive fixture: Chrome starts in under a second here, 15s covers a cold shared runner.
    await withTimeout(ready, 15_000, 'Setup fixture did not start');
    page = await connectToPage(chrome, pageUrl);
    const browser = page;
    await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.phone });
    if (viewport.phone) await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await browser.settle();
    // Polls a page condition every 100ms (fine enough to catch each screen, cheap for Chrome). The sample scan plays
    // for 8s and checkout and install answer within 1.5s, so 20s means the walk is stuck (sample timings: SCAN_MS, the
    // checkout and install timeouts in setup-sample.ts).
    const until = async (expression: string, label: string) => {
      const deadline = Date.now() + 20_000;
      while (!(await browser.evaluate(expression))) {
        if (Date.now() > deadline) throw new Error(`Setup walk stuck waiting for ${label}`);
        await Bun.sleep(100);
      }
      await browser.settle();
    };
    const step = () => browser.evaluate(`document.querySelector('.cmem-setup')?.dataset.step`);
    await walk({
      browser, until, step,
      atStep: (name: string) => until(`document.querySelector('.cmem-setup')?.dataset.step === ${JSON.stringify(name)}`, name),
      press: async (selector: string, text?: string) => { await browser.evaluate(`window.press(${JSON.stringify(selector)}, ${JSON.stringify(text ?? '')})`); await browser.settle(); },
    });
  } finally {
    page?.close();
    await chrome?.close();
    server.stop(true);
  }
}

/** A run of the history upload as the worker reports it (history-import.ts HistoryImportState). */
const uploadRun = (changes: object = {}) => ({
  state: 'running', total: 128, sent: 0, unconfirmed: 0, imported: 0, skipped: 0, percent: 0, error: null,
  startedAt: '2026-11-16T10:00:00.000Z', finishedAt: null, ...changes,
});

type FakeWorker = ReturnType<typeof fakeWorker>;
/**
 * A worker for the page's own source (no `?source=sample`), in this process: setup's reads, its event stream (`send`
 * writes a frame, `drop` ends every stream so the page's EventSource reconnects), telemetry, the storage choice, and the
 * upload's start and stop, which play `run` the way the worker does: every change goes out as a `setup-import` frame
 * before the request's answer. Every request is recorded. Nothing here reaches a real worker or cmem.ai.
 */
function fakeWorker(initialRun: object) {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let connections = 0;
  let run: any = initialRun;
  const state = () => ({
    status: 'pending', alreadyPro: true, choice: null, install: null, checkout: null, installer: null,
    history: { projects: 3, sessions: 24, observations: 128 }, historyImport: run, backgroundWorkRunning: [],
  });
  const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const send = (event: string, data: unknown) => {
    for (const stream of [...streams]) {
      try { stream.enqueue(frame(event, data)); } catch { streams.delete(stream); /* The page closed that stream. */ }
    }
  };
  const update = (changes: object) => { run = { ...run, ...changes }; send('setup-import', run); };
  const handle = async (request: Request): Promise<Response | null> => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return null;
    const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
    requests.push({ method: request.method, path: pathname, body });
    const route = `${request.method} ${pathname}`;
    if (route === 'GET /api/work-view/events') {
      connections++;
      let own!: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          own = controller;
          streams.add(controller);
          // Reconnect 200ms after a drop; then, as the worker does on every connect, say where setup stands.
          controller.enqueue(encoder.encode('retry: 200\n\n'));
          controller.enqueue(frame('setup-state', state()));
        },
        cancel() { streams.delete(own); },
      }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    }
    if (route === 'GET /api/setup/state') return Response.json(state());
    if (route === 'GET /api/setup/scan') return Response.json({ agents: [{ id: 'claude-code', label: 'Claude Code', detected: true, prompts: 3 }], percent: 100, phase: 'done', done: true, error: null, improveProduct: true, uploadedAgents: [] });
    if (route === 'GET /api/setup/telemetry') return Response.json({ context: { setup_flow_id: '0f8fad5b-d9cb-469f-a165-70867728950e', already_pro: true } });
    if (route === 'POST /api/setup/telemetry') return Response.json({ ok: true });
    if (route === 'POST /api/setup/choice') return Response.json(state());
    if (route === 'POST /api/setup/import') {
      // One run at a time: a start while one runs answers with that run and starts nothing.
      if (run.state === 'running') return Response.json(run, { status: 202 });
      // The person's Continue after a Stop at 100 of 128 sent: cmem.ai has the first 100 and skips them, then writes the
      // 28 it never saved (the worker's numbers, history-import-stop.test.ts). 400ms a batch, so the import screen shows.
      update(uploadRun({ startedAt: '2026-11-16T10:05:00.000Z' }));
      setTimeout(() => update({ sent: 100, skipped: 100, percent: 78 }), 400);
      setTimeout(() => update({ state: 'done', sent: 128, imported: 28, skipped: 100, percent: 100, finishedAt: '2026-11-16T10:05:01.000Z' }), 800);
      return Response.json(run, { status: 202 });
    }
    if (route === 'POST /api/setup/import/stop') {
      if (run.state !== 'running') return Response.json({ error: 'No import is running, so there is nothing to stop.' }, { status: 409 });
      update({ state: 'stopped', unconfirmed: run.total - run.sent, finishedAt: '2026-11-16T10:01:00.000Z' });
      return Response.json(run);
    }
    return Response.json({ error: `The fake worker has no ${route}.` }, { status: 404 });
  };
  return {
    handle, send, state,
    setRun(next: object) { run = next; },
    connections: () => connections,
    drop() { for (const stream of [...streams]) { streams.delete(stream); stream.close(); } },
    /** The page's POSTs other than telemetry, in order. */
    posts: () => requests.filter((entry) => entry.method === 'POST' && entry.path !== '/api/setup/telemetry').map((entry) => entry.path),
    telemetry: () => requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/setup/telemetry').map((entry) => entry.body),
  };
}

/** From the first screen to Finish Setup on the page's own source: the fake worker's scan is done and the person has Pro. */
async function toFinishSetupOnTheWorker(page: SetupWalk) {
  await page.atStep('reveal');
  await page.press('.setup-actions .primary', 'Continue');
  await page.atStep('choice');
  await page.press('.setup-actions .primary', 'Continue with');
  await page.atStep('savings');
  await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
  await page.atStep('finish-setup');
}

/** Ticks the reinstall box and installs, the way into the scan on the sample fixtures. */
async function install(page: SetupWalk) {
  await page.until(`!!document.querySelector('.install-reinstall input')`, 'install options');
  await page.press('.install-reinstall input');
  await page.press('.setup-actions .primary', 'Install and continue');
}

(chromeExecutablePath ? it : it.skip)('setup screens keep the step bar, Back, one navy button, 44px controls and 14px text on a phone', async () => {
  const seen: Record<string, any> = {};
  let thumbs: string[] = [];
  let keptNote: { kept: number; bytes: number; line: string | null } | undefined;
  await withSetupPage('', { width: 390, height: 844, phone: true }, async (page) => {
    // Measured at rest: an entrance (the workspace's search box grows in over 650ms) would read as a smaller box.
    // Launch is measured while it plays (its controls do not move; its moving tool tiles keep their computed type size).
    const measure = async (label: string, atRest = true) => {
      if (atRest) await page.until(`document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity)`, `${label} at rest`);
      seen[label] = await page.browser.evaluate('window.measure()');
    };
    await page.until(`!!document.querySelector('.install-reinstall input')`, 'install options');
    await measure('install');
    await install(page);
    await page.atStep('scan');
    await measure('scan running');
    // The finished scan moves on by itself; its done state is the one Back from the Reveal shows.
    await page.atStep('reveal');
    // The areas land 900ms after the scan (setup-sample.ts REVEAL_GAP_MS); each row's picture stays 64px on a phone (E4).
    await page.until(`!!document.querySelector('.reveal-thumb')`, 'the focus area rows');
    thumbs = await page.browser.evaluate(`[...document.querySelectorAll('.reveal-thumb')].map((el) => { const box = el.getBoundingClientRect(); return Math.round(box.width) + 'x' + Math.round(box.height); })`);
    await measure('reveal');
    await page.press('.setup-back');
    await page.atStep('scan');
    await measure('scan done');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('reveal');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('choice');
    await measure('choice');
    await page.press('.setup-actions .primary', 'Continue with');
    await page.atStep('savings');
    await measure('savings');
    await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
    await page.atStep('checkout');
    await measure('checkout');
    await page.press('.setup-actions .primary', 'Open checkout');
    await page.atStep('finish-setup');
    await measure('finish setup');
    await page.press('.setup-actions .primary', 'Continue');
    await page.until(`['launch', 'workspace'].includes(document.querySelector('.cmem-setup')?.dataset.step)`, 'launch');
    if (await page.step() === 'launch') await measure('launch', false);
    await page.atStep('workspace');
    await measure('workspace');

    // A kept note holds only what one synced record can (setup-search.ts keptNoteText), and the box says so. The
    // sample search finds its signup record; the paste is CJK text (3 bytes a character) past that limit.
    await page.browser.evaluate(`(() => { const input = document.querySelector('#workspace-query');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'signup screens');
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.press('.workspace-search button', 'Search');
    await page.until(`!!document.querySelector('.workspace-card')`, 'a search result');
    await page.press('.workspace-card button', 'Keep as note');
    await page.until(`!!document.querySelector('.kept-notes textarea')`, 'the kept note');
    await page.browser.evaluate(`(() => { const box = document.querySelector('.kept-notes textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '日本語の記録'.repeat(20000));
      box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.browser.settle();
    keptNote = await page.browser.evaluate(`(() => { const box = document.querySelector('.kept-notes textarea');
      return { kept: box.value.length, bytes: new TextEncoder().encode(box.value).length,
        line: document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent ?? null }; })()`);
  });

  for (const [label, result] of Object.entries(seen)) {
    expect(result.step, label).toBe(label === 'finish setup' ? 'finish-setup' : label.split(' ')[0]);
    expect(result.coarse, label).toBe(true);
    expect(result.barSteps, label).toBe(5);
    expect(result.back, label).toBe(label === 'install' ? 0 : 1);
    expect(result.navy.length, label).toBeLessThanOrEqual(1);
    expect(result.short, label).toEqual([]);
    expect(result.small, label).toEqual([]);
  }
  expect(Object.keys(seen)).toEqual(expect.arrayContaining(['install', 'scan running', 'scan done', 'reveal', 'choice', 'savings', 'checkout', 'finish setup', 'workspace']));
  expect(thumbs.length).toBeGreaterThan(0);
  expect([...new Set(thumbs)]).toEqual(['64x64']);
  // Cut below the 120,000 characters pasted, to within one synced record (CONTENT_BODY_MAX_BYTES), and the line under
  // the box says how many characters were kept.
  expect(keptNote!.kept).toBeGreaterThan(80_000);
  expect(keptNote!.kept).toBeLessThan(120_000);
  expect(keptNote!.bytes).toBeLessThanOrEqual(CONTENT_BODY_MAX_BYTES);
  expect(keptNote!.line).toBe(`Only the first ${keptNote!.kept.toLocaleString('en-US')} characters are kept.`);
// The sample walk takes about 20s (an 8s scan plus each screen's sample delays); 90s allows a slow shared runner.
}, 90_000);

(chromeExecutablePath ? it : it.skip)('Back goes where the flow says, the scan moves on by itself, and a failed hand-off stays on its own screen', async () => {
  // `&installer=on`: the sample installer applies the storage choice, which locks it. `&fail=choice`: the first
  // storage choice is refused once.
  await withSetupPage('&installer=on&fail=choice', { width: 1440, height: 900, phone: false }, async (page) => {
    const row = () => page.browser.evaluate('window.row()');
    const alerts = (): Promise<string[]> => page.browser.evaluate('window.alerts()');
    await install(page);
    await page.atStep('scan');
    // While the scan runs: Back dimmed with its reason, nothing to press forward.
    expect(await row()).toEqual({ back: 'dimmed', waiting: 'Back waits while the scan runs.', forward: [] });
    // Nothing is pressed: the finished scan opens the Reveal by itself.
    await page.atStep('reveal');
    // With the sample's four areas the bottom row stays on the first 1440×900 screen (Phase 8 checklist; the areas land
    // 900ms after the scan, setup-sample.ts REVEAL_GAP_MS).
    await page.until(`document.querySelectorAll('.reveal-area').length === 4`, 'the focus area rows');
    expect(await page.browser.evaluate(`Math.round([...document.querySelectorAll('.setup-actions')].pop().getBoundingClientRect().bottom + scrollY)`)).toBeLessThan(900);

    // Back from the Reveal shows the finished scan and stays there; Back again shows the finished installation.
    await page.press('.setup-back');
    await page.atStep('scan');
    expect((await row()).forward).toEqual(['Continue']);
    await page.press('.setup-back');
    await page.atStep('install');
    expect(await page.browser.evaluate(`document.querySelector('h1').textContent`)).toBe('Your agents and integrations are ready.');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('scan');
    // The page moves on during render, so the four frames atStep waits after the step would already show a move.
    await page.browser.settle();
    expect(await page.step()).toBe('scan');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('reveal');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('choice');
    await page.press('.setup-back');
    await page.atStep('reveal');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('choice');
    await page.press('.setup-actions .primary', 'Continue with');
    await page.atStep('savings');

    // The refused choice: its alert, with Try again, on Token Savings only.
    await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
    await page.until(`window.alerts().includes('Couldn’t save your storage choice.')`, 'the refused choice');
    expect(await page.step()).toBe('savings');
    expect(await page.browser.evaluate(`[...document.querySelectorAll('.setup-error button')].some((el) => el.textContent.trim() === 'Try again')`)).toBe(true);
    // Not sent yet, so the choice can still change: Back is there, and the alert follows it to no other screen.
    await page.press('.setup-back');
    await page.atStep('choice');
    expect(await alerts()).toEqual([]);
    await page.press('.setup-back');
    await page.atStep('reveal');
    expect(await alerts()).toEqual([]);
    await page.press('.setup-back');
    await page.atStep('scan');
    expect(await alerts()).toEqual([]);
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('reveal');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('choice');
    await page.press('.setup-actions .primary', 'Continue with');
    await page.atStep('savings');
    expect(await alerts()).toEqual([]);

    // Sent and applied by the installer: Checkout → Back → Token Savings, and no Back to the choice from there.
    await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
    await page.atStep('checkout');
    await page.press('.setup-back');
    await page.atStep('savings');
    expect((await row()).back).toBe('none');
    await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
    await page.atStep('checkout');
    await page.press('.setup-actions .primary', 'Open checkout');
    await page.atStep('finish-setup');

    // A paid checkout reached by Back goes on with Continue; it never offers to open checkout again.
    await page.press('.setup-back');
    await page.atStep('checkout');
    expect(await row()).toEqual({ back: 'on', waiting: null, forward: ['Continue'] });
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('finish-setup');
  });
// About 15s: the 8s sample scan, then each press; 90s allows a slow shared runner.
}, 90_000);

(chromeExecutablePath ? it : it.skip)('a refused hand-off is sent again only when the person presses Try again', async () => {
  // `&scan=failed` stops the sample scan at 40% (3.2s), the quickest way past it; `&fail=choice` refuses the first choice.
  await withSetupPage('&scan=failed&fail=choice', { width: 1440, height: 900, phone: false }, async (page) => {
    await install(page);
    await page.atStep('scan');
    await page.until(`!!document.querySelector('.setup-actions .secondary')`, 'the stopped scan');
    await page.press('.setup-actions .secondary', 'Skip the scan');
    await page.atStep('reveal');
    await page.press('.setup-actions .primary', 'Continue');
    await page.atStep('choice');
    await page.press('.setup-actions .primary', 'Continue with');
    await page.atStep('savings');
    await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
    await page.until(`window.alerts().includes('Couldn’t save your storage choice.')`, 'the refused choice');
    // Nothing retries by itself: 2s is longer than any sample delay (checkout answers in 1.5s, setup-sample.ts), so a
    // timed retry would have moved the page by now.
    await Bun.sleep(2_000);
    expect(await page.step()).toBe('savings');
    await page.press('.setup-error button', 'Try again');
    await page.atStep('checkout');
    expect(await page.browser.evaluate('window.alerts()')).toEqual([]);
  });
// About 6s: the scan stops at 3.2s; 90s allows a slow shared runner.
}, 90_000);

(chromeExecutablePath ? it : it.skip)('"Skip the scan" does nothing while "Try again" is starting the scan', async () => {
  // `&scan=failed` stops the sample scan at 40% (3.2s). Its Try again answers after 1.2s (setup-sample.ts ANSWER_MS),
  // as a worker does after its round trip, so the walk presses Skip inside that time.
  await withSetupPage('&scan=failed', { width: 1440, height: 900, phone: false }, async (page) => {
    const skip = `[...document.querySelectorAll('.setup-actions button')].find((el) => el.textContent.trim() === 'Skip the scan')`;
    await install(page);
    await page.atStep('scan');
    await page.until(`!!(${skip})`, 'the stopped scan');
    expect(await page.browser.evaluate(`${skip}.getAttribute('aria-disabled')`)).toBeNull();
    await page.press('.setup-actions .primary', 'Try again');
    expect(await page.browser.evaluate(`${skip}.getAttribute('aria-disabled')`)).toBe('true');
    await page.press('.setup-actions .secondary', 'Skip the scan');
    expect(await page.step()).toBe('scan');
    // The new scan runs to the end and opens the Reveal by itself, with no word of a skip: it was never skipped.
    await page.atStep('reveal');
    expect(await page.browser.evaluate(`document.querySelector('main').textContent.includes('You skipped this step')`)).toBe(false);
  });
// About 14s: the scan stops at 3.2s, Try again answers in 1.2s, then the new scan plays for 8s; 90s allows a slow shared runner.
}, 90_000);

/** From the install screen to Finish Setup on On The Go (the sample's default storage choice), through its checkout. */
async function toFinishSetup(page: SetupWalk) {
  await install(page);
  // The sample scan plays for 8s, then opens the Reveal by itself.
  await page.atStep('reveal');
  await page.press('.setup-actions .primary', 'Continue');
  await page.atStep('choice');
  await page.press('.setup-actions .primary', 'Continue with');
  await page.atStep('savings');
  await page.press('.setup-actions .primary', 'Continue with CMEM Pro');
  await page.atStep('checkout');
  await page.press('.setup-actions .primary', 'Open checkout');
  await page.atStep('finish-setup');
}

(chromeExecutablePath ? it : it.skip)('"Stop import" ends the upload, says what was sent, and only the person starts it again', async () => {
  const seen: Record<string, any> = {};
  await withSetupPage('', { width: 390, height: 844, phone: true }, async (page) => {
    const row = () => page.browser.evaluate('window.row()');
    const stoppedText = () => page.browser.evaluate(`document.querySelector('.history-stopped')?.innerText ?? null`);
    const startImport = async () => {
      await page.press('.history-permission input');
      await page.press('.history-actions .import-button', 'Import full history');
      await page.atStep('import');
    };
    await toFinishSetup(page);
    await startImport();
    // Pressed at once: the sample import sends its two batches 1.8s apart and its Stop answers after 1.2s
    // (setup-sample.ts IMPORT_MS, ANSWER_MS), so the stop lands while the import still runs.
    expect(await row()).toEqual({ back: 'dimmed', waiting: 'Back waits while the import runs.', forward: ['Stop import'] });
    await page.press('.setup-actions .secondary', 'Stop import');
    // Stopping: the button says so and takes no second press until the worker answers.
    expect(await row()).toEqual({ back: 'dimmed', waiting: 'Back waits while the import runs.', forward: ['Stopping…'] });
    expect(await page.browser.evaluate(`document.querySelector('.setup-actions .secondary').getAttribute('aria-busy')`)).toBe('true');
    seen.import = await page.browser.evaluate('window.measure()');

    // The stopped run takes the page back to Finish Setup, which says how far it got and what was on its way. The sample
    // sends whole batches, as the worker does (HISTORY_IMPORT_BATCH), so a Stop finds 0 or 100 of 128 sent.
    await page.atStep('finish-setup');
    const stopped = await stoppedText();
    expect(stopped).toContain('You stopped the import.');
    const sent = Number(/(\d+) of 128 memories were sent before you stopped\./.exec(stopped)?.[1]);
    expect([0, HISTORY_IMPORT_BATCH]).toContain(sent);
    const onItsWay = Math.min(HISTORY_IMPORT_BATCH, 128 - sent);
    expect(stopped).toContain(`${onItsWay} more were on their way when you stopped. cmem.ai may have saved some of them.`);
    expect(stopped).toContain('Nothing was deleted on this computer or in your account. Importing again skips memories already there.');
    expect(await page.browser.evaluate('window.alerts()')).toEqual([]);
    seen['finish-setup stopped'] = await page.browser.evaluate('window.measure()');

    // Nothing starts it again by itself: 2s is longer than the sample's answer delay and its batch time.
    await Bun.sleep(2_000);
    expect(await page.step()).toBe('finish-setup');
    expect(await stoppedText()).toBe(stopped);
    // Continue is the person's choice: the offer waits for its tick box, then runs to the end.
    expect(await page.browser.evaluate(`document.querySelector('.history-actions .import-button').getAttribute('aria-disabled')`)).toBe('true');
    await startImport();
    await page.atStep('finish-setup');
    // The new run sends all 128 again; the sample's cmem.ai kept the batch that was on its way, so the run gets those
    // back as skipped and adds the rest, the numbers the worker gives (history-import-stop.test.ts, the batch saved).
    const already = sent + onItsWay;
    expect(await page.browser.evaluate(`[...document.querySelectorAll('.history-done p')].map((line) => line.innerText)`))
      .toEqual([`This import added ${128 - already} of 128 memories to your CMEM account · Ready to search.`, `The other ${already} were already there, or cmem.ai couldn’t read them.`]);
  });

  for (const [label, result] of Object.entries(seen)) {
    expect(result.step, label).toBe(label.split(' ')[0]);
    expect(result.coarse, label).toBe(true);
    expect(result.barSteps, label).toBe(5);
    expect(result.back, label).toBe(1);
    expect(result.navy.length, label).toBeLessThanOrEqual(1);
    expect(result.short, label).toEqual([]);
    expect(result.small, label).toEqual([]);
  }
  expect(Object.keys(seen)).toEqual(['import', 'finish-setup stopped']);
// About 25s: the 8s scan, the checkout's 1.5s, a stop, a 2s wait and a full 3.6s import; 90s allows a slow shared runner.
}, 90_000);

(chromeExecutablePath ? it : it.skip)('the launch hands over to the workspace when it did before Phase 8, and plays once', async () => {
  await withSetupPage('', { width: 1440, height: 900, phone: false }, async (page) => {
    const animations = () => page.browser.evaluate('window.launchAnimations()');
    // Before Phase 8 the workspace opened when the last launch animation ended (HEAD launch-screen.tsx:43-45): the logo
    // after 1,950 ms, or the last of n tools after 1,500 + 80 × (n − 1) ms.
    for (const [count, expected] of [[6, 1950], [7, 1980], [10, 2220]]) {
      await page.browser.evaluate(`window.mountLaunch(${count})`);
      await page.until('window.launchAnimations().length === 2', `the launch with ${count} tools`);
      expect((await animations()).map((animation: { end: number }) => animation.end), `${count} tools`).toEqual([expected, expected]);
      await page.until('window.launch.handedOver.length === 1', `the handover with ${count} tools`);
      const handedOver = await page.browser.evaluate('window.launch.handedOver[0]');
      // Never earlier; later only by the frames it takes to mount and to report the end.
      expect(handedOver, `${count} tools`).toBeGreaterThanOrEqual(expected);
      expect(handedOver, `${count} tools`).toBeLessThan(expected + 1_000);
      await page.browser.evaluate('window.launch.unmount()');
    }

    // A worker update while it plays gives the screen a new tools list (here also a longer one): the launch keeps its
    // animations and its length, and hands over once.
    await page.browser.evaluate('window.mountLaunch(7)');
    await page.until('window.launchAnimations().length === 2 && window.launchAnimations().every((animation) => animation.start !== null)', 'the launch with 7 tools');
    const playing = await animations();
    await Bun.sleep(400);
    await page.browser.evaluate('window.launch.rerender(7); window.launch.rerender(10)');
    await page.browser.settle();
    expect(await animations()).toEqual(playing);
    await page.until('window.launch.handedOver.length === 1', 'the handover after an update');
    await Bun.sleep(500);
    const handovers: number[] = await page.browser.evaluate('window.launch.handedOver');
    expect(handovers).toHaveLength(1);
    expect(handovers[0]).toBeGreaterThanOrEqual(1980);
    expect(handovers[0]).toBeLessThan(1980 + 1_000);
  });
// About 10s: three launches of up to 2.2s and one with an update; 60s allows a slow shared runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the DeepSeek Harness profile and the signup note keep the worker\'s limits, and say when a paste is cut', async () => {
  const seen: Record<string, any> = {};
  await withSetupPage('', { width: 390, height: 844, phone: true }, async (page) => {
    await page.browser.evaluate('window.mountInstall()');
    await page.until(`!!document.querySelector('#install-fixture .install-host input[type=text]')`, 'the profile field');
    // A paste: the value set as the browser sets it, then the input event React listens for.
    const paste = (selector: string, length: number) => page.browser.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)});
      const prototype = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(box, 'p'.repeat(${length}));
      box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const field = (selector: string) => page.browser.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)});
      const line = document.getElementById(box.getAttribute('aria-describedby') ?? '');
      return { kept: box.value.length, line: line?.textContent ?? null, role: line?.getAttribute('role') ?? null,
        size: line ? parseFloat(getComputedStyle(line).fontSize) : null }; })()`);
    const profile = '#install-fixture .install-host input[type=text]';
    await paste(profile, SETUP_DSH_PROFILE_MAX_CHARACTERS);
    await page.browser.settle();
    seen.profileWithin = await field(profile);
    await paste(profile, SETUP_DSH_PROFILE_MAX_CHARACTERS + 50);
    await page.browser.settle();
    seen.profileCut = await field(profile);

    // The note shows once "Email me product updates" is ticked, in the folded "Skills and preferences".
    await page.press('#install-fixture .install-options button', 'Skills and preferences');
    await page.browser.evaluate(`[...document.querySelectorAll('#install-fixture label')].find((label) => label.textContent.includes('Email me product updates')).querySelector('input').click()`);
    await page.until(`!!document.querySelector('#install-fixture .install-email textarea')`, 'the note box');
    const note = '#install-fixture .install-email textarea';
    await paste(note, SETUP_INSTALL_NOTE_MAX_CHARACTERS + 500);
    await page.browser.settle();
    seen.noteCut = await field(note);
  });
  expect(seen.profileWithin).toEqual({ kept: SETUP_DSH_PROFILE_MAX_CHARACTERS, line: null, role: null, size: null });
  expect(seen.profileCut).toEqual({ kept: SETUP_DSH_PROFILE_MAX_CHARACTERS, line: `Only the first ${SETUP_DSH_PROFILE_MAX_CHARACTERS} characters are kept.`, role: 'status', size: 15 });
  expect(seen.noteCut).toEqual({ kept: SETUP_INSTALL_NOTE_MAX_CHARACTERS, line: `Only the first ${SETUP_INSTALL_NOTE_MAX_CHARACTERS.toLocaleString('en-US')} characters are kept.`, role: 'status', size: 15 });
// About 3s: one page load and three pastes; 60s allows a slow shared runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('Install opens "Skills and preferences" when the email folded inside it fails the browser\'s check, so the press is never silent', async () => {
  const seen: Record<string, any> = {};
  await withSetupPage('', { width: 1440, height: 900, phone: false }, async (page) => {
    await page.browser.evaluate('window.mountInstall()');
    await page.until(`!!document.querySelector('#install-fixture .install-options')`, 'the install fixture');
    // A person's press (mouse input through DevTools), not a script click(): the browser runs its form checks for it.
    const pressInstall = async () => {
      const { x, y } = await page.browser.evaluate(`(() => { const button = document.querySelector('#install-fixture button[type=submit]');
        button.scrollIntoView({ block: 'center' }); const box = button.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
      await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await page.browser.settle();
    };
    const look = `(() => { const body = document.querySelector('#install-fixture [data-slot=collapsible-content]');
      const email = document.querySelector('#install-fixture .install-email input[type=email]');
      return { fold: body.dataset.state, emailShown: !!email && getComputedStyle(body).display !== 'none' && email.getClientRects().length > 0,
        emailFocused: !!email && document.activeElement === email, installs: window.installs.length }; })()`;
    // Opt in to product emails, leave the address empty, then fold the row again.
    await page.press('#install-fixture .install-options button', 'Skills and preferences');
    await page.browser.evaluate(`[...document.querySelectorAll('#install-fixture label')].find((label) => label.textContent.includes('Email me product updates')).querySelector('input').click()`);
    await page.until(`!!document.querySelector('#install-fixture .install-email input[type=email]')`, 'the email field');
    await page.press('#install-fixture .install-options button', 'Skills and preferences');
    seen.folded = await page.browser.evaluate(look);
    await pressInstall();
    seen.afterPress = await page.browser.evaluate(look);
    // The person types the address where the browser pointed, and Install sends it.
    await page.browser.send('Input.insertText', { text: 'person@example.com' });
    await page.browser.settle();
    await pressInstall();
    seen.sent = await page.browser.evaluate('window.installs.map((selection) => selection.email)');
  });
  expect(seen.folded).toEqual({ fold: 'closed', emailShown: false, emailFocused: false, installs: 0 });
  expect(seen.afterPress).toEqual({ fold: 'open', emailShown: true, emailFocused: true, installs: 0 });
  expect(seen.sent).toEqual(['person@example.com']);
// About 3s: one page load and two presses; 60s allows a slow shared runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('after a reload during a run, Finish Setup stops it without the tick box, and a reconnect starts nothing again', async () => {
  // As the page finds it after a reload: the first batch answered, the second on its way.
  const worker = fakeWorker(uploadRun({ sent: 100, imported: 100, percent: 78 }));
  await withSetupPage('', { width: 1440, height: 900, phone: false }, async (page) => {
    await toFinishSetupOnTheWorker(page);
    expect(await page.browser.evaluate(`document.querySelector('.history-running')?.innerText ?? null`)).toContain('An import is already running.');
    // Stop is on beside that line, while the tick box below it, which is for a start, is still empty.
    expect(await page.browser.evaluate(`document.querySelector('.history-permission input').checked`)).toBe(false);
    expect(await page.browser.evaluate(`document.querySelector('.history-running button').getAttribute('aria-disabled')`)).toBeNull();
    await page.press('.history-running button', 'Stop import');
    await page.until(`!!document.querySelector('.history-stopped')`, 'the stopped notice');
    expect(await page.step()).toBe('finish-setup');
    const stopped = await page.browser.evaluate(`document.querySelector('.history-stopped').innerText`);
    expect(stopped).toContain('100 of 128 memories were sent before you stopped.');
    expect(stopped).toContain('28 more were on their way when you stopped. cmem.ai may have saved some of them.');
    expect(worker.posts()).toEqual(['/api/setup/choice', '/api/setup/import/stop']);

    // The event stream drops. The page's EventSource opens a new one, whose first words are the stopped run (the worker
    // says where setup stands on every connect); then a restarted worker, with no run at all.
    const connected = worker.connections();
    worker.drop();
    const deadline = Date.now() + 10_000;
    while (worker.connections() === connected) {
      if (Date.now() > deadline) throw new Error('The page did not reconnect its event stream');
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    worker.setRun(uploadRun({ state: 'idle', total: 0, startedAt: null }));
    worker.send('setup-state', worker.state());
    // Nothing starts the upload again: 2s is ten times the stream's 200ms retry.
    await Bun.sleep(2_000);
    expect(worker.posts()).toEqual(['/api/setup/choice', '/api/setup/import/stop']);
    expect(await page.step()).toBe('finish-setup');
  }, worker);
// About 8s: no scan to wait for, a reconnect and a 2s wait; 60s allows a slow shared runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('Import full history on a run already running shows it and counts no start; after Stop, Continue says what it added and what was already there', async () => {
  const worker = fakeWorker(uploadRun({ sent: 100, imported: 100, percent: 78 }));
  await withSetupPage('', { width: 390, height: 844, phone: true }, async (page) => {
    const importFullHistory = async () => {
      await page.press('.history-permission input');
      await page.press('.history-actions .import-button', 'Import full history');
      await page.atStep('import');
    };
    await toFinishSetupOnTheWorker(page);
    await importFullHistory();
    // The worker answered with the run it has: its progress, and Stop.
    expect(await page.browser.evaluate(`document.querySelector('.import-count')?.innerText`)).toBe('100 of 128');
    await page.press('.setup-actions .secondary', 'Stop import');
    await page.atStep('finish-setup');
    await page.until(`!!document.querySelector('.history-stopped')`, 'the stopped notice');
    // The person's Continue: the worker sends all 128 again and cmem.ai skips the 100 it has.
    await importFullHistory();
    await page.atStep('finish-setup');
    expect(await page.browser.evaluate(`[...document.querySelectorAll('.history-done p')].map((line) => line.innerText)`))
      .toEqual(['This import added 28 of 128 memories to your CMEM account · Ready to search.', 'The other 100 were already there, or cmem.ai couldn’t read them.']);
    expect(worker.posts()).toEqual(['/api/setup/choice', '/api/setup/import', '/api/setup/import/stop', '/api/setup/import']);
    // Telemetry goes out one event after another; once the third Finish Setup visit is in, so is every action before it.
    const deadline = Date.now() + 10_000;
    while (worker.telemetry().filter((event) => event.event === 'setup_step_viewed' && event.step === 'finish-setup').length < 3) {
      if (Date.now() > deadline) throw new Error('The setup telemetry did not arrive');
      await Bun.sleep(50);
    }
    // One start counted, for the Continue; the press on the run that was already running counted none.
    expect(worker.telemetry().filter((event) => event.event === 'setup_step_action' && event.action === 'start_import'))
      .toEqual([expect.objectContaining({ step: 'finish-setup' })]);
  }, worker);
// About 8s: no scan to wait for, two imports of under a second each; 60s allows a slow shared runner.
}, 60_000);

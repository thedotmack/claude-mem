import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the aceternity components’ reduced-motion regressions.');

/**
 * Plan rule 8: every animation is off under prefers-reduced-motion inside the component itself, not only through the
 * app's MotionConfig. So these mount DraggableCardBody (deciding on release), SparklesCore and
 * PlaceholdersAndVanishInput alone, with no MotionConfig, under an emulated reduced-motion preference:
 * - a deciding card stays in place while dragged, so nothing springs back on release (the drag still decides);
 * - the sparkles are drawn still (no fade-in, twinkle or drift);
 * - the vanish input's example neither fades in nor rotates;
 * - the card glow (GlowingEffect) follows no pointer even when its caller asks it to, and keeps its resting edge.
 */
let server: ReturnType<typeof Bun.serve> | undefined;
let fixtureUrl = '';
let markReady: () => void = () => {};
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];

async function openWithReducedMotion() {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  chrome = launchChrome(fixtureUrl, { profilePrefix: 'claude-mem-reduced-motion-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The fixture is three components and React; a cold CI Chrome draws it well within 20s.
  await withTimeout(ready, 20_000, 'reduced-motion fixture did not load');
  page = await connectToPage(chrome, fixtureUrl);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  expect(await page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(true);
}

async function closePage() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Waits until `expression` is truthy in the page; the components settle within a few frames, the particle engine in under a second. */
async function waitFor(expression: string, what: string, milliseconds = 5_000) {
  await withTimeout(page!.evaluate(`new Promise((resolve) => { const check = () => (${expression}) ? resolve(true) : requestAnimationFrame(check); check(); })`), milliseconds, `timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { DraggableCardBody } from './src/ui/my-work/src/components/aceternity/draggable-card';
    import { SparklesCore } from './src/ui/my-work/src/components/aceternity/sparkles';
    import { PlaceholdersAndVanishInput } from './src/ui/my-work/src/components/aceternity/placeholders-and-vanish-input';
    import { GlowingEffect } from './src/ui/my-work/src/components/aceternity/glowing-effect';
    window.React = React;
    const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
    // Pointer listeners put on the page body: the card glow follows the pointer through one (glowing-effect.tsx).
    window.pointerListeners = 0;
    const addBodyListener = document.body.addEventListener.bind(document.body);
    document.body.addEventListener = (type, listener, options) => { if (type === 'pointermove') window.pointerListeners++; addBodyListener(type, listener, options); };
    const root = createRoot(document.getElementById('root'));
    // Mounted on demand, after the test has set the reduced-motion preference.
    window.mount = (what) => {
      if (what === 'card') root.render(<div style={{ padding: 40 }}><DraggableCardBody dragAxis="x" onDragRelease={(offset) => { window.released = offset; }} className="h-32 min-h-0 w-64"><p>Card</p></DraggableCardBody></div>);
      if (what === 'sparkles') root.render(<div data-testid="sparkles" style={{ position: 'relative', width: 320, height: 200 }}><SparklesCore className="absolute inset-0" background="transparent" particleColor="#5b57e6" minSize={0.6} maxSize={1.6} particleDensity={90} speed={2} /></div>);
      if (what === 'vanish') root.render(<div style={{ padding: 40 }}><PlaceholdersAndVanishInput placeholders={['First example', 'Second example']} onChange={() => {}} onSubmit={() => {}} /></div>);
      // Its caller asks for the pointer layer (disabled={false}), as a caller that forgot reduced motion would.
      if (what === 'glow') root.render(<div data-testid="glow" style={{ position: 'relative', width: 320, height: 200, borderRadius: 12 }}><GlowingEffect disabled={false} glow spread={40} proximity={64} inactiveZone={0.01} borderWidth={2} /></div>);
    };
    fetch('/fixture-ready');
  `, ['--loader:.webp=empty', '--loader:.css=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty']);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (path === '/fixture-error') { fixtureErrors.push(await request.text()); return new Response('noted'); }
    return new Response('not found', { status: 404 });
  } });
  fixtureUrl = server.url.href;
});

afterAll(async () => {
  await closePage();
  server?.stop(true);
});

// Each test opens its own Chrome (1–2s locally); the vanish input waits out one 3s example; 60s is for a cold CI runner.
const TEST_LIMIT_MS = 60_000;

it.skipIf(!chromeExecutablePath)('a deciding card stays in place while dragged and nothing springs back on release; the drag still decides', async () => {
  try {
    await openWithReducedMotion();
    await page!.evaluate('window.mount("card")');
    await waitFor('document.querySelector(".transform-3d")', 'the card');
    const box = await page!.evaluate('(() => { const box = document.querySelector(".transform-3d").getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()');
    const mouse = (type: string, x: number) => page!.send('Input.dispatchMouseEvent', { type, x, y: box.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mousePressed', box.x);
    for (let x = box.x + 10; x <= box.x + 80; x += 10) await mouse('mouseMoved', x);
    // Mid-drag the card stays where it is (without reduced motion it follows at half speed: DECIDE_DRAG_ELASTIC).
    expect(await page!.evaluate('new DOMMatrix(getComputedStyle(document.querySelector(".transform-3d")).transform).m41')).toBe(0);
    await mouse('mouseReleased', box.x + 80);
    // Twenty frames after letting go (about 330ms, longer than the spring back took): it never moves.
    const frames: number[] = await page!.evaluate(`new Promise((resolve) => {
      const card = document.querySelector('.transform-3d');
      const seen = [];
      const step = () => { seen.push(Math.round(new DOMMatrix(getComputedStyle(card).transform).m41)); if (seen.length < 20) requestAnimationFrame(step); else resolve(seen); };
      requestAnimationFrame(step);
    })`);
    expect(frames.filter((x) => x !== 0)).toEqual([]);
    expect(await page!.evaluate('window.released.x')).toBeGreaterThan(60);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the sparkles are drawn still: no fade-in, twinkle or drift', async () => {
  try {
    await openWithReducedMotion();
    await page!.evaluate('window.mount("sparkles")');
    // The particle engine loads asynchronously; under a second locally, 10s on a cold runner.
    await waitFor('document.querySelector("[data-testid=sparkles] canvas") && getComputedStyle(document.querySelector("[data-testid=sparkles] > div")).opacity === "1"', 'the drawn field', 10_000);
    const snapshot = 'document.querySelector("[data-testid=sparkles] canvas").toDataURL()';
    const first = await page!.evaluate(snapshot);
    // Half a second: the twinkle at speed 2 changes every particle's opacity many times over in that time.
    await page!.evaluate('new Promise((resolve) => setTimeout(resolve, 500))');
    const second = await page!.evaluate(snapshot);
    expect(first.length).toBeGreaterThan(1_000);
    expect(second).toBe(first);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the card glow follows no pointer under reduced motion whatever its caller passes, and keeps its resting edge', async () => {
  try {
    await openWithReducedMotion();
    await page!.evaluate('window.mount("glow")');
    await waitFor('document.querySelector("[data-testid=glow] [data-glow-edge]")', 'the glow');
    // The pointer listener goes on once the card is on screen (its IntersectionObserver answers within a frame or two);
    // 300ms is many frames.
    await page!.evaluate('new Promise((resolve) => setTimeout(resolve, 300))');
    await page!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 60 });
    await page!.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const glow = await page!.evaluate(`(() => { const layer = document.querySelector('[data-testid=glow] [style*="--blur"]'); return {
      listeners: window.pointerListeners, layer: getComputedStyle(layer).display, active: layer.style.getPropertyValue('--active'),
      edge: getComputedStyle(document.querySelector('[data-testid=glow] [data-glow-edge]')).display }; })()`);
    expect(glow).toEqual({ listeners: 0, layer: 'none', active: '0', edge: 'block' });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the vanish input’s example neither fades in nor rotates', async () => {
  try {
    await openWithReducedMotion();
    await page!.evaluate('window.mount("vanish")');
    await waitFor('document.querySelector("form p")', 'the example');
    // On the first frame it is already fully shown (the demo slides it up from opacity 0).
    expect(await page!.evaluate('getComputedStyle(document.querySelector("form p")).opacity')).toBe('1');
    expect(await page!.evaluate('document.querySelector("form p").textContent')).toBe('First example');
    // After one full example's time (PLACEHOLDER_SHOWN_MS, 3s) and a margin, it is still the first.
    await page!.evaluate('new Promise((resolve) => setTimeout(resolve, 3_400))');
    expect(await page!.evaluate('document.querySelector("form p").textContent')).toBe('First example');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

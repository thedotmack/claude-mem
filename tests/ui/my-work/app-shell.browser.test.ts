import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { LOCALES } from '../../../src/ui/i18n/locale';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, FITS_THE_WINDOW, htmlResponse, launchChrome, myWorkFontResponse, PAGE_WIDTHS, pageFitsTheWindow, scriptResponse, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { THEME_PRE_PAINT_SCRIPT } from '../../../src/ui/my-work/src/lib/theme-pre-paint';

failOnCiWithoutChrome('CI requires Chrome for the My Work shell regressions.');

/**
 * The app shell (Phase 2 of the pro-max-v16 plan), on the real App with the sample source, the app's real stylesheet,
 * its Geist font and the pre-paint theme script the build puts in index.html:
 * - G6: the bar holds Live, the machine count, Classic viewer and one "…" menu, and nothing sticks out of the pill;
 * - G10 and the keyboard: Tab reaches the Live chip and the machine count, Enter opens each, Escape closes it and
 *   returns focus; the menu opens with Enter, moves with the arrows, closes with Escape and returns focus;
 * - G8: Theme in the menu changes <html> and is saved, System follows the operating system, setup stays light, and a
 *   `?theme=` address lasts the visit without being saved;
 * - phones: every header control and menu row is at least 44px on a coarse pointer, the page is exactly 390 wide,
 *   the page ends above the pinned bottom bar, and no focused control sits under the bar or the header;
 * - the Phase 2 fix round: rail rows 38–54px and "All N" at least 24px; rail names at 768–1023px; Account & billing on
 *   the cloud viewer; names that contain their visible words in every language; focus kept after Hide banner, after
 *   Try again and when Tab leaves the Live or machines panel; the pill, the strip and the bottom bar under reduced motion.
 */
// `text` makes Chrome send the key's character too, which is what activates a native button on Enter.
const KEYS = {
  Tab: { code: 'Tab', keyCode: 9, text: undefined }, Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27, text: undefined }, ArrowDown: { code: 'ArrowDown', keyCode: 40, text: undefined },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, text: undefined },
} as const;
/** A name the test machine's resolver sends to the fixture server, so the page counts as served by the cloud viewer. */
const CLOUD_HOSTNAME = 'cloud-viewer.test';

let server: ReturnType<typeof Bun.serve> | undefined;
let fixtureUrl = '';
let markReady: () => void = () => {};
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];

/** `shift`: Shift+Tab (CDP modifier 8). */
async function press(key: keyof typeof KEYS, { shift = false } = {}) {
  const { code, keyCode, text } = KEYS[key];
  const modifiers = shift ? 8 : 0;
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text, modifiers });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  // Radix moves roving focus in a timeout after the keydown, so focus is read once the page has drawn again.
  if (key !== 'Tab') await page!.settle();
}

/**
 * Each test gets its own Chrome on the one compiled fixture, so a failure in one cannot leave the next on a dead or
 * half-open page (Bun ends a failed test's leftover processes). `query` adds to the fixture's address; `hostname`
 * serves the page under another name (the fixture server answers for it through Chrome's resolver).
 */
async function openShell({ query = '', hostname = '' } = {}) {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${hostname ? fixtureUrl.replace('127.0.0.1', hostname) : fixtureUrl}${query}`;
  const resolverFlags = hostname ? [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`] : [];
  chrome = launchChrome(url, { profilePrefix: 'claude-mem-app-shell-', remoteDebugging: true, extraFlags: [...UNTHROTTLED_TIMER_FLAGS, ...resolverFlags] });
  // Each test here, Chrome start and the whole App with sample data included, took 1.0–2.0s (2026-11-16); 20s is for a
  // cold Chrome on a CI runner.
  await withTimeout(ready, 20_000, 'My Work shell fixture did not draw its header');
  page = await connectToPage(chrome, url);
}

/**
 * The accessible name and description Chrome computes for the element `expression` returns: the words a screen reader
 * says and speech input matches (CDP's accessibility tree, not the page's own guess).
 */
async function accessibleText(expression: string): Promise<{ name: string; description: string }> {
  const { result } = await page!.send('Runtime.evaluate', { expression });
  if (!result.objectId) throw new Error(`no element for ${expression}`);
  const { nodes } = await page!.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
  return { name: nodes[0]?.name?.value ?? '', description: nodes[0]?.description?.value ?? '' };
}

async function closeShell() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Waits until `expression` is truthy in the page. Every wait here is for a frame or two of React work. */
async function waitFor(expression: string, what: string) {
  // React commits a state change within one or two frames; 5s is for a cold Chrome on a shared CI runner.
  await withTimeout(page!.evaluate(`new Promise((resolve) => { const check = () => (${expression}) ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, `timed out waiting for ${what}`);
}

const focused = () => page!.evaluate('window.describeFocus()');

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // Compile the application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());
  // The stylesheet's @font-face rules ask for ./files/<name>.woff2 (Geist and Geist Mono); widths depend on the font,
  // so the real files are served (myWorkFontResponse).
  // The whole App: its pages' artwork and stylesheets load empty (the one-file bundle has nowhere to put them).
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import App from './src/ui/my-work/src/App';
    import { Notch } from './src/ui/my-work/src/components/aceternity/notch';
    import { NavBody } from './src/ui/my-work/src/components/aceternity/resizable-navbar';
    import { setLocale } from './src/ui/my-work/src/lib/i18n';
    import { useStore } from './src/ui/my-work/src/store';
    window.React = React;
    const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
    // The star count would come from GitHub; a test never calls out, so the page reads this one.
    const realFetch = window.fetch.bind(window);
    window.githubStarReads = 0;
    // \`&github=refuse\`: GitHub gives no count (a network failure, as a rate-limited or offline page sees).
    const githubRefuses = new URLSearchParams(location.search).get('github') === 'refuse';
    window.fetch = (input, init) => String(input).startsWith('https://api.github.com/')
      ? (window.githubStarReads++, githubRefuses ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response(JSON.stringify({ stargazers_count: 117482 }), { headers: { 'Content-Type': 'application/json' } })))
      : realFetch(input, init);
    // \`&fail-reads=N\`: the first N reads of the work fail as an unreachable worker's do, then the sample answers.
    const failReads = Number(new URLSearchParams(location.search).get('fail-reads') ?? 0);
    if (failReads > 0) {
      const startWorkSource = useStore.getState().startWorkSource;
      let failed = 0;
      useStore.setState({ startWorkSource: (source) => {
        const failing = Object.create(source);
        failing.loadWorkModel = () => failed++ < failReads ? Promise.reject(new TypeError('Failed to fetch')) : source.loadWorkModel();
        return startWorkSource(failing);
      } });
    }
    window.store = useStore;
    window.setLocale = setLocale;
    createRoot(document.getElementById('root')).render(<App />);
    // The bottom bar's and the header pill's own reduced-motion checks, outside the App's MotionConfig (which makes
    // positions and sizes instant by itself): a bar that would fade and blur in, and a bar that would spring to a pill.
    window.mountNotchProbe = () => {
      const probe = document.body.appendChild(document.createElement('div'));
      createRoot(probe).render(<Notch reveal pinned position="bottom" items={[{ id: 'probe', label: 'Probe', options: [{ id: 'probe', label: 'Probe' }] }]} />);
    };
    window.mountNavBodyProbe = () => {
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.cssText = 'position: fixed; top: 0; left: 0; width: 1440px;';
      const root = createRoot(probe);
      const draw = (visible) => root.render(<NavBody visible={visible}><span>Probe</span></NavBody>);
      draw(false);
      window.navBodyProbe = { bar: () => probe.firstElementChild, toPill: () => draw(true) };
    };
    // Ready once the loaded header is drawn, or the failed-read screen (a fixture opened with fail-reads).
    (function waitForShell() {
      if (document.querySelector('[data-slot="work-shell"] header [data-live-chip], [role="alert"]')) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForShell);
    })();
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    // Names are cut at 60 characters (40 in the size lists) so a failure prints one line; every name a test compares
    // is shorter (the longest, the cloud rail row's "Account & billing" twice, is 34).
    const nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    window.describeFocus = () => {
      const element = document.activeElement;
      return element ? { name: nameOf(element).slice(0, 60), role: element.getAttribute('role'), tag: element.tagName.toLowerCase(),
        chip: element.getAttribute('data-live-chip'), expanded: element.getAttribute('aria-expanded'), inMenu: !!element.closest('[role="menu"]') } : null;
    };
    const header = () => document.querySelector('[data-slot="work-shell"] header');
    window.headerControls = () => [...header().querySelectorAll('button, a[href], select, input')].filter(visible)
      .map((element) => ({ name: nameOf(element).slice(0, 40), height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width }));
    window.popoverText = () => document.querySelector('[data-slot="popover-content"]')?.textContent ?? null;
    // The sample-data strip above the header (G7): its switch items, Use my data and its close.
    const strip = () => document.querySelector('[data-slot="work-shell"] > header')?.previousElementSibling;
    window.stripControls = () => {
      const element = strip();
      return element ? [...element.querySelectorAll('button, a[href]')].filter(visible).map((control) => ({ name: nameOf(control).slice(0, 40), height: control.getBoundingClientRect().height, width: control.getBoundingClientRect().width })) : null;
    };
    // The strip slides in when the page loads (aceternity/sticky-banner.tsx: y -100 to 0 over 0.3s, its close button
    // scaling up with a spring), and a box read while it moves goes through the transform: Chrome maps it in 32-bit
    // floats, so a 44px control read 43.999996px on Linux CI (PR #6210 watch, 2026-11-17). Resolves once the strip and
    // every control in it have carried no transform for two frames in a row, the strip at rest as a person sees it.
    window.stripAtRest = () => new Promise((resolve, reject) => {
      const started = performance.now();
      let still = 0;
      (function check() {
        const element = strip();
        const moving = !element || [element, ...element.querySelectorAll('button, a[href]')].some((node) => getComputedStyle(node).transform !== 'none');
        still = moving ? 0 : still + 1;
        if (still >= 2) return resolve(true);
        // The slide ends 0.3s after load and the spring in well under a second (2026-11-17); 8s covers a runner several
        // times slower, as headerAtRest's does.
        if (performance.now() - started > 8000) return reject(new Error('the sample strip did not come to rest in 8s'));
        requestAnimationFrame(check);
      })();
    });
    // Row heights are layout heights: the menu opens with a short zoom, and a box read mid-zoom is scaled down.
    window.menu = () => {
      const menu = document.querySelector('[role="menu"]');
      return menu ? { rows: [...menu.querySelectorAll('[role^="menuitem"]')].filter(visible).map((row) => ({ name: nameOf(row).slice(0, 40), role: row.getAttribute('role'), height: row.offsetHeight, checked: row.getAttribute('aria-checked') })) } : null;
    };
    // Tab from the top of the page. A blurred element stays the starting point of the next Tab, so the shell itself
    // takes focus first (not as a stop of its own: tabindex -1). The failed-read screen has no shell: its body does.
    // The header slides between the bar and the floating pill with a spring (aceternity/resizable-navbar.tsx: y 20px and
    // its width; stiffness 200, damping 50). Resolves once its whole-pixel box has stayed put for eight frames in a row:
    // simulated from those constants and motion's default rest thresholds (2026-11-16), the box holds still for at most
    // 7 frames while the spring still crawls sub-pixel at its end (the 390px pill at 60 fps; 3 frames on the 1440px bar,
    // 1 at 15 fps), so eight still frames only happen once motion has stopped it.
    window.headerAtRest = () => new Promise((resolve, reject) => {
      const started = performance.now();
      let last = '', still = 0;
      (function check() {
        const box = document.querySelector('[data-slot="work-shell"] header > * > *')?.getBoundingClientRect();
        const now = box ? [box.top, box.bottom, box.left, box.right].map(Math.round).join(',') : '';
        still = now === last ? still + 1 : 0;
        last = now;
        if (still >= 8) return resolve(true);
        // The spring settles in under a second here (2026-11-16); 8s covers a runner several times slower (the test
        // held with the CPU slowed 4×, Emulation.setCPUThrottlingRate).
        if (performance.now() - started > 8000) return reject(new Error('the header did not come to rest in 8s'));
        requestAnimationFrame(check);
      })();
    });
    window.focusPageStart = () => {
      const shell = document.querySelector('[data-slot="work-shell"]') ?? document.body;
      shell.tabIndex = -1;
      shell.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    };
    window.visibleIn = (selector) => [...document.querySelectorAll(selector)].filter(visible);
    window.clickMenuRow = (name) => {
      const row = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find((element) => nameOf(element).startsWith(name));
      if (!row) throw new Error('no menu row ' + name);
      row.click();
    };
    // How far anything in the floating pill reaches past the pill's own box, in px (0 when it all fits).
    window.pillOverhang = () => {
      const pill = document.querySelector('.header-pill');
      if (!pill) return null;
      const box = pill.getBoundingClientRect();
      let overhang = 0;
      for (const element of pill.querySelectorAll('*')) {
        const inner = element.getBoundingClientRect();
        if (inner.width === 0 || getComputedStyle(element).position === 'absolute') continue;
        overhang = Math.max(overhang, box.left - inner.left, inner.right - box.right);
      }
      return { overhang: Math.round(overhang * 10) / 10, width: box.width, controls: [...pill.querySelectorAll('button, a[href]')].filter(visible).map(nameOf) };
    };
    window.isDark = () => document.documentElement.classList.contains('dark');
    window.savedTheme = () => JSON.parse(localStorage.getItem('claude-mem:my-work:preferences') ?? '{}').state?.theme ?? null;
    // The pinned bottom bar's edges, and where the page's own content ends.
    window.bottomBar = () => {
      const bar = document.querySelector('nav[aria-label="Pages"].md\\\\:hidden .pointer-events-auto');
      const main = document.querySelector('main');
      return bar && main ? { barTop: bar.getBoundingClientRect().top, barBottom: bar.getBoundingClientRect().bottom, contentBottom: main.getBoundingClientRect().bottom, viewport: innerHeight } : null;
    };
  `, ['--loader:.webp=empty', '--loader:.css=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty']);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    // The page the build makes: the pre-paint theme script in <head> (vite.config.ts), then the app.
    if (path === '/') return htmlResponse(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>${THEME_PRE_PAINT_SCRIPT}</script><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    const font = myWorkFontResponse(path);
    if (font) return font;
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (path === '/fixture-error') { fixtureErrors.push(await request.text()); return new Response('noted'); }
    return new Response('not found', { status: 404 });
  } });
  // `?source=sample`: App reads its source from the address (store/index.ts ACTIVE_SOURCE).
  fixtureUrl = `${server.url.href}?source=sample`;
});

afterAll(async () => {
  await closeShell();
  server?.stop(true);
});

async function desktop() {
  await page!.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page!.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page!.evaluate('window.scrollTo(0, 0)');
  await page!.settle();
}

/**
 * Tabs from the top of the page until `match` is focused. With sample data the menu button is the 8th stop (skip link,
 * the strip's switch, Use my data, Hide banner, Live, machines, Classic viewer, More); 12 leaves room without letting a
 * missed control tab through the whole page. The rail's last row on the cloud viewer is the 12th at 900px, so that
 * test passes 16.
 */
async function tabTo(match: (focus: any) => boolean, what: string, limit = 12) {
  await page!.evaluate('window.focusPageStart()');
  const seen: string[] = [];
  for (let step = 0; step < limit; step++) {
    await press('Tab');
    const focus = await focused();
    if (focus && match(focus)) return focus;
    seen.push(focus?.name ?? '(none)');
  }
  throw new Error(`Tab never reached ${what}; stops: ${seen.join(' | ')}`);
}

(chromeExecutablePath ? it : it.skip)('G6: the bar holds Live, the machine count, Classic viewer and one menu, and nothing sticks out of the pill', async () => {
  await openShell();
  try {
    await desktop();
    const controls: { name: string; height: number }[] = await page!.evaluate('window.headerControls()');
    expect(controls.map((control) => control.name.replace(/[\d.,]+\s*/g, '').trim())).toEqual(['Live', 'machines', 'Classic viewer', 'More']);
    // Desktop: at least WCAG 2.5.8's 24px, at the mockup's 32px look (34px at the 17px root).
    for (const control of controls) expect(control.height).toBeGreaterThanOrEqual(24);
    await page!.evaluate('window.scrollTo(0, 1500)');
    await waitFor('document.querySelector(".header-pill")', 'the floating pill');
    // The pill's width springs to its size; its contents are measured once its box has held still for 10 frames.
    await waitFor(`(() => { const pill = document.querySelector('.header-pill').getBoundingClientRect(); const key = pill.left + ',' + pill.width;
      window.pillStill = window.pillKey === key ? (window.pillStill ?? 0) + 1 : 0; window.pillKey = key; return window.pillStill >= 10; })()`, 'the pill to settle');
    const pill = await page!.evaluate('window.pillOverhang()');
    // Boxes sit on fractional pixels at the 17px root; 0.5px is under one device pixel at this scale, so any overhang
    // a person could see fails.
    expect(pill.overhang).toBeLessThanOrEqual(0.5);
    // The pill moves Classic viewer into the menu and says how many need you.
    expect(pill.controls.some((name: string) => name.includes('Classic viewer'))).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the Live chip and the machine count open by keyboard, close with Escape and give focus back', async () => {
  await openShell();
  try {
    await desktop();
    const skip = await tabTo(() => true, 'the first stop');
    expect(skip.name).toBe('Skip to content');
    const chip = await tabTo((focus) => focus.chip !== null, 'the Live chip');
    expect(chip.expanded).toBe('false');
    await press('Enter');
    await waitFor('window.popoverText()', 'the Live popover');
    expect(await page!.evaluate('window.popoverText()')).toContain('Connection');
    await press('Escape');
    await waitFor('!window.popoverText()', 'the Live popover to close');
    expect((await focused()).chip).not.toBeNull();
    await press('Tab');
    const machines = await focused();
    expect(machines.name).toContain('machines');
    await press('Enter');
    await waitFor('window.popoverText()?.includes("Machines reporting")', 'the machines popover');
    await press('Escape');
    await waitFor('!window.popoverText()', 'the machines popover to close');
    expect((await focused()).name).toContain('machines');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the "…" menu opens with Enter, moves with the arrows, closes with Escape and returns focus', async () => {
  await openShell();
  try {
    await desktop();
    const trigger = await tabTo((focus) => focus.name === 'More', 'the menu button');
    expect(trigger.expanded).toBe('false');
    // The star count is seen only in the menu, so GitHub is asked when the menu first opens, not when the page loads.
    expect(await page!.evaluate('window.githubStarReads')).toBe(0);
    await press('Enter');
    await waitFor('window.menu()', 'the menu');
    const first = await focused();
    expect(first.inMenu).toBe(true);
    await press('ArrowDown');
    const second = await focused();
    expect(second.inMenu).toBe(true);
    expect(second.name).not.toBe(first.name);
    await press('ArrowUp');
    expect((await focused()).name).toBe(first.name);
    const menu = await page!.evaluate('window.menu()');
    // G6's rows: Team view, the team plan, Language, the three themes, Feedback, Star with its count, Show spec IDs.
    const names = menu.rows.map((row: { name: string }) => row.name);
    for (const expected of ['Team view', 'Start team plan', 'Language', 'System', 'Light mode', 'Dark mode', 'Send feedback', 'Star on GitHub', 'Show spec IDs']) {
      expect(names.some((name: string) => name.startsWith(expected))).toBe(true);
    }
    expect(names.find((name: string) => name.startsWith('Star on GitHub'))).toContain('117.5K');
    // Classic viewer is in the bar at this width, so not in the menu.
    expect(names.some((name: string) => name.startsWith('Classic viewer'))).toBe(false);
    // Desktop rows are at least 40px (D b9 M 191).
    for (const row of menu.rows) expect(row.height).toBeGreaterThanOrEqual(40);
    await press('Escape');
    await waitFor('!window.menu()', 'the menu to close');
    expect((await focused()).name).toBe('More');
    // Opened again, the menu shows the count it has: one read for the page.
    await press('Enter');
    await waitFor('window.menu()', 'the menu again');
    expect(await page!.evaluate('window.githubStarReads')).toBe(1);
    await press('Escape');
    await waitFor('!window.menu()', 'the menu to close again');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('a star count GitHub does not give shows "—" with its reason, not a loading bar that never ends', async () => {
  await openShell({ query: '&github=refuse' });
  try {
    await desktop();
    await tabTo((focus) => focus.name === 'More', 'the menu button');
    await press('Enter');
    await waitFor('window.menu()', 'the menu');
    const starCount = `document.querySelector('[role="menu"] [data-star-count]')`;
    await waitFor(`${starCount}?.getAttribute('data-star-count') === 'unavailable'`, 'the star count to say it is unavailable');
    const shown = await page!.evaluate(`({ text: ${starCount}.textContent, loadingBars: ${starCount}.querySelectorAll('[aria-hidden="true"].rounded-full').length })`);
    expect(shown.text).toContain('—');
    expect(shown.text).toContain('Star count unavailable');
    expect(shown.loadingBars).toBe(0);
    expect(await page!.evaluate('window.githubStarReads')).toBe(1);
    await press('Escape');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here, like the menu test above (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('G8: a ?theme= address lasts the visit and is never saved, even after other changes are', async () => {
  await openShell({ query: '&theme=dark' });
  try {
    await desktop();
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page!.settle();
    // The address's theme draws the page, the pre-paint script and the app alike.
    expect(await page!.evaluate('window.isDark()')).toBe(true);
    // persist saves the preferences on every change; an unrelated one saves them without the address's theme.
    await page!.evaluate("window.store.getState().setFilter('working')");
    await page!.settle();
    expect(await page!.evaluate('[window.isDark(), window.savedTheme()]')).toEqual([true, 'system']);
    // A choice in the menu is the person's own: saved, and the address stops overriding it.
    await tabTo((focus) => focus.name === 'More', 'the menu button');
    await press('Enter');
    await waitFor('window.menu()', 'the menu');
    expect((await page!.evaluate('window.menu()')).rows.find((row: { name: string }) => row.name.startsWith('Dark mode'))?.checked).toBe('true');
    await page!.evaluate('window.clickMenuRow("Light mode")');
    await waitFor('!window.menu()', 'the menu to close');
    await page!.settle();
    expect(await page!.evaluate('[window.isDark(), window.savedTheme(), new URL(location.href).searchParams.has("theme")]')).toEqual([false, 'light', false]);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('G8: Theme in the menu changes the page and is saved; System follows the OS; setup stays light', async () => {
  await openShell();
  try {
    await desktop();
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const choose = async (theme: string) => {
      await tabTo((focus) => focus.name === 'More', 'the menu button');
      await press('Enter');
      await waitFor('window.menu()', 'the menu');
      await page!.evaluate(`window.clickMenuRow(${JSON.stringify(theme)})`);
      await waitFor('!window.menu()', 'the menu to close');
      await page!.settle();
    };
    await choose('Dark mode');
    expect(await page!.evaluate('[window.isDark(), window.savedTheme()]')).toEqual([true, 'dark']);
    await choose('Light mode');
    expect(await page!.evaluate('[window.isDark(), window.savedTheme()]')).toEqual([false, 'light']);
    await choose('System');
    expect(await page!.evaluate('[window.isDark(), window.savedTheme()]')).toEqual([false, 'system']);
    // "System" follows the operating system when it changes, with no reload.
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await waitFor('window.isDark()', 'the page to follow the system to dark');
    // Setup is light whatever the theme: opening it removes the dark class (it has its own light canvas).
    await page!.evaluate('window.store.getState().startSetup()');
    await waitFor('!window.isDark()', 'setup to draw light');
    await page!.evaluate('window.store.getState().finishSetup()');
    await waitFor('window.isDark()', 'My Work to come back dark');
    await page!.send('Emulation.setEmulatedMedia', { features: [] });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('on a touch phone: 44px controls, a page exactly 390 wide, and nothing focused under the bars', async () => {
  await openShell();
  try {
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page!.evaluate('window.scrollTo(0, 0)');
    await page!.settle();
    expect(await page!.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
    // Nothing scrolls sideways, at the width named: the window is that wide, the page that wide or a classic scrollbar
    // narrower (Linux CI draws a 15px one; a touch phone none), and nothing runs past it.
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    const controls: { name: string; height: number; width: number }[] = await page!.evaluate('window.headerControls()');
    expect(controls.filter((control) => control.height < 44 || control.width < 44)).toEqual([]);
    // G7: with sample data the strip says so, and its controls are 44px on touch too, measured at rest (stripAtRest).
    await page!.evaluate('window.stripAtRest()');
    const strip: { name: string; height: number; width: number }[] = await page!.evaluate('window.stripControls()');
    // (The switch items' "· localhost:37777" and "· cmem.ai" are drawn from 768px up only.)
    expect(strip.map((control) => control.name.split('·')[0].trim())).toEqual(['At home', 'On the go', 'Use my data', 'Hide banner']);
    expect(strip.filter((control) => control.height < 44 || control.width < 44)).toEqual([]);
    // The phone bar: Live, the machine count with its icon and number, and the menu, which holds Classic viewer.
    expect(controls.map((control) => control.name.replace(/[\d.,]+\s*/g, '').trim())).toEqual(['Live', 'machines', 'More']);
    await tabTo((focus) => focus.name === 'More', 'the menu button');
    await press('Enter');
    await waitFor('window.menu()', 'the menu');
    const menu = await page!.evaluate('window.menu()');
    expect(menu.rows.some((row: { name: string }) => row.name.startsWith('Classic viewer'))).toBe(true);
    expect(menu.rows.filter((row: { height: number }) => row.height < 44)).toEqual([]);
    // Every language is a row of the menu itself at this width, wholly on the screen (a side menu opened 18px past the
    // left edge and cut the first letters of each name).
    const languages: { lang: string; left: number; right: number }[] = await page!.evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitemradio"][lang]')]
      .map((row) => { const box = row.getBoundingClientRect(); return { lang: row.getAttribute('lang'), left: Math.floor(box.left), right: Math.ceil(box.right) } })`);
    expect(languages.map((language) => language.lang)).toEqual(LOCALES);
    expect(languages.filter((language) => language.left < 0 || language.right > 390)).toEqual([]);
    await page!.evaluate(`document.querySelector('[role="menuitemradio"][lang="pt-BR"]').click()`);
    await waitFor('!window.menu()', 'the menu to close');
    await waitFor(`document.documentElement.lang === 'pt-BR' && document.querySelector('nav[aria-label="Páginas"]')`, 'the navigation in Brazilian Portuguese');
    await page!.evaluate("window.setLocale('en')");
    await page!.settle();
    // The page ends above the pinned bottom bar.
    await page!.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
    await page!.settle();
    const bar = await page!.evaluate('window.bottomBar()');
    expect(bar.contentBottom).toBeLessThanOrEqual(bar.barTop);
    // Pinned to the bottom edge (c-shell-notch M; it floated 17px above it): within 1px, under one device pixel here.
    expect(Math.abs(bar.barBottom - bar.viewport)).toBeLessThanOrEqual(1);
    // Chips are Buttons, so the Button's own touch rule makes each 44px here; the page sets 34px (plan rule 6).
    const chips: { name: string; height: number }[] = await page!.evaluate(`window.visibleIn('nav[aria-label="My focus"] button').map((chip) => ({ name: chip.textContent.trim().slice(0, 40), height: chip.getBoundingClientRect().height }))`);
    expect(chips.length).toBeGreaterThan(2);
    expect(chips.filter((chip) => chip.height < 44)).toEqual([]);
    // Tab through the page: no stop lands under the header or the bottom bar (scroll padding, index.css). The jump back to
    // the top turns the pill back into the bar; it is measured at rest, as a person sees it (Linux CI read the first
    // chip while the header was still sliding back).
    await page!.evaluate('window.focusPageStart()');
    await page!.evaluate('window.headerAtRest()');
    const stops: number = await page!.evaluate('document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]:not([tabindex=\\"-1\\"])").length');
    const hidden: unknown[] = [];
    for (let index = 0; index < stops; index++) {
      await press('Tab');
      const measure = `(() => {
        const element = document.activeElement;
        // Only page content counts: the header, the bottom bar, the sample strip and the skip link are the fixed and
        // sticky chrome the content scrolls under, drawn on top on purpose.
        const inChrome = (node) => { for (let at = node; at && at !== document.body; at = at.parentElement) { const position = getComputedStyle(at).position; if (position === 'fixed' || position === 'sticky') return true; } return false; };
        if (!element || element === document.body || inChrome(element) || element.closest('[data-radix-popper-content-wrapper]')) return null;
        const box = element.getBoundingClientRect();
        const header = document.querySelector('[data-slot="work-shell"] header > * > *').getBoundingClientRect();
        const bar = document.querySelector('nav[aria-label="Pages"].md\\\\:hidden .pointer-events-auto').getBoundingClientRect();
        return box.height > 0 && (box.top < header.bottom - 1 || box.bottom > bar.top + 1) ? { name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40), top: Math.round(box.top), bottom: Math.round(box.bottom), headerBottom: Math.round(header.bottom), barTop: Math.round(bar.top) } : null;
      })()`;
      let found = await page!.evaluate(measure);
      // A stop whose focus scrolled the page can catch the header mid-slide (bar to pill or back): read it again at rest.
      if (found) { await page!.evaluate('window.headerAtRest()'); found = await page!.evaluate(measure); }
      if (found) hidden.push(found);
    }
    expect(hidden).toEqual([]);
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // About 2s here with its ~110 Tab stops (2026-11-16); 90s for a slow CI runner.
}, 90_000);

(chromeExecutablePath ? it : it.skip)('rail rows are 38–54px and "All N" at least 24px; at 768–1023px the rail page buttons keep their names', async () => {
  await openShell();
  try {
    await desktop();
    const rail: { name: string; variant: string; height: number }[] = await page!.evaluate(`window.visibleIn('nav[aria-label="Pages"] button')
      .map((button) => ({ name: button.textContent.trim().slice(0, 40), variant: button.dataset.variant, height: button.getBoundingClientRect().height }))`);
    // c-shell-focus-nav Keep: every row (areas, Other, suggested, Focus overview, the pages, Past focus) 38–54px.
    const rows = rail.filter((button) => button.variant === 'bare');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((row) => row.height < 38 || row.height > 54)).toEqual([]);
    // Plan rule 6 on desktop: "All N" is at least 24px tall (it was 19px).
    const allAreas = rail.filter((button) => button.variant === 'link');
    expect(allAreas.map((button) => button.name)).toEqual([expect.stringMatching(/^All \d+$/)]);
    expect(allAreas[0].height).toBeGreaterThanOrEqual(24);
    // The icon-only rail: each page button is still named by its page (WCAG 4.1.2), not by its tile alone.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    const pageButtons: number = await page!.evaluate(`window.visibleIn('nav[aria-label="Pages"] button').length`);
    const names: string[] = [];
    for (let index = 0; index < pageButtons; index++) {
      names.push((await accessibleText(`window.visibleIn('nav[aria-label="Pages"] button')[${index}]`)).name);
    }
    expect(names.map((name) => name.replace(/\s*\d+ needs? you$/, ''))).toEqual(['My Work', 'My Rules']);
    for (const height of await page!.evaluate(`window.visibleIn('nav[aria-label="Pages"] button').map((button) => button.getBoundingClientRect().height)`)) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('on the cloud viewer, Account & billing is a named, translated rail row, 44px on touch and where only its tile shows', async () => {
  await openShell({ hostname: CLOUD_HOSTNAME });
  try {
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    const row = `document.querySelector('nav[aria-label="Pages"] a[href="https://cmem.ai/account"]')`;
    expect(await page!.evaluate(`${row}.hasAttribute('title')`)).toBe(false);
    expect((await accessibleText(row)).name).toBe('Account & billing');
    expect(await page!.evaluate(`${row}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
    // Where only the tile shows, its tooltip names it on keyboard focus too (G10), not on hover only.
    await tabTo((focus) => focus.name.startsWith('Account & billing'), 'Account & billing', 16);
    await waitFor(`document.querySelector('[data-slot="tooltip-content"]')?.textContent === 'Account & billing'`, 'its tooltip on focus');
    // Wide: its words show; on touch the row is 44px or more (the Button's touch rule).
    await desktop();
    expect(await page!.evaluate(`[...${row}.querySelectorAll('span')].filter((span) => getComputedStyle(span).display !== 'none' && !span.classList.contains('sr-only') && span.textContent.trim()).map((span) => span.textContent)`)).toEqual(['Account & billing']);
    expect(await page!.evaluate(`${row}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(24);
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page!.settle();
    expect(await page!.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
    expect(await page!.evaluate(`${row}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    // Rule 4: through t(), in the reader's language.
    await page!.evaluate("window.setLocale('fr')");
    await page!.settle();
    expect((await accessibleText(row)).name).toBe('Compte et facturation');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 2–3s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('"All N" and the menu\'s feedback row are named by their visible words in every language (label in name)', async () => {
  await openShell();
  try {
    for (const locale of LOCALES) {
      await desktop();
      await page!.evaluate(`window.setLocale(${JSON.stringify(locale)})`);
      await page!.settle();
      // Found by place, not by their translated labels: the rail is the one sticky nav, the chip row the nav in main.
      const railAll = `window.visibleIn('nav.sticky button[data-variant="link"]')[0]`;
      const rail = await accessibleText(railAll);
      expect({ locale, name: rail.name }).toEqual({ locale, name: await page!.evaluate(`${railAll}.textContent.trim()`) });
      // Where it leads is read after the name.
      expect(rail.description).toMatch(/\d/);
      await page!.evaluate("document.querySelector('[data-slot=\"work-shell\"] header button[aria-haspopup=\"menu\"]').focus()");
      await press('Enter');
      await waitFor('window.menu()', `the menu in ${locale}`);
      const feedback = `document.querySelector('[role="menu"] a[href*="my-work-feedback"]')`;
      const words: string = await page!.evaluate(`${feedback}.querySelector('span').textContent.trim()`);
      const row = await accessibleText(feedback);
      expect({ locale, contains: row.name.includes(words), name: row.name }).toEqual({ locale, contains: true, name: row.name });
      expect(row.description.length).toBeGreaterThan(words.length);
      await press('Escape');
      await waitFor('!window.menu()', 'the menu to close');
      // The chip row's "All N" (phones and the icon-only rail).
      await page!.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
      await page!.settle();
      const chipAll = `window.visibleIn('main nav button').at(-1)`;
      expect({ locale, name: (await accessibleText(chipAll)).name }).toEqual({ locale, name: await page!.evaluate(`${chipAll}.textContent.trim()`) });
    }
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // About 3s here for five languages (2026-11-16); 45s for a slow CI runner.
}, 45_000);

(chromeExecutablePath ? it : it.skip)('focus stays on the page when Tab leaves the Live or machines panel, and after Hide banner', async () => {
  await openShell();
  try {
    await desktop();
    // Shift+Tab from the Live panel goes back to the chip, the panel still open; Escape then closes it.
    await tabTo((focus) => focus.chip !== null, 'the Live chip');
    await press('Enter');
    await waitFor('window.popoverText()', 'the Live popover');
    await press('Tab', { shift: true });
    await page!.settle();
    expect((await focused()).chip).not.toBeNull();
    expect(await page!.evaluate('!!window.popoverText()')).toBe(true);
    await press('Escape');
    await waitFor('!window.popoverText()', 'the Live popover to close');
    // Tab past the panel's end goes on to the stop after the chip (the machines), and the panel closes.
    await press('Enter');
    await waitFor('window.popoverText()', 'the Live popover again');
    await press('Tab');
    await waitFor('!window.popoverText()', 'the Live popover to close as focus leaves it');
    expect((await focused()).name).toContain('machines');
    // The same from the machines panel: on to Classic viewer.
    await press('Enter');
    await waitFor('window.popoverText()?.includes("Machines reporting")', 'the machines popover');
    await press('Tab');
    await waitFor('!window.popoverText()', 'the machines popover to close as focus leaves it');
    expect((await focused()).name).toBe('Classic viewer');
    // Hide banner: the strip leaves the page and focus goes on to the header's first control.
    await tabTo((focus) => focus.name === 'Hide banner', 'Hide banner');
    await press('Enter');
    await waitFor('window.stripControls()?.length === 0', 'the strip to leave');
    expect((await focused()).chip).not.toBeNull();
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('Try again keeps focus: on the next failed screen\'s Try again, then on the main content once the work loads', async () => {
  await openShell({ query: '&fail-reads=2' });
  try {
    await desktop();
    expect(await page!.evaluate(`!!document.querySelector('[role="alert"]')`)).toBe(true);
    await tabTo((focus) => focus.name === 'Try again', 'Try again');
    await press('Enter');
    await waitFor(`document.querySelector('[role="alert"]') && document.activeElement?.textContent === 'Try again'`, 'the second failed screen with focus on Try again');
    await press('Enter');
    await waitFor(`document.querySelector('[data-slot="work-shell"] header [data-live-chip]')`, 'the loaded page');
    await waitFor(`document.activeElement?.id === 'main-content'`, 'focus on the main content');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('under reduced motion the pill, the sample strip and the bottom bar change at once (plan rule 8)', async () => {
  await openShell();
  try {
    await desktop();
    // Motion's useReducedMotion reads the setting when a component mounts, so the page loads again under it.
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
    await page!.send('Page.reload', {});
    // The reload draws the whole App again in about a second here (2026-11-16); 20s is for a cold CI runner.
    await withTimeout(ready, 20_000, 'the shell did not draw again after the reload');
    expect(await page!.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")).toBe(true);
    await page!.evaluate('window.scrollTo(0, 0)');
    await page!.settle();
    // Every frame for 20 frames after the scroll (about 330ms, longer than the strip's 0.3s fade; the pill's spring takes
    // longer still): the bar is the full bar or the 800px pill and the strip is shown or gone, never in between.
    const scrolled = await page!.evaluate(`new Promise((resolve) => {
      const strip = document.querySelector('[data-slot="work-shell"] > header').previousElementSibling;
      const bar = document.querySelector('[data-slot="work-shell"] header h1').parentElement;
      const widths = new Set(), opacities = new Set();
      let frames = 0;
      window.scrollTo(0, 1500);
      (function sample() {
        widths.add(Math.round(bar.getBoundingClientRect().width));
        opacities.add(getComputedStyle(strip).opacity);
        if (++frames < 20) requestAnimationFrame(sample);
        else resolve({ widths: [...widths].sort((a, b) => a - b), opacities: [...opacities].sort(), pill: !!document.querySelector('.header-pill'), pageWidth: document.documentElement.clientWidth });
      })();
    })`);
    // The full bar is as wide as the page's layout width: 1440 here, 1425 where Chrome draws a 15px classic scrollbar
    // (Linux CI), so the page's own clientWidth is the measure, not the window's 1440.
    const { pageWidth, ...seen } = scrolled;
    expect(seen).toEqual({ widths: [800, pageWidth], opacities: ['0', '1'], pill: true });
    // The bottom bar, mounted outside the App's MotionConfig: no fade and blur in.
    const bar = await page!.evaluate(`new Promise((resolve) => {
      window.mountNotchProbe();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const shell = document.body.lastElementChild.querySelector('.pointer-events-auto');
        resolve({ opacity: getComputedStyle(shell).opacity, filter: getComputedStyle(shell).filter });
      }));
    })`);
    expect(bar.opacity).toBe('1');
    expect(['none', 'blur(0px)']).toContain(bar.filter);
    // The header bar on its own, outside the App's MotionConfig: it turns into the 800px pill at once.
    await page!.evaluate('window.mountNavBodyProbe()');
    await page!.settle();
    const probe = await page!.evaluate(`new Promise((resolve) => {
      const width = () => Math.round(window.navBodyProbe.bar().getBoundingClientRect().width);
      const start = width();
      const widths = new Set();
      let frames = 0;
      window.navBodyProbe.toPill();
      (function sample() {
        widths.add(width());
        if (++frames < 20) requestAnimationFrame(sample);
        else resolve({ start, widths: [...widths].sort((a, b) => a - b), last: width() });
      })();
    })`);
    // The kit's own bar is at most 1360px wide (its max-w-7xl at the 17px root); the App's is 1440px.
    expect(probe.start).toBe(1360);
    expect({ last: probe.last, widths: probe.widths }).toEqual({ last: 800, widths: [800, 1360] });
    await page!.send('Emulation.setEmulatedMedia', { features: [] });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

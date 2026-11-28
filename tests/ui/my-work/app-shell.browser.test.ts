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
import { MEMORY_PLACE, MY_WORK_PLACES } from '../../../src/ui/app-places';

failOnCiWithoutChrome('CI requires Chrome for the My Work shell regressions.');

/**
 * The app shell (My Work design pass, Phase 3: one look and one bar), on the real App with the sample source, the
 * app's real stylesheet, its Geist font and the pre-paint theme script the build puts in index.html:
 * - the bar: the brain mark, the five places in order (src/ui/app-places.ts), Memory and one "…" menu; the active
 *   place is marked; a press moves to the place's page; nothing runs past the window at 1440 or at 768;
 * - the bar draws on the loading and failed screens too, its places and Memory working, and Try again keeps focus;
 * - the menu opens with Enter, moves with the arrows, closes with Escape and returns focus;
 * - G8: Theme in the menu changes <html> and is saved, System follows the OS, setup stays light, and a `?theme=`
 *   address lasts the visit without being saved;
 * - phones: the places are the bottom bar, every bar control and menu row is at least 44px on a coarse pointer, the
 *   page is exactly 390 wide, the page ends above the pinned bottom bar, and no focused control sits under the bars;
 * - the places not shown are muted, the one shown green with an edge along its foot (not colour alone);
 * - Back, Forward and a reload land where the page was left scrolled (the app restores it: scrollRestoration manual);
 *   Account & billing on the cloud viewer; names that contain their visible words in every language; the sample
 *   strip under reduced motion.
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
    // \`&hold-reads=1\`: the first read never answers, so the page stays on its loading screen.
    if (new URLSearchParams(location.search).get('hold-reads') === '1') {
      const startWorkSource = useStore.getState().startWorkSource;
      useStore.setState({ startWorkSource: (source) => {
        const holding = Object.create(source);
        holding.loadWorkModel = () => new Promise(() => {});
        return startWorkSource(holding);
      } });
    }
    if (failReads > 0) {
      const startWorkSource = useStore.getState().startWorkSource;
      let failed = 0;
      useStore.setState({ startWorkSource: (source) => {
        const failing = Object.create(source);
        failing.loadWorkModel = () => failed++ < failReads ? Promise.reject(new TypeError('Failed to fetch')) : source.loadWorkModel();
        return startWorkSource(failing);
      } });
    }
    // \`&areas=many\`: every model carries a second copy of each kept area, so the focus area board has more areas than
    // it shows at first (FOCUS_OVERVIEW_FIRST_AREAS) and its Show all / Show priority areas fold.
    if (new URLSearchParams(location.search).get('areas') === 'many') {
      const withMoreAreas = (model) => ({ ...model, focusAreas: [...model.focusAreas, ...model.focusAreas.filter((area) => area.status === 'kept')
        .map((area) => ({ ...area, id: area.id + '-again', name: area.name + ' again', subFocuses: [] }))] });
      const startWorkSource = useStore.getState().startWorkSource;
      useStore.setState({ startWorkSource: (source) => {
        const more = Object.create(source);
        more.loadWorkModel = () => source.loadWorkModel().then(withMoreAreas);
        more.subscribeToLiveUpdates = (onModel, onConnection) => source.subscribeToLiveUpdates((model) => onModel(withMoreAreas(model)), onConnection);
        return startWorkSource(more);
      } });
    }
    window.store = useStore;
    window.setLocale = setLocale;
    createRoot(document.getElementById('root')).render(<App />);
    // Ready once the bar is drawn over a page that is not reading (the loaded page or the failed read), or over the
    // loading screen when the fixture holds the read (hold-reads).
    const holding = new URLSearchParams(location.search).get('hold-reads') === '1';
    (function waitForShell() {
      const bar = document.querySelector('[data-slot="app-bar"]');
      const reading = document.querySelector('main [aria-busy="true"]');
      if (bar && (holding ? reading : document.querySelector('main') && !reading)) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForShell);
    })();
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    // Names are cut at 60 characters (40 in the size lists) so a failure prints one line; every name a test compares
    // is shorter (the longest, the cloud rail row's "Account & billing" twice, is 34).
    const nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    window.describeFocus = () => {
      const element = document.activeElement;
      return element ? { name: nameOf(element).slice(0, 60), role: element.getAttribute('role'), tag: element.tagName.toLowerCase(),
        expanded: element.getAttribute('aria-expanded'), inMenu: !!element.closest('[role="menu"]'), inBar: !!element.closest('[data-slot="app-bar"]') } : null;
    };
    const controlsIn = (root) => root ? [...root.querySelectorAll('button, a[href], select, input')].filter(visible)
      .map((element) => ({ name: nameOf(element).slice(0, 40), height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width, current: element.getAttribute('aria-current') })) : null;
    window.headerControls = () => controlsIn(document.querySelector('[data-slot="app-bar"]'));
    // How each place in a bar draws, beside the colours its tokens name in this theme: the muted words, the green of
    // the place shown. An element's computed colour, so a class the merge dropped shows up here.
    window.placeLooks = (slot) => {
      const tokenColour = (token) => { const probe = document.createElement('span'); probe.style.color = 'var(' + token + ')'; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; };
      const nav = document.querySelector('[data-slot="' + slot + '"]');
      return { muted: tokenColour('--muted-foreground'), green: tokenColour('--place-active-foreground'),
        places: [...(nav.matches('nav') ? nav : nav.querySelector('nav')).querySelectorAll('a[href]')].map((link) => { const style = getComputedStyle(link);
          return { name: nameOf(link), color: style.color, edge: style.borderBottomWidth + ' ' + style.borderBottomColor }; }) };
    };
    window.bottomBarControls = () => controlsIn(document.querySelector('[data-slot="bottom-bar"]'));
    // The sample-data strip above the bar (G7): its switch items, Use my data and its close.
    const strip = () => document.querySelector('[data-slot="app-bar"]')?.previousElementSibling;
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
        // times slower.
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
    // takes focus first (not as a stop of its own: tabindex -1).
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
    window.isDark = () => document.documentElement.classList.contains('dark');
    window.savedTheme = () => JSON.parse(localStorage.getItem('claude-mem:my-work:preferences') ?? '{}').state?.theme ?? null;
    // The pinned bottom bar's edges, and where the page's own content ends.
    window.bottomBar = () => {
      const bar = document.querySelector('[data-slot="bottom-bar"]');
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
 * Tabs from the top of the page until `match` is focused. With sample data the menu button is the 13th stop (skip link,
 * the strip's two switch items, Use my data, Hide banner, the brand, five places, Memory, More); 16 leaves room without
 * letting a missed control tab through the whole page.
 */
async function tabTo(match: (focus: any) => boolean, what: string, limit = 16) {
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

/** The bar's places, the words each shows, in order (src/ui/app-places.ts), and the one marked as the page shown. */
const PLACES = MY_WORK_PLACES.map((place) => place.label);
const PHONE_PLACES = MY_WORK_PLACES.map((place) => place.shortLabel);
const MEMORY = MEMORY_PLACE.label;
const currentPlace = (controls: { name: string; current: string | null }[]) => controls.filter((control) => control.current === 'page').map((control) => control.name);

/** Presses a place in the top bar (or the bottom bar with `phone`) the way a person does: a plain left click. */
async function pressPlace(name: string, { phone = false } = {}) {
  await page!.evaluate(`[...document.querySelectorAll('[data-slot="${phone ? 'bottom-bar' : 'app-bar'}"] a[href]')].find((link) => link.textContent.trim() === ${JSON.stringify(name)}).click()`);
  await page!.settle();
}

(chromeExecutablePath ? it : it.skip)('the bar holds the brand, the five places in order, Memory and one menu; the place shown is marked and each press moves there', async () => {
  await openShell();
  try {
    await desktop();
    const controls: { name: string; height: number; current: string | null }[] = await page!.evaluate('window.headerControls()');
    expect(controls.map((control) => control.name)).toEqual(['claude-mem', ...PLACES, MEMORY, 'More']);
    expect(currentPlace(controls)).toEqual(['My Work']);
    // Every control in the bar is 44px tall (Codex's nav links and icon button), the brand's 34px mark aside.
    expect(controls.filter((control) => control.name !== 'claude-mem' && control.height < 44)).toEqual([]);
    // Memory is another page, at its own address.
    expect(await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[href="${MEMORY_PLACE.address}"]').textContent.trim()`)).toBe(MEMORY);
    // The places not shown draw in the muted words and the one shown in green, with a green edge along its foot, in
    // both themes (cn() once took the place's font size for a colour and dropped the muted one: full ink).
    for (const theme of ['light', 'dark']) {
      await page!.evaluate(`window.store.getState().setTheme(${JSON.stringify(theme)})`);
      // The places' colours ease to the new theme (transition-colors); they are read once that has finished.
      await waitFor(`window.isDark() === ${theme === 'dark'} && [...document.querySelectorAll('[data-slot="app-bar"] nav a')].every((link) => link.getAnimations().length === 0)`, `the ${theme} theme drawn`);
      const looks: { muted: string; green: string; places: { name: string; color: string; edge: string }[] } = await page!.evaluate(`window.placeLooks('app-bar')`);
      expect(looks.muted).not.toBe(looks.green);
      expect(looks.places).toEqual(PLACES.map((name) => name === PLACES[0]
        ? { name, color: looks.green, edge: `2px ${looks.green}` } : { name, color: looks.muted, edge: '2px rgba(0, 0, 0, 0)' }));
    }
    await page!.evaluate(`window.store.getState().setTheme('system')`);
    await page!.settle();
    // Nothing runs past the window, at the desktop width and at the narrowest width that has the top bar's places,
    // measured once the sample strip has come to rest (its close button springs in past its own size).
    await page!.evaluate('window.stripAtRest()');
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 1440)).toMatchObject(FITS_THE_WINDOW);
    await pressPlace('My Rules');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'rules' && document.querySelector('main h1')?.textContent === 'My Rules'`, 'My Rules');
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['My Rules']);
    // Focus areas opens the home page at its focus area board until it has a page of its own (design pass Phase 7).
    await pressPlace('Focus areas');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'focus' && document.getElementById('focus-areas')`, 'Focus areas');
    await waitFor(`Math.abs(document.getElementById('focus-areas').getBoundingClientRect().top - 82) <= 2`, 'the focus area board at the top, under the bar');
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['Focus areas']);
    // Past focus, where areas marked done go, has a quiet link on the board until Focus areas has its tabs (Phase 7).
    const pastFocus = `[...document.querySelectorAll('#focus-areas a[href]')].find((link) => link.textContent.trim() === 'Past focus')`;
    expect(await page!.evaluate(`[new URL(${pastFocus}.href).searchParams.get('view'), new URL(${pastFocus}.href).searchParams.get('source')]`)).toEqual(['past-focus', 'sample']);
    await page!.evaluate(`${pastFocus}.click()`);
    await waitFor(`new URLSearchParams(location.search).get('view') === 'past-focus' && document.querySelector('main h1')?.textContent === 'Past focus'`, 'Past focus');
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['Focus areas']);
    // A focus area's page sits under Focus areas; its own header names it, so the page's h1 is for screen readers.
    await page!.evaluate(`window.store.getState().goToFocus(window.store.getState().work.load.model.focusAreas[0].id)`);
    await page!.settle();
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['Focus areas']);
    expect(await page!.evaluate(`document.querySelector('main h1').classList.contains('sr-only')`)).toBe(true);
    // The brand goes home.
    await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[href]').click()`);
    await waitFor(`!new URLSearchParams(location.search).get('view') && !new URLSearchParams(location.search).get('focus')`, 'home');
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['My Work']);
    // 768px: the five places and Memory's mark still fit in the bar, and Memory keeps its name for screen readers.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    expect((await page!.evaluate('window.headerControls()')).map((control: { name: string }) => control.name)).toEqual(['claude-mem', ...PLACES, MEMORY, 'More']);
    expect((await accessibleText(`document.querySelector('[data-slot="app-bar"] a[href="${MEMORY_PLACE.address}"]')`)).name).toBe(MEMORY);
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 768)).toMatchObject(FITS_THE_WINDOW);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // About 3s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('each press of Focus areas shows every area, also after the person folded the board back to its first areas', async () => {
  await openShell({ query: '&areas=many' });
  try {
    await desktop();
    await pressPlace('Focus areas');
    const toggle = `[...document.querySelectorAll('#focus-areas button[aria-expanded]')].find((button) => /^Show (all|priority)/.test(button.textContent.trim()))`;
    await waitFor(`${toggle}?.getAttribute('aria-expanded') === 'true'`, 'every area shown');
    await page!.evaluate(`${toggle}.click()`);
    await waitFor(`${toggle}.getAttribute('aria-expanded') === 'false'`, 'the board folded to its first areas');
    // The page shown is Focus areas already; pressing it again is the person asking for every area again.
    await pressPlace('Focus areas');
    await waitFor(`${toggle}.getAttribute('aria-expanded') === 'true'`, 'every area shown again');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the bar draws on the loading screen and its places work there; the content area is kept, not shaped like navigation', async () => {
  await openShell({ query: '&hold-reads=1' });
  try {
    await desktop();
    const controls = await page!.evaluate('window.headerControls()');
    expect(controls.map((control: { name: string }) => control.name)).toEqual(['claude-mem', ...PLACES, MEMORY, 'More']);
    expect(currentPlace(controls)).toEqual(['My Work']);
    expect(await page!.evaluate(`[document.querySelector('main h1').textContent, document.querySelector('main [role="status"]').textContent]`)).toEqual(['My Work', 'Reading local work…']);
    // The placeholders sit in the page's content area only.
    expect(await page!.evaluate(`document.querySelectorAll('[data-slot="skeleton"]').length > 0 && [...document.querySelectorAll('[data-slot="skeleton"]')].every((shape) => shape.closest('main'))`)).toBe(true);
    // A place pressed while the work is read: the address and the bar move, and the screen keeps reading.
    await pressPlace('My Rules');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'rules' && document.querySelector('main h1')?.textContent === 'My Rules'`, 'My Rules while reading');
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['My Rules']);
    expect(await page!.evaluate(`!!document.querySelector('main [aria-busy="true"]')`)).toBe(true);
    // The "…" menu opens there too: it reads no work model.
    await tabTo((focus) => focus.name === 'More', 'the menu button');
    await press('Enter');
    await waitFor('window.menu()', 'the menu on the loading screen');
    await press('Escape');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the failed screen keeps the bar, names what did not answer and offers Try again, Memory and the technical details', async () => {
  await openShell({ query: '&fail-reads=1' });
  try {
    await desktop();
    expect((await page!.evaluate('window.headerControls()')).map((control: { name: string }) => control.name)).toEqual(['claude-mem', ...PLACES, MEMORY, 'More']);
    const alert = await page!.evaluate(`(() => { const alert = document.querySelector('[role="alert"]'); return {
      heading: alert.querySelector('h2').textContent, text: alert.querySelector('p').textContent,
      actions: [...alert.querySelectorAll('button, a[href]')].map((control) => [control.textContent.trim(), control.getAttribute('href')]) } })()`);
    expect(alert).toEqual({
      heading: 'Local work couldn’t load',
      text: 'The worker on this computer didn’t answer. It may be restarting.',
      actions: [['Try again', null], ['Open Memory', '/viewer'], ['Technical details', null]],
    });
    // The raw cause is one press away, folded.
    await page!.evaluate(`[...document.querySelectorAll('[role="alert"] button')].find((button) => button.textContent.trim() === 'Technical details').click()`);
    await waitFor(`document.querySelector('[role="alert"]').textContent.includes('Failed to fetch')`, 'the cause under Technical details');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-27); 30s for a slow CI runner.
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
    // Memory is in the bar at this width, so not in the menu; Account & billing is for the cloud viewer only.
    expect(names.some((name: string) => name.startsWith(MEMORY) || name.startsWith('Account & billing'))).toBe(false);
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
    // The bar's links carry it while it lasts, so a place opened in a new tab keeps the visit's theme.
    const linkThemes = `[...document.querySelectorAll('[data-slot="app-bar"] a[href]')].filter((link) => link.getAttribute('href') !== ${JSON.stringify(MEMORY_PLACE.address)}).map((link) => new URL(link.href).searchParams.get('theme'))`;
    expect(new Set(await page!.evaluate(linkThemes))).toEqual(new Set(['dark']));
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
    // ...and stop carrying it once it no longer sets the visit's theme (a new tab or a copied link would force dark).
    expect(new Set(await page!.evaluate(linkThemes))).toEqual(new Set([null]));
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

(chromeExecutablePath ? it : it.skip)('on a touch phone: the places are the bottom bar, 44px controls, a page exactly 390 wide, and nothing focused under the bars', async () => {
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
    // The top keeps the brand and the menu, which holds Memory; the places are the bottom bar.
    const controls: { name: string; height: number; width: number }[] = await page!.evaluate('window.headerControls()');
    expect(controls.map((control) => control.name)).toEqual(['claude-mem', 'More']);
    expect(controls.filter((control) => control.height < 44 || control.width < 44)).toEqual([]);
    const places: { name: string; height: number; width: number; current: string | null }[] = await page!.evaluate('window.bottomBarControls()');
    expect(places.map((place) => place.name)).toEqual(PHONE_PLACES);
    expect(currentPlace(places)).toEqual(['My Work']);
    expect(places.filter((place) => place.height < 44 || place.width < 44)).toEqual([]);
    // The bottom bar marks the place shown the same way: muted words for the others, green words and edge for it.
    const looks: { muted: string; green: string; places: { name: string; color: string; edge: string }[] } = await page!.evaluate(`window.placeLooks('bottom-bar')`);
    expect(looks.places).toEqual(PHONE_PLACES.map((name) => name === PHONE_PLACES[0]
      ? { name, color: looks.green, edge: `2px ${looks.green}` } : { name, color: looks.muted, edge: '2px rgba(0, 0, 0, 0)' }));
    await pressPlace('Review', { phone: true });
    await waitFor(`new URLSearchParams(location.search).get('view') === 'review-stack'`, 'Review Stack from the bottom bar');
    expect(currentPlace(await page!.evaluate('window.bottomBarControls()'))).toEqual(['Review']);
    await pressPlace('My Work', { phone: true });
    await waitFor(`!new URLSearchParams(location.search).get('view')`, 'home from the bottom bar');
    // G7: with sample data the strip says so, and its controls are 44px on touch too, measured at rest (stripAtRest).
    await page!.evaluate('window.stripAtRest()');
    const strip: { name: string; height: number; width: number }[] = await page!.evaluate('window.stripControls()');
    // (The switch items' "· localhost:37777" and "· cmem.ai" are drawn from 768px up only.)
    expect(strip.map((control) => control.name.split('·')[0].trim())).toEqual(['At home', 'On the go', 'Use my data', 'Hide banner']);
    expect(strip.filter((control) => control.height < 44 || control.width < 44)).toEqual([]);
    await tabTo((focus) => focus.name === 'More', 'the menu button');
    await press('Enter');
    await waitFor('window.menu()', 'the menu');
    const menu = await page!.evaluate('window.menu()');
    expect(menu.rows.some((row: { name: string }) => row.name.startsWith(MEMORY))).toBe(true);
    expect(menu.rows.filter((row: { height: number }) => row.height < 44)).toEqual([]);
    // Every language is a row of the menu itself at this width, wholly on the screen (a side menu opened 18px past the
    // left edge and cut the first letters of each name).
    const languages: { lang: string; left: number; right: number }[] = await page!.evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitemradio"][lang]')]
      .map((row) => { const box = row.getBoundingClientRect(); return { lang: row.getAttribute('lang'), left: Math.floor(box.left), right: Math.ceil(box.right) } })`);
    expect(languages.map((language) => language.lang)).toEqual(LOCALES);
    expect(languages.filter((language) => language.left < 0 || language.right > 390)).toEqual([]);
    await page!.evaluate(`document.querySelector('[role="menuitemradio"][lang="pt-BR"]').click()`);
    await waitFor('!window.menu()', 'the menu to close');
    await waitFor(`document.documentElement.lang === 'pt-BR' && document.querySelector('[data-slot="bottom-bar"][aria-label="Páginas"]')`, 'the navigation in Brazilian Portuguese');
    await page!.evaluate("window.setLocale('en')");
    await page!.settle();
    // The page ends above the pinned bottom bar.
    await page!.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
    await page!.settle();
    const bar = await page!.evaluate('window.bottomBar()');
    expect(bar.contentBottom).toBeLessThanOrEqual(bar.barTop);
    // Pinned to the bottom edge: within 1px, under one device pixel here.
    expect(Math.abs(bar.barBottom - bar.viewport)).toBeLessThanOrEqual(1);
    // Tab through the page: no stop lands under the bar or the bottom bar (scroll padding, index.css).
    await page!.evaluate('window.focusPageStart()');
    const stops: number = await page!.evaluate('document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]:not([tabindex=\\"-1\\"])").length');
    const hidden: unknown[] = [];
    for (let index = 0; index < stops; index++) {
      await press('Tab');
      const found = await page!.evaluate(`(() => {
        const element = document.activeElement;
        // Only page content counts: the bars, the sample strip and the skip link are the fixed and sticky chrome the
        // content scrolls under, drawn on top on purpose.
        const inChrome = (node) => { for (let at = node; at && at !== document.body; at = at.parentElement) { const position = getComputedStyle(at).position; if (position === 'fixed' || position === 'sticky') return true; } return false; };
        if (!element || element === document.body || inChrome(element) || element.closest('[data-radix-popper-content-wrapper]')) return null;
        const box = element.getBoundingClientRect();
        const header = document.querySelector('[data-slot="app-bar"]').getBoundingClientRect();
        const bar = document.querySelector('[data-slot="bottom-bar"]').getBoundingClientRect();
        return box.height > 0 && (box.top < header.bottom - 1 || box.bottom > bar.top + 1) ? { name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40), top: Math.round(box.top), bottom: Math.round(box.bottom), headerBottom: Math.round(header.bottom), barTop: Math.round(bar.top) } : null;
      })()`);
      if (found) hidden.push(found);
    }
    expect(hidden).toEqual([]);
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // About 2s here with its ~110 Tab stops (2026-11-16); 90s for a slow CI runner.
}, 90_000);

(chromeExecutablePath ? it : it.skip)('Back, Forward and a reload land where the person left each page scrolled, restored by the app, not the browser', async () => {
  await openShell();
  try {
    await desktop();
    // The app restores positions itself, once the page is drawn; the browser's own restore is off.
    expect(await page!.evaluate('history.scrollRestoration')).toBe('manual');
    await page!.evaluate('window.scrollTo(0, 1200)');
    await waitFor('Math.round(scrollY) === 1200', 'the home page scrolled');
    await pressPlace('My Rules');
    await waitFor(`document.querySelector('main h1')?.textContent === 'My Rules' && scrollY === 0`, 'My Rules from its top');
    await page!.evaluate('history.back()');
    await waitFor(`!new URLSearchParams(location.search).get('view') && document.getElementById('all-requests') && Math.abs(scrollY - 1200) <= 1`, 'home at 1200px again');
    // Requests opens at its board; the person scrolls on past it, goes Back home, then Forward: Requests comes back where
    // it was left, not at its board (the entry left by Back keeps its own position).
    await pressPlace('Requests');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'requests' && Math.abs(document.getElementById('all-requests').getBoundingClientRect().top - 82) <= 2`, 'Requests at its board');
    const atBoard: number = await page!.evaluate('Math.round(scrollY)');
    const past: number = await page!.evaluate(`Math.min(Math.round(scrollY) + 600, document.documentElement.scrollHeight - innerHeight)`);
    expect(past - atBoard).toBeGreaterThan(300);
    await page!.evaluate(`window.scrollTo(0, ${past})`);
    await waitFor(`Math.round(scrollY) === ${past}`, 'Requests scrolled past its board');
    await page!.evaluate('history.back()');
    await waitFor(`!new URLSearchParams(location.search).get('view') && Math.abs(scrollY - 1200) <= 1`, 'home at 1200px after Back');
    await page!.evaluate('history.forward()');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'requests' && Math.abs(scrollY - ${past}) <= 1`, 'Requests where it was left, after Forward');
    // A reload opens that entry where it was left too, once the work has been read again, and stays there while the
    // page settles: the focus area board above it draws taller for a frame (about 3,300px, then 670px here), and the
    // browser's scroll anchoring moved the window up by that much until the app held it at the position.
    const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
    await page!.send('Page.reload', {});
    // The reload draws the whole App again in about a second here (2026-11-27); 20s is for a cold CI runner.
    await withTimeout(ready, 20_000, 'the shell did not draw again after the reload');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'requests' && Math.abs(scrollY - ${past}) <= 1`, 'Requests where it was left, after a reload');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 2–3s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('on the cloud viewer, Account & billing is a named, translated row of the "…" menu; on this computer it is not there', async () => {
  await openShell({ hostname: CLOUD_HOSTNAME });
  try {
    await desktop();
    await tabTo((focus) => focus.name === 'More', 'the menu button');
    await press('Enter');
    await waitFor('window.menu()', 'the menu');
    const row = `document.querySelector('[role="menu"] a[href="https://cmem.ai/account"]')`;
    expect((await accessibleText(row)).name).toBe('Account & billing');
    expect(await page!.evaluate(`${row}.offsetHeight`)).toBeGreaterThanOrEqual(40);
    await press('Escape');
    await waitFor('!window.menu()', 'the menu to close');
    // Rule 4: through t(), in the reader's language.
    await page!.evaluate("window.setLocale('fr')");
    await page!.settle();
    await page!.evaluate(`document.querySelector('[data-slot="app-bar"] button[aria-haspopup="menu"]').focus()`);
    await press('Enter');
    await waitFor('window.menu()', 'the menu in French');
    expect((await accessibleText(row)).name).toBe('Compte et facturation');
    await press('Escape');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 2–3s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the bar\'s places and the menu\'s feedback row are named by their visible words in every language (label in name)', async () => {
  await openShell();
  try {
    for (const locale of LOCALES) {
      await desktop();
      await page!.evaluate(`window.setLocale(${JSON.stringify(locale)})`);
      await page!.settle();
      const places: number = await page!.evaluate(`document.querySelectorAll('[data-slot="app-bar"] nav a[href]').length`);
      expect(places).toBe(PLACES.length);
      for (let index = 0; index < places; index++) {
        const link = `document.querySelectorAll('[data-slot="app-bar"] nav a[href]')[${index}]`;
        expect({ locale, name: (await accessibleText(link)).name }).toEqual({ locale, name: await page!.evaluate(`${link}.textContent.trim()`) });
      }
      await page!.evaluate(`document.querySelector('[data-slot="app-bar"] button[aria-haspopup="menu"]').focus()`);
      await press('Enter');
      await waitFor('window.menu()', `the menu in ${locale}`);
      const feedback = `document.querySelector('[role="menu"] a[href*="my-work-feedback"]')`;
      const words: string = await page!.evaluate(`${feedback}.querySelector('span').textContent.trim()`);
      const row = await accessibleText(feedback);
      expect({ locale, contains: row.name.includes(words), name: row.name }).toEqual({ locale, contains: true, name: row.name });
      expect(row.description.length).toBeGreaterThan(words.length);
      await press('Escape');
      await waitFor('!window.menu()', 'the menu to close');
    }
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // About 3s here for five languages (2026-11-16); 45s for a slow CI runner.
}, 45_000);

(chromeExecutablePath ? it : it.skip)('Tab reaches the skip link, then the bar in order; Hide banner hands focus on to the bar', async () => {
  await openShell();
  try {
    await desktop();
    const skip = await tabTo(() => true, 'the first stop');
    expect(skip.name).toBe('Skip to content');
    // The bar's stops in the order it draws them, after the sample strip's.
    const order: string[] = [];
    await tabTo((focus) => focus.name === 'claude-mem', 'the brand');
    for (let step = 0; step < PLACES.length + 2; step++) {
      await press('Tab');
      order.push((await focused()).name);
    }
    expect(order).toEqual([...PLACES, MEMORY, 'More']);
    // Hide banner: the strip leaves the page and focus goes on to the bar's first control.
    await tabTo((focus) => focus.name === 'Hide banner', 'Hide banner');
    await press('Enter');
    await waitFor('window.stripControls()?.length === 0', 'the strip to leave');
    const next = await focused();
    expect([next.name, next.inBar]).toEqual(['claude-mem', true]);
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
    await waitFor(`document.getElementById('all-requests')`, 'the loaded page');
    await waitFor(`document.activeElement?.id === 'main-content'`, 'focus on the main content');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('under reduced motion the sample strip changes at once and the bar stays put (plan rule 8)', async () => {
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
    // Every frame for 20 frames after the scroll (about 330ms, longer than the strip's 0.3s fade): the strip is shown
    // or gone, never in between, and the bar keeps its size at the top of the window.
    const scrolled = await page!.evaluate(`new Promise((resolve) => {
      const strip = document.querySelector('[data-slot="app-bar"]').previousElementSibling;
      const bar = document.querySelector('[data-slot="app-bar"]');
      const boxes = new Set(), opacities = new Set();
      let frames = 0;
      window.scrollTo(0, 1500);
      (function sample() {
        const box = bar.getBoundingClientRect();
        boxes.add([Math.round(box.width), Math.round(box.height)].join('x'));
        opacities.add(getComputedStyle(strip).opacity);
        if (++frames < 20) requestAnimationFrame(sample);
        else resolve({ boxes: [...boxes], opacities: [...opacities].sort(), top: Math.round(bar.getBoundingClientRect().top), pageWidth: document.documentElement.clientWidth });
      })();
    })`);
    const { pageWidth, ...seen } = scrolled;
    expect(seen).toEqual({ boxes: [`${pageWidth}x72`], opacities: ['0', '1'], top: 0 });
    await page!.send('Emulation.setEmulatedMedia', { features: [] });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

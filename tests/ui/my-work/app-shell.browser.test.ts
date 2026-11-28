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
import { THEME_CHOICES } from '../../../src/ui/my-work/src/lib/theme';
import { PAGE_FRAME } from '../../../src/ui/my-work/src/lib/page-frame';
import { FIND_RESULT_GROUPS } from '../../../src/ui/my-work/src/live/find-work';
import { WORK_VIEW_SECTIONS } from '../../../src/shared/work-view-pages';
import { MEMORY_PLACE, MY_WORK_PLACES } from '../../../src/ui/app-places';

failOnCiWithoutChrome('CI requires Chrome for the My Work shell regressions.');

/**
 * The app shell (My Work design pass, Phase 3: one look and one bar), on the real App with the sample source, the
 * app's real stylesheet, its Geist font and the pre-paint theme script the build puts in index.html:
 * - the bar: the brain mark, the five places in order (src/ui/app-places.ts), Find work, Memory and "…" (the Workspace
 *   page, design pass Phase 4); the active place is marked; a press moves to the place's page; nothing runs past the
 *   window at 1440 or at 768;
 * - the bar draws on the loading and failed screens too, its places, Find work, Memory and "…" working, and Try again
 *   keeps focus; "…" opens Workspace there, whose Theme and Language work while the work cannot be read;
 * - Workspace: one choice open at a time; G8: Theme there changes <html> and is saved, System follows the OS, setup
 *   stays light, and a `?theme=` address lasts the visit without being saved; no star count is asked of GitHub;
 * - Find work: Cmd K (Ctrl K) opens it from any page, typing finds focus areas, requests and rules in use, the arrow
 *   keys move, Enter opens the marked result, the words live in the address, and how many it found is read out; it
 *   works at 390px; Cmd K does nothing while a dialog is open, so a typed edit survives it;
 * - the failure line: one line under the title of the pages that showed the refresh banner, when the last review
 *   failed, and its Review details opens Machine and sync;
 * - phones: the places are the bottom bar, every bar control and Workspace row is at least 44px on a coarse pointer,
 *   the page is exactly 390 wide, the page ends above the pinned bottom bar, and no focused control sits under the bars;
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
    // No page of My Work asks GitHub for its star count since the design pass (Phase 4); any read is counted here and
    // answered without calling out.
    const realFetch = window.fetch.bind(window);
    window.githubStarReads = 0;
    window.fetch = (input, init) => String(input).startsWith('https://api.github.com/')
      ? (window.githubStarReads++, Promise.resolve(new Response(JSON.stringify({ stargazers_count: 117482 }), { headers: { 'Content-Type': 'application/json' } })))
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
    // \`&requests=many\`: every model carries 60 more requests named "Zebracopy <n>", so Find work pages them 50 at a
    // time (LINE_ROWS_PER_PAGE) and offers "Show 10 more".
    if (new URLSearchParams(location.search).get('requests') === 'many') {
      const withMoreRequests = (model) => ({ ...model, requests: [...model.requests, ...Array.from({ length: 60 }, (_, index) =>
        ({ ...model.requests[0], id: 'zebracopy-' + (index + 1), title: 'Zebracopy ' + (index + 1), summary: null }))] });
      const startWorkSource = useStore.getState().startWorkSource;
      useStore.setState({ startWorkSource: (source) => {
        const more = Object.create(source);
        more.loadWorkModel = () => source.loadWorkModel().then(withMoreRequests);
        more.subscribeToLiveUpdates = (onModel, onConnection) => source.subscribeToLiveUpdates((model) => onModel(withMoreRequests(model)), onConnection);
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
    // Tab from the top of the page. A blurred element stays the starting point of the next Tab, so the shell itself
    // takes focus first (not as a stop of its own: tabindex -1).
    window.focusPageStart = () => {
      const shell = document.querySelector('[data-slot="work-shell"]') ?? document.body;
      shell.tabIndex = -1;
      shell.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    };
    window.visibleIn = (selector) => [...document.querySelectorAll(selector)].filter(visible);
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
 * Tabs from the top of the page until `match` is focused. With sample data "…" is the 14th stop (skip link, the strip's
 * two switch items, Use my data, Hide banner, the brand, five places, Find work, Memory, Workspace); 16 leaves room
 * without letting a missed control tab through the whole page.
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
/** The bar after the places: Find work, Memory, and "…", named for the Workspace page it opens. */
const BAR_END = ['Find work', MEMORY, 'Workspace'];
const currentPlace = (controls: { name: string; current: string | null }[]) => controls.filter((control) => control.current === 'page').map((control) => control.name);

/** Presses a place in the top bar (or the bottom bar with `phone`) the way a person does: a plain left click. */
async function pressPlace(name: string, { phone = false } = {}) {
  await page!.evaluate(`[...document.querySelectorAll('[data-slot="${phone ? 'bottom-bar' : 'app-bar'}"] a[href]')].find((link) => link.textContent.trim() === ${JSON.stringify(name)}).click()`);
  await page!.settle();
}

(chromeExecutablePath ? it : it.skip)('the bar holds the brand, the five places in order, Find work, Memory and "…"; the place shown is marked and each press moves there', async () => {
  await openShell();
  try {
    await desktop();
    const controls: { name: string; height: number; current: string | null }[] = await page!.evaluate('window.headerControls()');
    expect(controls.map((control) => control.name)).toEqual(['claude-mem', ...PLACES, ...BAR_END]);
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
    // 768px: the five places, Find work's and Memory's marks still fit in the bar, and both keep their names for screen readers.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    expect((await page!.evaluate('window.headerControls()')).map((control: { name: string }) => control.name)).toEqual(['claude-mem', ...PLACES, ...BAR_END]);
    expect((await accessibleText(`document.querySelector('[data-slot="app-bar"] a[href="${MEMORY_PLACE.address}"]')`)).name).toBe(MEMORY);
    expect((await accessibleText(`document.querySelector('[data-slot="app-bar"] a[aria-keyshortcuts]')`)).name).toBe('Find work');
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 768)).toMatchObject(FITS_THE_WINDOW);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.7–1.9s here (2026-11-28, three runs); 30s for a slow CI runner.
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
    expect(controls.map((control: { name: string }) => control.name)).toEqual(['claude-mem', ...PLACES, ...BAR_END]);
    expect(currentPlace(controls)).toEqual(['My Work']);
    expect(await page!.evaluate(`[document.querySelector('main h1').textContent, document.querySelector('main [role="status"]').textContent]`)).toEqual(['My Work', 'Reading local work…']);
    // The placeholders sit in the page's content area only.
    expect(await page!.evaluate(`document.querySelectorAll('[data-slot="skeleton"]').length > 0 && [...document.querySelectorAll('[data-slot="skeleton"]')].every((shape) => shape.closest('main'))`)).toBe(true);
    // A place pressed while the work is read: the address and the bar move, and the screen keeps reading.
    await pressPlace('My Rules');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'rules' && document.querySelector('main h1')?.textContent === 'My Rules'`, 'My Rules while reading');
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['My Rules']);
    expect(await page!.evaluate(`!!document.querySelector('main [aria-busy="true"]')`)).toBe(true);
    // "…" opens Workspace there (it reads no work model): its rows, in place of the reading screen, while the read goes on.
    await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[aria-label="Workspace"]').click()`);
    await waitFor(`new URLSearchParams(location.search).get('view') === 'workspace' && document.querySelector('main h1')?.textContent === 'Workspace' && document.querySelector('[data-workspace-row]')`, 'Workspace while reading');
    expect(await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[aria-label="Workspace"]').getAttribute('aria-current')`)).toBe('page');
    expect(await page!.evaluate(`!!document.querySelector('main [aria-busy="true"]')`)).toBe(false);
    // A page that needs the work goes back to the reading screen.
    await pressPlace('My Rules');
    await waitFor(`document.querySelector('main h1')?.textContent === 'My Rules' && document.querySelector('main [aria-busy="true"]')`, 'My Rules reading again');
    // Requests is headed while it reads as it is once read: by its status tab, or by its grouping.
    await page!.evaluate(`window.store.getState().showRequests({ status: 'idle' })`);
    await waitFor(`document.querySelector('main h1')?.textContent === 'Idle requests' && document.querySelector('main [aria-busy="true"]')`, 'Idle requests while reading');
    await page!.evaluate(`window.store.getState().showRequests({ by: 'agent' })`);
    await waitFor(`document.querySelector('main h1')?.textContent === 'Requests by agent' && document.querySelector('main [aria-busy="true"]')`, 'Requests by agent while reading');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the failed screen keeps the bar, names what did not answer and offers Try again, Memory and the technical details', async () => {
  await openShell({ query: '&fail-reads=1' });
  try {
    await desktop();
    expect((await page!.evaluate('window.headerControls()')).map((control: { name: string }) => control.name)).toEqual(['claude-mem', ...PLACES, ...BAR_END]);
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

/** Workspace's rows as the page draws them: each row's words (title, quiet line, value), and whether it is open. */
const WORKSPACE_ROWS = `[...document.querySelectorAll('main [data-workspace-row] > button, main a[href].rounded-none')].map((row) => ({ title: row.querySelector('.text-row-title').textContent, name: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60), expanded: row.getAttribute('aria-expanded'), height: row.offsetHeight }))`;
/** Opens Workspace from the bar's "…", the way a person does. */
async function openWorkspace() {
  await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[aria-label="Workspace"]').click()`);
  await waitFor(`new URLSearchParams(location.search).get('view') === 'workspace' && document.querySelector('[data-workspace-row]')`, 'Workspace');
}
/** A Workspace row that opens its choice under itself, found by the words it starts with. */
const workspaceRow = (words: string) => `[...document.querySelectorAll('main [data-workspace-row] > button')].find((button) => button.textContent.trim().startsWith(${JSON.stringify(words)}))`;
/** Opens one of Workspace's choices by its row and presses one of its options (a toggle), by its words or its lang. */
async function chooseInWorkspace(row: string, option: string) {
  if (await page!.evaluate(`${workspaceRow(row)}.getAttribute('aria-expanded')`) !== 'true') await page!.evaluate(`${workspaceRow(row)}.click()`);
  await waitFor(`${workspaceRow(row)}.getAttribute('aria-expanded') === 'true'`, `the ${row} choice open`);
  await page!.evaluate(`[...document.getElementById(${workspaceRow(row)}.getAttribute('aria-controls')).querySelectorAll('[role="radio"]')].find((item) => item.textContent.trim() === ${JSON.stringify(option)} || item.getAttribute('lang') === ${JSON.stringify(option)}).click()`);
  await page!.settle();
}

(chromeExecutablePath ? it : it.skip)('while the work cannot be read, "…" opens Workspace, and its Theme and Language work there', async () => {
  await openShell({ query: '&fail-reads=1' });
  try {
    await desktop();
    expect(await page!.evaluate(`document.querySelector('main [role="alert"] h2')?.textContent ?? null`)).toBe('Local work couldn’t load');
    await openWorkspace();
    // Workspace, in place of the failed screen, every row there. Machine and sync's quiet line names no feed state,
    // since no feed was read: the fixture's source is the sample, so it says that, as Machine and sync does.
    expect(await page!.evaluate(`[document.querySelector('main h1').textContent, !!document.querySelector('main [role="alert"]')]`)).toEqual(['Workspace', false]);
    const rows: { title: string; name: string }[] = await page!.evaluate(WORKSPACE_ROWS);
    expect(rows.map((row) => row.title)).toEqual(['Theme', 'Language', 'Focus area artwork', 'Machine and sync', 'Memory viewer', 'Memory settings', 'Team view', 'Help and feedback', 'Developer options']);
    expect(rows.find((row) => row.title === 'Machine and sync')?.name).toBe('Machine and sync Sample data · not your work');
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chooseInWorkspace('Theme', 'Dark mode');
    expect(await page!.evaluate('[window.isDark(), window.savedTheme()]')).toEqual([true, 'dark']);
    await chooseInWorkspace('Language', 'fr');
    await waitFor(`document.documentElement.lang === 'fr' && document.querySelector('main h1')?.textContent === 'Espace de travail'`, 'Workspace in French');
    // Another page goes back to the failed screen, in the language and theme just chosen.
    await pressPlace('Mes règles');
    await waitFor(`document.querySelector('main [role="alert"]')`, 'the failed screen again');
    expect(await page!.evaluate('window.isDark()')).toBe(true);
    await page!.evaluate(`window.setLocale('en')`);
    await page!.send('Emulation.setEmulatedMedia', { features: [] });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.2–1.4s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('"…" opens Workspace: its sections and rows, one choice open at a time, and no star count asked of GitHub', async () => {
  await openShell();
  try {
    await desktop();
    const trigger = await tabTo((focus) => focus.name === 'Workspace', 'the "…" link');
    expect(trigger.inBar).toBe(true);
    await press('Enter');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'workspace' && document.querySelector('[data-workspace-row]')`, 'Workspace from "…"');
    expect(await page!.evaluate(`[document.querySelector('main h1').textContent, ...[...document.querySelectorAll('main h2')].map((heading) => heading.textContent)]`))
      .toEqual(['Workspace', 'Appearance', 'This computer', 'Tools and support']);
    // "…" is marked while Workspace is shown; no place is.
    expect(currentPlace(await page!.evaluate('window.headerControls()'))).toEqual(['Workspace']);
    const rows: { title: string; name: string; expanded: string | null; height: number }[] = await page!.evaluate(WORKSPACE_ROWS);
    expect(rows.map((row) => row.title)).toEqual(['Theme', 'Language', 'Focus area artwork', 'Machine and sync', 'Memory viewer', 'Memory settings', 'Team view', 'Help and feedback', 'Developer options']);
    // A choice says its value on its row: the theme in use (System, from the OS) and the language.
    expect(rows.slice(0, 2).map((row) => row.name)).toEqual(['Theme System', 'Language English']);
    // This computer's rows go somewhere: Machine and sync in the page, and Memory's own pages.
    expect(await page!.evaluate(`[...document.querySelectorAll('main a[href].rounded-none')].map((link) => { const url = new URL(link.href); url.searchParams.delete('source'); return url.pathname + url.search + url.hash; })`))
      .toEqual(['/?view=machine', '/viewer', '/viewer#/settings']);
    // Account & billing is for the cloud viewer only; the star count and the team plan promotion left with the menu.
    expect(rows.some((row) => row.name.startsWith('Account & billing'))).toBe(false);
    expect(await page!.evaluate(`document.querySelectorAll('[data-star-count]').length`)).toBe(0);
    // Desktop rows are at least 40px (D b9 M 191); every choice starts closed.
    for (const row of rows) expect(row.height).toBeGreaterThanOrEqual(40);
    expect(rows.filter((row) => row.expanded === 'true')).toEqual([]);
    // A closed row names nothing it controls: its choice is drawn only while it is open.
    expect(await page!.evaluate(`[...document.querySelectorAll('main [data-workspace-row] > button')].filter((button) => button.hasAttribute('aria-controls')).length`)).toBe(0);
    // One choice open at a time: opening Language closes Theme, so every language and theme are never shown at once.
    await page!.evaluate(`${workspaceRow('Theme')}.focus()`);
    await press('Enter');
    await waitFor(`${workspaceRow('Theme')}.getAttribute('aria-expanded') === 'true'`, 'Theme open');
    expect(await page!.evaluate(`[...document.querySelectorAll('main [role="radio"]')].map((item) => item.dataset.themeChoice)`)).toEqual([...THEME_CHOICES]);
    await page!.evaluate(`${workspaceRow('Language')}.focus()`);
    await press('Enter');
    await waitFor(`${workspaceRow('Language')}.getAttribute('aria-expanded') === 'true' && ${workspaceRow('Theme')}.getAttribute('aria-expanded') === 'false'`, 'Language open and Theme closed');
    expect(await page!.evaluate(`[...document.querySelectorAll('main [role="radio"]')].map((item) => item.getAttribute('lang'))`)).toEqual(LOCALES);
    // The artwork choice moved here from the home page's board: the same saved preference.
    await chooseInWorkspace('Focus area artwork', 'Off');
    expect(await page!.evaluate(`window.store.getState().view.focusArtwork`)).toBe('off');
    expect(JSON.parse(await page!.evaluate(`localStorage.getItem('claude-mem:my-work:preferences')`)).state.focusArtwork).toBe('off');
    // Developer options opens its own switch.
    await page!.evaluate(`${workspaceRow('Developer options')}.click()`);
    await page!.evaluate(`document.getElementById(${workspaceRow('Developer options')}.getAttribute('aria-controls')).querySelector('[role="switch"]').click()`);
    await waitFor(`window.store.getState().view.showSpec === true`, 'spec IDs shown');
    await page!.evaluate(`window.store.getState().setShowSpec(false)`);
    // Help and feedback: the documentation, the feedback form and the repository, each another site.
    await page!.evaluate(`${workspaceRow('Help and feedback')}.click()`);
    await waitFor(`${workspaceRow('Help and feedback')}.getAttribute('aria-expanded') === 'true'`, 'Help and feedback open');
    expect(await page!.evaluate(`[...document.getElementById(${workspaceRow('Help and feedback')}.getAttribute('aria-controls')).querySelectorAll('a[href]')].map((link) => [link.textContent.trim(), link.target])`))
      .toEqual([['Documentation', '_blank'], ['Send feedback', '_blank'], ['claude-mem on GitHub', '_blank']]);
    expect(await page!.evaluate('window.githubStarReads')).toBe(0);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-27); 30s for a slow CI runner.
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
    // A choice on Workspace is the person's own: saved, and the address stops overriding it.
    await openWorkspace();
    expect(await page!.evaluate(`[...document.querySelectorAll('main [data-workspace-row] > button')].find((button) => button.textContent.trim().startsWith('Theme')).textContent`)).toContain('Dark mode');
    await chooseInWorkspace('Theme', 'Light mode');
    expect(await page!.evaluate('[window.isDark(), window.savedTheme(), new URL(location.href).searchParams.has("theme")]')).toEqual([false, 'light', false]);
    // ...and stop carrying it once it no longer sets the visit's theme (a new tab or a copied link would force dark).
    expect(new Set(await page!.evaluate(linkThemes))).toEqual(new Set([null]));
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-16); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('G8: Theme on Workspace changes the page and is saved; System follows the OS; setup stays light', async () => {
  await openShell();
  try {
    await desktop();
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await openWorkspace();
    const choose = (theme: string) => chooseInWorkspace('Theme', theme);
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
    // The top keeps the brand, Find work's mark and "…" (Workspace, which holds Memory); the places are the bottom bar.
    const controls: { name: string; height: number; width: number }[] = await page!.evaluate('window.headerControls()');
    expect(controls.map((control) => control.name)).toEqual(['claude-mem', 'Find work', 'Workspace']);
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
    // Workspace holds Memory on a phone, and every row there is 44px or more.
    await openWorkspace();
    const rows: { name: string; height: number }[] = await page!.evaluate(WORKSPACE_ROWS);
    expect(rows.some((row) => row.name.startsWith('Memory viewer'))).toBe(true);
    expect(rows.filter((row) => row.height < 44)).toEqual([]);
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    // Every language is a choice under its row, wholly on the screen (a side menu once opened 18px past the left edge
    // and cut the first letters of each name), each 44px or more.
    await page!.evaluate(`${workspaceRow('Language')}.click()`);
    await waitFor(`${workspaceRow('Language')}.getAttribute('aria-expanded') === 'true'`, 'the Language choice open');
    const languages: { lang: string; left: number; right: number; height: number }[] = await page!.evaluate(`[...document.querySelectorAll('main [role="radio"][lang]')]
      .map((row) => { const box = row.getBoundingClientRect(); return { lang: row.getAttribute('lang'), left: Math.floor(box.left), right: Math.ceil(box.right), height: box.height } })`);
    expect(languages.map((language) => language.lang)).toEqual(LOCALES);
    expect(languages.filter((language) => language.left < 0 || language.right > 390 || language.height < 44)).toEqual([]);
    await chooseInWorkspace('Language', 'pt-BR');
    await waitFor(`document.documentElement.lang === 'pt-BR' && document.querySelector('[data-slot="bottom-bar"][aria-label="Páginas"]')`, 'the navigation in Brazilian Portuguese');
    await page!.evaluate("window.setLocale('en')");
    await pressPlace('My Work', { phone: true });
    await waitFor(`!new URLSearchParams(location.search).get('view')`, 'home again');
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
    // The sample strip folds away as the page scrolls (hideOnScroll), and the browser's scroll anchoring may then move
    // the window by a pixel or two: the position the person left is wherever it settles.
    await waitFor('Math.abs(scrollY - 1200) <= 3', 'the home page scrolled');
    await page!.settle();
    const homeY: number = await page!.evaluate('scrollY');
    await pressPlace('My Rules');
    await waitFor(`document.querySelector('main h1')?.textContent === 'My Rules' && scrollY === 0`, 'My Rules from its top');
    await page!.evaluate('history.back()');
    await waitFor(`!new URLSearchParams(location.search).get('view') && document.getElementById('all-requests') && Math.abs(scrollY - ${homeY}) <= 1`, 'home where it was left again');
    // Focus areas opens at its board on the home page (until design pass Phase 7); the person scrolls on past it, goes
    // Back home, then Forward: Focus areas comes back where it was left, not at its board (the entry left by Back keeps
    // its own position). (Requests opened at its board too until it became a page of its own, Phase 5.)
    await pressPlace('Focus areas');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'focus' && Math.abs(document.getElementById('focus-areas').getBoundingClientRect().top - 82) <= 2`, 'Focus areas at its board');
    const atBoard: number = await page!.evaluate('Math.round(scrollY)');
    const past: number = await page!.evaluate(`Math.min(Math.round(scrollY) + 600, document.documentElement.scrollHeight - innerHeight)`);
    expect(past - atBoard).toBeGreaterThan(300);
    await page!.evaluate(`window.scrollTo(0, ${past})`);
    await waitFor(`Math.round(scrollY) === ${past}`, 'Focus areas scrolled past its board');
    await page!.evaluate('history.back()');
    await waitFor(`!new URLSearchParams(location.search).get('view') && Math.abs(scrollY - ${homeY}) <= 1`, 'home where it was left, after Back');
    await page!.evaluate('history.forward()');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'focus' && Math.abs(scrollY - ${past}) <= 1`, 'Focus areas where it was left, after Forward');
    // A reload opens that entry where it was left too, once the work has been read again, and stays there while the
    // page settles: the focus area board above it draws taller for a frame (about 3,300px, then 670px here), and the
    // browser's scroll anchoring moved the window up by that much until the app held it at the position.
    const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
    await page!.send('Page.reload', {});
    // The reload draws the whole App again in about a second here (2026-11-27); 20s is for a cold CI runner.
    await withTimeout(ready, 20_000, 'the shell did not draw again after the reload');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'focus' && Math.abs(scrollY - ${past}) <= 1`, 'Focus areas where it was left, after a reload');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 2–3s here (2026-11-27); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('on the cloud viewer, Account & billing is a named, translated row of Workspace; on this computer it is not there', async () => {
  await openShell({ hostname: CLOUD_HOSTNAME });
  try {
    await desktop();
    await openWorkspace();
    // The middle panel is the cloud viewer, as Machine and sync calls it there: the page reads no computer of yours.
    expect(await page!.evaluate(`[...document.querySelectorAll('main h2')].map((heading) => heading.textContent)`)).toEqual(['Appearance', 'Cloud viewer', 'Tools and support']);
    const row = `document.querySelector('main a[href="https://cmem.ai/account"]')`;
    expect((await accessibleText(row)).name).toBe('Account & billing');
    expect(await page!.evaluate(`${row}.offsetHeight`)).toBeGreaterThanOrEqual(40);
    // Rule 4: through t(), in the reader's language.
    await page!.evaluate("window.setLocale('fr')");
    await page!.settle();
    expect((await accessibleText(row)).name).toBe('Compte et facturation');
    await page!.evaluate("window.setLocale('en')");
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.1–1.3s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('the bar\'s places and Workspace\'s rows are named by their visible words in every language (label in name)', async () => {
  await openShell();
  try {
    await desktop();
    await openWorkspace();
    for (const locale of LOCALES) {
      await page!.evaluate(`window.setLocale(${JSON.stringify(locale)})`);
      await page!.settle();
      const places: number = await page!.evaluate(`document.querySelectorAll('[data-slot="app-bar"] nav a[href]').length`);
      expect(places).toBe(PLACES.length);
      for (let index = 0; index < places; index++) {
        const link = `document.querySelectorAll('[data-slot="app-bar"] nav a[href]')[${index}]`;
        expect({ locale, name: (await accessibleText(link)).name }).toEqual({ locale, name: await page!.evaluate(`${link}.textContent.trim()`) });
      }
      // Each Workspace row's name holds its visible title, whatever the language.
      const rows: number = await page!.evaluate(`document.querySelectorAll('main [data-workspace-row] > button, main a[href].rounded-none').length`);
      for (let index = 0; index < rows; index++) {
        const row = `document.querySelectorAll('main [data-workspace-row] > button, main a[href].rounded-none')[${index}]`;
        const title: string = await page!.evaluate(`${row}.querySelector('.text-row-title').textContent.trim()`);
        const { name } = await accessibleText(row);
        expect({ locale, title, contains: name.includes(title) }).toEqual({ locale, title, contains: true });
      }
    }
    await page!.evaluate("window.setLocale('en')");
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // About 3s here for seven languages (2026-11-27); 45s for a slow CI runner.
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
    for (let step = 0; step < PLACES.length + BAR_END.length; step++) {
      await press('Tab');
      order.push((await focused()).name);
    }
    expect(order).toEqual([...PLACES, ...BAR_END]);
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

/**
 * Presses the K key with Cmd (Meta, CDP modifier 4) or Ctrl (2), as a person opens Find work from the keyboard. `key`:
 * the character the layout gives that key ("л" on a Russian layout).
 */
async function pressFindShortcut(modifier: 'meta' | 'ctrl', key = 'k') {
  const modifiers = modifier === 'meta' ? 4 : 2;
  await page!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers });
  await page!.settle();
}
/** Find work's results as the list draws them: each group's heading words and its options, then the marked option. */
const FIND_RESULTS = `(() => {
  const groups = [...document.querySelectorAll('main [cmdk-group]')].map((group) => ({
    heading: group.querySelector('[cmdk-group-heading]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    options: [...group.querySelectorAll('[role="option"]')].map((option) => option.dataset.findResult ?? null),
  }));
  const selected = document.querySelector('main [role="option"][aria-selected="true"]');
  return { groups, selected: selected ? selected.dataset.value ?? selected.getAttribute('data-value') : null,
    activedescendant: document.querySelector('main [cmdk-input]').getAttribute('aria-activedescendant'), selectedId: selected?.id ?? null };
})()`;

(chromeExecutablePath ? it : it.skip)('Cmd K opens Find work from any page; typing finds focus areas, requests and rules in use; the arrows move and Enter opens the marked result', async () => {
  await openShell();
  try {
    await desktop();
    await pressPlace('My Rules');
    await waitFor(`document.querySelector('main h1')?.textContent === 'My Rules'`, 'My Rules');
    const entries: number = await page!.evaluate('history.length');
    await pressFindShortcut('meta');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'find' && document.activeElement?.hasAttribute('data-find-work-input')`, 'Find work open with its box focused');
    expect(await page!.evaluate(`[document.querySelector('main h1').textContent, document.querySelector('[data-slot="app-bar"] a[aria-label="Find work"]').getAttribute('aria-current')]`)).toEqual(['Find work', 'page']);
    // Nothing typed: one line saying what it finds, no results.
    expect(await page!.evaluate(`document.querySelectorAll('main [role="option"]').length`)).toBe(0);
    await page!.send('Input.insertText', { text: 'work' });
    await waitFor(`document.querySelectorAll('main [role="option"]').length > 0`, 'the results');
    const found = await page!.evaluate(FIND_RESULTS);
    // Grouped by what each opens, in the order FIND_RESULT_GROUPS gives, each heading with its own count; Memory's search last.
    expect(found.groups.map((group: { options: string[] }) => group.options[0])).toEqual([...FIND_RESULT_GROUPS, 'memory']);
    for (const group of found.groups.slice(0, 3)) {
      expect(group.options.length).toBeGreaterThan(0);
      expect(group.heading).toEndWith(`${group.options.length} ${group.options.length === 1 ? 'match' : 'matches'}`);
    }
    expect(found.groups.flatMap((group: { options: string[] }) => group.options).at(-1)).toBe('memory');
    // The words are in the address, written in place: Back leaves Find work, not one letter.
    expect(await page!.evaluate(`new URLSearchParams(location.search).get('q')`)).toBe('work');
    expect(await page!.evaluate('history.length')).toBe(entries + 1);
    // One status region, there from the start, says how many results the words found (Memory's row is not one).
    const results = found.groups.slice(0, FIND_RESULT_GROUPS.length).reduce((total: number, group: { options: string[] }) => total + group.options.filter((option) => option !== null).length, 0);
    expect(await page!.evaluate(`document.querySelector('main [data-find-heard]').textContent`)).toBe(`${results} results`);
    // The bar's Find work pressed on Find work keeps the words and the address, and puts the cursor back in the box.
    await page!.evaluate('document.activeElement.blur()');
    await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[aria-label="Find work"]').click()`);
    await waitFor(`document.activeElement?.hasAttribute('data-find-work-input')`, 'the box focused by the bar link');
    expect(await page!.evaluate(`[new URLSearchParams(location.search).get('q'), history.length]`)).toEqual(['work', entries + 1]);
    // The first result is marked, so Enter opens it; the arrows move the mark and the box says which (activedescendant:
    // cmdk names the marked result once the keyboard has moved it).
    expect(found.groups[0].options[0]).toBe('areas');
    expect(found.selectedId).toBe(await page!.evaluate(`document.querySelector('main [role="option"]').id`));
    const first = found.selectedId;
    await press('ArrowDown');
    const moved = await page!.evaluate(FIND_RESULTS);
    expect(moved.selectedId).not.toBe(first);
    expect(moved.activedescendant).toBe(moved.selectedId);
    await press('ArrowUp');
    const back = await page!.evaluate(FIND_RESULTS);
    expect([back.selectedId, back.activedescendant]).toEqual([first, first]);
    const firstArea: string = await page!.evaluate(`document.querySelector('main [role="option"][aria-selected="true"]').textContent`);
    await press('Enter');
    await waitFor(`new URLSearchParams(location.search).get('focus') && document.querySelector('[data-focus-header]')`, 'the first area opened');
    expect(firstArea).toContain(await page!.evaluate(`document.querySelector('[data-focus-header] h2').textContent`));
    // Back returns to Find work with the same words and results.
    await page!.evaluate('history.back()');
    await waitFor(`new URLSearchParams(location.search).get('view') === 'find' && document.querySelector('main [data-find-work-input]')?.value === 'work' && document.querySelectorAll('main [role="option"]').length > 0`, 'Find work again, with its words');
    // Ctrl K while Find work is open puts the cursor back in its box.
    await page!.evaluate('document.activeElement.blur()');
    await pressFindShortcut('ctrl');
    await waitFor(`document.activeElement?.hasAttribute('data-find-work-input')`, 'the box focused by Ctrl K');
    // The same key on a Russian layout (it types "л") is the same shortcut: the key is read by its place.
    await page!.evaluate('document.activeElement.blur()');
    await pressFindShortcut('ctrl', 'л');
    await waitFor(`document.activeElement?.hasAttribute('data-find-work-input')`, 'the box focused by Ctrl K on a Russian layout');
    // A rule in use opens My Rules at that rule, once its page has drawn it.
    const rule = `document.querySelector('main [role="option"][data-find-result="rules"]')`;
    const ruleId: string = await page!.evaluate(`${rule}.dataset.value ?? ${rule}.getAttribute('data-value')`);
    await page!.evaluate(`${rule}.click()`);
    await waitFor(`new URLSearchParams(location.search).get('view') === 'rules' && document.getElementById(${JSON.stringify(ruleId.replace('rule:', 'rule-'))})`, 'My Rules with the rule');
    await waitFor(`(() => { const box = document.getElementById(${JSON.stringify(ruleId.replace('rule:', 'rule-'))}).getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; })()`, 'the rule in view');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.6–1.7s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('on a touch phone, Find work\'s mark in the bar opens it; results fit the 390px page, each 44px or more, and a request opens over it', async () => {
  await openShell();
  try {
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page!.settle();
    await page!.evaluate(`document.querySelector('[data-slot="app-bar"] a[aria-label="Find work"]').click()`);
    await waitFor(`new URLSearchParams(location.search).get('view') === 'find' && document.querySelector('main [data-find-work-input]')`, 'Find work');
    await page!.evaluate(`document.querySelector('main [data-find-work-input]').focus()`);
    await page!.send('Input.insertText', { text: 'work' });
    await waitFor(`document.querySelectorAll('main [role="option"]').length > 0`, 'the results');
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    const small = await page!.evaluate(`[...document.querySelectorAll('main [role="option"]')].map((option) => ({ name: option.textContent.trim().slice(0, 30), height: option.getBoundingClientRect().height })).filter((option) => option.height < 44)`);
    expect(small).toEqual([]);
    // A request opens over Find work: its drawer, with the words kept in the address for the way back.
    await page!.evaluate(`document.querySelector('main [role="option"][data-find-result="requests"]').click()`);
    await waitFor(`new URLSearchParams(location.search).get('request') && new URLSearchParams(location.search).get('q') === 'work'`, 'the request opened over Find work');
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1–2s here (2026-11-28); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('Find work\'s "Show 10 more" marks the first request it added, so the arrows and Enter carry on from there (G4)', async () => {
  await openShell({ query: '&requests=many' });
  try {
    await desktop();
    await pressFindShortcut('meta');
    await waitFor(`document.activeElement?.hasAttribute('data-find-work-input')`, 'Find work with its box focused');
    await page!.send('Input.insertText', { text: 'zebracopy' });
    const more = `document.querySelector('main [role="option"][data-value="requests:more"]')`;
    await waitFor(more, 'Show more');
    expect(await page!.evaluate(`[document.querySelectorAll('main [role="option"][data-find-result="requests"]').length, ${more}.textContent.trim()]`)).toEqual([50, 'Show 10 more · 10 left']);
    await page!.evaluate(`${more}.click()`);
    await waitFor(`document.querySelectorAll('main [role="option"][data-find-result="requests"]').length === 60`, 'the ten added requests');
    await page!.settle();
    const marked = `document.querySelector('main [role="option"][aria-selected="true"]')?.dataset.value ?? null`;
    expect(await page!.evaluate(marked)).toBe('request:zebracopy-51');
    // The cursor stays in the box, and the arrows go on from the first added request.
    expect(await page!.evaluate(`document.activeElement?.hasAttribute('data-find-work-input')`)).toBe(true);
    await press('ArrowDown');
    expect(await page!.evaluate(marked)).toBe('request:zebracopy-52');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.5–1.6s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('Cmd K does nothing while a dialog is open: the edit typed in a focus area\'s Rename dialog stays', async () => {
  await openShell();
  try {
    await desktop();
    await page!.evaluate(`window.store.getState().goToFocus(window.store.getState().work.load.model.focusAreas.find((area) => area.status === 'kept').id)`);
    await waitFor(`document.querySelector('[data-focus-header] button[aria-label^="Change "]')`, 'a focus area page');
    // Rename, from the area's menu, by the keyboard.
    await page!.evaluate(`document.querySelector('[data-focus-header] button[aria-label^="Change "]').focus()`);
    await press('Enter');
    await waitFor(`document.querySelector('[role="menu"]')`, 'the area menu');
    await page!.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === 'Rename').focus()`);
    await press('Enter');
    await waitFor(`document.querySelector('[role="dialog"] input')`, 'the Rename dialog');
    await page!.evaluate(`document.querySelector('[role="dialog"] input').focus()`);
    await page!.send('Input.insertText', { text: ' typed' });
    const typed: string = await page!.evaluate(`document.querySelector('[role="dialog"] input').value`);
    expect(typed).toEndWith(' typed');
    const address: string = await page!.evaluate('location.href');
    await pressFindShortcut('meta');
    await pressFindShortcut('ctrl');
    expect(await page!.evaluate(`[location.href, document.querySelector('[role="dialog"] input')?.value ?? null, document.activeElement === document.querySelector('[role="dialog"] input')]`))
      .toEqual([address, typed, true]);
    expect(await page!.evaluate(`document.querySelectorAll('[role="dialog"][data-state="open"]').length`)).toBe(1);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.1–1.3s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('a failed review is one line under the title of each page that showed the refresh banner, and Review details opens Machine and sync', async () => {
  await openShell({ query: `&sample-state=refresh-failed` });
  try {
    await desktop();
    const lineUnderTitle = `document.querySelector('main h1 + [data-review-failed-line]')`;
    // Every page, from the one page list, split by the frame each page is drawn in (lib/page-frame.ts).
    for (const section of WORK_VIEW_SECTIONS.filter((page) => PAGE_FRAME[page].reviewLine)) {
      await page!.evaluate(`window.store.getState().goToPage(${JSON.stringify(section)})`);
      await waitFor(lineUnderTitle, `the failure line on ${section}`);
      expect({ section, lines: await page!.evaluate(`document.querySelectorAll('[data-review-failed-line]').length`) }).toEqual({ section, lines: 1 });
    }
    // A focus area's page names it in its own header, so the line sits under the area's name there.
    await page!.evaluate(`window.store.getState().goToFocus(window.store.getState().work.load.model.focusAreas.find((area) => area.status === 'kept').id)`);
    await waitFor(`document.querySelector('[data-focus-header] [data-review-failed-line]')`, 'the failure line in the area header');
    expect(await page!.evaluate(`document.querySelectorAll('[data-review-failed-line]').length`)).toBe(1);
    // Not on pages that never had the banner, nor on Machine and sync, which shows the review itself.
    for (const section of WORK_VIEW_SECTIONS.filter((page) => !PAGE_FRAME[page].reviewLine)) {
      await page!.evaluate(`window.store.getState().goToPage(${JSON.stringify(section)})`);
      await waitFor(`new URLSearchParams(location.search).get('view') === ${JSON.stringify(section)} && document.querySelector('main h1')`, section);
      await page!.settle();
      expect({ section, lines: await page!.evaluate(`document.querySelectorAll('[data-review-failed-line]').length`) }).toEqual({ section, lines: 0 });
    }
    await page!.evaluate(`window.store.getState().goToPage('work')`);
    await waitFor(lineUnderTitle, 'the failure line on Home again');
    const line: string = await page!.evaluate(`${lineUnderTitle}.innerText`);
    // The failure was on screen when the line was drawn: page text, not news.
    expect(await page!.evaluate(`${lineUnderTitle}.getAttribute('role')`)).toBe('status');
    expect(line).toContain('Review failed at');
    expect(line).toContain('Last reviewed at');
    await page!.evaluate(`[...${lineUnderTitle}.querySelectorAll('a[href]')].find((link) => link.textContent.trim() === 'Review details').click()`);
    await waitFor(`new URLSearchParams(location.search).get('view') === 'machine' && document.querySelector('[data-focus-review=failed]')`, 'Machine and sync with the failed review');
    expect(await page!.evaluate(`[document.querySelectorAll('[data-review-failed-line]').length, document.querySelector('main nav[aria-label="Breadcrumb"] a')?.textContent ?? null]`)).toEqual([0, 'Workspace']);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 1.3–1.4s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('a review that fails while the page is open is announced: its failure line is an alert', async () => {
  await openShell();
  try {
    await desktop();
    await waitFor(`document.querySelector('main h1')?.textContent === 'My Work'`, 'Home');
    expect(await page!.evaluate(`document.querySelectorAll('[data-review-failed-line]').length`)).toBe(0);
    // The worker's record turns failed while Home is open, as refresh.json does when a review fails.
    await page!.evaluate(`window.store.setState((state) => ({ work: { ...state.work, load: { ...state.work.load, model: { ...state.work.load.model,
      refresh: { state: 'failed', finishedAt: 'Nov 28 at 2:40 am', finishedAtIso: '2026-11-28T10:40:00.000Z', error: 'a new cause' } } } } }))`);
    await waitFor(`document.querySelector('main h1 + [data-review-failed-line]')`, 'the failure line');
    expect(await page!.evaluate(`document.querySelector('main h1 + [data-review-failed-line]').getAttribute('role')`)).toBe('alert');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 0.9s here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

(chromeExecutablePath ? it : it.skip)('Machine and sync\'s Focus review says when the goals run last finished, and when its result could not be read, what failed', async () => {
  const goalsRun = `document.querySelector('main [data-goals-run]')`;
  await openShell();
  try {
    await desktop();
    await page!.evaluate(`window.store.getState().goToPage('machine')`);
    await waitFor(goalsRun, 'the goals run on Machine and sync');
    expect(await page!.evaluate(`[${goalsRun}.dataset.goalsRun, ${goalsRun}.innerText.replace(/\\s+/g, ' ').trim()]`))
      .toEqual(['read', 'Last goals run Today, 11:02 am Suggested and Past focus come from it. Ran on MacBook Pro.']);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  await openShell({ query: '&sample-state=months-unreadable' });
  try {
    await desktop();
    await page!.evaluate(`window.store.getState().goToPage('machine')`);
    await waitFor(goalsRun, 'the goals run on Machine and sync');
    expect(await page!.evaluate(`[${goalsRun}.dataset.goalsRun, ${goalsRun}.querySelector('p').textContent]`)).toEqual(['unreadable', 'The last goals run could not be read.']);
    // What failed is one press away, folded (G17).
    expect(await page!.evaluate(`${goalsRun}.innerText.includes('owner-goals/2026-10-18')`)).toBe(false);
    await page!.evaluate(`[...${goalsRun}.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Technical details').click()`);
    await waitFor(`${goalsRun}.innerText.includes('owner-goals/2026-10-18 is unreadable')`, 'the cause under Technical details');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeShell(); }
  // 2.3–2.4s for its two Chromes here (2026-11-28, three runs); 30s for a slow CI runner.
}, 30_000);

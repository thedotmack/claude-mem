import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  FITS_THE_WINDOW, PAGE_WIDTHS, REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, myWorkFontResponse, pageFitsTheWindow, pinnedClockFor, scriptResponse, SCROLLBAR_MODES, scrollbarStyleFor, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { THEME_PRE_PAINT_SCRIPT } from '../../../src/ui/my-work/src/lib/theme-pre-paint';
import { SAMPLE_STATES, type SampleState } from '../../../src/ui/my-work/src/live/sample-source';
import { myWorkPlace } from '../../../src/ui/app-places';

failOnCiWithoutChrome('CI requires Chrome for the My Work focus area page regressions.');

/**
 * Phase 6 of the pro-max-v16 plan (a focus area page, page-03, and Other, page-04) on the real App, its compiled
 * stylesheet and its Geist font, with the sample data:
 * - the request that needs you is the main card, the first block under the header, with its reply card inside, and the
 *   first screen has one solid orange button (G1, G2);
 * - the area menu: a 44px "…", rows under small labels, Move up and Move down saying "N of M" in the saved order, Mark
 *   done last with where it goes and its Undo; the change bar's saved row (outlined Undo) and failed row (Try again);
 * - the area dialogs: Save says what it saves, beside Cancel, and waits with a reason (Merge until an area is chosen);
 * - sharing: the dialog's two columns, the comment count on the shared mark, the labelled comment box in the dialog's
 *   one scroll, and a failed comments read in plain words with Try again;
 * - Other shows every ask nobody has started, each with "Copy as prompt"; both pages fit a 390px phone;
 * - handed over by earlier phases: Past focus's done date (the moment it was marked done), the mapper's placeholders and
 *   a rule's missing time in another language, card heights in one row, the drawer's focus return to a row that moved
 *   group, at most two moving things on home after a live change, the List title's room before its area link (and a
 *   request not sorted yet cut there with an ellipsis), By agent's next step on as many lines as it needs, read errors'
 *   Try again focus, and My Rules' copy with no clipboard.
 * Each width-sensitive check runs with no scrollbar and with a classic 15px one (SCROLLBAR_MODES). A check of
 * fixed instants' words pins the page's clock (PINNED_NOW), so it reads the same on any run date.
 * Nothing here reaches a worker: every change is the sample's, kept in the page (plan rule: write only in sample mode).
 */
const sampleState = (name: SampleState) => {
  if (!SAMPLE_STATES.includes(name)) throw new Error(`No sample state ${name} in SAMPLE_STATES`);
  return `&sample-state=${name}`;
};

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27, text: undefined },
} as const;

let server: ReturnType<typeof Bun.serve> | undefined;
let fixtureUrl = '';
let markReady: () => void = () => {};
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // The application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import App from './src/ui/my-work/src/App';
    import { useStore } from './src/ui/my-work/src/store';
    import { setLocale } from './src/ui/my-work/src/lib/i18n';
    window.React = React;
    const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
    // The star count would come from GitHub; a test never calls out.
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).startsWith('https://api.github.com/')
      ? Promise.resolve(new Response(JSON.stringify({ stargazers_count: 1 }), { headers: { 'Content-Type': 'application/json' } }))
      : realFetch(input, init);
    window.store = useStore;
    window.setLocale = setLocale;
    // What the page warns about, as text (a failed read the screen has no room to explain says it here).
    window.warnings = [];
    const warn = console.warn.bind(console);
    console.warn = (...args) => { window.warnings.push(args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(' ')); warn(...args); };
    // Every focus save the page sends, by its action, from now on (the sample answers it in the page).
    window.countSaves = () => {
      const send = useStore.getState().saveFocusChange;
      window.saves = [];
      useStore.setState({ saveFocusChange: (change) => { window.saves.push(change.action); return send(change); } });
    };
    // The sample's timed demo (its working request finishes 7s in) is held still: each test makes the changes it reads.
    useStore.setState({ playSampleDemo: () => () => {} });
    // The clipboard the page writes to: copies are kept here; \`clipboardRefuses\` refuses the next ones as a browser
    // does, and \`noClipboard\` takes navigator.clipboard away, as a page that is not a secure context has it.
    window.copies = [];
    window.clipboardRefuses = null;
    window.noClipboard = false;
    const clipboard = { writeText: async (text) => { if (window.clipboardRefuses) throw new Error(window.clipboardRefuses); window.copies.push(text); } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => (window.noClipboard ? undefined : clipboard) });
    createRoot(document.getElementById('root')).render(<App />);
    (function waitForPage() {
      const main = document.querySelector('[data-slot="work-shell"] main');
      if (main && main.innerText.trim()) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForPage);
    })();
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    window.visible = visible;
    window.nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    // Marks the first visible element \`selector\` finds whose name matches \`pattern\`, for a real press on it.
    window.markNamed = (selector, pattern) => {
      for (const old of document.querySelectorAll('[data-test-target]')) old.removeAttribute('data-test-target');
      const element = [...document.querySelectorAll(selector)].find((each) => visible(each) && new RegExp(pattern).test(window.nameOf(each)));
      if (!element) return false;
      element.setAttribute('data-test-target', '');
      return true;
    };
    // The solid orange buttons on the first screen (G1: one per decision unit), as the home page's test counts them.
    window.orangeOnFirstScreen = () => [...document.querySelectorAll('[data-slot="button"][data-variant="default"]')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.width > 0 && rect.height > 0;
    }).map((button) => window.nameOf(button));
    // Every solid orange button on the page, below the first screen too.
    window.orangeOnPage = () => [...document.querySelectorAll('[data-slot="work-shell"] [data-slot="button"][data-variant="default"]')].filter(visible)
      .map((button) => ({ name: window.nameOf(button), top: Math.round(button.getBoundingClientRect().top), inMainCard: !!button.closest('section[data-main-card]') }));
    // A model from the live feed, as the store receives one (the change ticker and "just updated" read its changes).
    window.receive = (change) => { const state = useStore.getState(); state.receiveWorkModel(change(state.work.load.model)); };
    window.model = () => useStore.getState().work.load.model;
    // Reads \`measure\` once a frame for \`ms\` and answers every reading.
    window.sampleFrames = (ms, measure) => new Promise((resolve) => {
      const readings = [];
      const until = performance.now() + ms;
      (function frame() { readings.push(measure()); if (performance.now() < until) requestAnimationFrame(frame); else resolve(readings); })();
    });
    // What moves on the page (rule 8 counts things, not animations): every running Web Animation, CSS animation and
    // transition in the main column, and every element whose inline transform changed since the frame before, grouped
    // by what it moves: the ticker, a badge's riffle, or the request it moves (the one whose card, row or line is
    // around the element, or the one inside it, as a board cell holds its card), else that one element. So each moving
    // element is counted apart unless it moves a part of the same thing: it named every element outside a card or row
    // by its tag, and HEAD's glide of four board cells read as one thing, "DIV" (Phase 6 re-verify V2). A thing is
    // counted once a frame however many of its own parts move. A steady indicator that turns as long as it shows (a
    // working request's spinner, an endless animation) is there before a change and after it, so it is not what a
    // change moves; nor is an instant change, which reduced motion makes of every transition (index.css sets 0.01ms)
    // and no one sees move. Answers the things of each frame; \`detail\` adds the property and element to each.
    window.movingThingsOver = (ms, detail = false) => {
      const scope = document.querySelector('[data-slot="work-shell"] main');
      // An element named apart has its own number: one in no request's block, or in a block of several requests.
      const elementNumbers = new WeakMap();
      let elementsNumbered = 0;
      const numberedName = (element) => { if (!elementNumbers.has(element)) elementNumbers.set(element, ++elementsNumbered); return element.tagName + '#' + elementNumbers.get(element); };
      // A request's own block: its card, the area page's main card, its List or board row, its one-line row.
      const ownBlock = (element) => element.closest('[data-slot="card"], [data-main-card], [data-list-row], [data-request-row], [data-request-line]') ?? element;
      const requestIdsIn = (element) => new Set([...(element.matches('[data-request-opener]') ? [element] : []), ...element.querySelectorAll('[data-request-opener]')].map((opener) => opener.dataset.requestOpener));
      const thing = (element, how) => {
        if (element.closest('[data-ticker]')) return 'ticker';
        const own = ownBlock(element);
        const requests = requestIdsIn(own);
        const name = requests.size === 1 ? [...requests][0] : numberedName(own);
        return (element.closest('[data-state-badge]') ? 'riffle: ' : 'moving: ') + name + (detail ? ' (' + how + ' ' + element.tagName + '.' + String(element.className).slice(0, 50) + ')' : '');
      };
      const lastTransform = new WeakMap();
      return window.sampleFrames(ms, () => {
        const things = new Set();
        for (const animation of document.getAnimations()) {
          const target = animation.effect?.target;
          const timing = animation.effect?.getComputedTiming();
          const steady = timing?.iterations === Infinity;
          const instant = (timing?.activeDuration ?? 0) <= 1;
          if (animation.playState === 'running' && !steady && !instant && target && scope.contains(target)) things.add(thing(target, 'animation ' + (animation.transitionProperty ?? animation.animationName ?? '')));
        }
        for (const element of scope.querySelectorAll('[style*="transform"]')) {
          const transform = element.style.transform;
          if (lastTransform.has(element) && lastTransform.get(element) !== transform) things.add(thing(element, 'transform'));
          lastTransform.set(element, transform);
        }
        return [...things];
      });
    };
    // Sets a text field as typing does, so React reads the new value.
    window.typeInto = (field, value) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set;
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const round = (value) => Math.round(value * 100) / 100;
    window.round = round;
    window.boxOf = (element) => { const box = element.getBoundingClientRect(); return { left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) }; };
    // Whether a text cut with an ellipsis shows the whole ellipsis. Chrome keeps a cut line's first letter (CSS Overflow 3
    // clips the first character rather than replace it) and draws the ellipsis after it, so the text's box must hold that
    // letter and the ellipsis; at the List's 2rem floor it did not, and the ellipsis showed one dot, "V." (Phase 6 fix 2).
    // Both in the element's own font: its first letter as drawn, and an ellipsis in a hidden copy of the element.
    window.ellipsisRoom = (element) => {
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('ellipsisRoom needs an element whose first child is its text');
      const letter = document.createRange();
      letter.setStart(text, 0);
      letter.setEnd(text, [...text.data][0].length);
      const probe = element.cloneNode(false);
      probe.textContent = '…';
      probe.style.cssText = 'position: absolute; visibility: hidden; width: auto; max-width: none; overflow: visible';
      element.parentElement.append(probe);
      const ellipsis = probe.getBoundingClientRect().width;
      probe.remove();
      const box = element.getBoundingClientRect().width;
      const letterWidth = letter.getBoundingClientRect().width;
      // 0.5px for subpixel rounding: a clipped ellipsis loses at least a dot, wider than that.
      return { box: round(box), letter: round(letterWidth), ellipsis: round(ellipsis), whole: box + 0.5 >= letterWidth + ellipsis };
    };
  `, ['--loader:.webp=empty', '--loader:.css=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty']);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(`<!doctype html>${pinnedClockFor(request.url)}<meta name="viewport" content="width=device-width,initial-scale=1"><script>${THEME_PRE_PAINT_SCRIPT}</script>${scrollbarStyleFor(request.url)}<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    const font = myWorkFontResponse(path);
    if (font) return font;
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (path === '/fixture-error') { fixtureErrors.push(await request.text()); return new Response('noted'); }
    return new Response('not found', { status: 404 });
  } });
  fixtureUrl = `${server.url.href}?source=sample`;
});

afterAll(async () => {
  await closePage();
  server?.stop(true);
});

/**
 * Each test gets its own Chrome on the one compiled fixture, opened at `query` and sized before it reads anything.
 * `reducedMotion`: Chrome starts with the reduced-motion preference, so the page mounts under it, as a person's does.
 */
async function openPage(query: string, viewport: { width: number; height: number; touch?: boolean } = { width: 1440, height: 900 }, { reducedMotion = false } = {}) {
  fixtureErrors.length = 0;
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${fixtureUrl}${query}`;
  // A fixed zone, so a date reads the same on every machine (CI runs in UTC), set on a blank page before the fixture
  // draws: set after its first draw, the dates drawn first kept the machine's zone and a later redraw wrote Los
  // Angeles's (PR #6210 CI, 2026-11-17: Past focus's done date read "4:05:00 PM UTC", then "PDT" after a rename).
  chrome = launchChrome('about:blank', { profilePrefix: 'claude-mem-focus-page-', remoteDebugging: true, extraFlags: [...UNTHROTTLED_TIMER_FLAGS, ...(reducedMotion ? ['--force-prefers-reduced-motion'] : [])] });
  page = await connectToPage(chrome, 'about:blank');
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
  await page.send('Page.navigate', { url });
  // The App with sample data drew its first page in 1.0–2.0s in board-views.browser.test.ts (2026-11-16); 20s is for
  // a cold Chrome on a CI runner.
  await withTimeout(ready, 20_000, 'My Work fixture did not draw its page');
  await resize(viewport.width, viewport.height, viewport.touch);
  await page.settle();
}

async function resize(width: number, height = 900, touch = false) {
  await page!.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
  await page!.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await page!.settle();
}

async function closePage() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Waits until `expression` is truthy. Every wait here is a frame or two of React work, a dialog's 100–200ms fade, or a lazy page chunk. */
async function waitFor(expression: string, what: string) {
  // React commits within one or two frames and the page chunks are in the one bundle; 5s is for a cold CI runner.
  await withTimeout(page!.evaluate(`new Promise((resolve) => { const check = () => (${expression}) ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, `timed out waiting for ${what}`);
}

async function press(key: keyof typeof KEYS) {
  const { code, keyCode, text } = KEYS[key];
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page!.settle();
}

/** A real press (pointer down and up at its middle) on the first visible element `selector` finds named `pattern`. */
async function pressNamed(selector: string, pattern: string) {
  const found = await page!.evaluate(`window.markNamed(${JSON.stringify(selector)}, ${JSON.stringify(pattern)})`);
  if (!found) throw new Error(`nothing named /${pattern}/ at ${selector}`);
  await pressAt('[data-test-target]');
}

async function pressAt(selector: string) {
  const point = await page!.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!point) throw new Error(`nothing to press at ${selector}`);
  await page!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await page!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await page!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  await page!.settle();
}

/** The area menu's rows and labels, as drawn. */
async function readMenu(): Promise<{ labels: string[]; items: { name: string; hint: string | null; height: number; disabled: boolean }[] }> {
  return page!.evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]');
    return {
      labels: [...menu.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((label) => label.textContent),
      items: [...menu.querySelectorAll('[role="menuitem"]')].map((item) => {
        const hint = item.querySelector('[data-slot="dropdown-menu-item-hint"]');
        return { name: item.textContent.replace(hint?.textContent ?? '', '').trim(), hint: hint?.textContent ?? null, height: window.round(item.getBoundingClientRect().height), disabled: item.hasAttribute('data-disabled') };
      }),
    };
  })()`);
}

async function openAreaMenu(areaName: string) {
  // A menu that just closed blocks the page's pointer until its fade ends (Radix's modal menu sets the body's
  // pointer-events to none while it is open), and a save from it may still be on its way (the trigger waits then).
  await waitFor(`!document.querySelector('[role="menu"]') && getComputedStyle(document.body).pointerEvents !== 'none' && !window.store.getState().focus.saving`, 'the page to take presses again');
  await pressAt(`[data-focus-header] button[aria-label=${JSON.stringify(`Change ${areaName}`)}]`);
  await waitFor(`document.querySelector('[role="menu"]')`, 'the area menu');
  // The menu zooms in from 95% (ui/dropdown-menu.tsx); its rows are measured at their size, once that has finished.
  await page!.evaluate(`Promise.all(document.querySelector('[role="menu"]').getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})))`);
}

async function closeMenu() {
  await press('Escape');
  await waitFor(`!document.querySelector('[role="menu"]') && getComputedStyle(document.body).pointerEvents !== 'none'`, 'the area menu to close');
}

/** Waits for every animation and transition on the page that ends to end (a resize redraws the shell; its cards enter). */
async function settleAnimations() {
  await page!.evaluate(`Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})))`);
  await page!.settle();
}

/** The kept areas in the owner's saved order. */
const savedOrder = () => page!.evaluate(`window.model().focusAreas.filter((area) => area.status === 'kept' && !area.mergedInto).map((area) => area.id)`);

it.skipIf(!chromeExecutablePath)('on Other the request that needs you is the main card, the first block under the header, with its reply card in it, and the first screen has one solid orange button: Send; on an area it is Open request', async () => {
  try {
    await openPage(`${sampleState('reply-card')}&focus=other`);
    await waitFor(`document.querySelector('section[data-main-card] [data-slot="reply-card"]')`, 'the main card with its reply card');
    const lead = () => page!.evaluate(`(() => {
      const header = document.querySelector('[data-focus-header]').getBoundingClientRect();
      const card = document.querySelector('section[data-main-card]');
      const following = (selector) => { const other = document.querySelector(selector); return other ? !!(card.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) : null; };
      return { gap: window.round(card.getBoundingClientRect().top - header.bottom), state: card.dataset.mainCard, heading: card.querySelector('h2').textContent,
        request: card.querySelector('[data-request-opener]').dataset.requestOpener, replyCard: !!card.querySelector('[data-slot="reply-card"]'),
        typingBox: !!card.querySelector('[data-slot="reply-card"] textarea'), beforeAsks: following('[data-not-started-asks]'), beforeBoard: following('[data-board-view]') };
    })()`);
    const other = await lead();
    console.log(`[focus-area-page] Other's lead at 1440: ${JSON.stringify(other)}`);
    // Only the page stack's gap (space-y-5 at the 16px root: 20px) is between the header and the card: nothing else.
    expect(other.gap).toBeGreaterThanOrEqual(0);
    expect(other.gap).toBeLessThanOrEqual(22);
    expect({ ...other, gap: 0 }).toEqual({ gap: 0, state: 'your-move', heading: 'One thing needs you', request: 'r5', replyCard: true, typingBox: true, beforeAsks: true, beforeBoard: true });
    // Phase 6 fix AP-L8: two lines drawn, the whole summary in the page (a screen reader reads it all; the drawer shows it).
    expect(await page!.evaluate(`document.querySelector('section[data-main-card] p.line-clamp-2').textContent === window.model().requests.find((request) => request.id === 'r5').summary`)).toBe(true);
    // The decision unit is the main card: its Send is the page's one solid orange button. At 1440×900 it sits below the
    // first screen (the reply card shows the exchange before it), so the whole page is counted, and the card starts
    // on the first screen.
    const orange: { name: string; top: number; inMainCard: boolean }[] = await page!.evaluate('window.orangeOnPage()');
    console.log(`[focus-area-page] Other's solid orange buttons at 1440×900: ${JSON.stringify(orange)}`);
    expect(orange.map(({ name, inMainCard }) => ({ send: name.startsWith('Send'), inMainCard }))).toEqual([{ send: true, inMainCard: true }]);
    expect(await page!.evaluate(`document.querySelector('section[data-main-card]').getBoundingClientRect().top < innerHeight`)).toBe(true);
    // An area whose request is done and not checked: the card leads too, and its one orange is Open request (Mark
    // checked waits in the drawer).
    await page!.evaluate(`window.store.getState().goToFocus('fa-sync')`);
    await waitFor(`document.querySelector('section[data-main-card="needs-check"]')`, 'the Cloud sync main card');
    const area = await lead();
    expect(area.gap).toBeLessThanOrEqual(22);
    expect({ state: area.state, heading: area.heading, request: area.request, replyCard: area.replyCard, beforeAsks: area.beforeAsks, beforeBoard: area.beforeBoard })
      .toEqual({ state: 'needs-check', heading: 'One thing needs you', request: 'r3', replyCard: false, beforeAsks: true, beforeBoard: true });
    expect(await page!.evaluate('window.orangeOnFirstScreen()')).toEqual(['Open request']);
    expect((await page!.evaluate('window.orangeOnPage()')).map(({ name, inMainCard }: { name: string; inMainCard: boolean }) => ({ name, inMainCard }))).toEqual([{ name: 'Open request', inMainCard: true }]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('the area menu: a "…" of 44px or more, rows under small labels, Move up and Move down saying where the area sits in the saved order, Mark done last with where it goes and its Undo; the change bar shows each saved change on one row with an outlined Undo', async () => {
  try {
    await openPage('&focus=fa-sync');
    const trigger = await page!.evaluate(`window.boxOf(document.querySelector('[data-focus-header] button[aria-label="Change Cloud sync"]'))`);
    console.log(`[focus-area-page] the "…" at 1440: ${trigger.width}×${trigger.height}px`);
    expect(Math.min(trigger.width, trigger.height)).toBeGreaterThanOrEqual(44);
    expect(await savedOrder()).toEqual(['fa-viewer', 'fa-sync', 'fa-search', 'fa-behavior']);
    await openAreaMenu('Cloud sync');
    const menu = await readMenu();
    console.log(`[focus-area-page] the area menu: ${JSON.stringify(menu)}`);
    expect(menu.labels).toEqual(['Name and goal', 'Order', 'Organise', 'Finish']);
    expect(menu.items.map(({ name, hint }) => ({ name, hint }))).toEqual([
      { name: 'Rename', hint: null }, { name: 'Edit goal', hint: null },
      { name: 'Move up', hint: '2 of 4' }, { name: 'Move down', hint: '2 of 4' },
      { name: 'Merge into…', hint: null }, { name: 'Share…', hint: null },
      { name: 'Mark doneMoves it to Past focus. You can undo this right after.', hint: null },
    ]);
    // 44px rows on a desktop pointer too (page-03's area decision, the menu primitive's `lg` rows; Phase 6 verify V1: they
    // were 42.5px), and on touch (the 390 test below).
    expect(Math.min(...menu.items.map((item) => item.height))).toBeGreaterThanOrEqual(44);
    // Move down saves at once: the saved order changes, the change bar says so on one row with an outlined Undo.
    await pressNamed('[role="menuitem"]', '^Move down');
    await waitFor(`document.querySelector('[data-change-bar="saved"]')`, 'the saved change');
    expect(await savedOrder()).toEqual(['fa-viewer', 'fa-search', 'fa-sync', 'fa-behavior']);
    const bar = await page!.evaluate(`(() => {
      const bar = document.querySelector('[data-change-bar="saved"]');
      const undo = [...bar.querySelectorAll('button')].find((button) => window.nameOf(button) === 'Undo');
      const lines = new Set([...bar.children].map((child) => Math.round(child.getBoundingClientRect().top)));
      return { rows: document.querySelectorAll('[data-change-bar]').length, undo: undo?.dataset.variant ?? null, oneRow: Math.abs(undo.getBoundingClientRect().top + undo.getBoundingClientRect().height / 2 - (bar.getBoundingClientRect().top + bar.getBoundingClientRect().height / 2)) < 2, text: bar.innerText.replace(/\\s+/g, ' ') };
    })()`);
    console.log(`[focus-area-page] the change bar: ${JSON.stringify(bar)}`);
    expect({ rows: bar.rows, undo: bar.undo, oneRow: bar.oneRow }).toEqual({ rows: 1, undo: 'outline', oneRow: true });
    await openAreaMenu('Cloud sync');
    expect((await readMenu()).items.filter((item) => item.name.startsWith('Move')).map((item) => item.hint)).toEqual(['3 of 4', '3 of 4']);
    await closeMenu();
    await pressNamed('[data-change-bar="saved"] button', '^Undo$');
    await waitFor(`JSON.stringify(window.model().focusAreas.filter((area) => area.status === 'kept').map((area) => area.id)) === JSON.stringify(['fa-viewer', 'fa-sync', 'fa-search', 'fa-behavior'])`, 'the order put back');
    // Mark done: the area goes to Past focus, the header says Done, the bar offers Undo, and Undo brings it back.
    await openAreaMenu('Cloud sync');
    await pressAt('[role="menuitem"][data-mark-done]');
    await waitFor(`window.model().focusAreas.find((area) => area.id === 'fa-sync').status === 'done'`, 'the area marked done');
    await waitFor(`document.querySelector('[data-change-bar="saved"]')`, 'the saved change');
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-focus-header] [data-slot="badge"]')].map((badge) => badge.textContent)`)).toContain('Done');
    await openAreaMenu('Cloud sync');
    const done = await readMenu();
    expect(done.items.at(-1)!.name).toBe('Back in focus');
    expect(done.items.some((item) => item.name.startsWith('Move'))).toBe(false);
    await closeMenu();
    await pressNamed('[data-change-bar="saved"] button', '^Undo$');
    await waitFor(`window.model().focusAreas.find((area) => area.id === 'fa-sync').status === 'kept'`, 'the area back in focus');
    expect(await savedOrder()).toEqual(['fa-viewer', 'fa-sync', 'fa-search', 'fa-behavior']);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

/** The change bar's failed row, as drawn: its words, role, Details and Try again. */
const failedRow = () => page!.evaluate(`(() => {
  const bar = document.querySelector('[data-change-bar="failed"]');
  if (!bar) return null;
  const tryAgain = [...bar.querySelectorAll('button')].find((button) => window.nameOf(button) === 'Try again');
  return { rows: document.querySelectorAll('[data-change-bar]').length, role: bar.getAttribute('role'), words: bar.querySelector('p').textContent,
    details: !!bar.querySelector('[data-slot="collapsible-fold-trigger"], details, [data-slot="collapsible-trigger"]'), tryAgain: tryAgain?.dataset.variant ?? null };
})()`);
/** The sample refuses saves while its address names `focus-saves-fail` (read on every save), and takes them otherwise. */
const savesRefused = (refused: boolean, focus: string) => page!.evaluate(`history.replaceState(null, '', location.pathname + '?source=sample&focus=${focus}${refused ? sampleState('focus-saves-fail') : ''}')`);

// Phase 6 fix Q-M3 (the old test passed with a Try again that did nothing) and Q-M1 (the row names the change).
it.skipIf(!chromeExecutablePath)('a change that is not saved has the change bar’s matching row: it names the change, the reason under Details and an outlined Try again that sends that same change once more, refused again or saved', async () => {
  try {
    await openPage(`${sampleState('focus-saves-fail')}&focus=fa-sync`);
    await page!.evaluate('window.countSaves()');
    await openAreaMenu('Cloud sync');
    await pressNamed('[role="menuitem"]', '^Move down');
    await waitFor(`document.querySelector('[data-change-bar="failed"]')`, 'the failed change');
    const refused = { rows: 1, role: 'alert', words: 'Not saved: Changed the order of your focus areas.', details: true, tryAgain: 'outline' };
    expect(await failedRow()).toEqual(refused);
    expect(await page!.evaluate('window.saves')).toEqual(['reorder']);
    // Try again sends the move once more: refused again, the same one row.
    await pressNamed('[data-change-bar="failed"] button', '^Try again$');
    await waitFor(`window.saves.length === 2 && !window.store.getState().focus.saving`, 'the second try to answer');
    expect(await page!.evaluate('window.saves')).toEqual(['reorder', 'reorder']);
    expect(await failedRow()).toEqual(refused);
    expect(await savedOrder()).toEqual(['fa-viewer', 'fa-sync', 'fa-search', 'fa-behavior']);
    // The worker takes saves again: Try again sends it once more and it is saved, with its saved row and Undo.
    await savesRefused(false, 'fa-sync');
    await pressNamed('[data-change-bar="failed"] button', '^Try again$');
    await waitFor(`document.querySelector('[data-change-bar="saved"]') && !document.querySelector('[data-change-bar="failed"]')`, 'the move saved');
    expect(await page!.evaluate('window.saves')).toEqual(['reorder', 'reorder', 'reorder']);
    expect(await savedOrder()).toEqual(['fa-viewer', 'fa-search', 'fa-sync', 'fa-behavior']);
    expect(await page!.evaluate(`document.querySelector('[data-change-bar="saved"] p').textContent`)).toBe('Changed the order of your focus areas.');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix V5 (a dialog showed an earlier change's failure) and Q-M1 (a cancelled rename stayed on Try again).
it.skipIf(!chromeExecutablePath)('an edit dialog shows only its own save’s failure and stays open; cancelled, it leaves nothing that a Try again would save', async () => {
  try {
    await openPage(`${sampleState('focus-saves-fail')}&focus=fa-sync`);
    await page!.evaluate('window.countSaves()');
    // A failure from before: Mark done, refused.
    await openAreaMenu('Cloud sync');
    await pressAt('[role="menuitem"][data-mark-done]');
    await waitFor(`document.querySelector('[data-change-bar="failed"]')`, 'the failed Mark done');
    expect((await failedRow())?.words).toBe('Not saved: Marked “Cloud sync” done.');
    // The Rename dialog opens without it.
    await openAreaMenu('Cloud sync');
    await pressNamed('[role="menuitem"]', '^Rename$');
    await waitFor(`document.querySelector('[role="dialog"] input')`, 'the Rename dialog');
    expect(await page!.evaluate(`!!document.querySelector('[role="dialog"] [data-dialog-save-failure]')`)).toBe(false);
    // Its own save, refused: the dialog says so and stays open; the page's bar offers nothing for it.
    await page!.evaluate(`window.typeInto(document.querySelector('[role="dialog"] input'), 'Cloud sync everywhere')`);
    await pressNamed('[role="dialog"] button', '^Save name$');
    await waitFor(`document.querySelector('[role="dialog"] [data-dialog-save-failure]')`, 'the dialog’s failure line');
    expect(await page!.evaluate(`document.querySelector('[role="dialog"] [data-dialog-save-failure] p').textContent`)).toBe('This change was not saved.');
    expect(await page!.evaluate(`!!document.querySelector('[role="dialog"] input')`)).toBe(true);
    expect(await page!.evaluate(`!!document.querySelector('[data-change-bar="failed"]')`)).toBe(false);
    // Cancel, and discard the typed name: no Try again is left anywhere, and no rename is ever sent again.
    await pressNamed('[role="dialog"] [data-slot="dialog-footer"] button', '^Cancel$');
    await waitFor(`[...document.querySelectorAll('[role="dialog"] button')].some((button) => window.nameOf(button) === 'Discard')`, 'the discard question');
    await pressNamed('[role="dialog"] button', '^Discard$');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'the dialog to close');
    await savesRefused(false, 'fa-sync');
    expect(await page!.evaluate(`[...document.querySelectorAll('button')].filter((button) => window.nameOf(button) === 'Try again').length`)).toBe(0);
    expect(await page!.evaluate(`window.store.getState().focus.failed`)).toBeNull();
    expect(await page!.evaluate('window.saves')).toEqual(['done', 'rename']);
    expect(await page!.evaluate(`window.model().focusAreas.find((area) => area.id === 'fa-sync').name`)).toBe('Cloud sync');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M1: two screens at once, the drawer over its area's page: each change bar shows only its own failure.
it.skipIf(!chromeExecutablePath)('a move the drawer could not save is offered in the drawer, named, and never on the page under it', async () => {
  try {
    await openPage(`${sampleState('focus-saves-fail')}&focus=fa-sync`);
    await page!.evaluate(`window.store.getState().openRequestDrawer(window.model().requests.find((request) => request.id === 'r3'))`);
    await waitFor(`[...document.querySelectorAll('[role="dialog"] button')].some((button) => window.nameOf(button).startsWith('Move to'))`, 'Move to…');
    await pressNamed('[role="dialog"] button', '^Move to');
    await waitFor(`document.querySelector('[data-slot="command-input"]')`, 'the search field');
    await page!.send('Input.insertText', { text: 'Viewer' });
    await waitFor(`[...document.querySelectorAll('[data-slot="command-item"]')].map((item) => item.textContent).join('|') === 'Viewer'`, 'the list narrowed to Viewer');
    await page!.evaluate(`document.querySelector('[data-slot="command-item"]').click()`);
    await waitFor(`document.querySelector('[role="dialog"] [data-change-bar="failed"]')`, 'the drawer’s failed row');
    const bars = await page!.evaluate(`[...document.querySelectorAll('[data-change-bar="failed"]')].map((bar) => ({ inDrawer: !!bar.closest('[role="dialog"]'), words: bar.querySelector('p').textContent }))`);
    expect(bars).toEqual([{ inDrawer: true, words: 'Not saved: Moved “Move embeddings into their own table” to Viewer.' }]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M1: a failed attempt belongs to the screen that made it.
it.skipIf(!chromeExecutablePath)('a change not saved on one area’s page is not offered on another area’s page, and is gone when its own page is opened again', async () => {
  try {
    await openPage(`${sampleState('focus-saves-fail')}&focus=fa-sync`);
    await page!.evaluate('window.countSaves()');
    await openAreaMenu('Cloud sync');
    await pressAt('[role="menuitem"][data-mark-done]');
    await waitFor(`document.querySelector('[data-change-bar="failed"]')`, 'the failed Mark done');
    expect(await failedRow()).toEqual({ rows: 1, role: 'alert', words: 'Not saved: Marked “Cloud sync” done.', details: true, tryAgain: 'outline' });
    // Another area's page: nothing to try again there.
    await page!.evaluate(`window.store.getState().goToFocus('fa-viewer')`);
    await waitFor(`document.querySelector('[data-focus-header] h2')?.textContent === 'Viewer'`, 'the Viewer page');
    expect(await failedRow()).toBeNull();
    expect(await page!.evaluate(`[...document.querySelectorAll('button')].some((button) => window.nameOf(button) === 'Try again')`)).toBe(false);
    // Back on Cloud sync, with saves taken again: the failure was left behind with the page, and nothing was sent.
    await savesRefused(false, 'fa-viewer');
    await page!.evaluate(`window.store.getState().goToFocus('fa-sync')`);
    await waitFor(`document.querySelector('[data-focus-header] h2')?.textContent === 'Cloud sync'`, 'the Cloud sync page');
    expect(await failedRow()).toBeNull();
    expect(await page!.evaluate('window.saves')).toEqual(['done']);
    expect(await page!.evaluate(`window.model().focusAreas.find((area) => area.id === 'fa-sync').status`)).toBe('kept');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('the area dialogs: Save says what it saves, beside Cancel, with a helper line and the worker’s limit; Save waits with its reason said (a name; Merge until an area is chosen) and a press then saves nothing', async () => {
  try {
    await openPage('&focus=fa-sync');
    await openAreaMenu('Cloud sync');
    await pressNamed('[role="menuitem"]', '^Rename$');
    await waitFor(`document.querySelector('[role="dialog"] input')`, 'the Rename dialog');
    const dialog = () => page!.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const footer = dialog.querySelector('[data-slot="dialog-footer"]');
      const save = [...footer.querySelectorAll('button')].at(-1);
      const reason = save.getAttribute('aria-describedby') ? document.getElementById(save.getAttribute('aria-describedby'))?.textContent ?? null : null;
      const field = dialog.querySelector('input, [data-slot="select-trigger"]');
      const close = dialog.querySelector('[data-slot="dialog-close"]');
      return { footer: [...footer.querySelectorAll('button')].map((button) => window.nameOf(button)), waits: save.getAttribute('aria-disabled'), reason,
        helper: dialog.querySelector('[data-slot="field-helper-text"]')?.textContent ?? null, count: dialog.querySelector('[data-slot="field-count"]')?.textContent ?? null,
        // Layout sizes: the dialog opens with a short zoom, and a box read mid-zoom is scaled down.
        field: field.offsetHeight, close: Math.min(close.offsetWidth, close.offsetHeight) };
    })()`);
    const rename = await dialog();
    console.log(`[focus-area-page] Rename: ${JSON.stringify(rename)}`);
    expect({ footer: rename.footer, waits: rename.waits, reason: rename.reason, helper: rename.helper })
      .toEqual({ footer: ['Cancel', 'Save name'], waits: null, reason: null, helper: 'Shown in Focus areas and on every request in this area.' });
    expect(rename.count).toContain('80');
    expect(Math.min(rename.field, rename.close)).toBeGreaterThanOrEqual(44);
    // An empty name: Save waits, and says for what beside it (G16); pressing it saves nothing.
    await page!.evaluate(`window.typeInto(document.querySelector('[role="dialog"] input'), '')`);
    await page!.settle();
    expect(await dialog()).toMatchObject({ waits: 'true', reason: 'Save waits for a name.' });
    await pressNamed('[role="dialog"] [data-slot="dialog-footer"] button', '^Save name$');
    expect(await page!.evaluate(`!!document.querySelector('[data-change-bar]') || window.model().focusAreas.find((area) => area.id === 'fa-sync').name !== 'Cloud sync'`)).toBe(false);
    // Put the words back (no discard question), then Cancel closes the dialog.
    await page!.evaluate(`window.typeInto(document.querySelector('[role="dialog"] input'), 'Cloud sync')`);
    await pressNamed('[role="dialog"] [data-slot="dialog-footer"] button', '^Cancel$');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'the Rename dialog to close');
    // Merge: Save ("Merge") waits until an area is chosen, and says so.
    await openAreaMenu('Cloud sync');
    await pressNamed('[role="menuitem"]', '^Merge into');
    await waitFor(`document.querySelector('[role="dialog"] [data-slot="select-trigger"]')`, 'the Merge dialog');
    const merge = await dialog();
    console.log(`[focus-area-page] Merge: ${JSON.stringify(merge)}`);
    expect({ footer: merge.footer, waits: merge.waits, reason: merge.reason }).toEqual({ footer: ['Cancel', 'Merge'], waits: 'true', reason: 'Save waits until you choose the area to merge into.' });
    expect(Math.min(merge.field, merge.close)).toBeGreaterThanOrEqual(44);
    await pressNamed('[role="dialog"] [data-slot="dialog-footer"] button', '^Merge$');
    expect(await page!.evaluate(`!!document.querySelector('[data-change-bar]') || !!window.model().focusAreas.find((area) => area.id === 'fa-sync').mergedInto`)).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M3 (Enter to save had no test) and Q-L1 (an input method's Enter saved mid-word).
it.skipIf(!chromeExecutablePath)('Enter saves the Rename and Edit goal dialogs, except the Enter that picks a word while an input method composes it', async () => {
  try {
    await openPage('&focus=fa-sync');
    await page!.evaluate('window.countSaves()');
    await openAreaMenu('Cloud sync');
    await pressNamed('[role="menuitem"]', '^Rename$');
    await waitFor(`document.querySelector('[role="dialog"] input')`, 'the Rename dialog');
    await page!.evaluate(`(() => { const field = document.querySelector('[role="dialog"] input'); field.focus(); window.typeInto(field, 'Cloud sync everywhere'); })()`);
    // The Enter that confirms a candidate while Chinese or Korean is composed (KeyboardEvent.isComposing): nothing saves.
    await page!.evaluate(`document.querySelector('[role="dialog"] input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }))`);
    await page!.settle();
    expect(await page!.evaluate('window.saves')).toEqual([]);
    expect(await page!.evaluate(`!!document.querySelector('[role="dialog"] input')`)).toBe(true);
    // A plain Enter saves the name and closes the dialog; the bar says what changed.
    await press('Enter');
    await waitFor(`!document.querySelector('[role="dialog"]') && document.querySelector('[data-change-bar="saved"]')`, 'the name saved');
    expect(await page!.evaluate('window.saves')).toEqual(['rename']);
    expect(await page!.evaluate(`window.model().focusAreas.find((area) => area.id === 'fa-sync').name`)).toBe('Cloud sync everywhere');
    expect(await page!.evaluate(`document.querySelector('[data-change-bar="saved"] p').textContent`)).toBe('Renamed “Cloud sync” to “Cloud sync everywhere”.');
    // Edit goal: Enter saves the goal too.
    await openAreaMenu('Cloud sync everywhere');
    await pressNamed('[role="menuitem"]', '^Edit goal$');
    await waitFor(`document.querySelector('[role="dialog"] input')`, 'the Edit goal dialog');
    await page!.evaluate(`(() => { const field = document.querySelector('[role="dialog"] input'); field.focus(); window.typeInto(field, 'Every record syncs, and says when.'); })()`);
    await press('Enter');
    await waitFor(`!document.querySelector('[role="dialog"]') && window.saves.length === 2`, 'the goal saved');
    expect(await page!.evaluate(`window.model().focusAreas.find((area) => area.id === 'fa-sync').goal`)).toBe('Every record syncs, and says when.');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('sharing: the dialog says what goes on the page and what stays here in two columns, Cancel beside its one orange; the shared mark counts the comments, and they and the labelled comment box sit in the dialog’s one scroll', async () => {
  try {
    await openPage(`${sampleState('area-shared')}&focus=fa-sync`);
    await openAreaMenu('Cloud sync');
    await pressNamed('[role="menuitem"]', '^Share…$');
    await waitFor(`document.querySelector('[role="dialog"] [data-share-columns]')`, 'the share dialog');
    const columns = await page!.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const sections = [...dialog.querySelectorAll('[data-share-columns] > section')];
      const [first, second] = sections.map((section) => section.getBoundingClientRect());
      return { headings: sections.map((section) => section.querySelector('h3').textContent), sideBySide: Math.abs(first.top - second.top) < 1 && second.left >= first.right,
        items: sections.map((section) => [...section.querySelectorAll('li')].map((item) => item.textContent)),
        footer: [...dialog.querySelectorAll('[data-slot="dialog-footer"] button')].map((button) => window.nameOf(button)),
        orange: [...dialog.querySelectorAll('[data-slot="button"][data-variant="default"]')].map((button) => window.nameOf(button)) };
    })()`);
    expect(columns).toEqual({
      headings: ['On the page', 'Stays here'], sideBySide: true,
      items: [['This area’s requests', 'Where each one stands', 'What is next'], ['Your own words and prompts', 'Transcripts and files', 'Machine names', 'Your other areas and Other']],
      footer: ['Cancel', 'Share this area'], orange: ['Share this area'],
    });
    await pressNamed('[role="dialog"] [data-slot="dialog-footer"] button', '^Cancel$');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'the share dialog to close');
    // The shared area: its mark counts the comments on its page, as does the header's Sharing row.
    await page!.evaluate(`window.store.getState().goToFocus('fa-viewer')`);
    await waitFor(`document.querySelector('[data-shared-mark]')?.textContent.includes('2 comments')`, 'the comment count on the shared mark');
    expect(await page!.evaluate(`({ mark: document.querySelector('[data-shared-mark]').textContent, name: document.querySelector('[data-shared-mark]').getAttribute('aria-label'),
      fold: document.querySelector('[data-sharing-fold] [data-slot="fold-trigger-count"]')?.textContent ?? null })`))
      // One sentence in both places, "Shared · {comments}" (Phase 6 fix AP-L10: the mark and the row joined two words).
      .toEqual({ mark: 'Shared · 2 comments', name: 'Shared by link: open sharing', fold: 'Shared · 2 comments' });
    await pressAt('[data-shared-mark]');
    await waitFor(`document.querySelectorAll('[role="dialog"] [data-share-comments] li').length === 2`, 'the comments in the dialog');
    const comments = await page!.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const box = dialog.querySelector('textarea');
      const label = box && dialog.querySelector('label[for="' + CSS.escape(box.id) + '"]');
      // Every box in the dialog that scrolls its own content: only the dialog itself may.
      const scrollers = [dialog, ...dialog.querySelectorAll('*')].filter((element) => {
        const style = getComputedStyle(element);
        return ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      }).map((element) => element === dialog ? 'dialog' : element.tagName + (element.dataset.shareComments !== undefined ? '[data-share-comments]' : ''));
      const list = dialog.querySelector('[data-share-comments]');
      return { label: label?.textContent ?? null, labelShown: !!label && window.visible(label), listScrolls: ['auto', 'scroll'].includes(getComputedStyle(list).overflowY), scrollers };
    })()`);
    console.log(`[focus-area-page] the shared dialog: ${JSON.stringify(comments)}`);
    expect({ label: comments.label, labelShown: comments.labelShown, listScrolls: comments.listScrolls }).toEqual({ label: 'Answer as yourself', labelShown: true, listScrolls: false });
    expect(comments.scrollers.filter((name: string) => name !== 'dialog')).toEqual([]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

/** The sharing sample answers its comments read from the address on every call (sample-source.ts sampleShareAnswer). */
const commentsReadable = (readable: boolean) => page!.evaluate(`history.replaceState(null, '', location.pathname + '?source=sample&focus=fa-viewer${sampleState(readable ? 'area-shared' : 'share-comments-unreadable')}')`);

// Phase 6 fix Q-L2 (it spoke of comments shown when none were), Q-M3 (Try again passed if it read nothing) and AP-L5
// (the mark's failed count read was silent).
it.skipIf(!chromeExecutablePath)('a comments read that fails says so in plain words, without claiming comments it does not show, with Try again, which reads them again; the mark shows no count it cannot vouch for, and its failed count read is logged', async () => {
  try {
    await openPage(`${sampleState('share-comments-unreadable')}&focus=fa-viewer`);
    await waitFor(`document.querySelector('[data-shared-mark]')`, 'the shared mark');
    // The mark's own count read failed: no number, and the console says which area and why.
    await waitFor(`window.warnings.some((line) => line.includes('fa-viewer'))`, 'the count read’s warning');
    expect(await page!.evaluate(`document.querySelector('[data-shared-mark]').textContent`)).toBe('Shared');
    expect(await page!.evaluate(`window.warnings.find((line) => line.includes('fa-viewer'))`)).toContain('503 Service Unavailable');
    await pressAt('[data-shared-mark]');
    await waitFor(`document.querySelector('[role="dialog"] [data-comments-read-failure]')`, 'the comments read failure');
    const failure = () => page!.evaluate(`(() => {
      const box = document.querySelector('[role="dialog"] [data-comments-read-failure]');
      if (!box) return null;
      const tryAgain = [...box.querySelectorAll('button')].find((button) => window.nameOf(button) === 'Try again');
      return { role: box.getAttribute('role'), words: box.querySelector('p').textContent, details: !!box.querySelector('[data-slot="collapsible-fold-trigger"], [data-slot="collapsible-trigger"]'), tryAgain: tryAgain?.dataset.variant ?? null };
    })()`);
    // No read has answered, so no comment is on screen, and the words claim none.
    expect(await failure()).toEqual({ role: 'alert', words: 'Could not read the comments.', details: true, tryAgain: 'outline' });
    expect(await page!.evaluate(`document.querySelectorAll('[role="dialog"] [data-share-comments] li').length`)).toBe(0);
    // cmem.ai answers again: Try again reads now (the dialog's own reads come every 20 s), and the comments show.
    await commentsReadable(true);
    await pressNamed('[role="dialog"] [data-comments-read-failure] button', '^Try again$');
    await withTimeout(page!.evaluate(`new Promise((resolve) => { const check = () => document.querySelectorAll('[role="dialog"] [data-share-comments] li').length === 2 ? resolve(true) : requestAnimationFrame(check); check(); })`), 3_000, 'the comments within 3 s of Try again');
    expect(await failure()).toBeNull();
    await waitFor(`document.querySelector('[data-shared-mark]').textContent === 'Shared · 2 comments'`, 'the mark’s count');
    // A read that fails again: the mark drops its number rather than show the old one as current.
    await commentsReadable(false);
    await press('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'the dialog to close');
    await pressAt('[data-shared-mark]');
    await waitFor(`document.querySelector('[role="dialog"] [data-comments-read-failure]')`, 'the read to fail again');
    expect(await page!.evaluate(`document.querySelector('[data-shared-mark]').textContent`)).toBe('Shared');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix AP-M1: on a page where sharing is never read, the Sharing row claims nothing.
it.skipIf(!chromeExecutablePath)('where sharing does not work (plain sample data, as the cloud copy), the Sharing row says nothing about whether the area is shared', async () => {
  try {
    await openPage('&focus=fa-viewer');
    await waitFor(`document.querySelector('[data-sharing-fold]')`, 'the Sharing row');
    expect(await page!.evaluate(`({ count: document.querySelector('[data-sharing-fold] [data-slot="fold-trigger-count"]')?.textContent ?? null,
      words: document.querySelector('[data-focus-header]').innerText.includes('Not shared') })`)).toEqual({ count: null, words: false });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('"Why it’s here" is one fold row on every area: quotes with their times in one right-hand column, or the router’s evidence, a list of quoted prompts a line each', async () => {
  try {
    await openPage('&focus=fa-viewer');
    const why = () => page!.evaluate(`(() => {
      const fold = document.querySelector('[data-why-its-here]');
      const trigger = fold.querySelector('[data-slot="collapsible-fold-trigger"]');
      return { preview: trigger.textContent, count: fold.querySelector('[data-slot="fold-trigger-count"]')?.textContent ?? null, height: window.round(trigger.getBoundingClientRect().height),
        times: [...fold.querySelectorAll('time[data-slot="quote-time"]')].map((time) => ({ right: Math.round(time.getBoundingClientRect().right), font: getComputedStyle(time).fontFamily.split(',')[0] })),
        lines: [...fold.querySelectorAll('[data-slot="evidence-lines"] li')].map((line) => line.textContent) };
    })()`);
    const closed = await why();
    expect(closed.preview).toContain('Why it’s here');
    expect(closed.count).toBe('3 quotes');
    expect(closed.height).toBeGreaterThanOrEqual(44);
    await pressAt('[data-why-its-here] [data-slot="collapsible-fold-trigger"]');
    const quotes = await why();
    // One column: every time ends at the same x, in the monospace face.
    expect({ times: quotes.times.length, rights: new Set(quotes.times.map((time: { right: number }) => time.right)).size, font: quotes.times[0].font }).toEqual({ times: 3, rights: 1, font: 'ui-monospace' });
    // An area with no quotes and the router's list of quoted prompts: the same row, a prompt a line.
    await page!.evaluate(`window.receive((model) => ({ ...model, focusAreas: model.focusAreas.map((area) => area.id === 'fa-sync'
      ? { ...area, quotes: [], evidence: "'make the sync dependable'; 'stop losing records on restart'; 'show what is still uploading'" } : area) }))`);
    await page!.evaluate(`window.store.getState().goToFocus('fa-sync')`);
    await waitFor(`document.querySelector('[data-focus-header] h2')?.textContent === 'Cloud sync'`, 'Cloud sync');
    await pressAt('[data-why-its-here] [data-slot="collapsible-fold-trigger"]');
    await waitFor(`document.querySelector('[data-slot="evidence-lines"]')`, 'the evidence lines');
    expect((await why()).lines).toEqual(["'make the sync dependable'", "'stop losing records on restart'", "'show what is still uploading'"]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('an area with no requests is a compact box around its one next step, which goes to All requests', async () => {
  try {
    await openPage('&focus=fa-search');
    await waitFor(`document.querySelector('[data-slot="work-shell"] main [data-slot="empty"]')`, 'the empty area box');
    const box = await page!.evaluate(`(() => {
      const empty = document.querySelector('[data-slot="work-shell"] main [data-slot="empty"]');
      return { ...window.boxOf(empty), buttons: [...empty.querySelectorAll('button')].map((button) => window.nameOf(button)) };
    })()`);
    console.log(`[focus-area-page] the empty area box at 1440: ${JSON.stringify(box)}`);
    // max-w-md: 28rem at the 17px root is 476px (it was the page's full 1171px for two lines and no button).
    expect({ narrow: box.width <= 476.5, buttons: box.buttons }).toEqual({ narrow: true, buttons: ['Find a request to move here'] });
    await pressNamed('[data-slot="work-shell"] main [data-slot="empty"] button', '^Find a request to move here');
    await waitFor(`!new URLSearchParams(location.search).get('focus') && new URLSearchParams(location.search).get('view') === 'requests'`, 'All requests');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

/** Asks for Other beyond the old three-row limit: each with a quote, one asked twice. */
const OTHER_ASKS = Array.from({ length: 6 }, (_, index) => ({
  id: `other-ask-${index}`, title: `Other ask number ${index + 1} that no request covers`, timesAsked: index === 0 ? 2 : 1, latestAt: `11-0${index + 1} 09:3${index}`,
  quotes: [{ at: `11-0${index + 1} 09:3${index}`, quote: `Please look at ask ${index + 1} when there is time` }],
}));

it.skipIf(!chromeExecutablePath)('Other shows every ask nobody has started, each a 56px row with its quotes toggle at 24px or more and Copy as prompt, which copies the ask or says how to copy it', async () => {
  try {
    await openPage('&focus=other');
    await page!.evaluate(`window.receive((model) => ({ ...model, otherAsks: ${JSON.stringify(OTHER_ASKS)} }))`);
    await waitFor(`document.querySelectorAll('[data-not-started-ask]').length === ${OTHER_ASKS.length}`, 'every ask');
    const asks = await page!.evaluate(`(() => {
      const list = document.querySelector('[data-not-started-asks]');
      const rows = [...list.querySelectorAll('[data-not-started-ask]')];
      return { rows: rows.length, shorter: Math.min(...rows.map((row) => row.getBoundingClientRect().height)), toggles: Math.min(...[...list.querySelectorAll('[data-ask-quotes]')].map((toggle) => toggle.getBoundingClientRect().height)),
        showMore: [...list.querySelectorAll('button')].some((button) => /^Show \\d+ more/.test(window.nameOf(button))), count: list.querySelector('[data-slot="fold-trigger-count"]')?.textContent ?? null,
        // SaveButton keeps its other words in the button, unseen, so its width never jumps: the name starts with the shown one.
        copies: rows.map((row) => [...row.querySelectorAll('button')].some((button) => window.nameOf(button).startsWith('Copy as prompt'))).every(Boolean) };
    })()`);
    console.log(`[focus-area-page] Other's asks: ${JSON.stringify(asks)}`);
    expect({ rows: asks.rows, showMore: asks.showMore, count: asks.count, copies: asks.copies }).toEqual({ rows: OTHER_ASKS.length, showMore: false, count: `${OTHER_ASKS.length} asks`, copies: true });
    expect(asks.shorter).toBeGreaterThanOrEqual(56);
    expect(asks.toggles).toBeGreaterThanOrEqual(24);
    await pressNamed(`[data-not-started-ask="${OTHER_ASKS[0].id}"] button`, '^Copy as prompt');
    await waitFor(`window.copies.length === 1`, 'the copy');
    expect(await page!.evaluate('window.copies')).toEqual([OTHER_ASKS[0].title]);
    // A browser that refuses the clipboard: the row says how to copy it instead, with the reason under Details.
    await page!.evaluate(`window.clipboardRefuses = 'Write permission denied.'`);
    await pressNamed(`[data-not-started-ask="${OTHER_ASKS[1].id}"] button`, '^Copy as prompt');
    const refused = `[...document.querySelectorAll('[data-not-started-ask="${OTHER_ASKS[1].id}"] [role="alert"]')].map((alert) => alert.textContent)`;
    await waitFor(`${refused}.includes('Could not copy. Select the ask to copy it.')`, 'the refused copy’s words');
    // Heard once (Phase 6 fix V6: the button's own "Not copied" was a second alert), and the browser's reason is under Details.
    expect(await page!.evaluate(refused)).toEqual(['Could not copy. Select the ask to copy it.']);
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-not-started-ask="${OTHER_ASKS[1].id}"] [role="alert"], [data-not-started-ask="${OTHER_ASKS[1].id}"] [aria-live="assertive"]')].length`)).toBe(1);
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-not-started-ask="${OTHER_ASKS[1].id}"] [data-slot="collapsible-fold-trigger"]')].map((trigger) => trigger.textContent)`)).toContain('Details');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// A phone draws overlay scrollbars, so the classic scrollbar's run is a 390px desktop window (Windows, Linux), where
// Chrome draws it: the page then has 375px. Below 48rem every control is 44px there too (touch-target-size).
for (const scrollbar of SCROLLBAR_MODES) {
  const where = scrollbar.classic ? 'a 390px desktop window with a classic 15px scrollbar' : 'a 390px touch phone';
  it.skipIf(!chromeExecutablePath)(`a focus area page and Other fit ${where}: nothing runs past the page's width, the "…" and the menu rows are 44px or more`, async () => {
    try {
      await openPage(`&focus=fa-sync${scrollbar.query}`, { width: 390, height: 844, touch: !scrollbar.classic });
      if (scrollbar.classic) expect(await page!.evaluate('document.documentElement.clientWidth')).toBe(375);
      const fits = () => page!.evaluate(`(() => {
        const width = document.documentElement.clientWidth;
        const parts = [...document.querySelectorAll('[data-focus-header], section[data-main-card], [data-not-started-asks], [data-board-view]')];
        const past = parts.flatMap((part) => [part, ...part.querySelectorAll('*')]).filter((element) => window.visible(element) && element.getBoundingClientRect().right > width + 0.5)
          .map((element) => element.tagName + ' ' + (element.textContent ?? '').slice(0, 30));
        return { width, scrollWidth: document.documentElement.scrollWidth, past: past.slice(0, 5), parts: parts.length };
      })()`);
      const area = await fits();
      console.log(`[focus-area-page] Cloud sync at 390 with ${scrollbar.label}: ${JSON.stringify(area)}`);
      expect({ scrollWidth: area.scrollWidth, past: area.past }).toEqual({ scrollWidth: area.width, past: [] });
      const trigger = await page!.evaluate(`window.boxOf(document.querySelector('[data-focus-header] button[aria-label="Change Cloud sync"]'))`);
      expect(Math.min(trigger.width, trigger.height)).toBeGreaterThanOrEqual(44);
      await openAreaMenu('Cloud sync');
      expect(Math.min(...(await readMenu()).items.map((item) => item.height))).toBeGreaterThanOrEqual(44);
      await closeMenu();
      await page!.evaluate(`window.store.getState().goToFocus('other')`);
      await waitFor(`document.querySelector('[data-suggested-notice]')`, 'Other');
      await page!.evaluate(`window.receive((model) => ({ ...model, otherAsks: ${JSON.stringify(OTHER_ASKS)} }))`);
      await waitFor(`document.querySelectorAll('[data-not-started-ask]').length === ${OTHER_ASKS.length}`, 'every ask');
      const other = await fits();
      console.log(`[focus-area-page] Other at 390 with ${scrollbar.label}: ${JSON.stringify(other)}`);
      expect({ scrollWidth: other.scrollWidth, past: other.past }).toEqual({ scrollWidth: other.width, past: [] });
      expect(fixtureErrors).toEqual([]);
    } finally {
      await closePage();
    }
  }, 60_000);
}

it.skipIf(!chromeExecutablePath)('Past focus dates a done area by the moment it was marked done: a later rename or goal edit does not move it', async () => {
  try {
    await openPage('&view=past-focus');
    await waitFor(`[...document.querySelectorAll('time[datetime]')].some((time) => time.dateTime === '2026-10-17T16:05:00')`, 'the done area’s date');
    const doneDate = () => page!.evaluate(`(() => {
      const time = [...document.querySelectorAll('time[datetime]')].find((each) => each.dateTime.startsWith('2026-10-17'));
      const card = time?.closest('li, article, section, [data-slot="card"]');
      return time ? { dateTime: time.dateTime, shown: time.textContent, card: card?.textContent.includes(window.model().focusAreas.find((area) => area.id === 'fa-fixes').name) ?? false } : null;
    })()`);
    const before = await doneDate();
    console.log(`[focus-area-page] Past focus's done date: ${JSON.stringify(before)}`);
    expect(before).toMatchObject({ dateTime: '2026-10-17T16:05:00', card: true });
    expect(before!.shown).toContain('Oct 17');
    // A rename and a new goal on later saves (sample mode: kept in the page, as the worker's reducer keeps doneAt).
    const madeHere = `{ words: { text: 'A change', undo: null }, place: 'test' }`;
    expect(await page!.evaluate(`window.store.getState().applyFocusChange({ action: 'rename', focusAreaId: 'fa-fixes', name: 'Plugin fixes, renamed' }, null, ${madeHere})`)).toBe(true);
    expect(await page!.evaluate(`window.store.getState().applyFocusChange({ action: 'edit-goal', focusAreaId: 'fa-fixes', goal: 'The small fixes, all in.' }, null, ${madeHere})`)).toBe(true);
    await waitFor(`document.body.innerText.includes('Plugin fixes, renamed')`, 'the renamed area');
    expect(await doneDate()).toEqual(before);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('in French the drawer words what the mapper left unrecorded: a start, a workstream’s and a task’s name, and each source’s kind; My Rules words a rule’s missing time', async () => {
  try {
    await openPage('');
    // r1 as an older worker or a sparse record sends it: no start, a workstream and a task with no name, sources by kind.
    await page!.evaluate(`window.store.getState().updateSampleRequest('r1', (request) => ({ ...request, startedAt: null, startedAtIso: null,
      workstreams: [{ title: null, tasks: [{ name: null, done: false }, { name: 'Draw the wireframe', done: true }] }],
      evidence: [{ kind: 'observation', title: 'Wireframe drawn', href: '/api/work-view/evidence/observation/1' }, { kind: 'summary', title: 'Session wrap-up', href: '/api/work-view/evidence/summary/2' }] }))`);
    await page!.evaluate(`window.setLocale('fr')`);
    await page!.evaluate(`window.store.getState().openRequestDrawer(window.model().requests.find((request) => request.id === 'r1'))`);
    await waitFor(`document.querySelector('[role="dialog"]')`, 'the drawer');
    for (const fold of ['Flux de travail', 'Origine']) {
      await pressNamed('[role="dialog"] [data-slot="collapsible-fold-trigger"]', `^${fold}`);
    }
    await waitFor(`document.querySelector('[role="dialog"]').innerText.includes('Travail annexe')`, 'the workstream with no name');
    // Its tasks are folded under it.
    await pressNamed('[role="dialog"] button', '^Travail annexe');
    await waitFor(`document.querySelector('[role="dialog"]').innerText.includes('Tâche sans titre')`, 'the task with no name');
    const drawer: string = await page!.evaluate(`document.querySelector('[role="dialog"]').innerText.replace(/\\s+/g, ' ')`);
    for (const words of ['début non enregistré', 'Travail annexe', 'Tâche sans titre', 'Observation : Wireframe drawn', 'Résumé de session : Session wrap-up']) expect(drawer).toContain(words);
    for (const english of ['Start not recorded', 'start not recorded', 'Supporting work', 'Untitled task', 'Observation:']) expect(drawer).not.toContain(english);
    await press('Escape');
    // My Rules: a quote and a rule whose time was not recorded.
    await page!.evaluate(`window.store.getState().goToPage('rules')`);
    await waitFor(`location.search.includes('view=rules') && document.querySelector('blockquote')`, 'My Rules');
    // The rule whose quote the page shows first: its quotes' times and its latest time not recorded.
    await page!.evaluate(`(() => {
      const shown = document.querySelector('blockquote').textContent;
      window.receive((model) => ({ ...model, rules: model.rules.map((rule) => rule.quotes.some((quote) => shown.includes(quote.quote))
        ? { ...rule, latestAt: null, quotes: rule.quotes.map((quote) => ({ ...quote, at: null })) } : rule) }));
    })()`);
    await waitFor(`document.querySelector('blockquote').innerText.includes('Heure non enregistrée')`, 'the missing time in French');
    expect(await page!.evaluate(`document.body.innerText.includes('Time not recorded')`)).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('the drawer of a shipped request that ran under a minute says it took under a minute, never "Just started"', async () => {
  try {
    await openPage('');
    await page!.evaluate(`window.store.getState().updateSampleRequest('r4', (request) => ({ ...request, runningForMs: 30000 }))`);
    await page!.evaluate(`window.store.getState().openRequestDrawer(window.model().requests.find((request) => request.id === 'r4'))`);
    await waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes('Asked by')`, 'the drawer’s facts line');
    const facts: string = await page!.evaluate(`[...document.querySelectorAll('[role="dialog"] p')].map((line) => line.textContent).find((text) => text.startsWith('Asked by'))`);
    expect(facts).toContain('under a minute');
    expect(facts).not.toContain('Just started');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

for (const scrollbar of SCROLLBAR_MODES) {
  it.skipIf(!chromeExecutablePath)(`request cards in one row are as tall as the row, their footers on one line, at 1440 and 768 on home and the Cards board, with ${scrollbar.label}`, async () => {
    try {
      await openPage(scrollbar.query);
      const rows = () => page!.evaluate(`(() => {
        const cards = [...document.querySelectorAll('[data-slot="work-shell"] main [data-slot="card"]')].filter((card) => card.querySelector('[data-request-opener]') && window.visible(card));
        const byRow = new Map();
        for (const card of cards) {
          const grid = card.closest('.grid');
          const key = (grid ? [...document.querySelectorAll('.grid')].indexOf(grid) : -1) + ':' + Math.round(card.getBoundingClientRect().top);
          byRow.set(key, [...(byRow.get(key) ?? []), card]);
        }
        return [...byRow.values()].filter((row) => row.length > 1).map((row) => ({
          cards: row.map((card) => card.querySelector('[data-request-opener]').dataset.requestOpener),
          heights: row.map((card) => window.round(card.getBoundingClientRect().height)),
          footers: row.map((card) => { const footer = card.querySelector('[data-slot="card-footer"]'); return footer ? window.round(card.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom) : null; }),
        }));
      })()`);
      const seen: Record<string, unknown> = {};
      for (const width of [1440, 768]) {
        await resize(width);
        const found = await rows();
        seen[width] = found;
        for (const row of found) {
          expect({ width, cards: row.cards, spread: Math.max(...row.heights) - Math.min(...row.heights) <= 1, footers: new Set(row.footers.map((gap: number | null) => gap === null ? null : Math.round(gap))).size })
            .toEqual({ width, cards: row.cards, spread: true, footers: 1 });
        }
      }
      console.log(`[focus-area-page] card rows with ${scrollbar.label}: ${JSON.stringify(seen)}`);
      // Home at 1440 has a row of two at least (the sample's two that need you), so the check above is not empty.
      expect((seen[1440] as unknown[]).length).toBeGreaterThan(0);
      expect(fixtureErrors).toEqual([]);
    } finally {
      await closePage();
    }
  }, 60_000);
}

it.skipIf(!chromeExecutablePath)('the drawer opened from a List row gives focus back to that request’s row in its new group when the request finished while it was open', async () => {
  try {
    await openPage('');
    await page!.evaluate(`[...document.querySelectorAll('[role=radio]')].find((item) => window.nameOf(item) === 'List').click()`);
    await waitFor(`document.querySelector('[data-list-group="working"] [data-request-opener="r1"]')`, 'r1 in the List’s Working group');
    await page!.evaluate(`document.querySelector('[data-list-group="working"] [data-request-opener="r1"]').focus()`);
    await press('Enter');
    await waitFor(`document.querySelector('[role="dialog"]')`, 'the drawer');
    // The sample's own demo change: the wireframe agent finishes, and the request waits for your check.
    await page!.evaluate(`window.store.getState().updateSampleRequest('r1', (request) => ({ ...request, state: 'needs-check', stage: 'Reviewing',
      progress: { ...request.progress, percent: 100, readings: 4, reviewedAt: '2:04 pm', history: [30, 55, 70, 100] }, estimate: null,
      next: { who: 'human', text: 'Check the wireframe against the spec' }, activityWord: '' }))`);
    await waitFor(`!document.querySelector('[data-list-group="working"] [data-request-opener="r1"]') && document.querySelector('[data-request-opener="r1"]')`, 'r1 drawn in its new group');
    await press('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'the drawer to close');
    expect(await page!.evaluate(`({ opener: document.activeElement?.dataset.requestOpener ?? null, group: document.activeElement?.closest('[data-list-group]')?.dataset.listGroup ?? null, body: document.activeElement === document.body })`))
      .toEqual({ opener: 'r1', group: expect.any(String), body: false });
    expect(await page!.evaluate(`document.activeElement.closest('[data-list-group]').dataset.listGroup`)).not.toBe('working');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('on home a live change moves two things at most (rule 8): the changed cards, the one that needs you too, are marked "just updated" still, with no glow or fade', async () => {
  try {
    await openPage('');
    await waitFor(`document.querySelector('[data-slot="card"] [data-request-opener="r3"]')`, 'the card that needs you');
    // From a still page: the resize to 1440 redraws the shell, and its cards' entrances end first.
    await settleAnimations();
    // A live change as the feed sends one: two records changed (a new reading each; their cards' words as they were),
    // one of them the card that needs you.
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r3' || request.id === 'r1'
      ? { ...request, contentFingerprint: request.contentFingerprint + '-changed', progress: { ...request.progress, readings: request.progress.readings + 1 } } : request) }))`);
    const seen: string[][] = await page!.evaluate('window.movingThingsOver(1500)');
    const most = Math.max(...seen.map((things) => things.length));
    console.log(`[focus-area-page] home after a live change: ${most} moving at most, ${JSON.stringify([...new Set(seen.flat())])}`);
    expect(most).toBeLessThanOrEqual(2);
    const marked = await page!.evaluate(`['r3', 'r1'].map((id) => {
      const card = document.querySelector('[data-slot="card"] [data-request-opener="' + id + '"]').closest('[data-slot="card"]');
      return { id, marked: card.hasAttribute('data-just-updated'), animations: card.getAnimations().map((animation) => animation.transitionProperty ?? animation.animationName) };
    })`);
    expect(marked).toEqual([{ id: 'r3', marked: true, animations: [] }, { id: 'r1', marked: true, animations: [] }]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

/**
 * A live state change, as the feed sends one, that re-places and adds several cards: r1, working, finishes and waits for
 * your check (its record changed, the model's first change, so the newest), and two requests that need you arrive in its
 * area, Viewer: r6 (your move, the newest start) and r7 (to check, started after r1). On home the board re-places r1
 * and every card after it and adds r6 and r7; on the Viewer area's page the main card leads with r6 and the board, which
 * drew no card before, draws r7 and r1 (Phase 6 re-verify V2: with r1 alone, a card entrance put back never played, r1
 * re-placed in the same keyed grid, and the area's page drew no card at all).
 */
const R1_FINISHES_AND_TWO_ARRIVE = `window.receive((model) => {
  const like = (id) => model.requests.find((request) => request.id === id);
  return { ...model, requests: [...model.requests.map((request) => request.id === 'r1'
    ? { ...request, contentFingerprint: request.contentFingerprint + '-finished', state: 'needs-check', stage: 'Reviewing', runningLive: undefined,
        progress: { ...request.progress, percent: 100, readings: request.progress.readings + 1, history: [...(request.progress.history ?? []), 100] }, estimate: null,
        next: { who: 'human', text: 'Check the wireframe against the spec' }, activityWord: '' } : request),
    { ...like('r5'), id: 'r6', contentFingerprint: 'r6-arrived', title: 'Choose the viewer’s first-run layout', focusAreaId: 'fa-viewer', startedAt: 'Oct 20, 2:05 pm', startedAtIso: '2026-10-20T14:05:00-07:00' },
    { ...like('r3'), id: 'r7', contentFingerprint: 'r7-arrived', title: 'Check the viewer’s empty states', focusAreaId: 'fa-viewer', startedAt: 'Oct 20, 1:40 pm', startedAtIso: '2026-10-20T13:40:00-07:00' }] };
})`;

/**
 * The answer buttons a page draws (components/focus-main-card.tsx ReplyActions): the sample page cannot continue a
 * conversation, so it draws "Open request"; under `reply-card` it can, as the page this computer's worker serves (the
 * owner's own) can, so it draws Reply. Each run below draws one kind; on home the first card's is the orange one.
 */
const ANSWER_BUTTONS = [
  { label: '"Open request"', query: '', button: 'Open request' },
  { label: 'Reply, as a page that can reply draws them', query: sampleState('reply-card'), button: 'Reply' },
] as const;
/** The visible orange buttons in the main column, each with the request whose card holds it ('' outside a card). */
const ORANGE_BUTTONS = `[...document.querySelectorAll('[data-slot="work-shell"] main [data-slot="button"][data-variant="default"]')].filter(window.visible)
  .map((button) => window.nameOf(button) + ' ' + (button.closest('[data-slot="card"]')?.querySelector('[data-request-opener]')?.dataset.requestOpener ?? ''))`;

// Phase 6 fix V2 and the anti-pattern review's gap (page-03 had no count): a live state change, on home and on a focus
// area's page. What may move is the change ticker's slide to the newest change; the board takes the change at once.
for (const motion of ['allowed', 'reduced'] as const) {
  for (const answers of ANSWER_BUTTONS) for (const where of [
    { name: 'home', query: '', view: 'Cards' }, { name: 'the Viewer area’s page', query: '&focus=fa-viewer', view: 'Cards' },
    { name: 'home in the List', query: '', view: 'List' }, { name: 'the Viewer area’s page in the List', query: '&focus=fa-viewer', view: 'List' },
  ]) {
    it.skipIf(!chromeExecutablePath)(`on ${where.name} a live state change moves two things at most (rule 8), the change ticker included, with motion ${motion} and the answer buttons ${answers.label}`, async () => {
      try {
        await openPage(where.query + answers.query, { width: 1440, height: 900 }, { reducedMotion: motion === 'reduced' });
        expect(await page!.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(motion === 'reduced');
        if (where.view !== 'Cards') await page!.evaluate(`[...document.querySelectorAll('[role=radio]')].find((item) => window.nameOf(item) === ${JSON.stringify(where.view)}).click()`);
        await waitFor(`document.querySelector('[data-request-opener="r1"]')`, 'r1 on the board');
        await settleAnimations();
        // On home the first card that needs you, r5's, holds the orange answer button, of the kind this run draws.
        if (!where.query) expect(await page!.evaluate(ORANGE_BUTTONS)).toContain(`${answers.button} r5`);
        // A first change the ticker shows (r2's first review), so the state change after it slides in: the first change
        // a ticker shows has nothing to slide from.
        await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r2'
          ? { ...request, contentFingerprint: 'r2-reviewed', progress: { ...request.progress, percent: 20, readings: 1, reviewedAt: '2:01 pm', history: [20] } } : request) }))`);
        await waitFor(`document.querySelector('[data-ticker="changes"]')`, 'the ticker showing the first change');
        await settleAnimations();
        await page!.evaluate(R1_FINISHES_AND_TWO_ARRIVE);
        // Each moving thing with what moves on it; a thing is counted once a frame however many of its parts move. Past the
        // 4 s the "just updated" mark lasts (the store's FRESHLY_UPDATED_FOR_MS), so its ending is counted too.
        const detail: string[][] = await page!.evaluate('window.movingThingsOver(4500, true)');
        const seen = detail.map((frame) => [...new Set(frame.map((entry) => entry.replace(/ \(.*\)$/, '')))]);
        const most = Math.max(...seen.map((things) => things.length));
        const everything = [...new Set(seen.flat())];
        console.log(`[focus-area-page] ${where.name} with ${answers.button} during a state change, motion ${motion}: ${most} moving at most, ${JSON.stringify(everything)} ${JSON.stringify([...new Set(detail.flat())])}`);
        expect(most).toBeLessThanOrEqual(motion === 'reduced' ? 0 : 2);
        // The two are the change ticker and, where rows show their status, the newest change's riffle (r1's, the model's
        // first change); nothing else moves: no card, row or button (an answer button's fade from orange is a third thing).
        expect({ where: where.name, alsoMoving: everything.filter((thing) => thing !== 'ticker' && thing !== 'riffle: r1') }).toEqual({ where: where.name, alsoMoving: [] });
        // On home the orange went to the newer request that needs you, r6, which is where a fade from orange would show.
        if (!where.query) expect(await page!.evaluate(ORANGE_BUTTONS)).toContain(`${answers.button} r6`);
        if (!where.query) expect(await page!.evaluate(ORANGE_BUTTONS)).not.toContain(`${answers.button} r5`);
        // The change happened: r1 is drawn as one that needs you (a card, the area's main card, or the List's row), and
        // both arrivals are drawn.
        expect(await page!.evaluate(`[...document.querySelectorAll('[data-request-opener="r1"]')].some((opener) => opener.closest('[data-request-card="needs-check"], section[data-main-card="needs-check"], [data-list-group="needs-you"]'))`)).toBe(true);
        expect(await page!.evaluate(`['r6', 'r7'].filter((id) => document.querySelector('[data-request-opener="' + id + '"]'))`)).toEqual(['r6', 'r7']);
        // In Cards the change re-placed and added board cards, where a glide or an entrance would show: home's board
        // draws r6 and r7 among its cards; the area's page leads with r6 in its main card and its board draws r7 and r1.
        if (where.view === 'Cards') {
          const cards = await page!.evaluate(`({ board: [...document.querySelectorAll('[data-board-view] [data-request-card] [data-request-opener]')].map((opener) => opener.dataset.requestOpener),
            main: document.querySelector('section[data-main-card] [data-request-opener]')?.dataset.requestOpener ?? null })`);
          if (where.query) expect(cards).toEqual({ board: ['r7', 'r1'], main: 'r6' });
          else expect({ arrivedOnTheBoard: ['r6', 'r7'].every((id) => cards.board.includes(id)), main: cards.main }).toEqual({ arrivedOnTheBoard: true, main: null });
        }
        expect(fixtureErrors).toEqual([]);
      } finally {
        await closePage();
      }
    }, 60_000);
  }
}

/** A long title and a long area name for r1, so the List's Request cell has to share its room. */
const LONG_TITLE = 'Spec and wireframe the new work viewer, then check every page of it against the design review';
const LONG_AREA = 'Viewer, the live request monitor and every page around it';
/** The same name in Chinese: a cut name keeps its first letter, and a Chinese one is the widest of the UI's languages. */
const LONG_AREA_ZH = '查看器、实时请求监视器及其周围的每个页面';

for (const [scrollbar, areaName] of SCROLLBAR_MODES.flatMap((mode) => [LONG_AREA, LONG_AREA_ZH].map((name) => [mode, name] as const))) {
  it.skipIf(!chromeExecutablePath)(`in the List's table a request's title has its room before its area link: the link is cut first, at 1366 and 1440 with ${scrollbar.label}${areaName === LONG_AREA_ZH ? ', its area named in Chinese' : ''}`, async () => {
    try {
      await openPage(scrollbar.query, { width: 1440, height: 900 });
      await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r1' ? { ...request, title: ${JSON.stringify(LONG_TITLE)} } : request),
        focusAreas: model.focusAreas.map((area) => area.id === 'fa-viewer' ? { ...area, name: ${JSON.stringify(areaName)} } : area) }))`);
      await page!.evaluate(`[...document.querySelectorAll('[role=radio]')].find((item) => window.nameOf(item) === 'List').click()`);
      type AreaRow = { titleWidth: number; titleCut: boolean; areaWidth: number; areaFloor: number; areaCut: boolean; areaEllipsis: { whole: boolean } | null; areaTitle: string | null };
      const seen: Record<number, AreaRow | null> = {};
      for (const width of [1440, 1366]) {
        await resize(width);
        const row: AreaRow | null = await page!.evaluate(`(() => {
          const table = document.querySelector('table[aria-label]');
          if (!table) return null;
          const row = table.querySelector('[data-request-opener="r1"]').closest('tr');
          const title = row.querySelector('[data-row-title]');
          const area = row.querySelector('[data-row-area]');
          const areaText = area.querySelector('.truncate');
          const areaCut = !!areaText && areaText.scrollWidth > areaText.clientWidth + 1;
          return { titleWidth: window.round(title.getBoundingClientRect().width), titleCut: title.scrollWidth > title.clientWidth + 1,
            areaWidth: window.round(area.getBoundingClientRect().width), areaFloor: parseFloat(getComputedStyle(area).minWidth) || 0,
            areaCut, areaEllipsis: areaCut ? window.ellipsisRoom(areaText) : null, areaTitle: area.getAttribute('title') };
        })()`);
        seen[width] = row;
        console.log(`[focus-area-page] the List's r1 row at ${width} with ${scrollbar.label}: ${JSON.stringify(row)}`);
      }
      // Each width the table drew (with a classic scrollbar, 1366 is rows: LIST_TITLE_MIN_PX). The title yields only once
      // the link is down to its floor (its shrink is 100 times the title's; it kept up to 40% of the cell before, cutting
      // the title first: Phase 6 fix Q-M3); the cut link ends in a whole ellipsis after its mark and a letter, so it says
      // it is cut (at a 2rem floor the ellipsis showed one dot, "V.": Phase 6 fix 2); and it keeps its whole words as its
      // hover text. Every width is read before any is checked, so a failure names each one that fails.
      const checks = Object.entries(seen).filter((entry): entry is [string, AreaRow] => entry[1] !== null).map(([width, row]) => ({ width: Number(width),
        titleCutOnlyWithTheLinkAtItsFloor: !row.titleCut || (row.areaFloor > 0 && row.areaWidth <= row.areaFloor + 0.5), linkCutFirst: !row.titleCut || row.areaCut,
        cutLinkEndsInAWholeEllipsis: !row.areaCut || row.areaEllipsis!.whole, areaTitle: row.areaTitle }));
      expect(checks).toEqual(checks.map(({ width }) => ({ width, titleCutOnlyWithTheLinkAtItsFloor: true, linkCutFirst: true, cutLinkEndsInAWholeEllipsis: true, areaTitle: areaName })));
      expect(seen[1440]).not.toBeNull();
      expect(fixtureErrors).toEqual([]);
    } finally {
      await closePage();
    }
  }, 60_000);
}

/** What a screen reader reads inside the first element `selector` finds: the accessibility tree's text under it. */
async function screenReaderText(selector: string): Promise<string> {
  await page!.send('Accessibility.enable');
  const { root } = await page!.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page!.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`nothing matches ${selector}`);
  const { nodes } = await page!.send('Accessibility.queryAXTree', { nodeId, role: 'StaticText' });
  return nodes.filter((node: { ignored?: boolean }) => !node.ignored).map((node: { name?: { value?: string } }) => node.name?.value ?? '').join('');
}

/**
 * How a request's "Not sorted yet" reads in the List, for each one drawn: its words whole; cut with a whole ellipsis,
 * which says so; cut where its box has no room for a letter and the whole ellipsis ("clipped ellipsis": one dot, "N.");
 * or clipped without one (an element running past its own box, or a box cut by an ancestor that hides its overflow, with
 * no ellipsis drawn). Also its mark, its hover text, and whether it is in the table or a row.
 */
const NOT_SORTED_LOOKS = `[...document.querySelectorAll('[data-board-view] [data-focus-area="not-sorted"]')].filter(window.visible).map((chip, index) => {
  chip.setAttribute('data-test-chip', String(index));
  const words = chip.querySelector(':scope > span');
  const mark = chip.querySelector(':scope > svg');
  const range = document.createRange();
  range.selectNodeContents(words);
  const text = range.getBoundingClientRect();
  const box = words.getBoundingClientRect();
  let clipRight = Infinity;
  for (let element = words.parentElement; element && element !== document.documentElement; element = element.parentElement) {
    if (getComputedStyle(element).overflowX !== 'visible') clipRight = Math.min(clipRight, element.getBoundingClientRect().left + element.clientLeft + element.clientWidth);
  }
  const style = getComputedStyle(words);
  // Edges are fractional (the 17px root's rem); 1px covers their rounding, and a cut letter is wider than that.
  const runsPastItsBox = text.right > box.right + 1;
  const boxCut = box.right > clipRight + 1;
  const drawsAnEllipsis = style.textOverflow === 'ellipsis' && style.overflowX !== 'visible' && style.whiteSpace === 'nowrap';
  const ellipsis = runsPastItsBox && !boxCut && drawsAnEllipsis ? window.ellipsisRoom(words) : null;
  const row = chip.closest('tr, [data-request-row]');
  return { index, request: (row.matches('[data-request-opener]') ? row : row.querySelector('[data-request-opener]')).dataset.requestOpener, where: row.matches('tr') ? 'table' : 'row',
    look: !runsPastItsBox && !boxCut ? 'whole' : ellipsis ? (ellipsis.whole ? 'ellipsis' : 'clipped ellipsis') : 'clipped', ellipsis,
    markShown: mark.getBoundingClientRect().width > 0 && mark.getBoundingClientRect().right <= clipRight + 1,
    hover: chip.closest('[title]')?.getAttribute('title') ?? null, textWidth: window.round(text.width), boxWidth: window.round(box.width), clipRight: window.round(clipRight), boxRight: window.round(box.right) };
})`;

// Phase 6 fix 2: a request not sorted yet read "○ Not so" in the List table at 1366 and 1440 on the owner's data, cut
// mid-word with no ellipsis: its words were built to wrap, which the table's one-line row does not allow. In a one-line
// row it is cut the way a placed area is, its mark, a letter and a whole ellipsis; where the chip can wrap (the rows'
// facts line) it keeps wrapping.
for (const scrollbar of SCROLLBAR_MODES) {
  it.skipIf(!chromeExecutablePath)(`in the List a request not sorted yet reads its words whole or cut with a whole ellipsis, never clipped without one, the whole words in its hover text and for screen readers, at 1366 and 1440 with ${scrollbar.label}`, async () => {
    try {
      await openPage(scrollbar.query, { width: 1440, height: 900 });
      // r2 is not sorted yet in the sample; a long title leaves its area part at its floor. r1, out of its area, has a
      // short title, so its words have room.
      await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r2' ? { ...request, title: ${JSON.stringify(LONG_TITLE)} }
        : request.id === 'r1' ? { ...request, title: 'Fix it', focusAreaId: undefined } : request) }))`);
      await page!.evaluate(`[...document.querySelectorAll('[role=radio]')].find((item) => window.nameOf(item) === 'List').click()`);
      await waitFor(`document.querySelectorAll('[data-board-view] [data-focus-area="not-sorted"]').length >= 2`, 'both requests not sorted yet in the List');
      type Look = { index: number; request: string; where: string; look: string; markShown: boolean; hover: string | null };
      const seen: { width: number; look: Look; read: string }[] = [];
      for (const width of [1440, 1366]) {
        await resize(width);
        const looks: Look[] = await page!.evaluate(NOT_SORTED_LOOKS);
        console.log(`[focus-area-page] not sorted yet in the List at ${width} with ${scrollbar.label}: ${JSON.stringify(looks)}`);
        expect({ width, requests: looks.map((look) => look.request).sort() }).toEqual({ width, requests: ['r1', 'r2'] });
        for (const look of looks) seen.push({ width, look, read: await screenReaderText(`[data-test-chip="${look.index}"]`) });
      }
      console.log(`[focus-area-page] not sorted yet in the List with ${scrollbar.label}: ${JSON.stringify(seen.map(({ width, look }) => `${width} ${look.request} ${look.where} ${look.look}`))}`);
      // Every one, at each width, read before any is checked so a failure names each one that fails: whole, or cut with a
      // whole ellipsis after its mark and a letter, its mark shown; in the table, whose rows do not wrap, the whole words
      // are its hover text (a row's facts line wraps them, whole); a screen reader reads the whole words.
      const whole = (look: Look) => look.look === 'whole' || look.look === 'ellipsis';
      expect(seen.map(({ width, look, read }) => ({ width, request: look.request, look: whole(look) ? 'whole, or cut with a whole ellipsis' : look.look, markShown: look.markShown, hover: look.where === 'table' ? look.hover : 'Not sorted yet', read })))
        .toEqual(seen.map(({ width, look }) => ({ width, request: look.request, look: 'whole, or cut with a whole ellipsis', markShown: true, hover: 'Not sorted yet', read: 'Not sorted yet' })));
      // The table, where the cut happened, is drawn at 1440 in both modes (LIST_TITLE_MIN_PX), and r2's words are cut there.
      expect(seen.filter(({ width, look }) => width === 1440 && look.request === 'r2').map(({ look }) => `${look.where} ${look.look}`)).toEqual(['table ellipsis']);
      expect(fixtureErrors).toEqual([]);
    } finally {
      await closePage();
    }
  }, 60_000);
}

it.skipIf(!chromeExecutablePath)('By agent rows on Requests give a long name as many lines as it needs, whole', async () => {
  try {
    await openPage('&view=requests&by=agent');
    const name = 'Read the current usage rollup, then compare it with last month’s and write down every place the two disagree, and then say which of the disagreements came from a late sync rather than from a real change in usage';
    await page!.evaluate(`window.store.getState().updateSampleRequest('r2', (request) => ({ ...request, title: ${JSON.stringify(name)} }))`);
    await waitFor(`document.querySelector('[data-agent-group]')`, 'the agent groups');
    // Every agent's group open, so r2's row is drawn wherever its agent sits.
    await page!.evaluate(`[...document.querySelectorAll('[data-agent-group][data-state=closed] [data-agent-header]')].forEach((header) => header.click())`);
    await waitFor(`[...document.querySelectorAll('[data-agent-group] [data-row-title]')].some((title) => title.textContent.includes('usage rollup'))`, 'r2 in its agent');
    for (const width of [1440, 768]) {
      await resize(width);
      const title = await page!.evaluate(`(() => {
        const words = [...document.querySelectorAll('[data-agent-group] [data-row-title]')].find((each) => each.textContent.includes('usage rollup'));
        const style = getComputedStyle(words);
        return { whole: words.scrollWidth <= words.clientWidth + 1 && style.textOverflow !== 'ellipsis' && style.whiteSpace !== 'nowrap', lines: Math.round(words.getBoundingClientRect().height / parseFloat(style.lineHeight)) };
      })()`);
      console.log(`[focus-area-page] By agent's long name at ${width}: ${JSON.stringify(title)}`);
      expect(title.whole).toBe(true);
      expect(title.lines).toBeGreaterThanOrEqual(2);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('a Try again that leaves nothing unreadable sends focus to the board’s heading, where the last Dismiss sends it, never the page body', async () => {
  try {
    await openPage(sampleState('read-errors'));
    await waitFor(`document.querySelector('[data-read-errors="shown"]')`, 'the read-error card');
    // The next read finds nothing unreadable (the sample reads its state from the address on every load).
    await page!.evaluate(`history.replaceState(null, '', location.pathname + '?source=sample')`);
    await pressNamed('[data-read-errors="shown"] button', '^Try again$');
    await waitFor(`!document.querySelector('[data-read-errors]')`, 'the card to leave');
    await page!.settle();
    expect(await page!.evaluate(`({ id: document.activeElement?.id ?? null, heading: document.activeElement?.hasAttribute('data-view-heading') ?? false, body: document.activeElement === document.body })`))
      .toEqual({ id: 'all-requests', heading: true, body: false });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

it.skipIf(!chromeExecutablePath)('My Rules’ two Copy buttons say "Could not copy" on a page with no clipboard (plain http at a LAN address)', async () => {
  try {
    await openPage('&view=rules');
    await page!.evaluate('window.noClipboard = true');
    await waitFor(`[...document.querySelectorAll('button')].some((button) => window.nameOf(button) === 'Copy path')`, 'Copy path');
    await pressNamed('button', '^Copy path$');
    await waitFor(`[...document.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent === 'Could not copy. Select the text and copy it yourself.')`, 'Copy path’s failure');
    await pressNamed('button', '^Preview file');
    await waitFor(`document.querySelector('[role="dialog"]')`, 'the file preview');
    await pressNamed('[role="dialog"] button', '^Copy$');
    await waitFor(`[...document.querySelectorAll('[role="dialog"] [role="alert"]')].some((alert) => alert.textContent === 'Could not copy. Select the text and copy it yourself.')`, 'Copy’s failure in the preview');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

/**
 * The page reads `id`'s detail through a stand-in for the worker (the store's loadRequestDetail) whose every read waits
 * for the test: window.detailReads lists the versions asked for, window.answerDetail(version) brings back the request's
 * full record (its conversations too), window.failDetail(version, reason) fails that read.
 */
const installDetailReads = (id: string) => page!.evaluate(`(() => {
  const full = window.model().requests.find((request) => request.id === ${JSON.stringify(id)});
  const waiting = {};
  window.detailReads = [];
  window.answerDetail = (version) => waiting[version].resolve({ ...full, detailRevision: version });
  window.failDetail = (version, reason) => waiting[version].reject(new Error(reason));
  window.store.setState({ loadRequestDetail: (request) => {
    window.detailReads.push(request.detailRevision);
    return new Promise((resolve, reject) => { waiting[request.detailRevision] = { resolve, reject }; });
  } });
})()`);
/** `id` as the live overview sends it at `version`: its conversations left out, its detail to be read. */
const compactVersion = (id: string, version: string) => page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === ${JSON.stringify(id)}
  ? { ...request, detailLoaded: false, detailRevision: ${JSON.stringify(version)}, conversations: [] } : request) }))`);
const MAIN_CARD_BOX = 'section[data-main-card] [data-slot="reply-card"] textarea';

// Phase 6 fix Q-H1: a newer version of the main card's own request kept nothing of what was typed.
it.skipIf(!chromeExecutablePath)('the main card keeps its reply box, the words typed in it and its focus while a newer version of its request is read, and when that read fails', async () => {
  try {
    await openPage(`${sampleState('reply-card')}&focus=other`);
    await waitFor(`document.querySelector('${MAIN_CARD_BOX}')`, 'the main card’s reply box');
    await installDetailReads('r5');
    await compactVersion('r5', 'v1');
    await waitFor(`window.detailReads.length === 1`, 'the first read');
    await page!.evaluate(`window.answerDetail('v1')`);
    await waitFor(`document.querySelector('${MAIN_CARD_BOX}')`, 'the reply box from the first read');
    // The owner types a reply, in the box that has focus.
    await page!.evaluate(`(() => { const box = document.querySelector('${MAIN_CARD_BOX}'); box.dataset.testBox = 'typed-in'; box.focus(); window.typeInto(box, 'Keep the usage forecast.'); })()`);
    const box = () => page!.evaluate(`(() => { const box = document.querySelector('${MAIN_CARD_BOX}'); return { same: box?.dataset.testBox === 'typed-in', value: box?.value ?? null, focused: !!box && document.activeElement === box,
      read: document.querySelector('section[data-main-card] [data-main-card-read]')?.dataset.mainCardRead ?? null }; })()`);
    expect(await box()).toEqual({ same: true, value: 'Keep the usage forecast.', focused: true, read: null });
    // A newer version arrives while the owner types (the review or the title writer landed on it): its read runs.
    await compactVersion('r5', 'v2');
    await waitFor(`window.detailReads.length === 2`, 'the newer version’s read');
    expect(await box()).toEqual({ same: true, value: 'Keep the usage forecast.', focused: true, read: null });
    await page!.evaluate(`window.answerDetail('v2')`);
    await page!.settle();
    expect(await box()).toEqual({ same: true, value: 'Keep the usage forecast.', focused: true, read: null });
    // A newer version whose read fails: the box stays, with the failure beside it and Try again.
    await compactVersion('r5', 'v3');
    await waitFor(`window.detailReads.length === 3`, 'the third version’s read');
    await page!.evaluate(`window.failDetail('v3', 'The worker answered 503 Service Unavailable.')`);
    await waitFor(`document.querySelector('section[data-main-card] [data-main-card-read="newer-version-failed"]')`, 'the newer version’s failure');
    expect(await box()).toEqual({ same: true, value: 'Keep the usage forecast.', focused: true, read: 'newer-version-failed' });
    expect(await page!.evaluate(`document.querySelector('[data-main-card-read="newer-version-failed"] p').textContent`)).toBe('Could not load the newest version of this request. This is the version read before it.');
    await pressNamed('[data-main-card-read="newer-version-failed"] button', '^Try again$');
    await waitFor(`window.detailReads.length === 4`, 'the read again');
    await page!.evaluate(`window.answerDetail('v3')`);
    await waitFor(`!document.querySelector('[data-main-card-read="newer-version-failed"]')`, 'the failure to go');
    expect((await box()).value).toBe('Keep the usage forecast.');
    expect(await page!.evaluate('window.detailReads')).toEqual(['v1', 'v2', 'v3', 'v3']);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M3: the main card's reading and failed states, and its Try again, had no test.
it.skipIf(!chromeExecutablePath)('the main card says it is reading its request’s conversations, then why they could not be read, and Try again reads them again', async () => {
  try {
    await openPage(`${sampleState('reply-card')}&focus=other`);
    await waitFor(`document.querySelector('${MAIN_CARD_BOX}')`, 'the main card’s reply box');
    await installDetailReads('r5');
    await compactVersion('r5', 'v1');
    const read = () => page!.evaluate(`(() => {
      const part = document.querySelector('section[data-main-card] [data-main-card-read]');
      return part ? { state: part.dataset.mainCardRead, role: part.querySelector('p').getAttribute('role'), words: part.querySelector('p').textContent,
        skeleton: !!part.querySelector('[data-slot="skeleton"]'), details: !!part.querySelector('[data-slot="collapsible-fold-trigger"]'),
        tryAgain: [...part.querySelectorAll('button')].some((button) => window.nameOf(button) === 'Try again'), box: !!document.querySelector('${MAIN_CARD_BOX}') } : null;
    })()`);
    await waitFor(`window.detailReads.length === 1`, 'the read');
    expect(await read()).toEqual({ state: 'reading', role: 'status', words: 'Reading this request’s conversations…', skeleton: true, details: false, tryAgain: false, box: false });
    await page!.evaluate(`window.failDetail('v1', 'The worker answered 503 Service Unavailable.')`);
    await waitFor(`document.querySelector('[data-main-card-read="failed"]')`, 'the failure');
    expect(await read()).toEqual({ state: 'failed', role: 'alert', words: 'This request’s conversations could not be read here. Reply opens them in the request.', skeleton: false, details: true, tryAgain: true, box: false });
    await pressNamed('[data-main-card-read="failed"] button', '^Try again$');
    await waitFor(`window.detailReads.length === 2`, 'the read again');
    expect((await read())?.state).toBe('reading');
    await page!.evaluate(`window.answerDetail('v1')`);
    await waitFor(`document.querySelector('${MAIN_CARD_BOX}')`, 'the reply box');
    expect(await read()).toBeNull();
    // Phase 6 fix AP-L9: the card's start by the card's and the drawer's rule (recordedStart): a start recorded only as
    // words (a fixture, an older model) is a start, said in the reader's words; the legacy words for none say none.
    // The start's own span: the shortest that starts with "Started" (the one around it also holds how long it has run).
    const started = () => page!.evaluate(`[...document.querySelectorAll('section[data-main-card] span')].map((span) => span.textContent).filter((text) => text.startsWith('Started')).sort((a, b) => a.length - b.length)[0] ?? null`);
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r5' ? { ...request, startedAt: 'Oct 20, 12:40 pm', startedAtIso: undefined } : request) }))`);
    await waitFor(`document.querySelector('section[data-main-card]').textContent.includes('Oct 20, 12:40 pm')`, 'the start from its words');
    expect(await started()).toBe('StartedOct 20, 12:40 pm');
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r5' ? { ...request, startedAt: 'Start not recorded', startedAtIso: undefined } : request) }))`);
    await waitFor(`!document.querySelector('section[data-main-card]').textContent.includes('Oct 20, 12:40 pm')`, 'the start gone');
    expect(await started()).toBe('StartedStart not recorded');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M2: the main card's request part was not keyed by its request.
it.skipIf(!chromeExecutablePath)('when the next request that needs you takes the main card, it has its own reply box, and the drawer gives focus back by the one rule, never to the next request’s title', async () => {
  try {
    await openPage(`${sampleState('reply-card')}&focus=other`);
    await waitFor(`document.querySelector('${MAIN_CARD_BOX}')`, 'the main card’s reply box');
    // A second request waits on you in Other, newer than r5, with conversations to answer: it leads the card.
    await page!.evaluate(`window.receive((model) => { const conversations = model.requests.find((request) => request.id === 'r5').conversations;
      return { ...model, requests: model.requests.map((request) => request.id === 'r2' ? { ...request, focusAreaId: 'other', state: 'your-move', next: { who: 'human', text: 'Pick a forecast' }, conversations } : request) }; })`);
    await waitFor(`document.querySelector('section[data-main-card] [data-request-opener="r2"]') && document.querySelector('${MAIN_CARD_BOX}')`, 'r2 leading with its reply box');
    await page!.evaluate(`window.typeInto(document.querySelector('${MAIN_CARD_BOX}'), 'A reply meant for this request only')`);
    // Open r2 from its title; it is answered while its drawer is open, and r5 takes the card.
    await page!.evaluate(`document.querySelector('section[data-main-card] [data-request-opener="r2"]').focus()`);
    await press('Enter');
    await waitFor(`document.querySelector('[role="dialog"]')`, 'r2’s drawer');
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r2' ? { ...request, state: 'working', stage: 'Building', next: { who: 'bot', text: 'Answer the reply' } } : request) }))`);
    await waitFor(`document.querySelector('section[data-main-card] [data-request-opener="r5"]')`, 'r5 leading');
    expect(await page!.evaluate(`document.querySelector('${MAIN_CARD_BOX}')?.value ?? null`)).toBe('');
    await press('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'the drawer to close');
    expect(await page!.evaluate(`({ opener: document.activeElement?.dataset.requestOpener ?? null, inMainCard: !!document.activeElement?.closest('section[data-main-card]'), body: document.activeElement === document.body })`))
      .toEqual({ opener: 'r2', inMainCard: false, body: false });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M3: Other's "not counted" row had no test.
it.skipIf(!chromeExecutablePath)('Other says which requests its percent leaves out, and "Show them" names each as a way into its request', async () => {
  try {
    await openPage('&focus=other');
    // r2 joins Other with no review yet; r5 is reviewed at 30%.
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r2' ? { ...request, focusAreaId: 'other' } : request) }))`);
    await waitFor(`document.querySelector('[data-not-counted]')`, 'the not-counted row');
    const row = () => page!.evaluate(`(() => { const row = document.querySelector('[data-not-counted]'); return { words: row.querySelector('p span').textContent,
      toggle: [...row.querySelectorAll('button')].map((button) => window.nameOf(button)).find((name) => /them$/.test(name)), names: [...row.querySelectorAll('li')].filter(window.visible).map((item) => item.textContent) }; })()`);
    expect(await row()).toEqual({ words: 'Not counted in the 30%: 1 request with no review yet', toggle: 'Show them', names: [] });
    await pressNamed('[data-not-counted] button', '^Show them$');
    await waitFor(`[...document.querySelectorAll('[data-not-counted] li')].some(window.visible)`, 'the names');
    expect(await row()).toEqual({ words: 'Not counted in the 30%: 1 request with no review yet', toggle: 'Hide them', names: ['Show real usage on the price forecast page'] });
    await pressNamed('[data-not-counted] li button', '^Show real usage on the price forecast page$');
    await waitFor(`document.querySelector('[role="dialog"]') && window.store.getState().view.openRequest?.id === 'r2'`, 'r2’s drawer');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix Q-M3: the breadcrumb had no test.
// The crumb names Focus areas as the bar does (src/ui/app-places.ts); it said "Focus overview" before the design pass Phase 3 fixes.
it.skipIf(!chromeExecutablePath)('the breadcrumb is a real link to Focus areas, named as the bar names it, and a plain press moves there in the page, without a reload', async () => {
  try {
    await openPage('&focus=fa-sync');
    const crumbs = await page!.evaluate(`(() => { const nav = document.querySelector('nav[aria-label="breadcrumb"], nav[aria-label="Breadcrumb"]');
      const link = nav.querySelector('a[href]'); const url = new URL(link.href);
      return { link: link.textContent, source: url.searchParams.get('source'), focus: url.searchParams.get('focus'), view: url.searchParams.get('view'), hash: url.hash, current: nav.querySelector('[aria-current="page"]')?.textContent ?? null }; })()`);
    expect(crumbs).toEqual({ link: myWorkPlace('focus').label, source: 'sample', focus: null, view: 'focus', hash: '', current: 'Cloud sync' });
    // A plain press is the page's to handle: it moves in place and stops the browser's own navigation (whose address is
    // the one the press already moved to, so only the press itself shows it).
    // The bar's Focus areas has the same words, so the press is aimed at the crumb's own nav.
    const crumbLink = 'nav[aria-label="breadcrumb"] a[href], nav[aria-label="Breadcrumb"] a[href]';
    await page!.evaluate(`window.notReloaded = true; window.addEventListener('click', (event) => { if (event.target.closest?.(${JSON.stringify(crumbLink)})) window.pressHandledInThePage = event.defaultPrevented; })`);
    await pressNamed(crumbLink, `^${myWorkPlace('focus').label}$`);
    await waitFor(`!new URLSearchParams(location.search).get('focus') && new URLSearchParams(location.search).get('view') === 'focus' && document.getElementById('focus-areas')`, 'Focus areas');
    expect(await page!.evaluate('({ notReloaded: window.notReloaded === true, handledInThePage: window.pressHandledInThePage === true })')).toEqual({ notReloaded: true, handledInThePage: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

/** English words a time must never carry in another language (Phase 6 verify V3: "lancée 14 nov. at 11:06"). */
const ENGLISH_TIME_WORDS = /\b(at|am|pm|AM|PM|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

/**
 * The page's clock for a test of fixed instants' words (`clock=`, pinnedClockFor), the instant the bun process's clock
 * reads in tests/ui-display-time.test.ts: a day of 2026 that is none of the instants' own days, so a fixed 2026 instant
 * reads as another day of this year, with no year, on any run date. On the real clock this test passed only in 2026: from
 * 2027-01-01 it read "20 oct. 2026, 13:17", and on an instant's own day it would read the clock alone (Phase 6 re-verify).
 */
const PINNED_NOW = '2026-11-17T10:00:00-08:00';

// Phase 6 fix V3: every time from the one formatter, from the recorded instant, the date-and-time join in the reader's words.
it.skipIf(!chromeExecutablePath)('in French and in Korean no time on the cards or in the drawer carries an English word, whether the model has its instant or only English words', async () => {
  try {
    await openPage(`&clock=${encodeURIComponent(PINNED_NOW)}`);
    expect(await page!.evaluate('new Date().toISOString()')).toBe(new Date(PINNED_NOW).toISOString());
    // r1 as this build's mapper writes it in a browser that joins en-US with "at": English words beside each instant. The
    // words are a minute behind the instant here, so a screen that printed the words instead would show the wrong minute.
    // r3 as a fixture or an older model carries it: English words only, which the one formatter says in the reader's words.
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'r1' ? { ...request,
        startedAt: 'Oct 20 at 1:16 pm', startedAtIso: '2026-10-20T13:17:00-07:00',
        progress: { ...request.progress, reviewedAt: 'Oct 19', reviewedAtIso: '2026-10-20T13:50:00-07:00' },
        conversations: request.conversations.map((conversation, index) => ({ ...conversation, at: 'Oct 20 at 1:' + (16 + index * 8) + ' pm', atIso: '2026-10-20T13:' + (17 + index * 8) + ':00-07:00' })) }
      : request.id === 'r3' ? { ...request, startedAt: 'Oct 17 at 7:55 am', startedAtIso: undefined } : request) }))`);
    // French reads a 24-hour clock with two-digit hours ("07:55"), as tests/ui-display-time.test.ts holds it.
    const expected = { fr: { start: '20 oct., 13:17', words: '17 oct., 07:55', conversations: ['20 oct., 13:17', '20 oct., 13:25'], reviewed: '20 oct.' },
      ko: { start: '10월 20일 오후 1:17', words: '10월 17일 오전 7:55', conversations: ['10월 20일 오후 1:17', '10월 20일 오후 1:25'], reviewed: '10월 20일' } } as const;
    for (const locale of ['fr', 'ko'] as const) {
      await page!.evaluate(`window.setLocale(${JSON.stringify(locale)})`);
      await page!.settle();
      const cards = await page!.evaluate(`(() => {
        const card = (id) => document.querySelector('[data-slot="card"] [data-request-opener="' + id + '"]').closest('[data-slot="card"]');
        return { start: [...card('r1').querySelectorAll('dd')][1].textContent, words: [...card('r3').querySelectorAll('dd')][1].textContent,
          review: card('r1').querySelector('[data-slot="progress"]')?.parentElement?.parentElement?.innerText ?? '' };
      })()`);
      await page!.evaluate(`window.store.getState().openRequestDrawer(window.model().requests.find((request) => request.id === 'r1'))`);
      await waitFor(`document.querySelector('[role="dialog"] p.tabular')`, 'r1’s drawer');
      await pressNamed('[role="dialog"] [data-slot="collapsible-fold-trigger"]', locale === 'fr' ? '^Origine' : '^출처');
      await waitFor(`document.querySelectorAll('[role="dialog"] time').length >= 2`, 'the conversations’ times');
      const drawer = await page!.evaluate(`({ facts: [...document.querySelectorAll('[role="dialog"] p.tabular')].map((line) => line.textContent).find((text) => text.includes('Alex')) ?? null,
        times: [...document.querySelectorAll('[role="dialog"] time')].map((time) => time.textContent) })`);
      await press('Escape');
      await waitFor(`!document.querySelector('[role="dialog"]')`, 'the drawer to close');
      console.log(`[focus-area-page] times in ${locale}: ${JSON.stringify({ cards, drawer })}`);
      expect({ start: cards.start, words: cards.words, conversations: drawer.times, reviewed: cards.review.includes(expected[locale].reviewed) })
        .toEqual({ start: expected[locale].start, words: expected[locale].words, conversations: expected[locale].conversations, reviewed: true });
      expect(drawer.facts).toContain(expected[locale].start);
      for (const text of [cards.start, cards.words, cards.review, drawer.facts ?? '', ...drawer.times]) expect({ text, english: ENGLISH_TIME_WORDS.test(text) }).toEqual({ text, english: false });
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

// Phase 6 fix V4: sample pages ran 1px sideways at 1440 and 1366 (the sample strip's close button's hit area).
for (const scrollbar of SCROLLBAR_MODES) {
  it.skipIf(!chromeExecutablePath)(`sample pages do not scroll sideways at 1440 and 1366, with ${scrollbar.label}`, async () => {
    try {
      await openPage(scrollbar.query);
      for (const query of ['', '&focus=fa-sync']) {
        if (query) await page!.evaluate(`window.store.getState().goToFocus('fa-sync')`);
        for (const width of [1440, 1366]) {
          await resize(width);
          await waitFor(`document.querySelector('[data-slot="work-shell"] main') && window.scrollY === 0`, 'the page at its top, the sample strip open');
          const fit = pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), width);
          console.log(`[focus-area-page] sample${query || ' home'} at ${width} with ${scrollbar.label}: ${JSON.stringify(fit)}`);
          expect(fit).toMatchObject(FITS_THE_WINDOW);
        }
      }
      expect(fixtureErrors).toEqual([]);
    } finally {
      await closePage();
    }
  }, 60_000);
}

// Phase 6 fix V7: the ticker counted every area's working requests while the Working filter beside it counted the page's.
it.skipIf(!chromeExecutablePath)('the change ticker watches the working requests the Working filter counts, on an area’s page and on home', async () => {
  try {
    await openPage('&focus=fa-sync');
    const counts = () => page!.evaluate(`(() => {
      const watching = /Watching (\\d+) working/.exec(document.querySelector('[data-ticker="quiet"]')?.textContent ?? '')?.[1];
      const chip = [...document.querySelectorAll('[role="radio"]')].find((item) => window.nameOf(item).startsWith('Working'));
      return { watching: watching === undefined ? null : Number(watching), filter: chip ? Number(chip.querySelector('.mono-number').textContent) : null };
    })()`);
    await waitFor(`document.querySelector('[data-ticker="quiet"]')`, 'the ticker at rest');
    // Cloud sync has nothing working; r1 (Viewer) and r2 (no area) work elsewhere.
    expect(await counts()).toEqual({ watching: 0, filter: 0 });
    await page!.evaluate(`window.store.getState().goToPage('work')`);
    await waitFor(`!new URLSearchParams(location.search).get('focus')`, 'home');
    expect(await counts()).toEqual({ watching: 2, filter: 2 });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, 60_000);

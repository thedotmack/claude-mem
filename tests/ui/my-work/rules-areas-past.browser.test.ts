import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, FITS_THE_WINDOW, htmlResponse, launchChrome, myWorkFontResponse, PAGE_WIDTHS, pageFitsTheWindow, scriptResponse, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { THEME_PRE_PAINT_SCRIPT } from '../../../src/ui/my-work/src/lib/theme-pre-paint';
import { RULE_DECISIONS } from '../../../src/ui/my-work/src/live/rule-actions';
import { SUGGESTION_DECISIONS } from '../../../src/ui/my-work/src/live/to-focus-model';
import { SAMPLE_STATES } from '../../../src/ui/my-work/src/live/sample-source';

failOnCiWithoutChrome('CI requires Chrome for the My Rules, Suggested areas and Past focus regressions.');

/**
 * My Rules, Suggested areas and Past focus (Phase 7 of the pro-max-v16 plan and its fix round), on the real App with
 * the sample source, the app's real stylesheet and its Geist font:
 * - G1: each page holds one solid orange button, which moves on after a decision; no decision card is an alert;
 * - the phone's bottom bar never covers Approve or Reject at 390, at any scroll position, and the rule's sentence is
 *   whole on the first screen and while Approve or Reject has focus;
 * - G16/G17: dimmed buttons say what they wait for; failures read in plain words with the raw cause under Details;
 * - quality M1-M5: the card stays on the rule being read; the editor opens clean; a month keeps its state when the
 *   months are reordered; a scope id with spaces; focus after each kind of press;
 * - G4, G5, G10, swipe to decide, the phone chip rows' cue, and the reader's language for numbers and record words.
 * Decision and state values come from their one definitions (state-machines.md), never typed again here.
 */
const [APPROVED, REJECTED] = RULE_DECISIONS;
const [KEPT] = SUGGESTION_DECISIONS;
const sampleState = (name: (typeof SAMPLE_STATES)[number]) => {
  const state = SAMPLE_STATES.find((entry) => entry === name);
  if (!state) throw new Error(`No sample state ${name} in SAMPLE_STATES`);
  return state;
};

const KEYS = {
  Tab: { code: 'Tab', keyCode: 9, text: undefined }, Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27, text: undefined },
} as const;

let server: ReturnType<typeof Bun.serve> | undefined;
let fixtureUrl = '';
let markReady: () => void = () => {};
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];

async function press(key: keyof typeof KEYS) {
  const { code, keyCode, text } = KEYS[key];
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page!.settle();
}

/** Focuses the element `expression` finds and presses Enter on it, as a keyboard user would. */
async function pressEnterOn(expression: string) {
  await page!.evaluate(`(${expression}).focus()`);
  await press('Enter');
}

/** Each test gets its own Chrome on the one compiled fixture (as app-shell.browser.test.ts does), opened at `query`. */
async function openPage(query: string) {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${fixtureUrl}${query}`;
  chrome = launchChrome(url, { profilePrefix: 'claude-mem-rules-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The App with sample data drew its first page in 1.0–2.0s in app-shell.browser.test.ts (2026-11-16); 20s is for a
  // cold Chrome on a CI runner.
  await withTimeout(ready, 20_000, 'My Work fixture did not draw its page');
  page = await connectToPage(chrome, url);
}

async function closePage() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Waits until `expression` is truthy in the page. Every wait here is for a frame or two of React work, or a lazy page chunk. */
async function waitFor(expression: string, what: string) {
  // React commits within one or two frames and the page chunks are in the one bundle; 5s is for a cold CI runner.
  await withTimeout(page!.evaluate(`new Promise((resolve) => { const check = () => (${expression}) ? resolve(true) : requestAnimationFrame(check); check(); })`), 5_000, `timed out waiting for ${what}`);
}

async function desktop() {
  await page!.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page!.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page!.evaluate('window.scrollTo(0, 0)');
  await page!.settle();
}

async function phone(width = 390) {
  await page!.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
  await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page!.evaluate('window.scrollTo(0, 0)');
  await page!.settle();
}

/** Moves to another page of the App and back, so the page under test mounts afresh on the model now in the store. */
async function remount(view: string) {
  await page!.evaluate(`history.pushState(null, "", "?source=sample&view=suggested"); dispatchEvent(new PopStateEvent("popstate"))`);
  await waitFor('window.buttonsNamed("^Keep$").length > 0', 'Suggested areas');
  await page!.evaluate(`history.pushState(null, "", "?source=sample&view=${view}"); dispatchEvent(new PopStateEvent("popstate"))`);
  await page!.settle();
}

/** Adds rules (and scopes) to the model in the store, as a live update would. */
async function addToModel(fields: { rules?: string; ruleScopes?: string; rulesLearning?: string }) {
  await page!.evaluate(`(() => {
    const state = window.store.getState();
    const model = state.work.load.model;
    state.receiveWorkModel({ ...model, rules: [...model.rules, ...(${fields.rules ?? '[]'})], ruleScopes: ${fields.ruleScopes ?? 'model.ruleScopes'}, rulesLearning: ${fields.rulesLearning ?? 'model.rulesLearning'} });
  })()`);
  await page!.settle();
}

/** A waiting rule copied from the sample's first one, with new words and strength (timesSeen; days since). */
const waitingRule = (id: string, then: string, timesSeen: number, latestDaysAgo: number) =>
  `({ ...window.store.getState().work.load.model.rules.find((rule) => rule.status === 'suggested'), id: ${JSON.stringify(id)}, then: ${JSON.stringify(then)}, when: '', timesSeen: ${timesSeen}, latestDaysAgo: ${latestDaysAgo} })`;

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // The application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());
  // The stylesheet's @font-face rules ask for ./files/<name>.woff2 (Geist and Geist Mono); widths depend on the font,
  // so the real files are served (myWorkFontResponse).
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
    createRoot(document.getElementById('root')).render(<App />);
    (function waitForPage() {
      if (document.querySelector('[data-slot="work-shell"] main section, [data-slot="work-shell"] main [data-slot="empty"]')) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForPage);
    })();
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    const nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    window.nameOf = nameOf;
    // Solid orange buttons: the Button primitive's default variant. Their whole names are compared.
    window.orangeButtons = () => [...document.querySelectorAll('button[data-variant="default"], a[data-variant="default"]')].filter(visible).map(nameOf);
    window.buttonsNamed = (pattern) => [...document.querySelectorAll('button')].filter((button) => visible(button) && new RegExp(pattern).test(nameOf(button)));
    window.clickNamed = (pattern) => { const button = window.buttonsNamed(pattern)[0]; if (!button) throw new Error('no button ' + pattern); button.click(); };
    // The phone's pinned bottom bar (components/app-bar.tsx AppBottomBar, shown under md).
    window.bottomBar = () => {
      const bar = document.querySelector('[data-slot="bottom-bar"]');
      return bar && visible(bar) ? bar.getBoundingClientRect() : null;
    };
    // Approve and Reject buttons a visible part of which the bar covers.
    window.decisionButtonsUnderBar = () => {
      const bar = window.bottomBar();
      if (!bar) return ['no bottom bar'];
      return window.buttonsNamed('^(Approve|Reject)$').filter((button) => { const box = button.getBoundingClientRect(); return box.bottom > bar.top && box.top < bar.bottom && box.top < innerHeight; }).map(nameOf);
    };
    window.currentRuleId = () => document.querySelector('#decide [data-slot=confirmation][id^=decide-]')?.id.slice('decide-'.length) ?? null;
    window.upNextIds = () => [...document.querySelectorAll('#decide [data-slot=queue-row]')].map((row) => row.dataset.ruleId);
    // Where focus is, and whether it shows (the Button ring is a box-shadow).
    window.focusInfo = () => {
      const element = document.activeElement;
      return { tag: element.tagName, slot: element.dataset.slot ?? null, step: element.dataset.step ?? null, name: nameOf(element).slice(0, 60),
        queueTarget: element.hasAttribute('data-queue-focus'), focusVisible: element.matches(':focus-visible'), ring: getComputedStyle(element).boxShadow !== 'none' };
    };
    // Parts of an element's text that are off screen or under something else: each line box, tested at its left, middle
    // and right with elementFromPoint.
    window.hiddenParts = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1).flatMap((rect) => [rect.left + 2, (rect.left + rect.right) / 2, rect.right - 2].map((x) => {
        const y = (rect.top + rect.bottom) / 2;
        const hit = y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
        return hit && element.contains(hit) ? null : { x: Math.round(x), y: Math.round(y), hit: hit ? (hit.closest('[data-slot]')?.dataset.slot ?? hit.tagName) : 'off screen' };
      }).filter(Boolean));
    };
    // How many characters each rendered line of an element holds.
    window.lineLengths = (element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const lines = new Map();
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let index = 0; index < node.length; index++) {
          range.setStart(node, index); range.setEnd(node, index + 1);
          const rect = range.getClientRects()[0];
          if (rect) lines.set(Math.round(rect.top), (lines.get(Math.round(rect.top)) ?? 0) + 1);
        }
      }
      return [...lines.values()];
    };
    // A text that shows whole: not cut to one line with an ellipsis, and nothing past its box.
    window.showsWhole = (element) => { const style = getComputedStyle(element); return style.textOverflow !== 'ellipsis' && style.whiteSpace !== 'nowrap' && element.scrollWidth <= element.clientWidth + 1; };
  `, ['--loader:.webp=empty', '--loader:.css=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty']);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>${THEME_PRE_PAINT_SCRIPT}</script><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
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

// Each test opens Chrome and the whole App (1–2s locally); 60s leaves room for a cold CI runner and the waits inside.
const TEST_LIMIT_MS = 60_000;

it.skipIf(!chromeExecutablePath)('each page holds one orange button, which moves on after a decision, and no decision card is an alert', async () => {
  try {
    await openPage('&view=rules');
    for (const size of [desktop, phone]) {
      await size();
      await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
      expect(await page!.evaluate('window.orangeButtons()')).toEqual(['Approve']);
      // Decision cards are cards: no alert and no status region among them (D b2 M49).
      expect(await page!.evaluate('document.querySelectorAll("[data-slot=confirmation][role]").length')).toBe(0);
      expect(await page!.evaluate('document.querySelectorAll("[role=alert]").length')).toBe(0);
    }
    // Plan rule 6: the scope pointer's 44px on touch comes from the Button primitive, not a page class.
    expect(await page!.evaluate('Math.min(...window.buttonsNamed("suggested · review above").map((button) => button.getBoundingClientRect().height))')).toBeGreaterThanOrEqual(44);
    await desktop();
    expect(await page!.evaluate('Math.min(...[...document.querySelectorAll("nav[aria-label=Scopes] button")].filter((button) => button.getBoundingClientRect().height > 0).map((button) => button.getBoundingClientRect().height))')).toBeGreaterThanOrEqual(44);
    // A middle rule: the queue's second rule, from Up next. Deciding it moves the card to the rule after it, not back
    // to the first.
    const first = await page!.evaluate('window.currentRuleId()');
    const [second] = await page!.evaluate('window.upNextIds()');
    await page!.evaluate(`document.querySelector('#decide [data-slot=queue-row][data-rule-id="${second}"]').click()`);
    await waitFor(`window.currentRuleId() === "${second}"`, 'the second rule as the card');
    const [afterSecond] = await page!.evaluate('window.upNextIds()');
    expect(afterSecond).not.toBe(first);
    await page!.evaluate('window.clickNamed("^Approve$")');
    await waitFor(`document.querySelector("[data-slot=decision-result][data-decision=${APPROVED}]") && window.currentRuleId() === "${afterSecond}"`, 'the rule after the decided one');
    expect(await page!.evaluate('window.buttonsNamed("^Undo$").length > 0')).toBe(true);
    expect(await page!.evaluate('window.orangeButtons()')).toEqual(['Approve']);
    // The page's other places to decide have no orange either.
    await page!.evaluate('history.pushState(null, "", "?source=sample&view=suggested"); dispatchEvent(new PopStateEvent("popstate"))');
    await waitFor('window.buttonsNamed("^Keep$").length > 0', 'Suggested areas');
    expect(await page!.evaluate('window.orangeButtons()')).toEqual(['Keep']);
    const keeps = await page!.evaluate('window.buttonsNamed("^Keep$").map((button) => button.dataset.variant)');
    expect(keeps[0]).toBe('default');
    expect(keeps.slice(1).every((variant: string) => variant === 'outline')).toBe(true);
    await page!.evaluate('window.buttonsNamed("^Keep$")[0].click()');
    // Kept: that card is a one-line result, and the orange Keep moved to the next card still waiting.
    await waitFor(`document.querySelector("[data-slot=suggested-area-card][data-decision=${KEPT}]")`, 'the kept result');
    expect(await page!.evaluate('window.orangeButtons()')).toEqual(['Keep']);
    await page!.evaluate('history.pushState(null, "", "?source=sample&view=past-focus"); dispatchEvent(new PopStateEvent("popstate"))');
    await waitFor('document.querySelector("[data-slot=timeline-date]")', 'Past focus');
    expect(await page!.evaluate('window.orangeButtons()')).toEqual([]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the bottom bar never covers Approve or Reject at 390, at any scroll position through the queue', async () => {
  try {
    await openPage('&view=rules');
    await phone();
    await waitFor('window.buttonsNamed("^Approve$").length > 0 && window.bottomBar()', 'the current rule and the bottom bar');
    // Nothing scrolls sideways, at the width named: the window is that wide, the page that wide or a classic scrollbar
    // narrower (Linux CI draws a 15px one; a touch phone none), and nothing runs past it.
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    // From the top of the page to past the end of the decision section, in 8px steps (finer than the 44px buttons,
    // so no position where the bar could cover one is skipped). Each step waits a frame for layout and sticky offsets.
    const covered = await page!.evaluate(`(async () => {
      const end = Math.min(document.getElementById('decide').getBoundingClientRect().bottom + scrollY, document.documentElement.scrollHeight - innerHeight);
      const covered = [];
      let positions = 0;
      for (let y = 0; y <= end; y += 8) {
        scrollTo(0, y);
        await new Promise(requestAnimationFrame);
        positions++;
        const under = window.decisionButtonsUnderBar();
        if (under.length) covered.push(y + ': ' + under.join(', '));
      }
      return { positions, covered };
    })()`);
    expect(covered.positions).toBeGreaterThan(20);
    expect(covered.covered).toEqual([]);
    // And with either button focused (the scroll padding keeps a focused control clear of the bar).
    for (const name of ['Approve', 'Reject']) {
      await page!.evaluate(`window.scrollTo(0, 0); window.buttonsNamed("^${name}$")[0].focus()`);
      await page!.settle();
      expect(await page!.evaluate('window.decisionButtonsUnderBar()')).toEqual([]);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

// The longest waiting rule on the owner's data is 180 characters (one sentence, no "when"); this one is as long.
const LONG_RULE = 'Carry each agreed change through review, merge and release on your own, check the result on the real install afterwards, and report what shipped instead of stopping to ask again later.';

it.skipIf(!chromeExecutablePath)('at 390 a long rule’s sentence is whole on the first screen and while Approve or Reject has focus; decided, it still shows whole', async () => {
  try {
    await openPage('&view=rules');
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    expect(LONG_RULE.length).toBeGreaterThanOrEqual(180);
    // The strongest waiting rule, drawn first when the page mounts.
    await addToModel({ rules: `[${waitingRule('long-rule', LONG_RULE, 40, 0)}]` });
    await remount('rules');
    await waitFor('window.currentRuleId() === "long-rule"', 'the long rule as the card');
    await phone();
    const sentence = 'document.querySelector("#decide [data-slot=confirmation][id^=decide-] dl")';
    expect(await page!.evaluate(`window.hiddenParts(${sentence})`)).toEqual([]);
    for (const name of ['Approve', 'Reject']) {
      await page!.evaluate(`window.scrollTo(0, 0); window.buttonsNamed("^${name}$")[0].focus()`);
      await page!.settle();
      expect(await page!.evaluate(`window.hiddenParts(${sentence})`)).toEqual([]);
      expect(await page!.evaluate('window.decisionButtonsUnderBar()')).toEqual([]);
    }
    // Rejected, the whole rule shows in its result (it is shown nowhere else) and in the full list. The sample source
    // saves only its own rules, so this save answers as the worker does: the model with the rule dismissed.
    await page!.evaluate(`window.store.setState({ saveRuleChange: async (change) => {
      const state = window.store.getState();
      const model = state.work.load.model;
      const saved = { ...model, rules: model.rules.map((rule) => rule.id === change.ruleId ? { ...rule, status: 'dismissed' } : rule) };
      state.receiveWorkModel(saved);
      return { model: saved, savedRuleId: null };
    } })`);
    await page!.evaluate('window.clickNamed("^Reject$")');
    await waitFor(`document.querySelector("[data-slot=decision-result][data-decision=${REJECTED}] [data-slot=decided-rule]")`, 'the rejected result');
    const result = `document.querySelector("[data-slot=decision-result] [data-slot=decided-rule]")`;
    expect(await page!.evaluate(`${result}.textContent`)).toBe(LONG_RULE);
    expect(await page!.evaluate(`window.showsWhole(${result})`)).toBe(true);
    await page!.evaluate('window.clickNamed("^Show all")');
    await waitFor('document.querySelector("#decide ul [data-slot=decided-rule]")', 'the decided row in the full list');
    expect(await page!.evaluate('window.showsWhole(document.querySelector("#decide ul [data-slot=decided-rule]"))')).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the rule editor’s Save waits with its reason until “Then” has words, saves nothing meanwhile, and opens clean after a save', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("Add rule").length > 0', 'Add rule');
    const rulesBefore = await page!.evaluate('window.store.getState().work.load.model.rules.length');
    await page!.evaluate('window.clickNamed("Add rule")');
    await waitFor('document.querySelector("[role=dialog] #rule-then")', 'the rule editor');
    const save = () => page!.evaluate(`(() => {
      const button = [...document.querySelectorAll('[role=dialog] button')].find((element) => /^Save rule/.test(window.nameOf(element)));
      const reason = button.getAttribute('aria-describedby') ? document.getElementById(button.getAttribute('aria-describedby')) : null;
      return { ariaDisabled: button.getAttribute('aria-disabled'), cursor: getComputedStyle(button).cursor, reason: reason?.textContent ?? null, reasonVisible: !!reason && reason.getBoundingClientRect().height > 0 };
    })()`);
    expect(await save()).toEqual({ ariaDisabled: 'true', cursor: 'not-allowed', reason: 'Save waits for the “Then” part: what the agent should do.', reasonVisible: true });
    // "Then" is marked required, has Cancel beside Save, and its example sits under the field.
    expect(await page!.evaluate('document.querySelector("[role=dialog] label[for=rule-then] [data-slot=label-required]") !== null')).toBe(true);
    expect(await page!.evaluate('[...document.querySelectorAll("[role=dialog] button")].some((button) => window.nameOf(button) === "Cancel")')).toBe(true);
    expect(await page!.evaluate('document.getElementById(document.getElementById("rule-then").getAttribute("aria-describedby")).textContent')).toMatch(/^Example: /);
    // Pressing the waiting Save does nothing: the dialog stays and no rule is added.
    await page!.evaluate('[...document.querySelectorAll("[role=dialog] button")].find((element) => /^Save rule/.test(window.nameOf(element))).click()');
    await page!.settle();
    expect(await page!.evaluate('!!document.querySelector("[role=dialog]")')).toBe(true);
    expect(await page!.evaluate('window.store.getState().work.load.model.rules.length')).toBe(rulesBefore);
    // Words in "Then": Save is ready, the reason line is gone, and "Reads as" shows the finished rule.
    await page!.evaluate('document.getElementById("rule-then").focus()');
    await page!.send('Input.insertText', { text: 'look up how we did that last time' });
    await page!.settle();
    expect(await save()).toEqual({ ariaDisabled: null, cursor: 'pointer', reason: null, reasonVisible: false });
    expect(await page!.evaluate('document.querySelector("[data-slot=rule-reads-as]")?.textContent')).toBe('look up how we did that last time');
    // Saved with a real press (the mouse moves focus off "Then", which used to mark it as left empty), then opened
    // again: no error yet.
    const saveAt = await page!.evaluate('(() => { const box = [...document.querySelectorAll("[role=dialog] button")].find((element) => /^Save rule/.test(window.nameOf(element))).getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()');
    for (const type of ['mousePressed', 'mouseReleased']) await page!.send('Input.dispatchMouseEvent', { type, x: saveAt.x, y: saveAt.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await waitFor('!document.querySelector("[role=dialog]")', 'the editor to close after saving');
    expect(await page!.evaluate('window.store.getState().work.load.model.rules.length')).toBe(rulesBefore + 1);
    await page!.evaluate('window.clickNamed("Add rule")');
    await waitFor('document.querySelector("[role=dialog] #rule-then")', 'the rule editor again');
    expect(await page!.evaluate('document.getElementById("rule-then").value')).toBe('');
    expect(await page!.evaluate('document.getElementById("rule-then").getAttribute("aria-invalid")')).toBeNull();
    expect(await page!.evaluate('document.querySelector("[role=dialog]").textContent.includes("This part is required")')).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the full queue draws 50 rows at a time and says how many are shown and left (G4, the shared footer)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // 60 waiting rules: the sample's first waiting rule, copied with new ids.
    await page!.evaluate(`(() => {
      const state = window.store.getState();
      const model = state.work.load.model;
      const waiting = model.rules.find((rule) => rule.status === 'suggested');
      const extra = Array.from({ length: 60 - model.rules.filter((rule) => rule.status === 'suggested').length }, (_, index) => ({ ...waiting, id: 'copy-' + index, then: waiting.then + ' (' + index + ')' }));
      state.receiveWorkModel({ ...model, rules: [...model.rules, ...extra] });
    })()`);
    await waitFor('window.buttonsNamed("^Show all 60$").length > 0', 'Show all 60');
    await page!.evaluate('window.clickNamed("^Show all 60$")');
    await waitFor('document.querySelector("#decide [data-slot=table-page-footer]")', 'the list footer');
    // 50 rows drawn (the current one among them), fewer than 60, and the footer says so.
    expect(await page!.evaluate('document.querySelectorAll("#decide ul > li").length')).toBe(50);
    expect(await page!.evaluate('document.querySelector("#decide [data-slot=table-page-footer] p").textContent')).toBe('Showing 50 of 60');
    await page!.evaluate('window.clickNamed("^Show 10 more\\\\s*· 10 left$")');
    await waitFor('document.querySelectorAll("#decide ul > li").length === 60', 'all 60 rows');
    expect(await page!.evaluate('document.querySelector("#decide [data-slot=table-page-footer] p").textContent')).toBe('Showing 60 of 60');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a quote’s time opens its sources on press and closes with its close button or Escape, back on the chip (G10)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('document.querySelector("#decide blockquote [aria-haspopup=dialog]")', 'the quote chip');
    const chip = 'document.querySelector("#decide blockquote [aria-haspopup=dialog]")';
    expect(await page!.evaluate(`${chip}.tagName`)).toBe('BUTTON');
    await pressEnterOn(chip);
    await waitFor('document.querySelector("[data-slot=popover-content] table")', 'the sources panel');
    // This quote's row is marked, and its words are whole (no "…").
    expect(await page!.evaluate('document.querySelector("[data-slot=popover-content] tr[aria-current=true] td").textContent.includes("…")')).toBe(false);
    await page!.evaluate('[...document.querySelectorAll("[data-slot=popover-content] button")].find((button) => window.nameOf(button) === "Close").click()');
    await waitFor('!document.querySelector("[data-slot=popover-content]")', 'the panel to close');
    expect(await page!.evaluate(`document.activeElement === ${chip}`)).toBe(true);
    await press('Enter');
    await waitFor('document.querySelector("[data-slot=popover-content]")', 'the panel to open again');
    await press('Escape');
    await waitFor('!document.querySelector("[data-slot=popover-content]")', 'Escape to close the panel');
    expect(await page!.evaluate(`document.activeElement === ${chip}`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('swiping the current rule sideways shows what letting go does and decides past 96px; a drag up the card shows nothing', async () => {
  try {
    await openPage('&view=rules');
    await phone();
    await waitFor('document.querySelector("[data-slot=swipe-to-decide]")', 'the swipeable rule');
    await page!.evaluate('document.getElementById("decide").scrollIntoView({ block: "start" })');
    await page!.settle();
    const start = await page!.evaluate(`(() => { const box = document.querySelector("[data-slot=swipe-to-decide] [id^=decide-] p.flex").getBoundingClientRect(); return { x: Math.round(box.left + 40), y: Math.round(box.top + box.height / 2) }; })()`);
    // A mostly vertical drag is the page's: the card lets the browser pan vertically, and shows no strip on the way.
    expect(await page!.evaluate('getComputedStyle(document.querySelector("[data-slot=swipe-to-decide] .transform-3d")).touchAction')).toBe('pan-y');
    const touch = (type: string, x: number, y: number) => page!.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', start.x, start.y);
    const stripsOnTheWayUp: number[] = [];
    for (let step = 1; step <= 10; step++) {
      await touch('touchMove', start.x + step * 2, start.y - step * 16);
      if (await page!.evaluate('!!document.querySelector("[data-slot=swipe-strip]")')) stripsOnTheWayUp.push(step);
    }
    await touch('touchEnd', start.x + 20, start.y - 160);
    await page!.settle();
    expect(stripsOnTheWayUp).toEqual([]);
    expect(await page!.evaluate('document.querySelector("[data-slot=decision-result]")')).toBeNull();
    // A sideways drag shows the strip, then "Let go to …" past the distance, and decides on release.
    await page!.evaluate('document.getElementById("decide").scrollIntoView({ block: "start" })');
    await page!.settle();
    const side = await page!.evaluate(`(() => { const box = document.querySelector("[data-slot=swipe-to-decide] [id^=decide-] p.flex").getBoundingClientRect(); return { x: Math.round(box.left + 40), y: Math.round(box.top + box.height / 2) }; })()`);
    await touch('touchStart', side.x, side.y);
    for (let x = side.x + 10; x <= side.x + 60; x += 10) await touch('touchMove', x, side.y);
    await page!.settle();
    expect(await page!.evaluate('document.querySelector("[data-slot=swipe-strip]")?.textContent')).toBe('Approve');
    expect(await page!.evaluate('document.querySelector("[data-slot=swipe-progress] p")?.textContent')).toBe('Swipe further to approve');
    for (let x = side.x + 70; x <= side.x + 130; x += 10) await touch('touchMove', x, side.y);
    await page!.settle();
    expect(await page!.evaluate('document.querySelector("[data-slot=swipe-progress] p")?.textContent')).toBe('Let go to approve');
    // Nothing scrolls sideways, at the width named: the window is that wide, the page that wide or a classic scrollbar
    // narrower (Linux CI draws a 15px one; a touch phone none), and nothing runs past it.
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    await touch('touchEnd', side.x + 130, side.y);
    await waitFor(`document.querySelector("[data-slot=decision-result][data-decision=${APPROVED}]")`, 'the decision from the swipe');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a failed save reads in plain words with the cause under Details, and focus stays where the person can go on (G17, M5)', async () => {
  try {
    await openPage(`&view=rules&sample-state=${sampleState('rule-saves-fail')}`);
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // A light rule, so a strength chip has a different card to show.
    await addToModel({ rules: `[${waitingRule('light-rule', 'Name the file a change lives in.', 1, 60)}]` });
    const cardBefore = await page!.evaluate('window.currentRuleId()');
    await pressEnterOn('window.buttonsNamed("^Approve$")[0]');
    await waitFor('document.querySelector("[data-slot=rule-change-failed]")', 'the failure line');
    const failure = 'document.querySelector("[data-slot=rule-change-failed]")';
    expect(await page!.evaluate(`${failure}.querySelector("p").textContent`)).toBe('The rule change was not saved.');
    // The raw cause is folded until Details opens, and nowhere else on the page.
    expect(await page!.evaluate('document.body.innerText.includes("SQLITE_BUSY")')).toBe(false);
    expect(await page!.evaluate('window.currentRuleId()')).toBe(cardBefore);
    expect(await page!.evaluate('window.focusInfo().name')).toBe('Approve');
    // A chip press after the failure changes the card but keeps focus on the chip.
    await pressEnterOn('window.buttonsNamed("^Light 1$")[0]');
    await waitFor('window.currentRuleId() === "light-rule"', 'the light rule as the card');
    expect(await page!.evaluate('window.focusInfo().name')).toBe('Light 1');
    await page!.evaluate(`${failure}.querySelector("[data-slot=collapsible-fold-trigger]").click()`);
    await page!.settle();
    expect(await page!.evaluate(`${failure}.textContent`)).toContain('SQLITE_BUSY');
    // The rule editor's failure and "Load my rules into Claude Code" read the same way.
    await page!.evaluate('window.clickNamed("Add rule")');
    await waitFor('document.querySelector("[role=dialog] #rule-then")', 'the rule editor');
    await page!.evaluate('document.getElementById("rule-then").focus()');
    await page!.send('Input.insertText', { text: 'say which file a change lives in' });
    await page!.settle();
    await page!.evaluate('[...document.querySelectorAll("[role=dialog] button")].find((element) => /^Save rule/.test(window.nameOf(element))).click()');
    await waitFor('document.querySelector("[role=dialog] [data-slot=rule-save-failed]")', 'the editor’s failure line');
    expect(await page!.evaluate('document.querySelector("[role=dialog] [data-slot=rule-save-failed]").innerText.includes("SQLITE_BUSY")')).toBe(false);
    expect(await page!.evaluate('document.querySelector("[role=dialog] [data-slot=rule-save-failed]").textContent')).toContain('The rule was not saved.');
    // Closing with typed words asks first (D b8 M173): discard them.
    await press('Escape');
    await waitFor('window.buttonsNamed("^Discard$").length > 0', 'the discard question');
    await page!.evaluate('window.clickNamed("^Discard$")');
    await waitFor('!document.querySelector("[role=dialog]")', 'the editor to close');
    await page!.evaluate('window.clickNamed("^Load my rules into Claude Code$")');
    await waitFor('document.querySelector("[data-slot=rules-load-failed]")', 'the load failure line');
    expect(await page!.evaluate('document.querySelector("[data-slot=rules-load-failed] p").textContent')).toBe('Your rules were not loaded into Claude Code.');
    expect(await page!.evaluate('document.body.innerText.includes("EACCES")')).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('focus after a press lands where the person can go on, with the focus ring, never on the page body (M5)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // The first rule's extra quotes, opened. The next rule's card opens with its own folds closed (quality L5).
    const moreQuotes = 'document.querySelector("#decide [data-slot=more-quotes] [data-slot=collapsible-fold-trigger]")';
    await page!.evaluate(`${moreQuotes}.click()`);
    await waitFor(`${moreQuotes}.dataset.state === "open"`, 'the quotes fold to open');
    // Next: the card shows the next rule and focus stays on Next.
    const first = await page!.evaluate('window.currentRuleId()');
    await pressEnterOn('document.querySelector("#decide [data-queue-focus] [data-step=next]")');
    await waitFor(`window.currentRuleId() !== "${first}"`, 'the next rule');
    expect(await page!.evaluate('window.focusInfo()')).toMatchObject({ step: 'next', focusVisible: true, ring: true });
    expect(await page!.evaluate(`${moreQuotes}.dataset.state`)).toBe('closed');
    // Approve: the next rule's card has focus.
    const second = await page!.evaluate('window.currentRuleId()');
    await pressEnterOn('window.buttonsNamed("^Approve$")[0]');
    await waitFor(`window.currentRuleId() !== "${second}" && document.activeElement.hasAttribute("data-queue-focus")`, 'focus on the next card');
    expect(await page!.evaluate('window.focusInfo()')).toMatchObject({ queueTarget: true, focusVisible: true, ring: true });
    // Decide every rule left: the last decision's result takes focus.
    for (let left = 0; left < 10 && await page!.evaluate('!!window.currentRuleId()'); left++) {
      const shown = await page!.evaluate('window.currentRuleId()');
      await pressEnterOn('window.buttonsNamed("^Approve$")[0]');
      await waitFor(`window.currentRuleId() !== "${shown}"`, 'the decision to land');
    }
    await waitFor('document.activeElement.dataset.slot === "decision-result"', 'focus on the last result');
    expect(await page!.evaluate('window.focusInfo()')).toMatchObject({ slot: 'decision-result', queueTarget: true, focusVisible: true, ring: true });
    // Undo on that result: the rule is the card again, and has focus.
    await pressEnterOn('[...document.querySelector("[data-slot=decision-result]").querySelectorAll("button")].find((button) => window.nameOf(button) === "Undo")');
    await waitFor('window.currentRuleId() && document.activeElement.hasAttribute("data-queue-focus")', 'focus on the undone rule');
    expect(await page!.evaluate('window.focusInfo()')).toMatchObject({ queueTarget: true, focusVisible: true });
    // Edit first, then Save and approve: the button that opened the editor went with its card, so focus lands on the
    // queue (here the last result), not the page body.
    await pressEnterOn('window.buttonsNamed("^Edit first$")[0]');
    await waitFor('document.querySelector("[role=dialog] #rule-then")', 'the editor');
    await page!.evaluate('[...document.querySelectorAll("[role=dialog] button")].find((element) => /^Save and approve/.test(window.nameOf(element))).click()');
    await waitFor('!document.querySelector("[role=dialog]")', 'the editor to close');
    await waitFor('document.activeElement !== document.body', 'focus to land');
    expect(await page!.evaluate('window.focusInfo()')).toMatchObject({ queueTarget: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a failed refresh names the refresh, holds the shared refresh line, folds the cause, and marks the last good run as earlier', async () => {
  try {
    await openPage(`&view=rules&sample-state=${sampleState('refresh-failed')}`);
    await desktop();
    await waitFor('document.querySelector("[data-slot=learning-run-failed]")', 'the failed refresh box');
    const box = 'document.querySelector("[data-slot=learning-run-failed]")';
    // The refresh runs owner-goals and the learning run, so the box names the refresh, not the learning run.
    expect(await page!.evaluate(`${box}.textContent`)).toContain('The last refresh didn’t finish');
    // The shared refresh line sits in the box, once on the page, its raw cause folded under Details. Its Try again
    // shows where a page can start a refresh (board-views.browser.test.ts); the sample cannot, and its pretend run
    // keeps its own button at the foot: one control on the page.
    expect(await page!.evaluate(`${box}.querySelector("[data-refresh-line=failed]") !== null`)).toBe(true);
    expect(await page!.evaluate('document.querySelectorAll("[data-refresh-line=failed]").length')).toBe(1);
    expect(await page!.evaluate('window.buttonsNamed("^(Try again|Refresh)").map((button) => window.nameOf(button))')).toEqual(['Refresh rules from preferences']);
    expect(await page!.evaluate(`${box}.innerText.includes("preferences[3]")`)).toBe(false);
    // The last good run's numbers, named as that earlier run's.
    expect(await page!.evaluate(`${box}.querySelector("[data-slot=learning-run-numbers]") !== null`)).toBe(true);
    expect(await page!.evaluate(`${box}.textContent`)).toContain('The last learning run that finished, ');
    expect(await page!.evaluate(`${box}.textContent`)).toContain('Waiting for your decision after it');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the card stays on the rule being read: a stronger new suggestion joins Up next, and a rule decided elsewhere hands over to the next one (M1)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    const reading = await page!.evaluate('window.currentRuleId()');
    // A live update lands a rule stronger than any: it waits first in Up next, and the card does not change.
    await addToModel({ rules: `[${waitingRule('stronger', 'Check the real install before saying a fix shipped.', 99, 0)}]` });
    expect(await page!.evaluate('window.currentRuleId()')).toBe(reading);
    expect((await page!.evaluate('window.upNextIds()'))[0]).toBe('stronger');
    // The person moves to a middle rule; another computer approves it: the card moves to the rule after it.
    const [, middle] = await page!.evaluate('window.upNextIds()');
    await page!.evaluate(`document.querySelector('#decide [data-slot=queue-row][data-rule-id="${middle}"]').click()`);
    await waitFor(`window.currentRuleId() === "${middle}"`, 'the middle rule as the card');
    const [after] = await page!.evaluate('window.upNextIds()');
    await page!.evaluate(`(() => {
      const state = window.store.getState();
      const model = state.work.load.model;
      state.receiveWorkModel({ ...model, rules: model.rules.map((rule) => rule.id === ${JSON.stringify(middle)} ? { ...rule, status: 'on', setBy: 'approved' } : rule) });
    })()`);
    await waitFor(`window.currentRuleId() !== "${middle}"`, 'the card to move on');
    expect(await page!.evaluate('window.currentRuleId()')).toBe(after);
    // Every rule left is approved elsewhere while focus is on the card: with no rule and no result of this visit to
    // show, focus lands on the queue's heading (quality M5), not the page body.
    await page!.evaluate('window.buttonsNamed("^Approve$")[0].focus()');
    await page!.evaluate(`(() => {
      const state = window.store.getState();
      const model = state.work.load.model;
      state.receiveWorkModel({ ...model, rules: model.rules.map((rule) => rule.status === 'suggested' ? { ...rule, status: 'on', setBy: 'approved' } : rule) });
    })()`);
    await waitFor('!window.currentRuleId()', 'every rule decided elsewhere');
    await waitFor('document.activeElement !== document.body', 'focus to land');
    expect(await page!.evaluate('document.activeElement.id')).toBe('decide-heading');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Past focus: a month keeps its state when the order changes, a read failure offers Try again only when pressed, and lines stay under 75 characters', async () => {
  try {
    await openPage('&view=past-focus');
    await desktop();
    await waitFor('document.querySelector("[data-slot=timeline-date]")', 'Past focus');
    const monthRow = (label: string) => `[...document.querySelectorAll("[data-slot=timeline-date]")].find((date) => date.textContent === ${JSON.stringify(label)}).closest("li").querySelector("[data-slot=month-row]")`;
    const labels = await page!.evaluate('[...document.querySelectorAll("[data-slot=timeline-date]")].map((date) => date.textContent)');
    const opened = labels[1];
    await page!.evaluate(`${monthRow(opened)}.click()`);
    await waitFor(`${monthRow(opened)}.getAttribute("aria-expanded") === "true"`, 'the month to open');
    await page!.evaluate('window.clickNamed("^Busiest first$")');
    await waitFor(`[...document.querySelectorAll("[data-slot=timeline-date]")].map((date) => date.textContent).join() !== ${JSON.stringify(labels.join())}`, 'the busiest order');
    const reordered = await page!.evaluate('[...document.querySelectorAll("[data-slot=timeline-date]")].map((date) => date.textContent)');
    // The opened month moved, so a state kept by position would now show on another month.
    expect(reordered.indexOf(opened)).not.toBe(1);
    expect(await page!.evaluate(`${monthRow(opened)}.getAttribute("aria-expanded")`)).toBe('true');
    expect(await page!.evaluate(`[...document.querySelectorAll("[data-slot=month-row][aria-expanded=true]")].length`)).toBe(1);
    // Reading text keeps to 75 characters a line (plan Phase 7): the description, and the opened month's summary.
    const measured = 'Math.max(...[...document.querySelectorAll("main p")].filter((p) => getComputedStyle(p).maxWidth !== "none").flatMap((p) => window.lineLengths(p)))';
    expect(await page!.evaluate('[...document.querySelectorAll("main p")].filter((p) => getComputedStyle(p).maxWidth !== "none").length')).toBeGreaterThanOrEqual(2);
    expect(await page!.evaluate(measured)).toBeLessThanOrEqual(75);
    await page!.evaluate('history.pushState(null, "", "?source=sample&view=suggested"); dispatchEvent(new PopStateEvent("popstate"))');
    await waitFor('window.buttonsNamed("^Keep$").length > 0', 'Suggested areas');
    // Suggested: the description, each goal and each "Why it's suggested" line.
    expect(await page!.evaluate('[...document.querySelectorAll("main p")].filter((p) => getComputedStyle(p).maxWidth !== "none").length')).toBeGreaterThanOrEqual(4);
    expect(await page!.evaluate(measured)).toBeLessThanOrEqual(75);
    await closePage();
    // The months cannot be read: plain words, Try again, the raw cause folded; a read happens only on the press.
    await openPage(`&view=past-focus&sample-state=${sampleState('months-unreadable')}`);
    await desktop();
    await waitFor('document.querySelector("[data-slot=months-read-failed]")', 'the read failure');
    expect(await page!.evaluate('document.body.innerText.includes("Unexpected token")')).toBe(false);
    await page!.evaluate(`(() => {
      window.readsAgain = 0;
      const read = window.store.getState().retryWorkRead;
      window.store.setState({ retryWorkRead: () => { window.readsAgain++; return read(); } });
    })()`);
    // No automatic retry: nothing reads again over a second of waiting (the worker's own refresh is not this page's).
    await page!.evaluate('new Promise((resolve) => setTimeout(resolve, 1000))');
    expect(await page!.evaluate('window.readsAgain')).toBe(0);
    await page!.evaluate('window.clickNamed("^Try again$")');
    await page!.settle();
    expect(await page!.evaluate('window.readsAgain')).toBe(1);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the side list marks the section on screen for a scope whose id has spaces (M4)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    const scopeId = 'situation:When I’m frustrated';
    await addToModel({
      ruleScopes: `[{ id: ${JSON.stringify(scopeId)}, tier: 'situation', name: 'When I’m frustrated' }, ...model.ruleScopes]`,
      rules: `[{ ...window.store.getState().work.load.model.rules.find((rule) => rule.status === 'on'), id: 'spaced-scope-rule', scopeId: ${JSON.stringify(scopeId)}, then: 'Slow down and say what you will check.' }]`,
    });
    await page!.evaluate(`document.getElementById(${JSON.stringify(`scope-${scopeId}`)}).scrollIntoView({ block: 'start' })`);
    await waitFor(`[...document.querySelectorAll("nav[aria-label=Scopes] button[aria-current=location]")].some((button) => button.textContent.includes("When I’m frustrated"))`, 'the spaced scope marked as on screen');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('quote folds are the shared fold row; decided names show whole; buttons dimmed during a save say what they wait for (G5, G16)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // The card's extra quotes fold under the one fold row (44px, chevron), opening below it.
    const rulesFold = 'document.querySelector("#decide [data-slot=more-quotes] [data-slot=collapsible-fold-trigger]")';
    expect(await page!.evaluate(`${rulesFold}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
    // A save under way: Approve, Edit first and Reject wait (still reachable), and a line says what for.
    await page!.evaluate('window.store.setState({ saveRuleChange: () => new Promise(() => {}) })');
    await pressEnterOn('window.buttonsNamed("^Approve$")[0]');
    await waitFor('document.querySelector("#decide [data-slot=decision-waits-for]")', 'the waiting line');
    const waiting = await page!.evaluate(`['Approve', 'Edit first', 'Reject'].map((name) => {
      const button = window.buttonsNamed('^' + name + '$')[0];
      const reason = document.getElementById(button.getAttribute('aria-describedby'));
      return { name, ariaDisabled: button.getAttribute('aria-disabled'), disabled: button.disabled, reason: reason?.textContent, reasonVisible: !!reason && reason.getBoundingClientRect().height > 0 };
    })`);
    for (const button of waiting) expect(button).toMatchObject({ ariaDisabled: 'true', disabled: false, reason: 'Saving your last change. These buttons work again once it’s saved.', reasonVisible: true });
    expect(await page!.evaluate('window.focusInfo().name')).toBe('Approve');
    await closePage();
    await openPage('&view=suggested');
    await desktop();
    await waitFor('window.buttonsNamed("^Keep$").length > 0', 'Suggested areas');
    expect(await page!.evaluate('document.querySelector("[data-slot=suggested-area-card] [data-slot=more-quotes] [data-slot=collapsible-fold-trigger]").getBoundingClientRect().height')).toBeGreaterThanOrEqual(44);
    await page!.evaluate('window.buttonsNamed("^Keep$")[0].click()');
    await waitFor(`document.querySelector("[data-slot=suggested-area-card][data-decision=${KEPT}] [data-slot=decided-area-name]")`, 'the kept result');
    expect(await page!.evaluate('window.showsWhole(document.querySelector("[data-slot=decided-area-name]"))')).toBe(true);
    await page!.evaluate('window.store.setState({ saveFocusChange: () => new Promise(() => {}) })');
    await page!.evaluate('window.buttonsNamed("^Keep$")[0].click()');
    await waitFor('document.querySelector("[data-slot=suggested-area-card] [data-slot=decision-waits-for]")', 'the waiting line on Suggested');
    const card = 'document.querySelector("[data-slot=decision-waits-for]").closest("[data-slot=suggested-area-card]")';
    const suggestedWaiting = await page!.evaluate(`[...${card}.querySelectorAll('button')].filter((button) => /^(Keep|Rename|Merge|Dismiss)$/.test(window.nameOf(button))).map((button) => ({ name: window.nameOf(button), ariaDisabled: button.getAttribute('aria-disabled'), describedBy: document.getElementById(button.getAttribute('aria-describedby'))?.textContent }))`);
    expect(suggestedWaiting).toHaveLength(4);
    for (const button of suggestedWaiting) expect(button).toMatchObject({ ariaDisabled: 'true', describedBy: 'Saving your last change. These buttons work again once it’s saved.' });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a rule rejected on an earlier visit is listed under its scope’s fold with the count, with Undo', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // Rejected before this visit: dismissed in the saved rules, with no decision made on this page.
    await addToModel({ rules: `[{ ...${waitingRule('rejected-earlier', 'Ask before deleting a branch that has no pull request.', 2, 9)}, status: 'dismissed' }]` });
    const fold = '[...document.querySelectorAll("[data-slot=rejected-rules]")].find((fold) => fold.textContent.includes("Rejected rules"))';
    expect(await page!.evaluate(`${fold}.querySelector("[data-slot=fold-trigger-count]").textContent`)).toBe('1');
    await page!.evaluate(`${fold}.querySelector("[data-slot=collapsible-fold-trigger]").click()`);
    await page!.settle();
    expect(await page!.evaluate(`${fold}.textContent`)).toContain('Ask before deleting a branch that has no pull request.');
    expect(await page!.evaluate(`[...${fold}.querySelectorAll("button")].some((button) => window.nameOf(button) === "Undo")`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a phone chip row that scrolls sideways shows a fade at each edge with more chips past it', async () => {
  try {
    await openPage('&view=rules');
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // Counts with two figures, as on the owner's data (All 47, Strong 23, Steady 12, Light 12): the fourth chip ran
    // past the edge at 390 there (Phase 7 verify, rules-real-390-dark-first-screen.png).
    await addToModel({ rules: `[...Array.from({ length: 20 }, (_, index) => ${waitingRule('strong-', 'A strong rule.', 60, 0).replace('"strong-"', '"strong-" + index')}), ...Array.from({ length: 12 }, (_, index) => ${waitingRule('light-', 'A light rule.', 1, 60).replace('"light-"', '"light-" + index')})]` });
    await phone();
    await waitFor('document.querySelector("[data-slot=strength-chips]")', 'the strength chips');
    const row = 'document.querySelector("[data-slot=strength-chips]")';
    await waitFor(`${row}.scrollWidth > ${row}.clientWidth`, 'chips past the edge');
    expect(await page!.evaluate(`({ before: ${row}.dataset.moreBefore ?? null, after: ${row}.dataset.moreAfter ?? null, mask: getComputedStyle(${row}).maskImage })`)).toMatchObject({ before: null, after: 'true' });
    expect(await page!.evaluate(`getComputedStyle(${row}).maskImage`)).not.toBe('none');
    await page!.evaluate(`${row}.scrollLeft = ${row}.scrollWidth`);
    await waitFor(`${row}.dataset.moreBefore === "true" && !${row}.dataset.moreAfter`, 'the fade on the other side');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('in French: the learning run’s numbers, a record’s words and the machine list follow the language (rule 4, rule 9)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    await page!.evaluate('window.setLocale("fr")');
    await addToModel({
      rulesLearning: '({ preferencesFound: 2345, newSuggestions: 3, reviewsRead: 12345 })',
      rules: `[{ ...window.store.getState().work.load.model.rules.find((rule) => rule.status === 'on'), id: 'worded-records', then: 'Keep the first screen short.',
        records: [{ kind: 'Review', label: 'request-progress · build story', at: 'Oct 20', fact: 'build-story' }, { kind: 'Instructions', label: 'Saved in My Rules on this computer', at: 'Oct 21', fact: 'saved-here' }] }]`,
    });
    // The numbers in the reader's format: French groups thousands with a narrow space, not a comma.
    await page!.evaluate('[...document.querySelectorAll("[data-slot=collapsible-fold-trigger]")].find((trigger) => trigger.textContent.includes("Dernière session")).click()');
    await waitFor('document.querySelector("[data-slot=learning-run-numbers]")', 'the learning run numbers');
    const numbers = await page!.evaluate('document.querySelector("[data-slot=learning-run-numbers]").textContent');
    expect(numbers).toMatch(/12\s345/u);
    expect(numbers).not.toContain('12,345');
    // A record's words: what it is, in French, not the mapper's English label.
    const block = 'document.getElementById("rule-worded-records")';
    await page!.evaluate(`[...${block}.querySelectorAll("button")].find((button) => window.nameOf(button) === "Pourquoi").click()`);
    await page!.evaluate(`[...${block}.querySelectorAll("[data-slot=collapsible-fold-trigger]")].find((trigger) => trigger.textContent.includes("Enregistrements sources")).click()`);
    await page!.settle();
    const records = await page!.evaluate(`${block}.querySelector("table").textContent`);
    expect(records).toContain('request-progress · récit de réalisation');
    expect(records).toContain('Enregistrée dans Mes règles sur cet ordinateur');
    expect(records).not.toContain('Saved in My Rules on this computer');
    // The sample receipt names the other machines as one French list.
    await page!.evaluate('document.querySelector("article[id^=rule-]:not(#rule-worded-records) [role=switch]").click()');
    const receiptLine = '[...document.querySelectorAll("[role=status]")].find((element) => element.textContent.includes("MY-RULES.md"))';
    await waitFor(`${receiptLine}?.textContent.includes("Mac Studio")`, 'the receipt');
    const receipt = await page!.evaluate(`${receiptLine}.textContent`);
    expect(receipt).toContain('Mac Studio et Cloud agent');
    expect(receipt).not.toContain(' and ');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/**
 * Every 16px from the top of the page to its end (each box here is 44px tall or more, so no overlap can fall between two
 * steps), one frame per step: where the sticky side list overlaps another box of the side column, the failed refresh box
 * or the main column, and at how many steps it was stuck at its offset (its bottom then within the window).
 */
const SIDE_LIST_SCAN = `(async () => {
  const nav = document.querySelector('aside nav[aria-label=Scopes]');
  const aside = nav.closest('aside');
  const sticky = [...aside.children].find((child) => child.contains(nav));
  const stickyTop = parseFloat(getComputedStyle(sticky).top);
  // Each box once, named by its first line of text, so a failure says which box the list covered.
  const named = (element) => element.innerText.trim().split('\\n')[0].slice(0, 40) || element.tagName;
  const others = new Map([...aside.children].filter((child) => child !== sticky).map((child) => [child, named(child)]));
  const failedBox = document.querySelector('[data-slot=learning-run-failed]');
  if (failedBox && !others.has(failedBox)) others.set(failedBox, 'failed refresh box');
  others.set(aside.previousElementSibling, 'main column');
  const overlaps = [];
  let stuck = 0;
  let stuckBelowWindow = 0;
  const end = document.documentElement.scrollHeight - innerHeight;
  for (let y = 0; y <= end; y += 16) {
    scrollTo(0, y);
    await new Promise(requestAnimationFrame);
    const list = nav.getBoundingClientRect();
    for (const [element, name] of others) {
      const box = element.getBoundingClientRect();
      const width = Math.min(list.right, box.right) - Math.max(list.left, box.left);
      const height = Math.min(list.bottom, box.bottom) - Math.max(list.top, box.top);
      if (width > 0.5 && height > 0.5) overlaps.push(y + ': ' + name);
    }
    if (Math.abs(sticky.getBoundingClientRect().top - stickyTop) < 1) {
      stuck++;
      if (list.bottom > innerHeight + 0.5) stuckBelowWindow++;
    }
  }
  return { steps: Math.floor(end / 16) + 1, overlaps, stuck, stuckBelowWindow };
})()`;

it.skipIf(!chromeExecutablePath)('at 1440×900 the side list never covers the failed refresh box or anything else, with five scopes or twenty, and still stays in view', async () => {
  try {
    await openPage(`&view=rules&sample-state=${sampleState('refresh-failed')}`);
    await desktop();
    await waitFor('document.querySelector("[data-slot=learning-run-failed]") && document.querySelector("aside nav[aria-label=Scopes]")', 'the failed refresh box and the side list');
    // The sample's five scopes.
    expect(await page!.evaluate('window.store.getState().work.load.model.ruleScopes.length')).toBe(5);
    const five = await page!.evaluate(SIDE_LIST_SCAN);
    expect(five.steps).toBeGreaterThan(100);
    expect(five.overlaps).toEqual([]);
    // It still stays in view while the page scrolls past the boxes above it.
    expect(five.stuck).toBeGreaterThan(20);
    expect(five.stuckBelowWindow).toBe(0);
    // Twenty scopes: a list taller than the window below its offset scrolls inside itself and still covers nothing.
    await page!.evaluate(`(() => {
      const state = window.store.getState();
      const model = state.work.load.model;
      const more = Array.from({ length: 15 }, (_, index) => ({ id: 'project:more-' + index, tier: 'project', name: 'Repo ' + (index + 1) }));
      state.receiveWorkModel({ ...model, ruleScopes: [...model.ruleScopes, ...more] });
    })()`);
    await waitFor('document.querySelectorAll("aside nav[aria-label=Scopes] button").length === 21', 'twenty scope rows and Needs your decision');
    const twenty = await page!.evaluate(SIDE_LIST_SCAN);
    expect(await page!.evaluate('(() => { const nav = document.querySelector("aside nav[aria-label=Scopes]"); return nav.scrollHeight > nav.clientHeight; })()')).toBe(true);
    expect(twenty.overlaps).toEqual([]);
    expect(twenty.stuck).toBeGreaterThan(20);
    expect(twenty.stuckBelowWindow).toBe(0);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('under reduced motion a sideways swipe on a phone still shows the strip’s word and icon, says “Let go to keep” past 96px, and keeps the area on release', async () => {
  try {
    await openPage('&view=suggested');
    await phone();
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await page!.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(true);
    await waitFor('document.querySelector("[data-slot=swipe-to-decide] [data-slot=suggested-area-card]")', 'a swipeable suggested area');
    const card = 'document.querySelector("[data-slot=swipe-to-decide]")';
    await page!.evaluate(`${card}.scrollIntoView({ block: "center" })`);
    await page!.settle();
    const start = await page!.evaluate(`(() => { const box = ${card}.querySelector("h3").getBoundingClientRect(); return { x: Math.round(box.left + 40), y: Math.round(box.top + box.height / 2) }; })()`);
    const touch = (type: string, x: number, y: number) => page!.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    // The strip's label (icon and word): which of its left, middle and right points show the strip, not the card over it.
    const stripShows = `(() => {
      const strip = document.querySelector('[data-slot=swipe-strip]');
      if (!strip) return null;
      const label = strip.querySelector('span');
      const box = label.getBoundingClientRect();
      const shown = [box.left + 2, box.left + box.width / 2, box.right - 2].map((x) => { const hit = document.elementFromPoint(x, box.top + box.height / 2); return !!hit && strip.contains(hit); });
      return { word: label.textContent, icon: label.querySelector('svg') !== null, shown, cardMoved: Math.round(new DOMMatrix(getComputedStyle(document.querySelector('[data-slot=swipe-to-decide] .transform-3d')).transform).m41) };
    })()`;
    const progressLine = 'document.querySelector("[data-slot=swipe-progress] p")?.textContent ?? null';
    await touch('touchStart', start.x, start.y);
    for (let x = start.x + 10; x <= start.x + 60; x += 10) await touch('touchMove', x, start.y);
    await page!.settle();
    expect(await page!.evaluate(progressLine)).toBe('Swipe further to keep');
    expect(await page!.evaluate(stripShows)).toMatchObject({ word: 'Keep', icon: true, cardMoved: 0 });
    // Past the 96px decide distance: "Let go to keep", and the strip's whole label shows.
    for (let x = start.x + 70; x <= start.x + 130; x += 10) await touch('touchMove', x, start.y);
    await page!.settle();
    expect(await page!.evaluate(progressLine)).toBe('Let go to keep');
    expect(await page!.evaluate(stripShows)).toEqual({ word: 'Keep', icon: true, shown: [true, true, true], cardMoved: 0 });
    // Nothing scrolls sideways, at the width named: the window is that wide, the page that wide or a classic scrollbar
    // narrower (Linux CI draws a 15px one; a touch phone none), and nothing runs past it.
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    await touch('touchEnd', start.x + 130, start.y);
    await waitFor(`document.querySelector("[data-slot=suggested-area-card][data-decision=${KEPT}]")`, 'the area kept on release');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a scope’s “review above” shows the rule it names: a strength chip that hides it goes back to All and says so (Greptile P2, PR #6210)', async () => {
  try {
    await openPage('&view=rules');
    await desktop();
    await waitFor('window.buttonsNamed("^Approve$").length > 0', 'the current rule');
    // A light rule in the first suggestion's scope, so the Light chip has a card of its own to show.
    await addToModel({ rules: `[${waitingRule('light-rule', 'Name the file a change lives in.', 1, 60)}]` });
    // With All on, the scope's link shows the scope's strongest waiting rule: the rule it names.
    const link = 'window.buttonsNamed("suggested · review above")[0]';
    await page!.evaluate(`${link}.click()`);
    await page!.settle();
    const named = await page!.evaluate('window.currentRuleId()');
    expect(named).not.toBe('light-rule');
    // The Light chip hides that rule; the link still shows it, the chip goes back to All, and the queue says so.
    await page!.evaluate('window.clickNamed("^Light 1$")');
    await waitFor('window.currentRuleId() === "light-rule"', 'the light rule as the card');
    expect(await page!.evaluate('document.querySelector("[data-slot=strength-made-room]").textContent')).toBe('');
    await page!.evaluate(`${link}.click()`);
    await waitFor(`window.currentRuleId() === ${JSON.stringify(named)}`, 'the named rule as the card');
    expect(await page!.evaluate('window.nameOf(document.querySelector("[data-slot=strength-chips] [data-state=on]"))')).toMatch(/^All \d+$/);
    expect(await page!.evaluate('document.querySelector("[data-slot=strength-made-room]").textContent')).toBe('Strength set to All, so the rule you asked to review shows.');
    // Choosing a chip again clears the line.
    await page!.evaluate('window.clickNamed("^Light 1$")');
    await waitFor('window.currentRuleId() === "light-rule"', 'the light rule again');
    expect(await page!.evaluate('document.querySelector("[data-slot=strength-made-room]").textContent')).toBe('');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/** WCAG contrast of two computed `rgb(r, g, b)` colours: the formula token-contrast.test.ts measures tokens with. */
function contrastOfComputed(first: string, second: string) {
  const luminance = (css: string) => {
    const channels = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    if (channels.length !== 3) throw new Error(`not an rgb() colour: ${css}`);
    const linear = (channel: number) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

it.skipIf(!chromeExecutablePath)('on a phone the Decide chip’s edge is ≥3:1 in both themes, Up next rows and quote chips are ≥44px, and section labels ≥12px (Phase 12)', async () => {
  try {
    await openPage('&view=rules');
    await phone();
    await waitFor('document.querySelector("#decide [data-slot=queue-row]") && document.querySelector("#decide blockquote [aria-haspopup=dialog]")', 'Up next and a quote chip');
    for (const theme of ['dark', 'light'] as const) {
      await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await waitFor(`document.documentElement.classList.contains("dark") === ${theme === 'dark'}`, `the ${theme} theme`);
      // The chip row is the page background at 95%, so the edge is read against --background itself.
      const colours = await page!.evaluate(`(() => {
        const chip = [...document.querySelectorAll("[data-slot=rule-scope-chips] button")].find((button) => /^Decide/.test(window.nameOf(button)));
        // The Button eases colour changes (transition-all): read the edge at the end of the theme change.
        chip?.getAnimations().forEach((animation) => animation.finish());
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--background)";
        document.body.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { edge: chip ? getComputedStyle(chip).borderTopColor : null, background };
      })()`) as { edge: string | null; background: string };
      expect(colours.edge).not.toBeNull();
      const ratio = contrastOfComputed(colours.edge!, colours.background);
      expect({ theme, passes: ratio >= 3, ratio: Number(ratio.toFixed(2)) }).toEqual({ theme, passes: true, ratio: Number(ratio.toFixed(2)) });
    }
    // Touch size (rule 6): the Button primitive's 44px holds; a page's own min-h must not shrink it on a phone.
    const heights = await page!.evaluate(`[...document.querySelectorAll("#decide [data-slot=queue-row], #decide blockquote [aria-haspopup=dialog]")]
      .map((element) => ({ name: window.nameOf(element).slice(0, 40), height: element.getBoundingClientRect().height }))`) as Array<{ name: string; height: number }>;
    expect(heights.length).toBeGreaterThan(1);
    expect(heights.filter((target) => target.height < 44)).toEqual([]);
    // The review's Keep line "card text ≥12px", at the 16px phone root.
    expect(await page!.evaluate('parseFloat(getComputedStyle(document.querySelector("#decide .section-label")).fontSize)')).toBeGreaterThanOrEqual(12);
    // A touch screen as wide as a desktop shows the top bar: its brand link keeps the 44px touch size too; a mouse
    // keeps the 34px mark's height (the rail this checked before went in the design pass, Phase 3).
    const brandLink = 'document.querySelector("[data-slot=\\"app-bar\\"] a[href]")';
    await desktop();
    expect(await page!.evaluate(`${brandLink}.getBoundingClientRect().height`)).toBeLessThan(44);
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page!.settle();
    expect(await page!.evaluate('matchMedia("(pointer: coarse)").matches')).toBe(true);
    expect(await page!.evaluate(`${brandLink}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await page?.send('Emulation.setEmulatedMedia', { features: [] });
    await closePage();
  }
}, TEST_LIMIT_MS);

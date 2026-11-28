import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, FITS_THE_WINDOW, htmlResponse, launchChrome, myWorkFontResponse, PAGE_WIDTHS, pageFitsTheWindow, scriptResponse, SCROLLBAR_MODES,
  scrollbarStyleFor, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { THEME_PRE_PAINT_SCRIPT } from '../../../src/ui/my-work/src/lib/theme-pre-paint';
import { SAMPLE_STATES } from '../../../src/ui/my-work/src/live/sample-source';
import { LINE_ROWS_PER_PAGE, LIST_TITLE_MIN_PX } from '../../../src/ui/my-work/src/live/card-groups';

failOnCiWithoutChrome('CI requires Chrome for the My Work List, By agent, Team and read-error regressions.');

/**
 * Phase 4 of the pro-max-v16 plan on the real App, its compiled stylesheet and its Geist font:
 * - the List (c-work-list-view, c-ui-table): 50 rows at a time (G4) and "Show 50 more", rows that are Tab stops Enter
 *   opens, a status cell a screen reader hears as one word (also while its split-flap tiles riffle after a live
 *   change, and only the newest change riffles), 44px rows on a touch phone;
 * - By agent (c-work-by-agent-view, c-ai-agent): the no-agent requests and the empty agents each one dashed line with
 *   "Show them", subagents nested only where the model links them, and Mark finished behind a confirm (its route
 *   cannot be undone), in sample mode;
 * - Team (c-work-team-board): the note for one person, Sort, G4 columns and the dashed places for teammates; each
 *   row's whole title on a line of its own, from 768px to a phone, and status badges that never break inside a word
 *   (StateBadge), in English and Korean; By agent's cards show each whole title the same way;
 * - the read-error card (sample case): plain words, the raw reason folded, Try again with its outcome, and a Dismiss
 *   per request that holds for that error and moves focus on;
 * - after a failed refresh, My Rules, Past focus and Suggested areas each offer one control, Try again;
 * - rule 8: one live model that changes several requests moves two things at most in the List, By agent and Team.
 * Nothing here reaches a worker: the data is the sample, reshaped in the page where a test needs more of it.
 */
const sampleState = (name: (typeof SAMPLE_STATES)[number]) => {
  const state = SAMPLE_STATES.find((entry) => entry === name);
  if (!state) throw new Error(`No sample state ${name} in SAMPLE_STATES`);
  return state;
};

/** The "many" scenario's board (built in the page below): what each count in a test comes from. */
const MANY = { yourMove: 2, working: 3, idle: 80, shipped: 45, noAgent: 60, emptyAgents: 8, twins: 2 } as const;
/** The "idle-agents" scenario: this many agents with nothing on them, the first with three subagents linked to it. */
const IDLE_CARDS = 60;
/** sub-1's task as its launch recorded it: longer than one line of its row, so the row cuts it. */
const SUB_TASK = 'Measure every List row at 768px and say which of the table facts each one shows, then check both By agent folds';
const MANY_TOTAL = MANY.yourMove + MANY.working + MANY.idle + MANY.shipped;

const KEYS = {
  Tab: { code: 'Tab', keyCode: 9, text: undefined }, Enter: { code: 'Enter', keyCode: 13, text: '\r' },
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
  // The stylesheet's @font-face rules ask for ./files/<name>.woff2 (Geist and Geist Mono); widths depend on the font,
  // so the real files are served (myWorkFontResponse).
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import App from './src/ui/my-work/src/App';
    import { useStore } from './src/ui/my-work/src/store';
    import { setLocale } from './src/ui/my-work/src/lib/i18n';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { THIS_COMPUTER, UNRECORDED_AGENT } from './src/ui/my-work/src/live/to-work-model';
    import { SAMPLE_AGENTS, SAMPLE_REQUESTS } from './src/ui/my-work/src/data';
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
    const counts = ${JSON.stringify(MANY)};
    const idleCards = ${IDLE_CARDS};
    const subTask = ${JSON.stringify(SUB_TASK)};
    const scenario = new URLSearchParams(location.search).get('scenario');
    // Every read the page makes, and every refresh it starts, counted (Try again must read or start exactly once).
    window.loads = 0;
    window.refreshStarts = 0;
    // Set to a reason, every read fails with it (Try again's outcome when the worker cannot be read).
    window.failReads = null;
    const sampleLoad = sampleSource.loadWorkModel;
    const byId = (id) => SAMPLE_REQUESTS.find((request) => request.id === id);
    // A request in a given state, from the sample request in that state (or the working one, made idle), so it keeps
    // the lifecycle rules; each starts an hour after the one before, so Newest puts the last made first.
    const made = (index, state, agentId) => {
      const from = { 'your-move': byId('r5'), working: byId('r1'), idle: { ...byId('r1'), state: 'idle', runningLive: false }, shipped: byId('r4') }[state];
      return { ...from, id: 'g' + index, title: 'Generated request ' + index, contentFingerprint: 'g' + index, agentId, askedBy: 'You',
        startedAtIso: new Date(Date.UTC(2026, 9, 1, 12) + index * 3_600_000).toISOString(), startedAt: 'Oct ' + (1 + Math.floor(index / 24)) + ', 12:00 pm' };
    };
    // Empty agents and subagents of the work viewer's Claude Code: three linked to it, one whose parent is not recorded.
    const empty = Array.from({ length: counts.emptyAgents }, (_, index) => ({ ...SAMPLE_AGENTS[0], id: 'empty-' + index, role: 'Empty agent ' + index }));
    // Two sessions in one folder: the same name, role and machine; only their sessions tell them apart.
    const twins = [['twin-a', 'aaaa1111'], ['twin-b', 'bbbb2222']].slice(0, counts.twins)
      .map(([id, sessionShortId]) => ({ ...SAMPLE_AGENTS[0], id, role: 'Twin folder', sessionShortId }));
    // A subagent as the mapper writes one: its own role and its typed status. sub-1 carries the task its launch
    // recorded, sub-3 none; sub-alone is shaped as the 15.19.0 worker sends one, its role behind the old prefix.
    const subagent = (id, status, parentId, fields = {}) => ({ ...SAMPLE_AGENTS[0], id, role: 'Work viewer', status, canMarkFinished: status !== 'finished', ...(parentId ? { parentId } : {}), ...fields });
    const subagents = [subagent('sub-1', 'working', 'claude', { launchDescription: subTask }), subagent('sub-2', 'finished', 'claude'), subagent('sub-3', 'quiet', 'claude'), subagent('sub-alone', 'quiet', null, { role: 'Subagent · Work viewer' })];
    const manyRequests = () => {
      const states = [...Array(counts.yourMove).fill('your-move'), ...Array(counts.working).fill('working'), ...Array(counts.idle).fill('idle'), ...Array(counts.shipped).fill('shipped')];
      // The first few go to the sample's agents (so every state has an agent with work), the next noAgent to none.
      return states.map((state, index) => made(index, state, index < 10 ? SAMPLE_AGENTS[index % SAMPLE_AGENTS.length].id : index < 10 + counts.noAgent ? UNRECORDED_AGENT.id : SAMPLE_AGENTS[index % SAMPLE_AGENTS.length].id));
    };
    const failedRefresh = { state: 'failed', finishedAt: 'Nov 16 at 12:19 pm', finishedAtIso: '2026-11-16T20:19:00.000Z', error: 'Claude Code: reviews: g_8f5a02b65d34: database is locked' };
    // A page this computer's worker serves ('local'): it can start a refresh, and the sample's demo flip stays off.
    if (scenario) sampleSource.sourceKind = 'local';
    sampleSource.loadWorkModel = async () => {
      window.loads++;
      if (window.failReads) throw new Error(window.failReads);
      const model = await sampleLoad();
      // The no-agent stand-in runs on this computer, as the mapper adds it (to-work-model toWorkModel).
      if (scenario === 'many') return { ...model, sourceKind: 'local', requests: manyRequests(), agents: [...SAMPLE_AGENTS, ...empty, ...twins, ...subagents, UNRECORDED_AGENT], devices: [...model.devices, THIS_COMPUTER], people: ['You'] };
      if (scenario === 'idle-agents') {
        const idle = Array.from({ length: idleCards }, (_, index) => ({ ...SAMPLE_AGENTS[0], id: 'idle-' + index, role: 'Idle agent ' + index }));
        const nested = [1, 2, 3].map((number) => subagent('idle-0-sub-' + number, 'quiet', 'idle-0'));
        return { ...model, sourceKind: 'local', requests: manyRequests(), agents: [...SAMPLE_AGENTS, ...idle, ...nested, UNRECORDED_AGENT], devices: [...model.devices, THIS_COMPUTER], people: ['You'] };
      }
      // The sample's own board (three people, every open state, "Done, not checked" the longest label), held still.
      if (scenario === 'team') return { ...model, sourceKind: 'local' };
      if (scenario === 'failed-refresh') return { ...model, sourceKind: 'local', refresh: failedRefresh };
      if (scenario === 'failed-refresh-no-rules') return { ...model, sourceKind: 'local', refresh: failedRefresh, rules: [], rulesLearning: null };
      return model;
    };
    sampleSource.refreshWork = async () => { window.refreshStarts++; return { state: 'running' }; };
    createRoot(document.getElementById('root')).render(<App />);
    (function waitForPage() {
      if (document.querySelector('[data-slot="work-shell"] main section, [data-slot="work-shell"] main [data-slot="empty"]')) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForPage);
    })();
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    window.nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    window.buttonsNamed = (pattern) => [...document.querySelectorAll('button')].filter((button) => visible(button) && new RegExp(pattern).test(window.nameOf(button)));
    window.clickNamed = (pattern) => { const button = window.buttonsNamed(pattern)[0]; if (!button) throw new Error('no button ' + pattern); button.click(); };
    window.tableRows = () => document.querySelectorAll('table[aria-label] tbody tr[data-list-row]');
    window.footerText = () => document.querySelector('[data-slot=table-page-footer]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null;
    // A model from the live feed, as the store receives one (the change ticker and the List's flip read its changes).
    window.receive = (change) => { const state = useStore.getState(); state.receiveWorkModel(change(state.work.load.model)); };
    // Reads \`measure\` once a frame for \`ms\` and answers every reading (a riffle lasts about 1.3s, a row's glow 3.2s).
    window.sampleFrames = (ms, measure) => new Promise((resolve) => {
      const readings = [];
      const until = performance.now() + ms;
      (function frame() { readings.push(measure()); if (performance.now() < until) requestAnimationFrame(frame); else resolve(readings); })();
    });
    // What moves in the change ticker and the board, once a frame for \`ms\`, as rule 8 counts things, not animations:
    // every running Web Animation and CSS animation, and every element whose inline transform changed since the frame
    // before (motion's glides and slides write one; a progress bar's still transform is its value, not a move), grouped
    // by what it moves: the ticker, one status badge's riffle, one agent's card (the one around the element or inside
    // it), or the request it moves (the one whose row, line or card is around the element, or the one inside it), else
    // that one element. So each moving element is counted apart unless it moves a part of the same thing: an element
    // outside a row or card was named by its tag, so several of them read as one thing (Phase 6 re-verify V2). Answers
    // the things of each frame.
    window.movingThingsOver = (ms) => {
      const scopes = () => [document.querySelector('[data-ticker]'), document.querySelector('[data-board-view]')].filter(Boolean);
      // An element named apart has its own number: one in no agent's or request's block, or in a block of several.
      const elementNumbers = new WeakMap();
      let elementsNumbered = 0;
      const numberedName = (element) => { if (!elementNumbers.has(element)) elementNumbers.set(element, ++elementsNumbered); return element.tagName + '#' + elementNumbers.get(element); };
      // One thing's own block: an agent's card, a request's card, its List row or table row, its one-line row.
      const ownBlock = (element) => element.closest('[data-agent-card], [data-slot="card"], [data-list-row], [data-request-row], [data-request-line]') ?? element;
      const requestIdsIn = (element) => new Set([...(element.matches('[data-request-opener]') ? [element] : []), ...element.querySelectorAll('[data-request-opener]')].map((opener) => opener.dataset.requestOpener));
      const thing = (element) => {
        if (element.closest('[data-ticker]')) return 'ticker';
        const own = ownBlock(element);
        const agents = own.matches('[data-agent-card]') ? [own] : [...own.querySelectorAll('[data-agent-card]')];
        const requests = requestIdsIn(own);
        const name = agents.length === 1 ? 'agent ' + agents[0].dataset.agentCard : requests.size === 1 ? [...requests][0] : numberedName(own);
        return (element.closest('[data-state-badge]') ? 'riffle: ' : 'moving: ') + name;
      };
      const lastTransform = new WeakMap();
      return window.sampleFrames(ms, () => {
        const inScope = scopes();
        const things = new Set();
        for (const animation of document.getAnimations()) {
          const target = animation.effect?.target;
          if (animation.playState === 'running' && target && inScope.some((scope) => scope.contains(target))) things.add(thing(target));
        }
        for (const scope of inScope) for (const element of scope.querySelectorAll('[style*="transform"]')) {
          const transform = element.style.transform;
          if (lastTransform.has(element) && lastTransform.get(element) !== transform) things.add(thing(element));
          lastTransform.set(element, transform);
        }
        return [...things];
      });
    };
    // Whether an element that took focus from code shows it (lib/paged-rows.ts FOCUS_FROM_CODE_CLASS_NAME): matched as
    // keyboard focus, with its ring-colour outline drawn (it had outline-none and nothing else).
    window.focusShows = () => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      return element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    };
    // How many lines some text boxes sit on: boxes that overlap in height are one line (a fallback font's Hangul sits a
    // pixel or two off the Latin text beside it).
    const lineCount = (rects) => {
      let lines = 0, bottom = -Infinity;
      for (const rect of [...rects].sort((a, b) => a.top - b.top)) {
        if (rect.top >= bottom - 1) { lines++; bottom = rect.bottom; } else bottom = Math.max(bottom, rect.bottom);
      }
      return lines;
    };
    // A status badge's words as drawn: the lines they take, the first word that breaks across lines, and whether every
    // word stays inside the pill. Words are what the spaces split; screen-reader text is not drawn.
    window.badgeWords = (badge) => {
      const pill = badge.getBoundingClientRect();
      const range = document.createRange();
      const drawn = [];
      let brokenWord = null;
      const walker = document.createTreeWalker(badge, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement.closest('.sr-only')) continue;
        for (const word of node.textContent.matchAll(/\\S+/g)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          const rects = [...range.getClientRects()];
          drawn.push(...rects);
          if (lineCount(rects) > 1 && brokenWord === null) brokenWord = word[0];
        }
      }
      return { lines: lineCount(drawn), brokenWord, inside: drawn.every((rect) => rect.left >= pill.left - 0.5 && rect.right <= pill.right + 0.5) };
    };
    // One request row as drawn: its title against the row's content box (its width less padding and border), whether
    // the title shows whole, its status badge's words, the tool name printed beside the mark, and the row's height.
    window.rowLayout = (row) => {
      const style = getComputedStyle(row);
      const box = row.getBoundingClientRect();
      const content = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      const title = row.querySelector('[data-row-title]');
      const titleStyle = getComputedStyle(title);
      const titleWidth = title.getBoundingClientRect().width;
      const name = row.querySelector('[role=img]')?.nextElementSibling;
      return {
        title: title.textContent, state: row.dataset.requestRow, widths: { row: Math.round(content * 100) / 100, title: Math.round(titleWidth * 100) / 100 },
        titleAsWideAsRow: Math.abs(titleWidth - content) <= 1,
        titleWhole: titleStyle.whiteSpace !== 'nowrap' && titleStyle.textOverflow !== 'ellipsis' && title.scrollWidth <= title.clientWidth + 1,
        badge: window.badgeWords(row.querySelector('[data-state-badge]')),
        name: name && name.getClientRects().length > 0 ? { text: name.textContent, whole: name.scrollWidth <= name.clientWidth + 1 } : null,
        height: box.height,
      };
    };
  `, ['--loader:.webp=empty', '--loader:.css=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty']);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>${THEME_PRE_PAINT_SCRIPT}</script>${scrollbarStyleFor(request.url)}<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
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

/** Each test gets its own Chrome on the one compiled fixture, opened at `query` and sized before it reads anything. */
async function openPage(query: string, viewport: { width: number; height: number; touch?: boolean } = { width: 1440, height: 900 }) {
  // Each test reports only its own page's errors.
  fixtureErrors.length = 0;
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${fixtureUrl}${query}`;
  chrome = launchChrome(url, { profilePrefix: 'claude-mem-board-views-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The App with sample data drew its first page in 1.0–2.0s in app-shell.browser.test.ts (2026-11-16); 20s is for a
  // cold Chrome on a CI runner.
  await withTimeout(ready, 20_000, 'My Work fixture did not draw its page');
  page = await connectToPage(chrome, url);
  await page.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: !!viewport.touch });
  if (viewport.touch) {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(await page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
  }
  await page.settle();
}

async function closePage() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Waits until `expression` is truthy. Every wait here is a frame or two of React work or a lazy page chunk. */
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

/** Picks a board view with its toggle, as a person would. */
async function chooseView(label: string) {
  await page!.evaluate(`[...document.querySelectorAll('[role=radio]')].find((item) => window.nameOf(item) === ${JSON.stringify(label)}).click()`);
  await page!.settle();
}

/** The name a screen reader gets for the element `selector` finds (the accessibility tree, not the DOM text). */
async function accessibleName(selector: string): Promise<{ role: string; name: string }> {
  await page!.send('Accessibility.enable');
  const { root } = await page!.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page!.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`nothing matches ${selector}`);
  const { nodes } = await page!.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  return { role: nodes[0].role?.value, name: nodes[0].name?.value };
}

// Each test opens Chrome and the whole App (1–2s locally); 60s leaves room for a cold CI runner and the waits inside.
const TEST_LIMIT_MS = 60_000;

it.skipIf(!chromeExecutablePath)('the List draws 50 rows; "Show 50 more" adds 50, says how many are left and moves focus to the first new row', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('List');
    // Sorted by Newest the List is one list in that order (G4: grouped only attention-first with every request).
    await page!.evaluate(`window.store.getState().setSort('started')`);
    await waitFor(`window.tableRows().length === ${LINE_ROWS_PER_PAGE}`, 'the first 50 rows');
    expect(await page!.evaluate('window.footerText()')).toBe(`Showing 50 of ${MANY_TOTAL} Show 50 more · ${MANY_TOTAL - 50} left`);
    const firstPage = await page!.evaluate(`[...window.tableRows()].map((row) => row.textContent)`);
    await page!.evaluate(`window.clickNamed('^Show 50 more')`);
    await waitFor(`window.tableRows().length === 100`, 'the next 50 rows');
    // The keyboard carries on from the first row added (row 51), and no row shows twice.
    expect(await page!.evaluate(`document.activeElement === window.tableRows()[50]`)).toBe(true);
    const twoPages = await page!.evaluate(`[...window.tableRows()].map((row) => row.textContent)`);
    expect(twoPages.slice(0, 50)).toEqual(firstPage);
    expect(new Set(twoPages).size).toBe(100);
    await page!.evaluate(`window.clickNamed('^Show ${MANY_TOTAL - 100} more')`);
    await waitFor(`window.tableRows().length === ${MANY_TOTAL}`, 'the last rows');
    expect(await page!.evaluate('window.footerText()')).toBe(`Showing ${MANY_TOTAL} of ${MANY_TOTAL}`);
    // Attention-first: Needs you and Working are open, Idle and Shipped one fold row each; a new sort starts over.
    await page!.evaluate(`window.store.getState().setSort('attention')`);
    await waitFor(`window.tableRows().length === ${MANY.yourMove + MANY.working}`, 'the open groups');
    expect(await page!.evaluate(`[...document.querySelectorAll('table[aria-label] tbody[data-list-group]')].map((group) => group.dataset.listGroup + ':' + group.dataset.state)`))
      .toEqual(['needs-you:undefined', 'working:undefined', 'idle:closed', 'shipped:closed']);
    // A folded group is its one line: no "Show 50 more" under it until it opens (one showed under each closed fold).
    expect(await page!.evaluate(`window.buttonsNamed('^Show [0-9]+ more').map((button) => window.nameOf(button))`)).toEqual([]);
    await page!.evaluate(`document.querySelector('tbody[data-list-group=idle] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelectorAll('tbody[data-list-group=idle] tr[data-list-row]').length === 50`, 'the first 50 idle rows');
    expect(await page!.evaluate(`window.nameOf(window.buttonsNamed('^Show 30 more')[0])`)).toBe(`Show 30 more · 30 left`);
    await page!.evaluate(`window.clickNamed('^Show 30 more')`);
    await waitFor(`document.querySelectorAll('tbody[data-list-group=idle] tr[data-list-row]').length === ${MANY.idle}`, 'every idle row');
    // Back to Newest: the list starts on its first page again.
    await page!.evaluate(`window.store.getState().setSort('started')`);
    await waitFor(`window.tableRows().length === ${LINE_ROWS_PER_PAGE}`, 'the first page again');
    // A new filter starts it over too: two pages shown, another filter and back, one page.
    await page!.evaluate(`window.clickNamed('^Show 50 more')`);
    await waitFor(`window.tableRows().length === 100`, 'two pages before the filter');
    await page!.evaluate(`window.store.getState().setFilter('working')`);
    await waitFor(`window.tableRows().length === ${MANY.working}`, 'the working filter');
    await page!.evaluate(`window.store.getState().setFilter('all')`);
    await waitFor(`window.tableRows().length === ${LINE_ROWS_PER_PAGE}`, 'the first page after the filter');
    // And a new area: two pages in the work viewer's area, then home again, one page.
    await page!.evaluate(`window.store.getState().goToFocus('fa-viewer')`);
    await waitFor(`window.tableRows().length === ${LINE_ROWS_PER_PAGE} && !document.getElementById('all-requests')`, "the area's first page");
    await page!.evaluate(`window.clickNamed('^Show 50 more')`);
    await waitFor(`window.tableRows().length === 100`, 'two pages in the area');
    await page!.evaluate(`window.store.getState().goToPage('work')`);
    await waitFor(`document.getElementById('all-requests') && window.tableRows().length === ${LINE_ROWS_PER_PAGE}`, 'home on its first page');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Tab reaches a List row, Enter opens its drawer, and the table has a name; non-sortable headings look plain', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('List');
    await waitFor(`window.tableRows().length > 0`, 'the List');
    expect(await accessibleName('table[aria-label]')).toEqual({ role: 'table', name: 'Requests' });
    // Only Status, Progress and Started sort: each has its button and arrows; the sorted one says so.
    expect(await page!.evaluate(`[...document.querySelectorAll('table[aria-label] thead th')].map((th) => [window.nameOf(th), !!th.querySelector('button'), th.getAttribute('aria-sort')])`))
      .toEqual([['Agent', false, null], ['Request', false, null], ['Status', true, 'descending'], ['Next step', false, null], ['Progress', true, null], ['Started', true, null], ['Running', false, null]]);
    // From the last heading button, Tab lands on the first row (a row of the open Needs you group).
    await page!.evaluate(`[...document.querySelectorAll('table[aria-label] thead button')].at(-1).focus()`);
    await press('Tab');
    const focused = await page!.evaluate(`(() => { const row = document.activeElement; return { row: row.matches('tr[data-list-row]'), title: row.querySelector('td:nth-child(2) span')?.textContent } })()`);
    expect(focused.row).toBe(true);
    await press('Enter');
    await waitFor(`document.querySelector('[role=dialog]')`, 'the request drawer');
    expect(await page!.evaluate(`document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(focused.title)})`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the status cell reads as one word, also while its tiles riffle after a live change, and only the newest change riffles', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('List');
    await waitFor(`window.tableRows().length > 0`, 'the List');
    // At rest: the state badge, its word read once (the mark is hidden from readers), no tiles on the first draw.
    expect(await page!.evaluate(`document.querySelectorAll('table[aria-label] .split-flap-tile').length`)).toBe(0);
    expect((await accessibleName('table[aria-label] tbody tr[data-list-row] td:nth-child(3)')).name).toBe('Your move');
    // Two working requests change state in one live model: only the newest change (the first of the model's changes)
    // riffles, so with the change ticker the view has two moving things at most (rule 8).
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g2' || request.id === 'g3' ? { ...request, state: 'your-move', next: { who: 'human', text: 'Look at this' } } : request) }))`);
    await waitFor(`document.querySelectorAll('table[aria-label] [data-state-badge] .split-flap-tile').length > 0`, 'the riffle');
    const flipping = await page!.evaluate(`[...document.querySelectorAll('table[aria-label] [data-state-badge]')].filter((badge) => badge.querySelector('.split-flap-tile')).map((badge) => badge.closest('tr').querySelector('td:nth-child(2) span').textContent)`);
    expect(flipping).toEqual(['Generated request 2']);
    // The riffling cell still reads as its one word.
    await page!.evaluate(`document.querySelector('table[aria-label] .split-flap-tile').closest('td').setAttribute('data-flipping-cell', '')`);
    expect((await accessibleName('[data-flipping-cell]')).name).toBe('Your move');
    // The longest label riffles inside its column: "Done, not checked", its mark and every tile stay within the
    // Status cell's padding (c-split-flap F; framed tiles ran about 100px into the next columns).
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g4' ? { ...request, state: 'needs-check', next: { who: 'human', text: 'Check it' } } : request) }))`);
    await waitFor(`[...document.querySelectorAll('table[aria-label] [data-state-badge]')].some((badge) => badge.querySelector('.split-flap-tile') && badge.querySelector('.sr-only').textContent === 'Done, not checked')`, 'the longest label riffling');
    const fit = await page!.evaluate(`(() => {
      const badge = [...document.querySelectorAll('table[aria-label] [data-state-badge]')].find((each) => each.querySelector('.split-flap-tile') && each.querySelector('.sr-only').textContent === 'Done, not checked');
      const cell = badge.closest('td'); const style = getComputedStyle(cell); const box = cell.getBoundingClientRect();
      const inner = { left: box.left + parseFloat(style.paddingLeft) - 0.5, right: box.right - parseFloat(style.paddingRight) + 0.5 };
      const parts = [badge, ...badge.querySelectorAll('.split-flap-tile')].map((element) => element.getBoundingClientRect());
      return { inside: parts.every((part) => part.left >= inner.left && part.right <= inner.right), oneLine: new Set([...badge.querySelectorAll('.split-flap-tile')].map((tile) => Math.round(tile.getBoundingClientRect().top))).size };
    })()`);
    expect(fit).toEqual({ inside: true, oneLine: 1 });
    // Reduced motion turned on while the List is open, before the next live change: the badge simply changes its word,
    // and no frame draws a tile (the List read the setting once, at mount, and riffled anyway).
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await waitFor(`document.querySelectorAll('table[aria-label] .split-flap-tile').length === 0`, 'the last riffle to go');
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g4' ? { ...request, state: 'your-move', next: { who: 'human', text: 'Look at this too' } } : request) }))`);
    const tilesEachFrame: number[] = await page!.evaluate(`window.sampleFrames(1500, () => document.querySelectorAll('table[aria-label] .split-flap-tile').length)`);
    expect(Math.max(...tilesEachFrame)).toBe(0);
    expect(await page!.evaluate(`[...window.tableRows()].find((row) => row.querySelector('td:nth-child(2) span').textContent === 'Generated request 4').querySelector('[data-state-badge]').textContent`)).toBe('Your move');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('on a touch phone every List row is at least 44px tall and the page is as wide as the window', async () => {
  try {
    await openPage('&scenario=many', { width: 390, height: 844, touch: true });
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('List');
    await page!.evaluate(`window.store.getState().setSort('started')`);
    await waitFor(`document.querySelectorAll('[data-request-row]').length === ${LINE_ROWS_PER_PAGE}`, 'the first 50 rows');
    const heights = await page!.evaluate(`[...document.querySelectorAll('[data-request-row]')].map((row) => row.getBoundingClientRect().height)`);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    // Nothing scrolls sideways, at the width named: the window is that wide, the page that wide or a classic scrollbar
    // narrower (Linux CI draws a 15px one; a touch phone none), and nothing runs past it.
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    // Two Tab stops per phone row: the agent's mark (a tooltip trigger, G10) and the row's own button; the facts line
    // of wider screens is not drawn here.
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-request-row]')].map((row) => [...row.querySelectorAll('button, a[href], [tabindex="0"]')].filter((stop) => stop.getClientRects().length > 0).length)`))
      .toEqual(Array(LINE_ROWS_PER_PAGE).fill(2));
    // "Show 50 more" puts focus on the first new row's own button, not on the agent's mark before it.
    await page!.evaluate(`window.clickNamed('^Show 50 more')`);
    await waitFor(`document.querySelectorAll('[data-request-row]').length === 100`, 'the next 50 rows');
    expect(await page!.evaluate(`document.activeElement === document.querySelectorAll('[data-request-row]')[50].querySelector('[data-row-target]')`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('By agent: agents with work first; the no-agent requests and the empty agents each fold to one dashed line with "Show them"; subagents nest only where linked', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('By agent');
    await waitFor(`document.querySelector('[data-agent-fold=no-agent]')`, 'the no-agent fold');
    // A fold row's label, the words at its right end, its height and its edge.
    const fold = (id: string) => page!.evaluate(`(() => {
      const trigger = document.querySelector('[data-agent-fold=${id}] [data-slot=collapsible-fold-trigger]');
      return {
        label: trigger.querySelector(':scope > span:not([data-slot])').textContent, end: trigger.querySelector('[data-slot=fold-trigger-count]').textContent,
        height: trigger.getBoundingClientRect().height, edge: getComputedStyle(trigger).borderTopStyle, expanded: trigger.getAttribute('aria-expanded'),
      };
    })()`);
    const noAgent = await fold('no-agent');
    expect(noAgent).toEqual({ label: `${MANY.noAgent} requests have no agent recorded`, end: 'Show them', height: expect.any(Number), edge: 'dashed', expanded: 'false' });
    // One line: the fold row's own 44px, not 18,066px of rows.
    expect(noAgent.height).toBeLessThan(60);
    // Every agent with nothing here, its subagents counted: the empty agents, the two sessions of one folder, and the
    // subagent with no parent link.
    const idle = await fold('idle-agents');
    expect([idle.label, idle.end, idle.edge]).toEqual([`${MANY.emptyAgents + MANY.twins + 1} agents have nothing in this view`, 'Show them', 'dashed']);
    expect(idle.height).toBeLessThan(60);
    // The agents with work are cards; the linked subagents sit in a fold under their parent, not beside it.
    expect(await page!.evaluate(`document.querySelectorAll('[data-agent-card=sub-1], [data-agent-card=sub-2], [data-agent-card=sub-3]').length`)).toBe(0);
    expect(await page!.evaluate(`(() => { const trigger = document.querySelector('[data-agent-card=claude] [data-subagents] [data-slot=collapsible-fold-trigger]'); return [trigger.querySelector(':scope > span:not([data-slot])').textContent, trigger.querySelector('[data-slot=fold-trigger-count]').textContent] })()`)).toEqual(['Subagents', '3']);
    // By agent shows no Sort, so it follows none: with the List sorted Newest, the no-agent requests still open as
    // one-line rows in their state groups, Idle and Shipped folded (G4), not as one Newest list.
    await page!.evaluate(`window.store.getState().setSort('started')`);
    await page!.evaluate(`document.querySelector('[data-agent-fold=no-agent] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-agent-fold=no-agent] [data-line-section=idle]')`, 'the no-agent groups');
    expect((await fold('no-agent')).end).toBe('Hide them');
    expect(await page!.evaluate(`document.querySelectorAll('[data-agent-fold=no-agent] [data-request-line]').length`)).toBe(0);
    // The linked subagents, opened: the one whose launch recorded a task shows it first, on one line with the whole
    // task in its tooltip; the one with none shows its state only.
    await page!.evaluate(`document.querySelector('[data-agent-card=claude] [data-subagents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-subagent-id=sub-1] [data-subagent-task]')`, 'the subagent rows');
    expect(await page!.evaluate(`(() => {
      const task = document.querySelector('[data-subagent-id=sub-1] [data-subagent-task]');
      const style = getComputedStyle(task);
      return { text: task.textContent, oneLine: style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis', cut: task.scrollWidth > task.clientWidth, first: task.closest('li').firstElementChild.contains(task), reachable: task.getAttribute('tabindex') };
    })()`)).toEqual({ text: SUB_TASK, oneLine: true, cut: true, first: true, reachable: '0' });
    await page!.evaluate(`document.querySelector('[data-subagent-id=sub-1] [data-subagent-task]').focus()`);
    await waitFor(`[...document.querySelectorAll('[data-slot=tooltip-content]')].some((tip) => tip.textContent.includes(${JSON.stringify(SUB_TASK)}))`, 'the whole task in the tooltip');
    expect(await page!.evaluate(`(() => { const row = document.querySelector('[data-subagent-id=sub-3]'); return [!!row.querySelector('[data-subagent-task]'), !!row.firstElementChild.querySelector('[data-subagent-status]')] })()`)).toEqual([false, true]);
    // The empty agents, opened: their cards, and the unlinked subagent as a card of its own with its label and state.
    await page!.evaluate(`document.querySelector('[data-agent-fold=idle-agents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-agent-fold=idle-agents] [data-agent-card=sub-alone]')`, 'the unlinked subagent card');
    expect(await page!.evaluate(`document.querySelectorAll('[data-agent-fold=idle-agents] [data-agent-card]').length`)).toBe(MANY.emptyAgents + MANY.twins + 1);
    // Each card's header words and the line that tells it apart, if it has one.
    const headers: Record<string, { text: string; detail: string | null }> = await page!.evaluate(`Object.fromEntries(['sub-alone', 'twin-a', 'twin-b', 'empty-0'].map((id) => {
      const card = document.querySelector('[data-agent-card=' + id + ']');
      return [id, { text: card.firstElementChild.textContent, detail: card.querySelector('[data-slot=agent-header-detail]')?.textContent ?? null }];
    }))`);
    // The unlinked subagent's role reads once, beside its own "Subagent" label, though its record carries the older
    // worker's prefix too.
    expect(headers['sub-alone'].text.match(/Work viewer/g)).toEqual(['Work viewer']);
    expect(headers['sub-alone'].text).not.toContain('Subagent ·');
    // Two sessions in one folder read the same but for their sessions; a card no other card reads like adds nothing.
    expect([headers['twin-a'].detail, headers['twin-b'].detail]).toEqual(['Session aaaa1111', 'Session bbbb2222']);
    expect(headers['twin-a'].text.replace('Session aaaa1111', '')).toBe(headers['twin-b'].text.replace('Session bbbb2222', ''));
    expect(headers['empty-0'].detail).toBe(null);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Mark finished asks first (its route cannot be undone); Cancel saves nothing, and confirmed the subagent reads Finished with focus on it', async () => {
  try {
    await openPage(`&sample-state=${sampleState('subagents')}`);
    await chooseView('By agent');
    await waitFor(`document.querySelector('[data-agent-card=claude] [data-subagents]')`, 'the Claude Code card with its subagents');
    await page!.evaluate(`document.querySelector('[data-agent-card=claude] [data-subagents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-subagent-row=working]')`, 'the subagent rows');
    // A recorded stop's time is a time in the reader's clock (the shared LocalTime), as the mapper's is, not English
    // text ("Oct 20 at 1:40 pm").
    expect(await page!.evaluate(`(() => { const status = document.querySelector('[data-subagent-id=claude-subagent-2] [data-subagent-status]'); return [!!status.querySelector('time[datetime]'), status.textContent.includes(' at ')] })()`)).toEqual([true, false]);
    const markButtons = `[...document.querySelectorAll('[data-agent-card=claude] [data-subagent-row] button')].filter((button) => window.nameOf(button) === 'Mark finished')`;
    // Only the rows with no recorded stop (working, quiet) offer it; the finished one does not.
    expect(await page!.evaluate(`${markButtons}.length`)).toBe(2);
    expect(await page!.evaluate(`document.querySelector('[data-subagent-row=finished]').textContent.includes('Mark finished')`)).toBe(false);
    await page!.evaluate(`document.querySelector('[data-subagent-row=working] button').click()`);
    await waitFor(`document.querySelector('[role=dialog]')`, 'the confirm dialog');
    expect(await page!.evaluate(`window.nameOf(document.querySelector('[role=dialog] h2'))`)).toBe('Mark this subagent finished?');
    expect(await page!.evaluate(`document.querySelector('[role=dialog]').textContent.includes('can’t be undone')`)).toBe(true);
    // Cancel: nothing saved.
    await page!.evaluate(`window.clickNamed('^Cancel$')`);
    await waitFor(`!document.querySelector('[role=dialog]')`, 'the dialog to close');
    expect(await page!.evaluate(`${markButtons}.length`)).toBe(2);
    // Confirmed by keyboard: saved, the row reads Finished with the time it stopped, and focus lands on that row's
    // status, with the focus ring (the sample already holds another Finished row, so a word check alone proves nothing).
    await page!.evaluate(`document.querySelector('[data-subagent-row=working] button').click()`);
    await waitFor(`document.querySelector('[role=dialog]')`, 'the confirm dialog again');
    await page!.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((button) => window.nameOf(button) === 'Mark finished').focus()`);
    await press('Enter');
    await waitFor(`!document.querySelector('[role=dialog]') && ${markButtons}.length === 1`, 'the saved stop');
    await waitFor(`document.activeElement !== document.body && document.activeElement.matches('[data-subagent-status]')`, 'focus on a subagent status');
    expect(await page!.evaluate(`(() => { const focused = document.activeElement; return { row: focused.closest('[data-subagent-id]').dataset.subagentId, words: focused.textContent.includes('Finished'), time: !!focused.querySelector('time[datetime]'), shows: window.focusShows() } })()`))
      .toEqual({ row: 'claude-subagent-1', words: true, time: true, shows: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the read-error card (sample case) is plain words at the top of the board, its raw reason folded, and stays there when nothing matches', async () => {
  try {
    await openPage(`&sample-state=${sampleState('read-errors')}`);
    await waitFor(`document.querySelector('[data-read-errors=shown]')`, 'the read-error card');
    const card = `document.querySelector('[data-read-errors=shown]')`;
    expect(await page!.evaluate(`${card}.getAttribute('role')`)).toBe('alert');
    expect(await page!.evaluate(`${card}.innerText`)).toContain('2 requests couldn’t be read');
    // No internal id and no rule's text on screen: both are under Details.
    expect(await page!.evaluate(`${card}.innerText.includes('r-unreadable-1') || ${card}.innerText.includes('is inconsistent')`)).toBe(false);
    await page!.evaluate(`${card}.querySelector('[data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`${card}.innerText.includes('is inconsistent')`, 'the raw reason under Details');
    // Shown once, at the top of the board, in every layout.
    for (const view of ['Cards', 'List', 'By agent']) {
      await chooseView(view);
      expect(await page!.evaluate(`document.querySelectorAll('[data-read-errors]').length`)).toBe(1);
      // After the board's controls (the Filter group is the last radio group on the page) and before everything the
      // board draws, in document order.
      expect(await page!.evaluate(`(() => {
        const card = document.querySelector('[data-read-errors]');
        const filter = [...document.querySelectorAll('[role=radiogroup]')].at(-1);
        const follows = (first, second) => !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
        const board = [...document.querySelectorAll('[data-slot=card], [data-list-row], [data-agent-card], [data-line-section], [data-request-group]')].filter((element) => follows(filter, element));
        return follows(filter, card) && board.length > 0 && board.every((element) => follows(card, element));
      })()`)).toBe(true);
    }
    // Nothing matches the filter: the card stays, "Nothing here" says so under it, and By agent still folds its agents
    // with their count (nothing was drawn under the card).
    await page!.evaluate(`window.store.getState().setFilter('closed')`);
    for (const view of ['Cards', 'By agent']) {
      await chooseView(view);
      await waitFor(`[...document.querySelectorAll('[data-slot=empty]')].some((empty) => empty.textContent.includes('Nothing here'))`, `"Nothing here" on ${view}`);
      expect(await page!.evaluate(`(() => { const empty = [...document.querySelectorAll('[data-slot=empty]')].find((each) => each.textContent.includes('Nothing here')); return !!(document.querySelector('[data-read-errors=shown]').compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING) })()`)).toBe(true);
    }
    expect(await page!.evaluate(`document.querySelector('[data-agent-fold=idle-agents] [data-slot=collapsible-fold-trigger] > span:not([data-slot])').textContent`)).toBe('4 agents have nothing in this view');
    await page!.evaluate(`window.store.getState().setFilter('all')`);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the read-error card: Try again says what it did; each Dismiss holds for its error and moves focus on; the dismissed fold keeps focus', async () => {
  try {
    await openPage(`&sample-state=${sampleState('read-errors')}`);
    await waitFor(`document.querySelector('[data-read-errors=shown]')`, 'the read-error card');
    // Try again reads the work once more (nothing retries by itself), and says when, and that these still can't be read.
    const loads = await page!.evaluate('window.loads');
    await page!.evaluate(`window.clickNamed('^Try again$')`);
    await waitFor(`window.loads === ${loads + 1} && document.querySelector('[data-read-again=read]')`, 'one more read and its outcome');
    expect(await page!.evaluate(`document.querySelector('[data-read-again]').innerText`)).toMatch(/^Read again at \d{1,2}:\d{2} [ap]m: these still can’t be read\.$/);
    // A read that fails says so in plain words, the raw cause under Details (G17).
    await page!.evaluate(`window.failReads = 'worker busy: SQLITE_BUSY'`);
    await page!.evaluate(`window.clickNamed('^Try again$')`);
    await waitFor(`document.querySelector('[data-read-again=failed]')`, 'the failed read');
    expect(await page!.evaluate(`document.querySelector('[data-read-again=failed] p').textContent`)).toBe('Couldn’t read your work again.');
    expect(await page!.evaluate(`document.querySelector('[data-read-again=failed]').innerText.includes('SQLITE_BUSY')`)).toBe(false);
    await page!.evaluate(`document.querySelector('[data-read-again=failed] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-read-again=failed]').innerText.includes('SQLITE_BUSY')`, 'the cause under Details');
    await page!.evaluate(`window.failReads = null`);
    // Dismiss by keyboard: that request folds away, and focus moves to the next one's Dismiss.
    const dismissButtons = `[...document.querySelectorAll('[data-read-errors=shown] [data-dismiss-read-error]')]`;
    await page!.evaluate(`${dismissButtons}[0].focus()`);
    await press('Enter');
    await waitFor(`${dismissButtons}.length === 1 && document.activeElement === ${dismissButtons}[0]`, 'focus on the next Dismiss');
    expect(await page!.evaluate(`document.querySelector('[data-read-errors=shown]').innerText`)).toContain('1 request couldn’t be read');
    const foldTrigger = `document.querySelector('[data-read-errors=dismissed] [data-slot=collapsible-fold-trigger]')`;
    expect(await page!.evaluate(`${foldTrigger}.textContent`)).toBe('1 dismissed request couldn’t be readShow them');
    // The last one: the alert goes, its two requests fold to one row, and focus lands on the board's heading, shown.
    await press('Enter');
    await waitFor(`!document.querySelector('[data-read-errors=shown]') && document.activeElement?.id === 'all-requests'`, 'focus on the board heading');
    expect(await page!.evaluate('window.focusShows()')).toBe(true);
    expect(await page!.evaluate(`${foldTrigger}.textContent`)).toBe('2 dismissed requests couldn’t be readShow them');
    // The fold row keeps focus as it opens and closes.
    await page!.evaluate(`${foldTrigger}.focus()`);
    await press('Enter');
    await waitFor(`${foldTrigger}.getAttribute('aria-expanded') === 'true'`, 'the dismissed requests shown');
    expect(await page!.evaluate(`document.activeElement === ${foldTrigger} && ${foldTrigger}.textContent.endsWith('Hide them')`)).toBe(true);
    expect(await page!.evaluate(`document.querySelector('[data-read-errors=dismissed]').innerText`)).toContain('Move the release notes into the docs site');
    await press('Enter');
    await waitFor(`${foldTrigger}.getAttribute('aria-expanded') === 'false'`, 'the dismissed requests folded');
    expect(await page!.evaluate(`document.activeElement === ${foldTrigger}`)).toBe(true);
    // Another one fixed by a later read: the one still unreadable stays dismissed (no alert comes back).
    await page!.evaluate(`window.receive((model) => ({ ...model, requestReadErrors: model.requestReadErrors.slice(1) }))`);
    await waitFor(`${foldTrigger}.textContent.startsWith('1 dismissed request')`, 'the fold to count one');
    expect(await page!.evaluate(`document.querySelector('[data-read-errors=shown]')`)).toBe(null);
    // A new unreadable request is a new error: it shows, alone.
    await page!.evaluate(`window.receive((model) => ({ ...model, requestReadErrors: [...model.requestReadErrors, { requestId: 'r-unreadable-3', title: 'A third one', reason: 'Request r-unreadable-3 is inconsistent: reading count matches the readings', evidenceHref: null }] }))`);
    await waitFor(`document.querySelector('[data-read-errors=shown]')`, 'the new error');
    expect(await page!.evaluate(`document.querySelector('[data-read-errors=shown]').innerText`)).toContain('1 request couldn’t be read');
    expect(await page!.evaluate(`document.querySelector('[data-read-errors=shown]').innerText.includes('A third one')`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('after a failed refresh, My Rules, Past focus and Suggested areas each offer one control, worded Try again, that starts one refresh', async () => {
  try {
    await openPage('&scenario=failed-refresh&view=rules');
    let started = 0;
    for (const view of ['rules', 'past-focus', 'suggested']) {
      await page!.evaluate(`history.pushState(null, '', '?source=sample&scenario=failed-refresh&view=${view}'); dispatchEvent(new PopStateEvent('popstate'))`);
      await waitFor(`document.querySelector('[data-refresh-line=failed]')`, `the failed refresh on ${view}`);
      // Every visible button that starts a refresh: exactly one, and it reads Try again.
      expect(await page!.evaluate(`window.buttonsNamed('^(Try again|Refresh now|Refresh)$').map((button) => window.nameOf(button))`)).toEqual(['Try again']);
      // One failed line on the page, not two.
      expect(await page!.evaluate(`document.querySelectorAll('[data-refresh-line=failed]').length`)).toBe(1);
      // Try again sits inside its line's box, also in My Rules' narrow side column (beside the words it ran out of it).
      const inside = await page!.evaluate(`(() => { const box = document.querySelector('[data-refresh-line=failed] [role=alert]').getBoundingClientRect(); const button = window.buttonsNamed('^Try again$')[0].getBoundingClientRect(); return button.left >= box.left && button.right <= box.right && button.top >= box.top && button.bottom <= box.bottom })()`);
      expect({ view, inside }).toEqual({ view, inside: true });
      await page!.evaluate(`window.clickNamed('^Try again$')`);
      started++;
      await waitFor(`window.refreshStarts === ${started}`, `the refresh Try again starts on ${view}`);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Team view: one line for a board of one, Sort shown, a column in G4 groups, and two dashed places for teammates', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await page!.evaluate(`window.store.getState().setWorkspace({ team: true })`);
    await waitFor(`[...document.querySelectorAll('[role=radio]')].some((item) => window.nameOf(item) === 'Team')`, 'the Team view');
    await chooseView('Team');
    await waitFor(`document.querySelector('[data-team-column]')`, 'the Team board');
    expect(await page!.evaluate(`document.querySelector('[data-team-note]').innerText`)).toContain('You are the only person here.');
    expect(await page!.evaluate(`document.querySelectorAll('[data-team-place]').length`)).toBe(2);
    expect(await page!.evaluate(`[...document.querySelectorAll('[role=combobox]')].some((sort) => window.nameOf(sort).startsWith('Sort'))`)).toBe(true);
    // The column: Needs you and Working open as rows with their next step, Idle and Shipped one fold row each.
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-team-column] [data-request-group], [data-team-column] [data-line-section]')].map((group) => group.dataset.requestGroup ?? group.dataset.lineSection + ':' + group.dataset.state)`))
      .toEqual(['needs-you', 'working', 'idle:closed', 'shipped:closed']);
    expect(await page!.evaluate(`document.querySelectorAll('[data-team-column] [data-request-row]').length`)).toBe(MANY.yourMove + MANY.working);
    // Each row prints its tool's name beside the mark, as HEAD's Team cards did (rule 2), whole; the List keeps the mark
    // alone. The open rows' agents: two Claude Codes' and one each of the others (the sample's four agents, g0-g4).
    const teamRowNames = `[...document.querySelectorAll('[data-team-column] [data-request-row]')].map((row) => {
      const name = row.querySelector('[role=img]')?.nextElementSibling;
      return name && name.getClientRects().length > 0 ? { text: name.textContent, whole: name.scrollWidth <= name.clientWidth + 1, height: row.getBoundingClientRect().height } : null;
    })`;
    const desktopNames: { text: string; whole: boolean }[] = await page!.evaluate(teamRowNames);
    expect(desktopNames.map((name) => name && [name.text, name.whole]).sort()).toEqual([['Claude Code', true], ['Claude Code', true], ['Claude Code', true], ['Codex', true], ['Gemini', true]]);
    // On a touch phone the name still prints, whole, and every row stays a 44px target (plan rule 6).
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page!.settle();
    const phoneNames: { text: string; whole: boolean; height: number }[] = await page!.evaluate(teamRowNames);
    expect(phoneNames.map((name) => name && [name.text, name.whole]).sort()).toEqual([['Claude Code', true], ['Claude Code', true], ['Claude Code', true], ['Codex', true], ['Gemini', true]]);
    expect(Math.min(...phoneNames.map((name) => name.height))).toBeGreaterThanOrEqual(44);
    // Nothing scrolls sideways, at the width named: the window is that wide, the page that wide or a classic scrollbar
    // narrower (Linux CI draws a 15px one; a touch phone none), and nothing runs past it.
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/**
 * Where Team rows are measured: three columns from 768px (md:grid-cols-3, 202px each at 768), 1024 and 1280 (the widths
 * the tool-name test above skipped; titles were 0px at 768-1024 and 26-116px at 1280-1440 with the name, the mark and
 * the status beside them), 1440, and a 390px touch phone (one column).
 */
const TEAM_WIDTHS: { width: number; touch?: boolean }[] = [{ width: 768 }, { width: 1024 }, { width: 1280 }, { width: 1440 }, { width: 390, touch: true }];

/** Resizes the open page, as a window or a touch phone, and lets it lay out again. */
async function resize(width: number, touch = false) {
  await page!.send('Emulation.setDeviceMetricsOverride', { width, height: touch ? 844 : 900, deviceScaleFactor: 1, mobile: touch });
  await page!.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await page!.settle();
}

/**
 * A row this narrow leaves its badge's words 0.4px: its content is 42.75px (64 less the row's 10.6px padding each
 * side), and the pill's own mark, gap, padding and edge take 42.4px. A badge held to its row would break every word;
 * one held to its longest word breaks none.
 */
const SQUEEZED_ROW_PX = 64;

// Each width-sensitive test runs with no scrollbar and with a classic 15px one (SCROLLBAR_MODES): PR #6210's CI measured
// every width here 15px narrower with Chrome's own scrollbar on Linux.
for (const scrollbar of SCROLLBAR_MODES) {
it.skipIf(!chromeExecutablePath)(`Team columns at 768, 1024, 1280, 1440 and on a touch phone, in English and Korean, with ${scrollbar.label}: each row’s whole title on a line of its own as wide as the row, the tool’s name whole, every status badge one line with its words whole, also squeezed`, async () => {
  try {
    await openPage(`&scenario=team${scrollbar.query}`, { width: 768, height: 900 });
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the sample board');
    await page!.evaluate(`window.store.getState().setWorkspace({ team: true })`);
    await waitFor(`[...document.querySelectorAll('[role=radio]')].some((item) => window.nameOf(item) === 'Team')`, 'the Team view');
    await chooseView('Team');
    await waitFor(`document.querySelector('[data-team-column] [data-request-row]')`, 'the Team rows');
    const teamRows = `[...document.querySelectorAll('[data-team-column] [data-request-row]')]`;
    for (const locale of ['en', 'ko'] as const) {
      await page!.evaluate(`window.setLocale(${JSON.stringify(locale)})`);
      await page!.settle();
      for (const { width, touch = false } of TEAM_WIDTHS) {
        await resize(width, touch);
        const rows: { title: string; state: string; widths: object; titleAsWideAsRow: boolean; titleWhole: boolean; badge: object; name: { text: string; whole: boolean } | null; height: number }[] = await page!.evaluate(`${teamRows}.map(window.rowLayout)`);
        // The sample's open rows: Alex's two working ones and his "Done, not checked", and Priya's "Your move".
        expect(rows.map((row) => row.state).sort()).toEqual(['needs-check', 'working', 'working', 'your-move']);
        for (const row of rows) {
          // The title is the row's whole width, so nothing shares its line, and it wraps instead of being cut; the badge
          // is one line with every word whole and inside the pill; the tool's name prints whole beside the mark.
          expect({ locale, width, title: row.title, widths: row.widths, asWideAsRow: row.titleAsWideAsRow, whole: row.titleWhole, badge: row.badge, name: row.name?.whole })
            .toEqual({ locale, width, title: row.title, widths: row.widths, asWideAsRow: true, whole: true, badge: { lines: 1, brokenWord: null, inside: true }, name: true });
        }
        if (touch) expect(Math.min(...rows.map((row) => row.height))).toBeGreaterThanOrEqual(44);
        expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), width, { touch })).toMatchObject(FITS_THE_WINDOW);
      }
      // At any width (StateBadge): every row squeezed to 64px in the page, its badge keeps each word whole and inside
      // the pill, wrapping between words only.
      await resize(1440);
      const squeezed: { brokenWord: string | null; inside: boolean }[] = await page!.evaluate(`(() => {
        const rows = ${teamRows};
        for (const row of rows) row.style.width = '${SQUEEZED_ROW_PX}px';
        const words = rows.map((row) => window.badgeWords(row.querySelector('[data-state-badge]')));
        for (const row of rows) row.style.width = '';
        return words;
      })()`);
      expect({ locale, squeezed: squeezed.map(({ brokenWord, inside }) => ({ brokenWord, inside })) })
        .toEqual({ locale, squeezed: squeezed.map(() => ({ brokenWord: null, inside: true })) });
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)(`By agent cards at 768, 1024 and 1280, with ${scrollbar.label}: each request’s whole title on a line of its own as wide as its row, its status badge one line`, async () => {
  try {
    await openPage(`&scenario=team${scrollbar.query}`, { width: 768, height: 900 });
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the sample board');
    await chooseView('By agent');
    await waitFor(`document.querySelector('[data-agent-card] [data-request-row]')`, 'the agent cards');
    for (const width of [768, 1024, 1280]) {
      await resize(width);
      const rows: { title: string; widths: object; titleAsWideAsRow: boolean; titleWhole: boolean; badge: object }[] = await page!.evaluate(`[...document.querySelectorAll('[data-agent-card] [data-request-row]')].map(window.rowLayout)`);
      // Every sample request has an agent: five rows on four cards.
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect({ width, title: row.title, widths: row.widths, asWideAsRow: row.titleAsWideAsRow, whole: row.titleWhole, badge: row.badge })
          .toEqual({ width, title: row.title, widths: row.widths, asWideAsRow: true, whole: true, badge: { lines: 1, brokenWord: null, inside: true } });
      }
      expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), width)).toMatchObject(FITS_THE_WINDOW);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);
}

it.skipIf(!chromeExecutablePath)('one live model that changes two requests moves two things at most in the List, By agent and Team: the ticker and the newest riffle (rule 8)', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    // Each round flips the same two working requests in one model: on the List's table, on By agent (where two agents'
    // cards change places), and on Team.
    const rounds: [string, string][] = [['List', 'your-move'], ['By agent', 'working'], ['Team', 'your-move']];
    for (const [view, state] of rounds) {
      if (view === 'Team') {
        await page!.evaluate(`window.store.getState().setWorkspace({ team: true })`);
        await waitFor(`[...document.querySelectorAll('[role=radio]')].some((item) => window.nameOf(item) === 'Team')`, 'the Team view');
      }
      await chooseView(view);
      if (view === 'List') await waitFor(`window.tableRows().length > 0`, 'the table');
      await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g2' || request.id === 'g3'
        ? { ...request, state: ${JSON.stringify(state)}, next: ${JSON.stringify(state)} === 'working' ? { who: 'bot', text: 'Keep going' } : { who: 'human', text: 'Look at this' } } : request) }))`);
      const seen: string[][] = await page!.evaluate(`window.movingThingsOver(1500)`);
      const most = Math.max(...seen.map((things) => things.length));
      const everything = [...new Set(seen.flat())];
      expect({ view, most, rowsMoving: everything.filter((thing) => thing.startsWith('moving: ')) }).toEqual({ view, most: expect.any(Number), rowsMoving: [] });
      expect(most).toBeLessThanOrEqual(2);
      // The riffle was seen, so the count is not empty by accident; both changed rows say "just updated", still.
      expect(everything.some((thing) => thing.startsWith('riffle: '))).toBe(true);
      expect(await page!.evaluate(`document.querySelectorAll('[data-board-view] [data-just-updated]').length`)).toBe(2);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

for (const scrollbar of SCROLLBAR_MODES) {
it.skipIf(!chromeExecutablePath)(`from 768px up to the table a List row keeps its progress, start, area and running time; with Team on the List is rows that say who asked, the title kept readable; the table only where its title column keeps ${LIST_TITLE_MIN_PX}px, with ${scrollbar.label}`, async () => {
  try {
    await openPage(`&scenario=many${scrollbar.query}`, { width: 1024, height: 900 });
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('List');
    await waitFor(`document.querySelector('[data-request-row] [data-row-facts]')`, 'the List rows');
    // The facts of a working request from the work viewer's area: its 70% bar, its start as a time in the reader's clock
    // (the shared LocalTime: a Tab stop with the full time in its tooltip), its area link, and how long it has run.
    const facts = (title: string) => page!.evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-request-row]')].find((each) => each.querySelector('[data-row-target] .truncate').textContent === ${JSON.stringify(title)});
      const line = row.querySelector('[data-row-facts]');
      return { shown: getComputedStyle(line).display !== 'none', progress: line.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? null, start: line.querySelector('time[datetime]')?.getAttribute('tabindex') ?? null,
        area: [...line.querySelectorAll('button')].map((button) => button.textContent.trim()), text: line.innerText.replace(/\\s+/g, ' ') };
    })()`);
    const working = await facts('Generated request 2');
    expect({ ...working, text: undefined }).toEqual({ shown: true, progress: '70', start: '0', area: [expect.any(String)], text: undefined });
    expect(working.text).toMatch(/70%.*Started .*Running /);
    expect(working.text).not.toContain('asked by');
    // Team on: the same line says who asked; at 1024 the List was rows already.
    await page!.evaluate(`window.store.getState().setWorkspace({ team: true })`);
    await waitFor(`document.querySelector('[data-request-row] [data-row-facts]')?.innerText.includes('asked by You')`, 'who asked on the row');
    // At 1366 with Team on, the table's title column would be about 70px, so the List stays rows, with a whole-width title.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    expect(await page!.evaluate(`document.querySelector('table[aria-label]')`)).toBe(null);
    const rowTitle = await page!.evaluate(`document.querySelector('[data-request-row] [data-row-target] .truncate').getBoundingClientRect().width`);
    expect(rowTitle).toBeGreaterThanOrEqual(LIST_TITLE_MIN_PX);
    // Team off: across the widths where the table starts (1355 to 1390px, and the owner's 1366), the List is the table
    // exactly where its title column keeps LIST_TITLE_MIN_PX, and rows elsewhere. A classic scrollbar takes 12px from
    // that column (it was 175.5px at 1366 on PR #6210's Linux CI under a window-width rule), so it moves the start.
    await page!.evaluate(`window.store.getState().setWorkspace({ team: false })`);
    const sweep: { width: number; table: boolean; titleColumn: number | null; rows: number }[] = [];
    for (const width of [1355, 1360, 1365, 1366, 1370, 1375, 1380, 1385, 1390]) {
      await page!.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await page!.settle();
      sweep.push(await page!.evaluate(`(() => { const head = document.querySelector('table[aria-label] thead th:nth-child(2)');
        return { width: ${width}, table: !!head, titleColumn: head ? Math.round(head.getBoundingClientRect().width * 100) / 100 : null, rows: document.querySelectorAll('[data-request-row]').length }; })()`));
    }
    console.log(`[board-views] List at 1355-1390px with ${scrollbar.label}: ${JSON.stringify(sweep)}`);
    for (const step of sweep) {
      expect({ width: step.width, kept: step.table ? step.titleColumn! >= LIST_TITLE_MIN_PX : step.rows > 0 }).toEqual({ width: step.width, kept: true });
    }
    // The table comes within the sweep either way, and with no scrollbar it is the table at 1366, as before.
    expect(sweep.at(-1)!.table).toBe(true);
    if (!scrollbar.classic) expect(sweep.find((step) => step.width === 1366)!.table).toBe(true);
    // At 1440 the table, its title column at least as wide; its start time opens its full stamp on keyboard focus too
    // (G10; it was a mouse-only title): Tab from the row's area link lands on it.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    await waitFor(`document.querySelector('table[aria-label]')`, 'the table');
    expect(await page!.evaluate(`document.querySelector('table[aria-label] thead th:nth-child(2)').getBoundingClientRect().width`)).toBeGreaterThanOrEqual(LIST_TITLE_MIN_PX);
    await page!.evaluate(`[...window.tableRows()][0].querySelector('td:nth-child(2) button').focus()`);
    await press('Tab');
    expect(await page!.evaluate(`document.activeElement.matches('td:nth-child(6) time[datetime]') && !document.activeElement.hasAttribute('title')`)).toBe(true);
    await waitFor(`[...document.querySelectorAll('[data-slot=tooltip-content]')].some((tip) => /2026/.test(tip.textContent))`, 'the full start time in its tooltip');
    // Below 768px the row is the phone's row again: no facts line.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
    await page!.settle();
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-request-row] [data-row-facts]')].every((line) => getComputedStyle(line).display === 'none')`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);
}

it.skipIf(!chromeExecutablePath)('the Progress cell reads its percent once, and a shipped request that took under a minute says so', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await chooseView('List');
    await page!.evaluate(`window.store.getState().setSort('started')`);
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g129' ? { ...request, runningForMs: 30_000 } : request) }))`);
    await waitFor(`window.tableRows()[0]?.querySelector('td:nth-child(2) span').textContent === 'Generated request 129'`, 'the newest row first');
    // The bar's name carries the percent; the number beside it is not read again (it was "100% 100%").
    const progress = await accessibleName('table[aria-label] tbody tr[data-list-row] td:nth-child(5)');
    expect(progress.name.match(/\d+%/g)).toEqual(['100%']);
    // It shipped: its run took under a minute, never "Just started".
    expect((await accessibleName('table[aria-label] tbody tr[data-list-row] td:nth-child(7)')).name).toBe('Took under a minute');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the sorted Cards board pages through the shared paging: a new sort starts over, and "Show more" puts focus on the first card it added, shown', async () => {
  try {
    await openPage('&scenario=many');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    // Every idle request working again: 83 working cards, a page and a half under the Working filter.
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.state === 'idle' ? { ...request, state: 'working' } : request) }))`);
    await page!.evaluate(`window.store.getState().setFilter('working'); window.store.getState().setSort('started')`);
    const cards = `document.querySelectorAll('[data-board-view] [data-list-row]')`;
    await waitFor(`${cards}.length === ${LINE_ROWS_PER_PAGE}`, 'the first page of cards');
    const working = MANY.working + MANY.idle;
    // By keyboard: focus lands on the first card added, and it shows (it had none of its own).
    await page!.evaluate(`window.buttonsNamed('^Show ${working - LINE_ROWS_PER_PAGE} more')[0].focus()`);
    await press('Enter');
    await waitFor(`${cards}.length === ${working}`, 'every card');
    expect(await page!.evaluate(`document.activeElement === ${cards}[${LINE_ROWS_PER_PAGE}] && window.focusShows()`)).toBe(true);
    // A new sort starts the board on its first page again.
    await page!.evaluate(`window.store.getState().setSort('progress')`);
    await waitFor(`${cards}.length === ${LINE_ROWS_PER_PAGE}`, 'the first page again');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('By agent: "Show more" among the idle agents counts only its own cards, an open Subagents fold inside one too, and the focused card shows it', async () => {
  try {
    await openPage('&scenario=idle-agents');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the idle-agents board');
    await chooseView('By agent');
    await page!.evaluate(`document.querySelector('[data-agent-fold=idle-agents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-agent-card=idle-0] [data-subagents]')`, 'the idle cards');
    // The first card's three subagents, opened: rows of their own list, inside the first card.
    await page!.evaluate(`document.querySelector('[data-agent-card=idle-0] [data-subagents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelectorAll('[data-agent-card=idle-0] [data-subagent-row]').length === 3`, 'the open Subagents fold');
    const idleCards = `[...document.querySelectorAll('[data-agent-fold=idle-agents] [data-agent-card]')].filter((card) => !card.closest('[data-subagents]'))`;
    expect(await page!.evaluate(`${idleCards}.length`)).toBe(LINE_ROWS_PER_PAGE);
    await page!.evaluate(`window.buttonsNamed('^Show ${IDLE_CARDS - LINE_ROWS_PER_PAGE} more')[0].focus()`);
    await press('Enter');
    await waitFor(`${idleCards}.length === ${IDLE_CARDS}`, 'every idle card');
    // Focus is on card 51, the first one added, not three cards early, and the keyboard user sees where it went.
    expect(await page!.evaluate(`document.activeElement.querySelector('[data-agent-card]')?.dataset.agentCard`)).toBe(`idle-${LINE_ROWS_PER_PAGE}`);
    expect(await page!.evaluate('window.focusShows()')).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('My Rules with no rules yet and a failed refresh shows the failed line and one Try again', async () => {
  try {
    await openPage('&scenario=failed-refresh-no-rules&view=rules');
    await waitFor(`document.querySelector('[data-slot=empty]')`, 'My Rules with no rules');
    expect(await page!.evaluate(`document.querySelector('[data-slot=empty]').innerText`)).toContain('No rules yet');
    await waitFor(`document.querySelector('[data-refresh-line=failed]')`, 'the failed refresh line');
    expect(await page!.evaluate(`window.buttonsNamed('^(Try again|Refresh now|Refresh)$').map((button) => window.nameOf(button))`)).toEqual(['Try again']);
    await page!.evaluate(`window.clickNamed('^Try again$')`);
    await waitFor(`window.refreshStarts === 1`, 'the refresh Try again starts');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

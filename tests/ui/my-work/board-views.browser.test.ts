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
import { CARD_GROUPS, LINE_ROWS_PER_PAGE, LIST_TITLE_MIN_PX } from '../../../src/ui/my-work/src/live/card-groups';
import { UNRECORDED_AGENT } from '../../../src/ui/my-work/src/live/to-work-model';
import type { LiveState } from '../../../src/ui/my-work/src/data';
import { myWorkPlace } from '../../../src/ui/app-places';

failOnCiWithoutChrome('CI requires Chrome for the My Work Requests page, List, By agent, Team and read-error regressions.');

/**
 * Requests (design pass Phase 5, Codex D06) on the real App, its compiled stylesheet and its Geist font: its title and
 * line, the find box (in the page, no read), Filter and sort (an area, the closed requests, the sort; its count in
 * words), status tabs from CARD_GROUPS whose counts add up to All, rows that are links 50 at a time (an untitled one
 * says its title is being written), a tab, an area and the closed choice as history entries and the words in the
 * address, which Back brings back where they were scrolled, the phone; By agent on it (the busiest agent open, the
 * others rows that open in place, "Agent not recorded" as a group, the agents with nothing here folded, the find box
 * for an agent or session, the read-error card, what it says with nothing to show, Mark finished behind a confirm);
 * focus on the h1 when the list and By agent change places; and the Team board in its place when Team view is on.
 *
 * Phase 4 of the pro-max-v16 plan, on the old board Home keeps until design pass Phase 6:
 * - the List (c-work-list-view, c-ui-table): 50 rows at a time (G4) and "Show 50 more", rows that are Tab stops Enter
 *   opens, a status cell a screen reader hears as one word (also while its split-flap tiles riffle after a live
 *   change, and only the newest change riffles), 44px rows on a touch phone;
 * - Team (c-work-team-board): the note for one person, Sort, G4 columns and the dashed places for teammates; each
 *   row's whole title on a line of its own, from 768px to a phone, and status badges that never break inside a word
 *   (StateBadge), in English and Korean; By agent's rows show each whole title the same way;
 * - the read-error card (sample case): plain words, the raw reason folded, Try again with its outcome, and a Dismiss
 *   per request that holds for that error and moves focus on;
 * - after a failed refresh, My Rules, Past focus and Suggested areas each offer one control, Try again;
 * - rule 8: one live model that changes several requests moves two things at most: Home's List (the ticker and the
 *   newest riffle), and on Requests, By agent (nothing) and Team (the newest riffle).
 * Nothing here reaches a worker: the data is the sample, reshaped in the page where a test needs more of it.
 */
/** The bar's Requests, and the crumb back to it from By agent: the place's own words. */
const REQUESTS_PLACE = myWorkPlace('requests').label;
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
  ArrowDown: { code: 'ArrowDown', keyCode: 40, text: undefined }, ArrowUp: { code: 'ArrowUp', keyCode: 38, text: undefined },
  Escape: { code: 'Escape', keyCode: 27, text: undefined },
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
    // Every generated request placed in this focus area (\`&placed=fa-viewer\`), so that area's page shows the old board
    // with all of them (Home gave its board up in design pass Phase 6; an area's page keeps it until Phase 8).
    const placed = new URLSearchParams(location.search).get('placed');
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
      return { ...from, ...(placed ? { focusAreaId: placed } : {}), id: 'g' + index, title: 'Generated request ' + index, contentFingerprint: 'g' + index, agentId, askedBy: 'You',
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
      if (document.querySelector('[data-slot="work-shell"] main section, [data-slot="work-shell"] main [data-slot="empty"], [data-slot="work-shell"] main [data-board-view]')) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForPage);
    })();
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    window.nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    window.buttonsNamed = (pattern) => [...document.querySelectorAll('button')].filter((button) => visible(button) && new RegExp(pattern).test(window.nameOf(button)));
    window.clickNamed = (pattern) => { const button = window.buttonsNamed(pattern)[0]; if (!button) throw new Error('no button ' + pattern); button.click(); };
    // Types into a field React controls, as the person's typing would (the value setter React tracks, then the event).
    window.typeInto = (selector, words) => { const field = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, words); field.dispatchEvent(new Event('input', { bubbles: true })); };
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
    // by what it moves: the ticker, one status badge's riffle, one agent's group on By agent (the one around the element
    // or inside it), or the request it moves (the one whose row, line or card is around the element, or the one inside
    // it), else that one element. So each moving element is counted apart unless it moves a part of the same thing: an
    // element outside a row or card was named by its tag, so several of them read as one thing (Phase 6 re-verify V2).
    // Answers the things of each frame.
    window.movingThingsOver = (ms) => {
      const scopes = () => [document.querySelector('[data-ticker]'), document.querySelector('[data-board-view]')].filter(Boolean);
      // An element named apart has its own number: one in no agent's or request's block, or in a block of several.
      const elementNumbers = new WeakMap();
      let elementsNumbered = 0;
      const numberedName = (element) => { if (!elementNumbers.has(element)) elementNumbers.set(element, ++elementsNumbered); return element.tagName + '#' + elementNumbers.get(element); };
      // One thing's own block: an agent's group, a request's card, its List row or table row, its one-line row.
      const ownBlock = (element) => element.closest('[data-agent-group], [data-slot="card"], [data-list-row], [data-request-row], [data-request-line]') ?? element;
      const requestIdsIn = (element) => new Set([...(element.matches('[data-request-opener]') ? [element] : []), ...element.querySelectorAll('[data-request-opener]')].map((opener) => opener.dataset.requestOpener));
      const thing = (element) => {
        if (element.closest('[data-ticker]')) return 'ticker';
        const own = ownBlock(element);
        const agents = own.matches('[data-agent-group]') ? [own] : [...own.querySelectorAll('[data-agent-group]')];
        const requests = requestIdsIn(own);
        const name = agents.length === 1 ? 'agent ' + agents[0].dataset.agentGroup : requests.size === 1 ? [...requests][0] : numberedName(own);
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

/** The many scenario on a focus area's page, every generated request placed in it: the old board's Cards, List, By agent and Team until design pass Phase 8. */
const AREA_BOARD = '&scenario=many&placed=fa-viewer&focus=fa-viewer';

it.skipIf(!chromeExecutablePath)('the List draws 50 rows; "Show 50 more" adds 50, says how many are left and moves focus to the first new row', async () => {
  try {
    await openPage(AREA_BOARD);
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
    // And a new area: two pages in the work viewer's area, then another area and back, one page.
    await page!.evaluate(`window.clickNamed('^Show 50 more')`);
    await waitFor(`window.tableRows().length === 100`, 'two pages in the area');
    await page!.evaluate(`window.store.getState().goToFocus('fa-sync')`);
    await waitFor(`window.tableRows().length === 0 && document.querySelector('[data-focus-header]')`, 'the Cloud sync area, which holds none of them');
    await page!.evaluate(`window.store.getState().goToFocus('fa-viewer')`);
    await waitFor(`window.tableRows().length === ${LINE_ROWS_PER_PAGE}`, "the work viewer's area on its first page");
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Tab reaches a List row, Enter opens its drawer, and the table has a name; non-sortable headings look plain', async () => {
  try {
    await openPage(AREA_BOARD);
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
    await openPage(AREA_BOARD);
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
    await openPage(AREA_BOARD, { width: 390, height: 844, touch: true });
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

/** The many scenario's requests in each state (MANY): what each status tab must count. A new state fails the typecheck here. */
const MANY_BY_STATE: Record<LiveState, number> = { 'your-move': MANY.yourMove, 'needs-check': 0, working: MANY.working, idle: MANY.idle, shipped: MANY.shipped };
const groupCount = (states: readonly LiveState[]) => states.reduce((sum, state) => sum + MANY_BY_STATE[state], 0);
/** Requests' list rows, in order (not By agent's nor the Team board's). */
const LIST_ROWS = `[...document.querySelectorAll('[data-board-view=list] [data-requests-row]')]`;
/** Each status tab: its id, whether it is the one shown, its count and the status its address names. */
const STATUS_TABS = `[...document.querySelectorAll('[data-status-tab]')].map((tab) => ({ id: tab.dataset.statusTab, current: tab.getAttribute('aria-current'), label: tab.firstChild.textContent, count: Number(tab.querySelector('span').textContent), status: new URL(tab.href).searchParams.get('status') }))`;
/** Requests' address details, as the address holds them now. */
const ADDRESS_DETAILS = `Object.fromEntries(['status', 'area', 'closed', 'q', 'by'].map((name) => [name, new URLSearchParams(location.search).get(name)]))`;
const pageWords = `({ h1: document.querySelector('main h1').textContent, lead: document.querySelector('[data-requests-lead]').textContent })`;

it.skipIf(!chromeExecutablePath)('Requests: its title and line, the find box, Filter and sort and By agent, then status tabs from CARD_GROUPS whose counts add up to All; a tab is a link and a history entry, and Back brings the last tab back where it was scrolled', async () => {
  try {
    await openPage('&scenario=many&view=requests');
    await waitFor(`${LIST_ROWS}.length === ${LINE_ROWS_PER_PAGE}`, 'the first 50 rows');
    expect(await page!.evaluate(pageWords)).toEqual({ h1: 'All requests', lead: `${MANY_TOTAL} requests across your workspace.` });
    // The toolbar: the find box named by its words, Filter and sort, and By agent as a link to `?by=agent`.
    expect(await page!.evaluate(`[document.querySelector('main input[type=search]').getAttribute('aria-label'), window.nameOf(document.querySelector('[data-filter-and-sort]')),
      [...document.querySelectorAll('main a[href]')].filter((link) => link.textContent.trim() === 'By agent').map((link) => new URL(link.href).searchParams.get('by'))]`))
      .toEqual(['Find a request', 'Filter and sort', ['agent']]);
    // The tabs: All, then every group of the one list, in its order and words, each counting its states. The one shown
    // is current within the page ("true"); the bar's Requests is the current page.
    const tabs: { id: string; current: string | null; label: string; count: number; status: string | null }[] = await page!.evaluate(STATUS_TABS);
    expect(tabs).toEqual([
      { id: 'all', current: 'true', label: 'All', count: MANY_TOTAL, status: null },
      ...CARD_GROUPS.map((group) => ({ id: group.id, current: null, label: group.label, count: groupCount(group.states), status: group.id })),
    ]);
    expect(tabs.slice(1).reduce((sum, tab) => sum + tab.count, 0)).toBe(tabs[0].count);
    // One line per request: its name, its area under it, its state at the right, the whole row a link to it.
    expect(await page!.evaluate(`(() => { const row = ${LIST_ROWS}[0]; return { tag: row.tagName, request: new URL(row.href).searchParams.get('request'), view: new URL(row.href).searchParams.get('view'), title: row.querySelector('[data-row-title]').textContent, area: row.querySelector('[data-row-area]').textContent, state: row.querySelector('[data-state-words]').textContent } })()`))
      .toEqual({ tag: 'A', request: 'g1', view: 'requests', title: 'Generated request 1', area: 'Other', state: 'Your move' });
    // Idle: its own title and line, its rows 50 at a time, and "Show 30 more" puts focus on the first row it added.
    await page!.evaluate(`document.querySelector('[data-status-tab=idle]').click()`);
    await waitFor(`new URLSearchParams(location.search).get('status') === 'idle' && ${LIST_ROWS}.length === ${LINE_ROWS_PER_PAGE}`, 'the Idle tab');
    expect(await page!.evaluate(pageWords)).toEqual({ h1: 'Idle requests', lead: `${MANY.idle} requests.` });
    expect(await page!.evaluate(`${LIST_ROWS}.every((row) => row.dataset.requestsRow === 'idle')`)).toBe(true);
    expect(await page!.evaluate(`window.nameOf(window.buttonsNamed('^Show 30 more')[0])`)).toBe('Show 30 more · 30 left');
    await page!.evaluate(`window.clickNamed('^Show 30 more')`);
    await waitFor(`${LIST_ROWS}.length === ${MANY.idle}`, 'every idle row');
    expect(await page!.evaluate(`document.activeElement === ${LIST_ROWS}[${LINE_ROWS_PER_PAGE}]`)).toBe(true);
    // Scrolled down, another tab: a new history entry on its first page; Back brings Idle back, scrolled where it was.
    await page!.evaluate('window.scrollTo(0, 1500)');
    await waitFor('Math.abs(scrollY - 1500) <= 3', 'Idle scrolled');
    await page!.settle();
    const idleY: number = await page!.evaluate('scrollY');
    await page!.evaluate(`document.querySelector('[data-status-tab=working]').click()`);
    await waitFor(`new URLSearchParams(location.search).get('status') === 'working' && ${LIST_ROWS}.length === ${MANY.working}`, 'the Working tab');
    expect(await page!.evaluate(pageWords)).toEqual({ h1: 'Working requests', lead: `${MANY.working} requests.` });
    await page!.evaluate('history.back()');
    await waitFor(`new URLSearchParams(location.search).get('status') === 'idle' && document.querySelector('main h1').textContent === 'Idle requests' && Math.abs(scrollY - ${idleY}) <= 1`, 'Idle again, where it was left');
    // The bar's Requests opens the list on All.
    // Only the bar's Requests (the top bar's, and the phone's bottom bar's) says it is the current page.
    expect(await page!.evaluate(`[...new Set([...document.querySelectorAll('[aria-current=page]')].map((link) => (link.closest('main') ? 'page: ' : 'bar: ') + link.textContent.trim()))]`)).toEqual([`bar: ${REQUESTS_PLACE}`]);
    await page!.evaluate(`[...document.querySelectorAll('[data-slot=app-bar] a')].find((link) => link.textContent.trim() === ${JSON.stringify(REQUESTS_PLACE)}).click()`);
    await waitFor(`!new URLSearchParams(location.search).get('status') && document.querySelector('main h1').textContent === 'All requests'`, 'All requests from the bar');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Requests: the find box filters titles and summaries in the browser; Filter and sort chooses an area, the closed requests and the sort; a row opens its request over the page', async () => {
  try {
    await openPage('&scenario=many&view=requests');
    await waitFor(`${LIST_ROWS}.length > 0`, 'the Requests rows');
    const reads = await page!.evaluate('window.loads');
    // The words filter the rows of the tab shown, in the page (no read); the tabs keep counting the whole view.
    await page!.evaluate(`window.typeInto('main input[type=search]', 'Generated request 129')`);
    await waitFor(`${LIST_ROWS}.length === 1`, 'one match');
    expect(await page!.evaluate(`[${LIST_ROWS}[0].querySelector('[data-row-title]').textContent, document.querySelector('[data-requests-heard]').textContent, document.querySelector('[data-status-tab=all] span').textContent]`))
      .toEqual(['Generated request 129', '1 result', String(MANY_TOTAL)]);
    await page!.evaluate(`window.typeInto('main input[type=search]', 'zebra')`);
    await waitFor(`document.querySelector('[data-board-view=list] [data-slot=empty]')`, 'nothing found');
    expect(await page!.evaluate(`document.querySelector('[data-board-view=list] [data-slot=empty]').innerText.trim()`)).toBe('No request here matches “zebra”.');
    await page!.evaluate(`window.typeInto('main input[type=search]', '')`);
    await waitFor(`${LIST_ROWS}.length === ${LINE_ROWS_PER_PAGE}`, 'every row again');
    expect(await page!.evaluate('window.loads')).toBe(reads);
    // A closed request shows only with "Closed requests only", which appears once there is one.
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g129' ? { ...request, closed: true } : request) }))`);
    await waitFor(`document.querySelector('[data-status-tab=all] span').textContent === '${MANY_TOTAL - 1}'`, 'the closed one out of All');
    await page!.evaluate(`document.querySelector('[data-filter-and-sort]').click()`);
    await waitFor(`document.querySelector('[data-slot=popover-content]')`, 'Filter and sort');
    const popover = `document.querySelector('[data-slot=popover-content]')`;
    expect(await page!.evaluate(`[...${popover}.querySelectorAll('label')].map((label) => label.textContent)`)).toEqual(['Focus area', 'Closed requests only', 'Sort']);
    await page!.evaluate(`${popover}.querySelector('[role=switch]').click()`);
    await waitFor(`document.querySelector('[data-status-tab=all] span').textContent === '1'`, 'the closed requests');
    expect(await page!.evaluate(`[${LIST_ROWS}.map((row) => row.querySelector('[data-row-title]').textContent), document.querySelector('[data-requests-lead]').textContent, document.querySelector('[data-filter-count]').textContent, ${ADDRESS_DETAILS}.closed]`))
      .toEqual([['Generated request 129'], '1 request.', '1', '1']);
    // The count says what it counts to a screen reader; the number alone is only drawn.
    expect(await accessibleName('[data-filter-and-sort]')).toEqual({ role: 'button', name: 'Filter and sort 1 choice hides requests' });
    await page!.evaluate(`${popover}.querySelector('[role=switch]').click()`);
    await waitFor(`document.querySelector('[data-status-tab=all] span').textContent === '${MANY_TOTAL - 1}'`, 'the open requests again');
    // An area, by the keyboard: the areas the requests sit in, named as the rows name them, in the work's order.
    await page!.evaluate(`${popover}.querySelector('[role=combobox]').focus()`);
    await press('Enter');
    await waitFor(`document.querySelectorAll('[role=option]').length > 0`, 'the area choices');
    expect(await page!.evaluate(`[...document.querySelectorAll('[role=option]')].map((option) => option.textContent)`)).toEqual(['Every focus area', 'Viewer', 'Other']);
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    await waitFor(`document.querySelector('[data-status-tab=all] span').textContent === '${MANY.yourMove}'`, 'the requests in Other');
    expect(await page!.evaluate(STATUS_TABS)).toEqual([
      expect.objectContaining({ id: 'all', count: MANY.yourMove }),
      ...CARD_GROUPS.map((group) => expect.objectContaining({ id: group.id, count: group.states.includes('your-move') ? MANY.yourMove : 0 })),
    ]);
    expect(await page!.evaluate(`document.querySelector('[data-requests-lead]').textContent`)).toBe(`${MANY.yourMove} requests.`);
    // The sort, by the keyboard: Newest puts the newest request first.
    await page!.evaluate(`${popover}.querySelectorAll('[role=combobox]')[0].focus()`);
    await press('Enter');
    await waitFor(`document.querySelectorAll('[role=option]').length > 0`, 'the area choices again');
    await press('ArrowUp');
    await press('ArrowUp');
    await press('Enter');
    await waitFor(`document.querySelector('[data-status-tab=all] span').textContent === '${MANY_TOTAL - 1}'`, 'every area again');
    await page!.evaluate(`[...${popover}.querySelectorAll('[role=combobox]')].at(-1).focus()`);
    await press('Enter');
    await waitFor(`window.store.getState().view.sort === 'attention' && [...document.querySelectorAll('[role=option]')].some((option) => option.getAttribute('aria-selected') === 'true')`, 'the sorts, Needs you first chosen');
    await press('ArrowDown');
    await press('Enter');
    await waitFor(`window.store.getState().view.sort === 'started'`, 'Newest');
    await waitFor(`${LIST_ROWS}[0].querySelector('[data-row-title]').textContent === 'Generated request 128'`, 'the newest open request first');
    await press('Escape');
    // A plain press on a row opens its request over the page; its address keeps the page's own.
    await page!.evaluate(`${LIST_ROWS}[0].click()`);
    await waitFor(`document.querySelector('[role=dialog]')?.textContent.includes('Generated request 128')`, 'the request');
    expect(await page!.evaluate(`[new URLSearchParams(location.search).get('view'), new URLSearchParams(location.search).get('request')]`)).toEqual(['requests', 'g128']);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Requests: the find words, the area and the tab are in the address; each word replaces the entry and an area is a history entry; a tab keeps the area and the words, and Back brings each back after leaving the page', async () => {
  try {
    await openPage('&scenario=many&view=requests');
    await waitFor(`${LIST_ROWS}.length === ${LINE_ROWS_PER_PAGE}`, 'the first 50 rows');
    const entries: number = await page!.evaluate('history.length');
    // Each word typed replaces the entry: the words are in the address, and no entry is added.
    await page!.evaluate(`window.typeInto('main input[type=search]', 'Generated')`);
    await page!.evaluate(`window.typeInto('main input[type=search]', 'Generated request')`);
    await waitFor(`${ADDRESS_DETAILS}.q === 'Generated request'`, 'the words in the address');
    expect(await page!.evaluate('history.length')).toBe(entries);
    // An area, by the keyboard: a history entry.
    await page!.evaluate(`document.querySelector('[data-filter-and-sort]').click()`);
    await waitFor(`document.querySelector('[data-slot=popover-content] [role=combobox]')`, 'Filter and sort');
    await page!.evaluate(`document.querySelector('[data-slot=popover-content] [role=combobox]').focus()`);
    await press('Enter');
    await waitFor(`document.querySelectorAll('[role=option]').length > 0`, 'the area choices');
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    await waitFor(`${ADDRESS_DETAILS}.area === 'other'`, 'Other in the address');
    expect(await page!.evaluate('history.length')).toBe(entries + 1);
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=popover-content]')`, 'Filter and sort closed');
    // A status tab keeps the area and the words, in its link and in the address it goes to.
    expect(await page!.evaluate(`(() => { const url = new URL(document.querySelector('[data-status-tab=needs-you]').href); return ['status', 'area', 'q'].map((name) => url.searchParams.get(name)) })()`))
      .toEqual(['needs-you', 'other', 'Generated request']);
    await page!.evaluate(`document.querySelector('[data-status-tab=needs-you]').click()`);
    await waitFor(`${ADDRESS_DETAILS}.status === 'needs-you' && ${LIST_ROWS}.length === ${MANY.yourMove}`, 'the Needs you tab in Other');
    const shown = `[${ADDRESS_DETAILS}, document.querySelector('main h1').textContent, document.querySelector('main input[type=search]').value, document.querySelector('[data-filter-count]')?.textContent ?? null, document.querySelector('[aria-current=true][data-status-tab]').dataset.statusTab]`;
    const needsYouAddress = { status: 'needs-you', area: 'other', closed: null, q: 'Generated request', by: null };
    const needsYouInOther = [needsYouAddress, 'Requests that need you', 'Generated request', '1', 'needs-you'];
    expect(await page!.evaluate(shown)).toEqual(needsYouInOther);
    // Another page, then Back: the tab, the area and the words come back, drawn as they were.
    await page!.evaluate(`window.store.getState().goToPage('rules')`);
    await waitFor(`new URLSearchParams(location.search).get('view') === 'rules'`, 'My Rules');
    await page!.evaluate('history.back()');
    await waitFor(`document.querySelector('main h1')?.textContent === 'Requests that need you' && ${LIST_ROWS}.length === ${MANY.yourMove}`, 'Requests again');
    expect(await page!.evaluate(shown)).toEqual(needsYouInOther);
    // Back again: All in Other with the words; and again: every area, with the words typed into the first entry.
    await page!.evaluate('history.back()');
    await waitFor(`document.querySelector('main h1').textContent === 'All requests'`, 'All in Other');
    expect(await page!.evaluate(shown)).toEqual([{ ...needsYouAddress, status: null }, 'All requests', 'Generated request', '1', 'all']);
    await page!.evaluate('history.back()');
    await waitFor(`!document.querySelector('[data-filter-count]')`, 'every area');
    expect(await page!.evaluate(shown)).toEqual([{ ...needsYouAddress, status: null, area: null }, 'All requests', 'Generated request', null, 'all']);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Requests: a request whose title is still being written says so on its row, dimmed, and never shows its summary as its name', async () => {
  try {
    await openPage('&scenario=many&view=requests');
    await waitFor(`${LIST_ROWS}.length === ${LINE_ROWS_PER_PAGE}`, 'the first 50 rows');
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g1' ? { ...request, title: null, resolvesTo: undefined } : request) }))`);
    const row = `document.querySelector('[data-board-view=list] [data-request-opener=g1]')`;
    await waitFor(`${row}?.querySelector('[data-row-title]').textContent !== 'Generated request 1'`, 'the untitled row');
    expect(await page!.evaluate(`(() => {
      const title = ${row}.querySelector('[data-row-title]');
      const named = document.querySelector('[data-board-view=list] [data-request-opener=g0] [data-row-title]');
      const summary = window.store.getState().work.load.model.requests.find((request) => request.id === 'g1').summary;
      return { words: title.textContent, dimmed: getComputedStyle(title).color !== getComputedStyle(named).color, summaryShown: !!summary && ${row}.textContent.includes(summary) };
    })()`)).toEqual({ words: 'New request, title being written', dimmed: true, summaryShown: false });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Requests: when the list and By agent change places by the keyboard (By agent, Request list, the crumb), focus goes to the h1 and shows', async () => {
  try {
    await openPage('&scenario=many&view=requests');
    await waitFor(`${LIST_ROWS}.length > 0`, 'the Requests rows');
    const link = (words: string) => `[...document.querySelectorAll('main a[href]')].find((link) => link.textContent.trim() === ${JSON.stringify(words)})`;
    const focused = `({ heading: document.activeElement === document.querySelector('main h1'), words: document.activeElement.textContent, shows: window.focusShows() })`;
    const pressLink = async (words: string, arrived: string) => {
      await page!.evaluate(`${link(words)}.focus()`);
      await press('Enter');
      await waitFor(arrived, `the page after ${words}`);
      await page!.settle();
    };
    await pressLink('By agent', `document.querySelector('[data-agent-group]')`);
    expect(await page!.evaluate(focused)).toEqual({ heading: true, words: 'Requests by agent', shows: true });
    await pressLink('Request list', `${LIST_ROWS}.length > 0`);
    expect(await page!.evaluate(focused)).toEqual({ heading: true, words: 'All requests', shows: true });
    await pressLink('By agent', `document.querySelector('[data-agent-group]')`);
    // The crumb over the h1 leads back to the list.
    await pressLink(REQUESTS_PLACE, `${LIST_ROWS}.length > 0`);
    expect(await page!.evaluate(focused)).toEqual({ heading: true, words: 'All requests', shows: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Requests\' By agent shows the read-error card once, above the agents; with no agent and no request it says none is recorded yet, and nothing under the alert when the saved work could not be read', async () => {
  try {
    await openPage(`&sample-state=${sampleState('read-errors')}&view=requests&by=agent`);
    await waitFor(`document.querySelector('[data-read-errors=shown]') && document.querySelector('[data-agent-group]')`, 'the read-error card and the agents');
    expect(await page!.evaluate(`(() => {
      const cards = document.querySelectorAll('[data-read-errors]');
      const follows = (first, second) => !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { cards: cards.length, above: [...document.querySelectorAll('[data-agent-group]')].every((group) => follows(cards[0], group)) };
    })()`)).toEqual({ cards: 1, above: true });
    // No agent and no request: By agent says so, as the list does (it drew nothing at all).
    await page!.evaluate(`window.receive((model) => ({ ...model, requests: [], agents: [], requestReadErrors: [] }))`);
    const empty = (view: string) => `document.querySelector('[data-board-view=${view}] [data-slot=empty]')`;
    await waitFor(empty('agents'), 'nothing to show');
    expect(await page!.evaluate(`${empty('agents')}.innerText.replace(/\\s+/g, ' ').trim()`)).toBe('No requests recorded yet. Ask an agent for something and it appears here.');
    // The worker answered but could not read the saved work: its alert says so, and nothing is said under it.
    await page!.evaluate(`window.receive((model) => ({ ...model, sourceHealth: { connected: false, error: 'database is locked' } }))`);
    await waitFor(`!${empty('agents')}`, 'the empty words gone');
    expect(await page!.evaluate(`document.querySelector('main').innerText.includes("Can't read local work right now")`)).toBe(true);
    // The list says the same.
    await page!.evaluate(`window.store.getState().showRequests({})`);
    await waitFor(`document.querySelector('[data-board-view=list]')`, 'the list');
    expect(await page!.evaluate(`[!!${empty('list')}, document.querySelector('main').innerText.includes('No requests recorded yet.')]`)).toEqual([false, false]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Requests on a touch phone: every row, tab and control is 44px or more, the toolbar wraps under the find box, and the page is as wide as the window', async () => {
  try {
    await openPage('&scenario=many&view=requests', { width: 390, height: 844, touch: true });
    await waitFor(`${LIST_ROWS}.length === ${LINE_ROWS_PER_PAGE}`, 'the first 50 rows');
    const heights = await page!.evaluate(`({
      rows: Math.min(...${LIST_ROWS}.map((row) => row.getBoundingClientRect().height)),
      tabs: Math.min(...[...document.querySelectorAll('[data-status-tab]')].map((tab) => tab.getBoundingClientRect().height)),
      controls: Math.min(...[document.querySelector('main input[type=search]').closest('[data-slot=input-group]'), document.querySelector('[data-filter-and-sort]'), [...document.querySelectorAll('main a[href]')].find((link) => link.textContent.trim() === 'By agent')].map((control) => control.getBoundingClientRect().height)),
      wraps: document.querySelector('[data-filter-and-sort]').getBoundingClientRect().top > document.querySelector('main input[type=search]').getBoundingClientRect().bottom,
    })`);
    expect(heights.rows).toBeGreaterThanOrEqual(44);
    expect(heights.tabs).toBeGreaterThanOrEqual(44);
    expect(heights.controls).toBeGreaterThanOrEqual(44);
    expect(heights.wraps).toBe(true);
    expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), 390, { touch: true })).toMatchObject(FITS_THE_WINDOW);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/** Opens an agent's group by its header, unless it is open. */
async function openAgentGroup(id: string) {
  await page!.evaluate(`(() => { const group = document.querySelector('[data-agent-group="${id}"]'); if (group.dataset.state !== 'open') group.querySelector('[data-agent-header]').click() })()`);
  await waitFor(`document.querySelector('[data-agent-group="${id}"]').dataset.state === 'open'`, `${id} open`);
}

it.skipIf(!chromeExecutablePath)('By agent: the busiest agent open on its panel, the others rows under "Other agents" with "Agent not recorded" first, the agents with nothing here folded with their count; no agent on the rows; subagents only under their parent; sessions of one folder told apart', async () => {
  try {
    await openPage('&scenario=many&view=requests&by=agent');
    await waitFor(`document.querySelector('[data-agent-group]')`, 'the agent groups');
    expect(await page!.evaluate(`[document.querySelector('main h1').textContent, document.querySelector('[data-requests-lead]').textContent, document.querySelector('main input[type=search]').getAttribute('aria-label')]`))
      .toEqual(['Requests by agent', 'Open an agent to see its requests.', 'Find an agent or session']);
    // The crumb and Request list both lead back to the list, on All.
    expect(await page!.evaluate(`[...document.querySelectorAll('main a[href]')].filter((link) => [${JSON.stringify(REQUESTS_PLACE)}, 'Request list'].includes(link.textContent.trim())).map((link) => [link.textContent.trim(), link.closest('nav') ? 'crumb' : 'toolbar', new URL(link.href).search])`))
      .toEqual([[REQUESTS_PLACE, 'crumb', '?source=sample&scenario=many&view=requests'], ['Request list', 'toolbar', '?source=sample&scenario=many&view=requests']]);
    // The first group is the busiest agent's, open on its panel, its most urgent request needing the owner.
    const groups = `[...document.querySelectorAll('[data-agent-group]')]`;
    const panel = await page!.evaluate(`(() => { const group = ${groups}[0]; return { open: group.dataset.state, heading: !!group.querySelector('h2 [data-agent-header]'), first: group.querySelector('[data-requests-row]').dataset.requestsRow } })()`);
    expect(panel).toEqual({ open: 'open', heading: true, first: 'your-move' });
    // "Other agents": the requests no agent is recorded for first, a group like any agent's, closed until opened.
    expect(await page!.evaluate(`[...document.querySelectorAll('main h2')].map((heading) => heading.textContent).includes('Other agents')`)).toBe(true);
    const unrecorded = `document.querySelector('[data-agent-group=${UNRECORDED_AGENT.id}]')`;
    expect(await page!.evaluate(`[${groups}.indexOf(${unrecorded}), ${unrecorded}.dataset.state, ${unrecorded}.querySelector('[data-agent-name]').textContent, ${unrecorded}.querySelector('[data-agent-header]').textContent.includes('${MANY.noAgent} requests')]`))
      .toEqual([1, 'closed', UNRECORDED_AGENT.name, true]);
    await openAgentGroup(UNRECORDED_AGENT.id);
    await waitFor(`${unrecorded}.querySelectorAll('[data-requests-row]').length === ${LINE_ROWS_PER_PAGE}`, 'its first 50 rows');
    expect(await page!.evaluate(`window.nameOf([...${unrecorded}.querySelectorAll('button')].find((button) => /^Show 10 more/.test(window.nameOf(button))))`)).toBe('Show 10 more · 10 left');
    // No row says its agent again: the group names it once.
    expect(await page!.evaluate(`document.querySelectorAll('[data-agent-group] [data-requests-row] [role=img]').length`)).toBe(0);
    // The agents with nothing here: one dashed line that counts them with their subagents (the empty agents, the two
    // sessions of one folder and the subagent with no parent link).
    const fold = await page!.evaluate(`(() => { const trigger = document.querySelector('[data-agent-fold=idle-agents] [data-slot=collapsible-fold-trigger]');
      return { label: trigger.querySelector(':scope > span:not([data-slot])').textContent, end: trigger.querySelector('[data-slot=fold-trigger-count]').textContent, edge: getComputedStyle(trigger).borderTopStyle, height: trigger.getBoundingClientRect().height } })()`);
    expect({ ...fold, height: fold.height < 60 }).toEqual({ label: `${MANY.emptyAgents + MANY.twins + 1} agents have nothing in this view`, end: 'Show them', edge: 'dashed', height: true });
    // The linked subagents sit in a fold under their parent, never as groups of their own.
    expect(await page!.evaluate(`document.querySelectorAll('[data-agent-group=sub-1], [data-agent-group=sub-2], [data-agent-group=sub-3]').length`)).toBe(0);
    await openAgentGroup('claude');
    expect(await page!.evaluate(`(() => { const trigger = document.querySelector('[data-agent-group=claude] [data-subagents] [data-slot=collapsible-fold-trigger]'); return [trigger.querySelector(':scope > span:not([data-slot])').textContent, trigger.querySelector('[data-slot=fold-trigger-count]').textContent] })()`)).toEqual(['Subagents', '3']);
    // Opened, in a 768px window: the one whose launch recorded a task shows it first, on one line with the whole task in
    // its tooltip; the one with none shows its state only.
    await resize(768);
    await page!.evaluate(`document.querySelector('[data-agent-group=claude] [data-subagents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-subagent-id=sub-1] [data-subagent-task]')`, 'the subagent rows');
    expect(await page!.evaluate(`(() => {
      const task = document.querySelector('[data-subagent-id=sub-1] [data-subagent-task]');
      const style = getComputedStyle(task);
      return { text: task.textContent, oneLine: style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis', cut: task.scrollWidth > task.clientWidth, first: task.closest('li').firstElementChild.contains(task), reachable: task.getAttribute('tabindex') };
    })()`)).toEqual({ text: SUB_TASK, oneLine: true, cut: true, first: true, reachable: '0' });
    await page!.evaluate(`document.querySelector('[data-subagent-id=sub-1] [data-subagent-task]').focus()`);
    await waitFor(`[...document.querySelectorAll('[data-slot=tooltip-content]')].some((tip) => tip.textContent.includes(${JSON.stringify(SUB_TASK)}))`, 'the whole task in the tooltip');
    expect(await page!.evaluate(`(() => { const row = document.querySelector('[data-subagent-id=sub-3]'); return [!!row.querySelector('[data-subagent-task]'), !!row.firstElementChild.querySelector('[data-subagent-status]')] })()`)).toEqual([false, true]);
    // The agents with nothing here, opened: the unlinked subagent labelled so, its role once; two sessions of one folder
    // read the same but for their sessions; an agent no other reads like adds none.
    await page!.evaluate(`document.querySelector('[data-agent-fold=idle-agents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-agent-fold=idle-agents] [data-agent-group=sub-alone]')`, 'the agents with nothing here');
    expect(await page!.evaluate(`document.querySelectorAll('[data-agent-fold=idle-agents] [data-agent-group]').length`)).toBe(MANY.emptyAgents + MANY.twins + 1);
    const headers: Record<string, { text: string; where: string | null }> = await page!.evaluate(`Object.fromEntries(['sub-alone', 'twin-a', 'twin-b', 'empty-0'].map((id) => {
      const header = document.querySelector('[data-agent-group=' + id + '] [data-agent-header]');
      return [id, { text: header.textContent, where: header.querySelector('[data-agent-where]')?.textContent ?? null }];
    }))`);
    expect(headers['sub-alone'].text).toContain('Subagent');
    expect(headers['sub-alone'].text.match(/Work viewer/g)).toEqual(['Work viewer']);
    expect(headers['sub-alone'].text).not.toContain('Subagent ·');
    expect([headers['twin-a'].where?.endsWith('Session aaaa1111'), headers['twin-b'].where?.endsWith('Session bbbb2222')]).toEqual([true, true]);
    expect(headers['twin-a'].where!.replace('Session aaaa1111', '')).toBe(headers['twin-b'].where!.replace('Session bbbb2222', ''));
    expect(headers['empty-0'].where).not.toContain('Session');
    // The find box keeps the agents whose words hold the typed words: a session's start finds its agent.
    await page!.evaluate(`window.typeInto('main input[type=search]', 'aaaa1111')`);
    await waitFor(`!document.querySelector('[data-agent-group=${UNRECORDED_AGENT.id}]')`, 'only the matching agent');
    expect(await page!.evaluate(`${groups}.map((group) => group.dataset.agentGroup)`)).toEqual(['twin-a']);
    await page!.evaluate(`window.typeInto('main input[type=search]', 'zebra')`);
    await waitFor(`!document.querySelector('[data-agent-group]')`, 'no agent');
    expect(await page!.evaluate(`document.querySelector('[data-board-view=agents]').innerText.trim()`)).toBe('No agent or session matches “zebra”.');
    // Request list goes back to the list.
    await page!.evaluate(`[...document.querySelectorAll('main a[href]')].find((link) => link.textContent.trim() === 'Request list').click()`);
    await waitFor(`!new URLSearchParams(location.search).get('by') && document.querySelector('main h1').textContent === 'All requests'`, 'the list again');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Mark finished asks first (its route cannot be undone); Cancel saves nothing, and confirmed the subagent reads Finished with focus on it', async () => {
  try {
    await openPage(`&sample-state=${sampleState('subagents')}&view=requests&by=agent`);
    await waitFor(`document.querySelector('[data-agent-group=claude]')`, 'the Claude Code group');
    await openAgentGroup('claude');
    await page!.evaluate(`document.querySelector('[data-agent-group=claude] [data-subagents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-subagent-row=working]')`, 'the subagent rows');
    // A recorded stop's time is a time in the reader's clock (the shared LocalTime), as the mapper's is, not English
    // text ("Oct 20 at 1:40 pm").
    expect(await page!.evaluate(`(() => { const status = document.querySelector('[data-subagent-id=claude-subagent-2] [data-subagent-status]'); return [!!status.querySelector('time[datetime]'), status.textContent.includes(' at ')] })()`)).toEqual([true, false]);
    const markButtons = `[...document.querySelectorAll('[data-agent-group=claude] [data-subagent-row] button')].filter((button) => window.nameOf(button) === 'Mark finished')`;
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

it.skipIf(!chromeExecutablePath)('the read-error card (sample case) is plain words on Home under its first line and at the top of Requests\' list, its raw reason folded, and stays there when nothing matches', async () => {
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
    // On Home: once, after the first line (whose count may be missing them) and before the lead card.
    const placed = (before: string, after: string) => page!.evaluate(`(() => {
      const follows = (first, second) => !!(first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      const card = document.querySelector('[data-read-errors]');
      return { cards: document.querySelectorAll('[data-read-errors]').length, placed: follows(document.querySelector(${JSON.stringify(before)}), card) && follows(card, document.querySelector(${JSON.stringify(after)})) };
    })()`);
    expect(await placed('[data-home-first-line]', '[data-lead-card]')).toEqual({ cards: 1, placed: true });
    // On Requests: once, after the status tabs and before the rows; words that match nothing leave it there, the line
    // saying so under it.
    await page!.evaluate(`window.store.getState().goToPage('requests')`);
    await waitFor(`document.querySelector('[data-board-view=list] [data-requests-row]') && document.querySelector('[data-read-errors=shown]')`, 'Requests with the card');
    expect(await placed('nav[aria-label="Status"]', '[data-board-view=list] [data-requests-row]')).toEqual({ cards: 1, placed: true });
    await page!.evaluate(`window.store.getState().setRequestsWords('zebra')`);
    await waitFor(`document.querySelector('[data-board-view=list] [data-slot=empty]')`, 'nothing found');
    expect(await placed('nav[aria-label="Status"]', '[data-board-view=list] [data-slot=empty]')).toEqual({ cards: 1, placed: true });
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
    // The last one: the alert goes, its two requests fold to one row, and focus lands on the page's heading, shown.
    await press('Enter');
    await waitFor(`!document.querySelector('[data-read-errors=shown]') && document.activeElement?.matches('h1[data-view-heading]')`, "focus on the page's heading");
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

/** Presses the failure line's Review details (a link) and waits for Machine and sync's failed review. */
async function openReviewDetails() {
  await page!.evaluate(`[...document.querySelectorAll('[data-review-failed-line] a[href]')].find((link) => link.textContent.trim() === 'Review details').click()`);
  await waitFor(`new URLSearchParams(location.search).get('view') === 'machine' && document.querySelector('[data-focus-review=failed]')`, 'Machine and sync with the failed review');
}

it.skipIf(!chromeExecutablePath)('after a failed review, My Rules, Past focus and Suggested areas each show one line under their title and no control; Machine and sync\'s one Try review again starts one review', async () => {
  try {
    await openPage('&scenario=failed-refresh&view=rules');
    for (const view of ['rules', 'past-focus', 'suggested']) {
      await page!.evaluate(`history.pushState(null, '', '?source=sample&scenario=failed-refresh&view=${view}'); dispatchEvent(new PopStateEvent('popstate'))`);
      await waitFor(`document.querySelector('main h1 + [data-review-failed-line]')`, `the failure line under the title on ${view}`);
      // One line on the page, right under its title (design pass Phase 4), and no button that starts a review there.
      expect(await page!.evaluate(`document.querySelectorAll('[data-review-failed-line]').length`)).toBe(1);
      expect(await page!.evaluate(`document.querySelectorAll('[data-refresh-line], [data-focus-review]').length`)).toBe(0);
      expect({ view, buttons: await page!.evaluate(`window.buttonsNamed('^(Try again|Try review again|Refresh now|Refresh|Review now)$').map((button) => window.nameOf(button))`) }).toEqual({ view, buttons: [] });
    }
    // The review's one control is on Machine and sync, worded for the failure, and it starts one review.
    await openReviewDetails();
    expect(await page!.evaluate(`window.buttonsNamed('^(Try again|Try review again|Refresh now|Refresh|Review now)$').map((button) => window.nameOf(button))`)).toEqual(['Try review again']);
    expect(await page!.evaluate(`document.querySelectorAll('[data-review-failed-line]').length`)).toBe(0);
    await page!.evaluate(`window.clickNamed('^Try review again$')`);
    await waitFor(`window.refreshStarts === 1`, 'Try review again to start a review');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('Team view on Requests: one line for a board of one, Sort in Filter and sort, a column in G4 groups, and two dashed places for teammates', async () => {
  try {
    await openPage('&scenario=many&view=requests');
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    await page!.evaluate(`window.store.getState().setWorkspace({ team: true })`);
    await waitFor(`document.querySelector('[data-board-view=team] [data-team-column]')`, 'the Team board');
    expect(await page!.evaluate(`document.querySelector('[data-team-note]').innerText`)).toContain('You are the only person here.');
    expect(await page!.evaluate(`document.querySelectorAll('[data-team-place]').length`)).toBe(2);
    await page!.evaluate(`document.querySelector('[data-filter-and-sort]').click()`);
    await waitFor(`document.querySelector('[data-slot=popover-content]')`, 'Filter and sort');
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-slot=popover-content] label')].some((label) => label.textContent === 'Sort')`)).toBe(true);
    await press('Escape');
    // The column on All, sorted Needs you first: Needs you and Working open as rows with their next step, Idle and
    // Shipped one fold row each.
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-team-column] [data-request-group], [data-team-column] [data-line-section]')].map((group) => group.dataset.requestGroup ?? group.dataset.lineSection + ':' + group.dataset.state)`))
      .toEqual(['needs-you', 'working', 'idle:closed', 'shipped:closed']);
    expect(await page!.evaluate(`document.querySelectorAll('[data-team-column] [data-request-row]').length`)).toBe(MANY.yourMove + MANY.working);
    // A status tab keeps the columns, with that tab's requests.
    await page!.evaluate(`document.querySelector('[data-status-tab=working]').click()`);
    await waitFor(`document.querySelectorAll('[data-team-column] [data-request-row]').length === ${MANY.working}`, 'the Working tab in the columns');
    await page!.evaluate(`document.querySelector('[data-status-tab=all]').click()`);
    await waitFor(`document.querySelectorAll('[data-team-column] [data-request-row]').length === ${MANY.yourMove + MANY.working}`, 'All in the columns again');
    // Each row prints its tool's name beside the mark, as HEAD's Team cards did (rule 2), whole. The open rows' agents:
    // two Claude Codes' and one each of the others (the sample's four agents, g0-g4).
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
    // On Requests, in Codex's narrower column (its widest Team column is about 300px, at 1440).
    await openPage(`&scenario=team${scrollbar.query}&view=requests`, { width: 768, height: 900 });
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the sample board');
    await page!.evaluate(`window.store.getState().setWorkspace({ team: true })`);
    await waitFor(`document.querySelector('[data-board-view=team] [data-team-column] [data-request-row]')`, 'the Team rows');
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

it.skipIf(!chromeExecutablePath)(`By agent rows at 768, 1024, 1280 and on a touch phone, with ${scrollbar.label}: each request’s whole title wraps on its own, its state on one line, every row a whole touch target`, async () => {
  try {
    await openPage(`&scenario=team${scrollbar.query}&view=requests&by=agent`, { width: 768, height: 900 });
    await waitFor(`document.querySelector('[data-agent-group]')`, 'the agent groups');
    const ids: string[] = await page!.evaluate(`[...document.querySelectorAll('[data-agent-group]')].map((group) => group.dataset.agentGroup)`);
    for (const id of ids) await openAgentGroup(id);
    for (const { width, touch = false } of [{ width: 768 }, { width: 1024 }, { width: 1280 }, { width: 390, touch: true }]) {
      await resize(width, touch);
      const rows: { title: string; whole: boolean; stateLines: number; height: number }[] = await page!.evaluate(`[...document.querySelectorAll('[data-agent-group] [data-requests-row]')].map((row) => {
        const title = row.querySelector('[data-row-title]');
        const style = getComputedStyle(title);
        const words = row.querySelector('[data-state-words]');
        return { title: title.textContent, whole: style.whiteSpace !== 'nowrap' && style.textOverflow !== 'ellipsis' && title.scrollWidth <= title.clientWidth + 1,
          stateLines: Math.round(words.getBoundingClientRect().height / parseFloat(getComputedStyle(words).lineHeight)), height: row.getBoundingClientRect().height };
      })`);
      // Every sample request has an agent: five rows under four agents, every group open.
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect({ width, title: row.title, whole: row.whole, stateLines: row.stateLines, target: row.height >= 44 }).toEqual({ width, title: row.title, whole: true, stateLines: 1, target: true });
      }
      expect(pageFitsTheWindow(await page!.evaluate(PAGE_WIDTHS), width, { touch })).toMatchObject(FITS_THE_WINDOW);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);
}

it.skipIf(!chromeExecutablePath)('one live model that changes two requests moves two things at most: the List on a focus area\'s page (the ticker and the newest riffle), By agent (nothing) and Team (the newest riffle) on Requests (rule 8)', async () => {
  try {
    await openPage(AREA_BOARD);
    await waitFor(`window.store.getState().work.load.state === 'loaded'`, 'the many-request board');
    // Each round flips the same two working requests in one model: on the area's List table, on By agent (where two agents'
    // groups change places), and on the Team board.
    const rounds: [string, string][] = [['List', 'your-move'], ['By agent', 'working'], ['Team', 'your-move']];
    for (const [view, state] of rounds) {
      if (view === 'List') {
        await chooseView('List');
        await waitFor(`window.tableRows().length > 0`, 'the table');
      }
      if (view === 'By agent') {
        await page!.evaluate(`window.store.getState().showRequests({ by: 'agent' })`);
        await waitFor(`document.querySelector('[data-board-view=agents] [data-agent-group]')`, 'By agent');
      }
      if (view === 'Team') {
        await page!.evaluate(`window.store.getState().setWorkspace({ team: true }); window.store.getState().showRequests({})`);
        await waitFor(`document.querySelector('[data-board-view=team] [data-team-column]')`, 'the Team board');
      }
      await page!.evaluate(`window.receive((model) => ({ ...model, requests: model.requests.map((request) => request.id === 'g2' || request.id === 'g3'
        ? { ...request, state: ${JSON.stringify(state)}, next: ${JSON.stringify(state)} === 'working' ? { who: 'bot', text: 'Keep going' } : { who: 'human', text: 'Look at this' } } : request) }))`);
      const seen: string[][] = await page!.evaluate(`window.movingThingsOver(1500)`);
      const most = Math.max(...seen.map((things) => things.length));
      const everything = [...new Set(seen.flat())];
      expect({ view, most, rowsMoving: everything.filter((thing) => thing.startsWith('moving: ')) }).toEqual({ view, most: expect.any(Number), rowsMoving: [] });
      expect(most).toBeLessThanOrEqual(2);
      if (view === 'By agent') {
        // Requests' rows show their state in still words: nothing in By agent moves at all.
        expect({ view, everything }).toEqual({ view, everything: [] });
        continue;
      }
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
    await openPage(`${AREA_BOARD}${scrollbar.query}`, { width: 1024, height: 900 });
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
    await openPage(AREA_BOARD);
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
    await openPage(AREA_BOARD);
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

it.skipIf(!chromeExecutablePath)('By agent: "Show more" among the agents with nothing here counts only its own groups, an open Subagents fold inside one too, and puts focus on the first header it added, shown', async () => {
  try {
    await openPage('&scenario=idle-agents&view=requests&by=agent');
    await waitFor(`document.querySelector('[data-agent-fold=idle-agents]')`, 'the fold of agents with nothing here');
    await page!.evaluate(`document.querySelector('[data-agent-fold=idle-agents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelector('[data-agent-group=idle-0]')`, 'the first idle groups');
    // The first group's three subagents, opened: rows of their own list, inside the first group.
    await openAgentGroup('idle-0');
    await page!.evaluate(`document.querySelector('[data-agent-group=idle-0] [data-subagents] [data-slot=collapsible-fold-trigger]').click()`);
    await waitFor(`document.querySelectorAll('[data-agent-group=idle-0] [data-subagent-row]').length === 3`, 'the open Subagents fold');
    const idleGroups = `document.querySelectorAll('[data-agent-fold=idle-agents] [data-agent-group]')`;
    expect(await page!.evaluate(`${idleGroups}.length`)).toBe(LINE_ROWS_PER_PAGE);
    await page!.evaluate(`window.buttonsNamed('^Show ${IDLE_CARDS - LINE_ROWS_PER_PAGE} more')[0].focus()`);
    await press('Enter');
    await waitFor(`${idleGroups}.length === ${IDLE_CARDS}`, 'every idle group');
    // Focus is on group 51's header, the first one added, not three rows early, and the keyboard user sees where it went.
    expect(await page!.evaluate(`(() => { const focused = document.activeElement; return { group: focused.closest('[data-agent-group]')?.dataset.agentGroup, header: focused.matches('[data-agent-header]'), shows: focused.matches(':focus-visible') && getComputedStyle(focused).boxShadow !== 'none' } })()`))
      .toEqual({ group: `idle-${LINE_ROWS_PER_PAGE}`, header: true, shows: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('My Rules with no rules yet and a failed review shows the failure line, and Machine and sync\'s Try review again starts one review', async () => {
  try {
    await openPage('&scenario=failed-refresh-no-rules&view=rules');
    await waitFor(`document.querySelector('[data-slot=empty]')`, 'My Rules with no rules');
    expect(await page!.evaluate(`document.querySelector('[data-slot=empty]').innerText`)).toContain('No rules yet');
    await waitFor(`document.querySelector('main h1 + [data-review-failed-line]')`, 'the failure line under the title');
    expect(await page!.evaluate(`window.buttonsNamed('^(Try again|Try review again|Refresh now|Refresh)$').map((button) => window.nameOf(button))`)).toEqual([]);
    await openReviewDetails();
    await page!.evaluate(`window.clickNamed('^Try review again$')`);
    await waitFor(`window.refreshStarts === 1`, 'Try review again to start a review');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { LOCALES } from '../../../src/ui/i18n/locale';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, myWorkFontResponse, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { STATEFUL_BUTTON_STATE } from '../../../src/ui/my-work/src/components/aceternity/stateful-button-state';
import { saveButtonLooks, type SaveButtonLook } from './save-button-looks';

failOnCiWithoutChrome('CI requires Chrome for the My Work request card regressions.');

/** The save button's states, from their one definition (stateful-button.tsx), never typed again here. */
const { rest: REST, saving: SAVING, saved: SAVED, notSaved: NOT_SAVED } = STATEFUL_BUTTON_STATE;

/**
 * Phase 5 (UI UX Pro Max review, section B): the request card's pieces and the drawer's records, in real Chrome with
 * the app's compiled stylesheet and fonts, on fixtures only (the sample store; nothing reaches a worker).
 * - c-save-button: five looks at one width with the icon slot in one place whether or not the caller passes an icon,
 *   aria-busy while saving, both outcomes announced, nothing turning in a hidden look, and a copy worded as a copy.
 * - c-request-card-open-follow-ups: "Done" leaves the row "Saved", struck through, with Undo, until the next data
 *   refresh brings the request again (no timer); focus moves Done → Undo → Done and "Saved" is said once; live work,
 *   which has no follow-up save path, says so.
 * - c-request-card-deliverables: a chip's full words on keyboard focus; "+N more" counts the rest (from the worker's
 *   count on a live card) and opens the drawer; chips, "+N more" and the area link are 44px tall on touch.
 * - the card's deliverable count and the drawer's are one number; the drawer names its commits and branches beside it.
 * - c-request-detail-records / c-ai-queue: a fixed mark size, a long row wrapped whole, the long list's caption.
 * - c-ai-chain-of-thought: a step's time column holds only a time; a step's description stays a description.
 * - c-bits-product-link: a refused copy says so, with the browser's own words under Details.
 * - c-ai-shimmer, c-aceternity-encrypted-text: plain under reduced motion; the title fades in once, not on a refresh.
 * - c-request-card (D b5 M115): Enter on the title opens it, a click on the card opens it, the area link does not, and
 *   keyboard focus rings the whole card.
 */
let server: ReturnType<typeof Bun.serve> | undefined;
let fixtureUrl = '';
let markReady: () => void = () => {};
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];

const FIXTURE = `
  import React, { useState } from './src/ui/my-work/node_modules/react';
  import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
  import { flushSync } from './src/ui/my-work/node_modules/react-dom';
  import { MotionConfig } from './src/ui/my-work/node_modules/motion/react';
  import { CheckIcon, CopyIcon } from './src/ui/my-work/node_modules/lucide-react';
  import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
  import { buttonVariants } from './src/ui/my-work/src/components/ui/button';
  import { SaveButton } from './src/ui/my-work/src/components/save-button';
  import { RequestCard } from './src/ui/my-work/src/components/request-card';
  import { RequestDetail } from './src/ui/my-work/src/components/request-detail';
  import { FocusAreaChip } from './src/ui/my-work/src/components/bits';
  import { DeliverableList } from './src/ui/my-work/src/components/deliverable-list';
  import { Shimmer } from './src/ui/my-work/src/components/ai-elements/shimmer';
  import { EncryptedText } from './src/ui/my-work/src/components/aceternity/encrypted-text';
  import { sampleSource } from './src/ui/my-work/src/live/sample-source';
  import { useStore } from './src/ui/my-work/src/store';
  import { setLocale, t } from './src/ui/my-work/src/lib/i18n';
  window.React = React;
  // The page's language, as the test sets it, and its words for what a test looks for (R4: every language).
  window.setLocale = setLocale;
  window.t = t;
  const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
  window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
  window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
  const root = createRoot(document.getElementById('root'));
  const shell = (children) => <MotionConfig reducedMotion="user"><TooltipProvider delayDuration={0}><main style={{ padding: 24, maxWidth: 640 }}>{children}</main></TooltipProvider></MotionConfig>;
  window.calls = { open: 0, openFocus: 0, save: 0 };
  // The save's outcome is the test's to give: each press waits until window.settleSave(value) answers it.
  let answer = null;
  window.settleSave = (value) => { answer(value); };
  const pressed = () => { window.calls.save++; return new Promise((resolve) => { answer = resolve; }); };
  const row = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' };
  // Four callers: an icon passed as the icon, no icon, an icon inside the label (the drawer's way), and a copy (setup).
  function SaveFixture() {
    return <div style={{ display: 'grid', gap: 16 }}>
      <div data-save-fixture="icon" style={row}>
        <button id="before-save">Before</button>
        <SaveButton className={buttonVariants({ variant: 'outline' })} icon={<CheckIcon />} onClick={pressed}>Mark checked</SaveButton>
      </div>
      <div data-save-fixture="no-icon" style={row}><SaveButton className={buttonVariants({ variant: 'outline' })} onClick={pressed}>Keep separate</SaveButton></div>
      <div data-save-fixture="icon-in-label" style={row}><SaveButton className={buttonVariants({ variant: 'outline' })} onClick={pressed}><CheckIcon />Mark checked</SaveButton></div>
      <div data-save-fixture="copy" style={row}>
        <SaveButton className={buttonVariants({ variant: 'outline' })} icon={<CopyIcon />} savingLabel="Copying…" savedLabel="Copied" notSavedLabel="Not copied" onClick={pressed}>Copy URL</SaveButton>
      </div>
    </div>;
  }
  // The browser's clipboard, as the test sets it: a refusal carries the browser's own words.
  window.clipboardRefuses = true;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
    if (window.clipboardRefuses) throw new Error('Write permission denied.');
    window.copiedText = text;
  } } });
  const loaded = async () => {
    useStore.getState().startWorkSource(sampleSource);
    while (useStore.getState().work.load.state !== 'loaded') await new Promise((resolve) => setTimeout(resolve, 10));
    return useStore.getState().work.load.model;
  };
  // The card as the board draws it: from the store, so a save or a refresh hands it the request's new version.
  function StoredCard({ id }) {
    const request = useStore((state) => state.work.load.state === 'loaded' ? state.work.load.model.requests.find((each) => each.id === id) : null);
    return request ? <div style={{ width: 400 }}><RequestCard request={request} onOpen={() => { window.calls.open++; }} onOpenFocus={() => { window.calls.openFocus++; }} /></div> : null;
  }
  /** A newer version of one request, as the live feed would bring it: the next data refresh. */
  window.refreshRequest = (id) => {
    const model = useStore.getState().work.load.model;
    useStore.getState().receiveWorkModel({ ...model, requests: model.requests.map((each) => each.id === id ? { ...each } : each) });
  };
  window.followUpsOf = (id) => useStore.getState().work.load.model.requests.find((each) => each.id === id).followUps.map((each) => each.text + ':' + each.done);
  window.showAsLive = () => {
    const model = useStore.getState().work.load.model;
    useStore.getState().receiveWorkModel({ ...model, sourceKind: 'local' });
  };
  const LONG_NAME = 'endless-mode-claude-code-mod-research-notes-for-the-owner-with-every-decision-and-its-reason.md';
  const LONG_RECORD = 'tv-for-all-users-research: Recommend one Fly app per watching account, so a watcher never wakes another account machine, and say how the cost scales past ten accounts';
  let setEncrypted;
  function EncryptedFixture() {
    const [state, set] = useState({ renders: 0, key: 'first' });
    setEncrypted = set;
    return <h3 data-renders={state.renders} style={{ fontSize: 20 }}><EncryptedText key={state.key} text="Show real usage on the price forecast page" revealDelayMs={500 / 42} /></h3>;
  }
  const BOTH_GROUPS = [
    { kind: 'Doc', label: 'notes.md', href: 'https://example.com/notes.md' },
    { kind: 'PR', label: 'Pull request 6210', href: 'https://github.com/thedotmack/claude-mem/pull/6210' },
    { kind: 'Branch', label: 'feature/cards' },
  ];
  let setFilterProducts;
  function FilterEmptiesFixture() {
    const [products, set] = useState(BOTH_GROUPS);
    setFilterProducts = set;
    return <DeliverableList products={products} />;
  }
  window.dropTheDocument = () => flushSync(() => setFilterProducts(BOTH_GROUPS.filter((product) => product.kind !== 'Doc')));
  window.rerenderEncrypted = () => flushSync(() => setEncrypted((state) => ({ ...state, renders: state.renders + 1 })));
  window.remountEncrypted = () => flushSync(() => setEncrypted((state) => ({ renders: state.renders + 1, key: 'second' })));
  window.mount = async (what) => {
    const model = await loaded();
    const yourMove = model.requests.find((request) => request.state === 'your-move');
    if (what === 'save') root.render(shell(<SaveFixture />));
    if (what === 'follow-ups') root.render(shell(<StoredCard id="r4" />));
    if (what === 'chips') {
      const request = { ...yourMove, id: 'chips', detailLoaded: true, workProduct: [
        { kind: 'Doc', label: LONG_NAME, href: '/api/deliverables/1/notes.md', deliverable: true },
        { kind: 'PR', label: 'github.com', href: 'https://github.com/thedotmack/claude-mem/pull/6229' },
        { kind: 'Page', label: 'index.html', href: 'https://example.com/index.html' },
        { kind: 'Deck', label: 'Launch deck', href: 'https://example.com/deck' },
        { kind: 'Link', label: 'Notebook', href: 'https://example.com/notebook' },
      ] };
      root.render(shell(<div style={{ width: 400 }}><RequestCard request={request} onOpen={() => { window.calls.open++; }} onOpenFocus={() => { window.calls.openFocus++; }} /></div>));
    }
    // A card from the live overview: its first three deliverables ride along, and the worker counts all nine.
    if (what === 'live-chips') {
      const request = { ...yourMove, id: 'live-chips', detailLoaded: false, detailCounts: { workProduct: 9 }, workProduct: [
        { kind: 'Doc', label: 'notes.md', href: '/api/deliverables/1/notes.md', deliverable: true },
        { kind: 'PR', label: 'github.com', href: 'https://github.com/thedotmack/claude-mem/pull/6229' },
        { kind: 'Page', label: 'index.html', href: 'https://example.com/index.html' },
      ] };
      root.render(shell(<div style={{ width: 400 }}><RequestCard request={request} onOpen={() => { window.calls.open++; }} onOpenFocus={() => {}} /></div>));
    }
    // One request whose work includes commits and a branch, as the card and as the drawer draw it.
    const withHistory = { ...yourMove, id: 'with-history', detailLoaded: true, workProduct: [
      { kind: 'Doc', label: 'report.md', href: '/api/deliverables/1/report.md', deliverable: true },
      { kind: 'Doc', label: 'notes.md', href: '/api/deliverables/2/notes.md', deliverable: true },
      { kind: 'PR', label: 'The PR', href: 'https://github.com/thedotmack/claude-mem/pull/6229' },
      { kind: 'Commit', label: 'first commit', href: 'https://github.com/thedotmack/claude-mem/commit/1111111' },
      { kind: 'Commit', label: 'second commit', href: 'https://github.com/thedotmack/claude-mem/commit/2222222' },
      { kind: 'Branch', label: 'feature/cards' },
    ] };
    if (what === 'history-card') root.render(shell(<div style={{ width: 400 }}><RequestCard request={withHistory} onOpen={() => {}} onOpenFocus={() => {}} /></div>));
    if (what === 'history-drawer') root.render(shell(<RequestDetail request={withHistory} onClose={() => {}} onOpenFocus={() => {}} />));
    // Build story steps as the mapper writes them (a time, or none recorded) and as the sample writes them (a description).
    if (what === 'story') {
      const story = [
        { label: 'Spec written from your prompts', description: '466 prompts, 15 sections', status: 'complete' },
        { label: 'Cards built', at: null, status: 'complete' },
        { label: 'Spacing fixed', at: '2:44 pm', status: 'active' },
      ];
      root.render(shell(<RequestDetail request={{ ...model.requests[0], story, storyNarrative: undefined }} onClose={() => {}} onOpenFocus={() => {}} />));
    }
    if (what === 'copy-name') root.render(shell(<div style={{ width: 560 }}><DeliverableList products={[{ kind: 'Branch', label: 'feature/cards' }]} /></div>));
    // Both groups, then a live update that drops the only document (its local file was deleted).
    if (what === 'filter-empties') root.render(shell(<div style={{ width: 560 }}><FilterEmptiesFixture /></div>));
    if (what === 'card') root.render(shell(<StoredCard id={yourMove.id} />));
    if (what === 'records') {
      const granular = [{ kind: 'work', text: LONG_RECORD, at: '2:44 pm' }, { kind: 'memory', text: 'Short memory', at: '11:51 am' },
        ...Array.from({ length: 30 }, (_, index) => ({ kind: index % 2 ? 'work' : 'memory', text: 'Earlier record ' + (index + 1) + ' with enough words to take a line', at: 'Nov ' + (1 + index % 9) }))];
      root.render(shell(<RequestDetail request={{ ...model.requests[0], granular }} onClose={() => {}} onOpenFocus={() => {}} />));
    }
    // A shipped request with more deliverables and open follow-ups than its card shows, so the card draws both "+N more"
    // (Badges drawn as buttons), beside label Badges: its state, a conversation's id chip and the records' kind chips (R3).
    const shipped = model.requests.find((request) => request.state === 'shipped');
    const badges = { ...shipped, id: 'badges', detailLoaded: true,
      workProduct: Array.from({ length: 5 }, (_, index) => ({ kind: 'Doc', label: 'notes-' + (index + 1) + '.md', href: '/api/deliverables/' + (index + 1) + '/notes.md', deliverable: true })),
      followUps: Array.from({ length: 5 }, (_, index) => ({ tag: 'Docs', text: 'Follow-up ' + (index + 1), done: false })),
      conversations: [{ tool: 'Claude Code', at: 'Time not recorded', title: 'Badge sizes', platform: 'claude', conversationSessionId: 'sample-conversation-badges' }],
      granular: [{ kind: 'work', text: 'A record', at: '2:44 pm' }, { kind: 'memory', text: 'A memory', at: '2:40 pm' }] };
    if (what === 'badges-card') root.render(shell(<div style={{ maxWidth: 400 }}><RequestCard request={badges} onOpen={() => { window.calls.open++; }} onOpenFocus={() => {}} /></div>));
    if (what === 'badges-drawer') root.render(shell(<RequestDetail request={badges} onClose={() => {}} onOpenFocus={() => {}} />));
    // The longest short times the mapper writes for a record (to-work-model.ts formatRecordTime: "12:59 pm" today, "Sep 30"
    // before), which each language words its own way (displayTime), for the records' time column (R4).
    if (what === 'record-times') {
      const granular = ['12:59 pm', '10:59 am', 'Sep 30', 'Nov 16'].map((at, index) => ({ kind: index % 2 ? 'memory' : 'work', text: 'Record at ' + at, at }));
      root.render(shell(<RequestDetail request={{ ...model.requests[0], granular }} onClose={() => {}} onOpenFocus={() => {}} />));
    }
    if (what === 'shimmer') root.render(shell(<div><Shimmer as="span">Writing the human title…</Shimmer></div>));
    if (what === 'encrypted') root.render(shell(<EncryptedFixture />));
    // The area chip of a request no refresh has placed yet (no focusAreaId, as the sample's r2), each in a row laid out as
    // the card header's left group (flex, items centred, allowed to shrink), from narrow to wide (L5, rule 5).
    if (what === 'not-sorted') root.render(shell(<div style={{ display: 'grid', gap: 12 }}>
      {[72, 96, 128, 160, 240, 320].map((width) => (
        <div key={width} data-chip-width={width} style={{ width, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><FocusAreaChip /></div>
      ))}
    </div>));
  };
  fetch('/fixture-ready');
`;

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // The app's real stylesheet: sizes, clamps and focus rings are what these tests read.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());
  // The page imports artwork and stylesheets the one-file bundle cannot hold; none of them draws these pieces.
  const bundle = compileBrowserFixture(FIXTURE, ['--loader:.webp=empty', '--loader:.css=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty']);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    // Widths depend on the face, so the real Geist and Geist Mono files are served (the stylesheet asks for ./files/…).
    const font = myWorkFontResponse(path);
    if (font) return font;
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

async function open(options: { reducedMotion?: boolean } = {}) {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  chrome = launchChrome(fixtureUrl, { profilePrefix: 'claude-mem-card-parts-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The fixture is React, the card and the sample store; a cold CI Chrome draws it well within 20s (here: under 1.5s).
  await withTimeout(ready, 20_000, 'request card fixture did not load');
  page = await connectToPage(chrome, fixtureUrl);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: options.reducedMotion ? 'reduce' : 'no-preference' }] });
}

async function closePage() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Polls a page expression until it is truthy; the pieces settle within a few frames, so 5s is generous. */
async function waitFor(expression: string, what: string, milliseconds = 5_000) {
  await withTimeout(page!.evaluate(`new Promise((resolve) => { const check = () => (${expression}) ? resolve(true) : requestAnimationFrame(check); check(); })`), milliseconds, `timed out waiting for ${what}`);
}

const KEYS = { Tab: { code: 'Tab', keyCode: 9 }, Enter: { code: 'Enter', keyCode: 13, text: '\r' } } as const;
async function press(key: keyof typeof KEYS) {
  const { code, keyCode } = KEYS[key];
  const text = 'text' in KEYS[key] ? KEYS[key].text : undefined;
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page!.settle();
}

/** Tab until the focused element matches; the fixtures have under 20 stops, so 30 presses means a missing stop. */
async function tabUntil(predicate: string) {
  for (let presses = 0; presses < 30; presses++) {
    await press('Tab');
    if (await page!.evaluate(`(() => { const active = document.activeElement; return !!(${predicate}); })()`)) return;
  }
  throw new Error(`Tab never reached: ${predicate}`);
}

/** A real left click at the middle of `selector` (or of the given point inside it, as fractions of its box). */
async function click(selector: string, at = { x: 0.5, y: 0.5 }) {
  const { x, y } = await page!.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width * ${at.x}, y: box.top + box.height * ${at.y} }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await page!.settle();
}

// Each test opens its own Chrome (1–2s here); the follow-up test waits out 4.5s on purpose; 60s is for a cold CI runner.
const TEST_LIMIT_MS = 60_000;

/**
 * One save button's look, by the name of its fixture row: its state, width and shown words, its busy and waiting marks,
 * its two screen-reader regions, and where its icon slot sits in the cell of each state (the shown mark: the reserved
 * slot, or the caller's own icon at the start of its label when the slot steps aside for it).
 */
const saveLook = (fixture: string) => `(() => { const scope = document.querySelector('[data-save-fixture="${fixture}"]'); const button = scope.querySelector('[data-save-state]');
  const markOf = (cell) => { const slot = cell.querySelector(':scope > [data-icon-slot]'); const shown = slot && getComputedStyle(slot).display !== 'none' ? slot : cell.querySelector(':scope > svg');
    const box = shown?.getBoundingClientRect(); return box ? { left: Math.round(box.left * 100) / 100, width: Math.round(box.width * 100) / 100, slot: shown === slot } : null; };
  return { state: button.dataset.saveState, width: Math.round(button.getBoundingClientRect().width * 100) / 100, label: button.innerText.trim(),
    busy: button.getAttribute('aria-busy'), disabled: button.getAttribute('aria-disabled'), focusVisible: button.matches(':focus-visible'),
    status: scope.querySelector('[role="status"]').textContent, alert: scope.querySelector('[role="alert"]')?.textContent ?? null,
    alertHidden: scope.querySelector('[role="alert"]')?.classList.contains('sr-only') ?? null, reasonLine: !!scope.querySelector('[data-slot="save-button-reason"]'),
    // Running CSS animations (a turning ring); a hover or busy-dimming transition is not one.
    words: scope.textContent, moving: document.getAnimations().filter((animation) => animation instanceof CSSAnimation).length,
    marks: Object.fromEntries([...button.querySelectorAll('[data-stateful-label]')].map((cell) => [cell.dataset.statefulLabel, markOf(cell)])) }; })()`;
const saveStateIs = (fixture: string, state: string) => `document.querySelector('[data-save-fixture="${fixture}"] [data-save-state]').dataset.saveState === ${JSON.stringify(state)}`;
const clickSave = (fixture: string) => page!.evaluate(`document.querySelector('[data-save-fixture="${fixture}"] [data-save-state]').click()`);

it.skipIf(!chromeExecutablePath)('the save button keeps one width in all five looks, is busy while saving, and announces both outcomes', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("save")');
    await waitFor('document.querySelector("[data-save-state]")', 'the save button');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const rest = await page!.evaluate(saveLook('icon'));
    await tabUntil('active.matches("[data-save-fixture=icon] [data-save-state]")');
    const focus = await page!.evaluate(saveLook('icon'));
    await press('Enter');
    const saving = await page!.evaluate(saveLook('icon'));
    // A second press while it saves does nothing (the review's Keep: a double press saves once).
    await press('Enter');
    const callsWhileSaving = await page!.evaluate('window.calls.save');
    await page!.evaluate('window.settleSave(true)');
    await waitFor(saveStateIs('icon', SAVED), 'saved');
    const saved = await page!.evaluate(saveLook('icon'));
    // A refusal: the caller words why under the button itself (with its Details), and this button says "Not saved".
    await press('Enter');
    await page!.evaluate('window.settleSave(false)');
    await waitFor(saveStateIs('icon', NOT_SAVED), 'not saved');
    const notSaved = await page!.evaluate(saveLook('icon'));

    expect(rest).toMatchObject({ state: REST, label: 'Mark checked', busy: null, status: '', alert: null });
    expect(focus).toMatchObject({ state: REST, focusVisible: true });
    expect(saving).toMatchObject({ state: SAVING, label: 'Saving…', busy: 'true', disabled: 'true' });
    expect(callsWhileSaving).toBe(1);
    expect(saved).toMatchObject({ state: SAVED, label: 'Saved', busy: null, status: 'Saved' });
    expect(notSaved).toMatchObject({ state: NOT_SAVED, label: 'Mark checked', status: '', alert: 'Not saved', alertHidden: true, reasonLine: false });
    // One width in every look: each state's words share one grid cell.
    const widths = [rest, focus, saving, saved, notSaved].map((each) => each.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5);
    // Only the spinner of the look on show turns, and only while it saves: the four buttons hold no turning ring at rest.
    expect([rest.moving, saving.moving, saved.moving, notSaved.moving]).toEqual([0, 1, 0, 0]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the save button keeps its icon slot in one place in every look, whether the caller passes an icon, none, or one inside its label', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("save")');
    await waitFor('document.querySelector("[data-save-fixture=no-icon] [data-save-state]")', 'the save buttons');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const looks = [await page!.evaluate(saveLook('no-icon'))];
    await clickSave('no-icon');
    looks.push(await page!.evaluate(saveLook('no-icon')));
    await page!.evaluate('window.settleSave(true)');
    await waitFor(saveStateIs('no-icon', SAVED), 'saved');
    looks.push(await page!.evaluate(saveLook('no-icon')));
    await clickSave('no-icon');
    await page!.evaluate('window.settleSave(false)');
    await waitFor(saveStateIs('no-icon', NOT_SAVED), 'not saved');
    looks.push(await page!.evaluate(saveLook('no-icon')));
    const iconInLabel = await page!.evaluate(saveLook('icon-in-label'));
    const withIcon = await page!.evaluate(saveLook('icon'));

    // No icon: every state's cell keeps a 16px slot (the rest look's is empty), so nothing moves from look to look.
    expect(looks.map((look) => look.state)).toEqual([REST, SAVING, SAVED, NOT_SAVED]);
    for (const look of looks) {
      const marks = Object.values(look.marks) as ({ left: number; width: number; slot: boolean } | null)[];
      expect(marks.every((mark) => mark?.slot === true)).toBe(true);
      expect(Math.max(...marks.map((mark) => mark!.left)) - Math.min(...marks.map((mark) => mark!.left))).toBeLessThanOrEqual(0.5);
    }
    const widths = looks.map((look) => look.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5);
    // An icon inside the label stands in the slot's place, so the empty slot steps aside rather than doubling the gap.
    for (const look of [iconInLabel, withIcon]) {
      const marks = Object.values(look.marks) as ({ left: number; width: number } | null)[];
      expect(marks.every((mark) => mark !== null)).toBe(true);
      expect(Math.max(...marks.map((mark) => mark!.left)) - Math.min(...marks.map((mark) => mark!.left))).toBeLessThanOrEqual(0.5);
    }
    expect(iconInLabel.marks[REST].slot).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a copy button reads Copying…, Copied and Not copied, and nothing in it says Saving or Saved', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("save")');
    await waitFor('document.querySelector("[data-save-fixture=copy] [data-save-state]")', 'the copy button');
    const looks = [await page!.evaluate(saveLook('copy'))];
    await clickSave('copy');
    looks.push(await page!.evaluate(saveLook('copy')));
    await page!.evaluate('window.settleSave(true)');
    await waitFor(saveStateIs('copy', SAVED), 'copied');
    looks.push(await page!.evaluate(saveLook('copy')));
    await clickSave('copy');
    await page!.evaluate('window.settleSave(false)');
    await waitFor(saveStateIs('copy', NOT_SAVED), 'not copied');
    looks.push(await page!.evaluate(saveLook('copy')));

    expect(looks.map((look) => [look.state, look.label])).toEqual([[REST, 'Copy URL'], [SAVING, 'Copying…'], [SAVED, 'Copied'], [NOT_SAVED, 'Copy URL']]);
    expect(looks[2].status).toBe('Copied');
    expect(looks[3].alert).toBe('Not copied');
    // Every word in it, hidden looks and screen-reader regions included.
    for (const look of looks) expect(look.words).not.toMatch(/sav/i);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('"Done" leaves the follow-up struck through as Saved with Undo until the next refresh, focus goes Done → Undo → Done, and live work says it cannot save', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("follow-ups")');
    await waitFor('document.querySelectorAll("[data-follow-up]").length === 2', 'the two open follow-ups');
    const row = (words: string) => `[...document.querySelectorAll('[data-follow-up]')].find((each) => each.textContent.includes(${JSON.stringify(words)}))`;
    const rowState = (words: string) => `(() => { const row = ${row(words)}; if (!row) return null; const words = [...row.querySelectorAll('span')].find((span) => span.textContent === ${JSON.stringify(words)});
      // innerText: what shows. A save button keeps every state's words in its one cell, hidden but in textContent.
      return { struck: words ? getComputedStyle(words).textDecorationLine : null, saved: row.innerText.includes('Saved'),
        undo: [...row.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Undo') }; })()`;
    // Where focus is: on a button of the row with these words, and which.
    const focusIn = (words: string) => `(() => { const active = document.activeElement; return { inRow: active?.closest('[data-follow-up]')?.textContent.includes(${JSON.stringify(words)}) ?? false, button: active?.tagName === 'BUTTON' ? active.innerText.trim() : null }; })()`;
    const rowButton = (words: string, label: string) => `active.closest('[data-follow-up]')?.textContent.includes(${JSON.stringify(words)}) && active.innerText.trim() === ${JSON.stringify(label)}`;
    // By keyboard, as a person would: the pressed Done goes away, so focus must be put somewhere on purpose.
    await tabUntil(rowButton('Write the release notes', 'Done'));
    await press('Enter');
    await waitFor(`${rowState('Write the release notes')}?.undo`, 'the saved row');
    await waitFor(`document.activeElement?.tagName === 'BUTTON'`, 'focus on a button');
    const justSaved = await page!.evaluate(rowState('Write the release notes'));
    const focusAfterDone = await page!.evaluate(focusIn('Write the release notes'));
    // "Saved" is said once: one live region says it, the row's.
    const savedSaid = await page!.evaluate(`[...document.querySelectorAll('[role="status"]')].filter((region) => region.textContent.trim() === 'Saved').length`);
    // No timer takes it away: 4.5s is past the 2s the old check showed and the store's 4s "Just updated" window, which
    // re-renders the card on its own.
    await Bun.sleep(4_500);
    const stillSaved = await page!.evaluate(rowState('Write the release notes'));
    const storeAfterSave = await page!.evaluate('window.followUpsOf("r4")');
    // The next data refresh brings a newer version of the request: the saved row goes.
    await page!.evaluate('window.refreshRequest("r4")');
    await waitFor(`!${row('Write the release notes')}`, 'the saved row to leave after the refresh');
    // Undo, on the second one, by keyboard: Done, then Undo where focus landed; the follow-up is open again.
    await tabUntil(rowButton('Launch post with walkthrough', 'Done'));
    await press('Enter');
    await waitFor(`${rowState('Launch post with walkthrough')}?.undo`, 'the second saved row');
    await waitFor(`document.activeElement?.tagName === 'BUTTON'`, 'focus on a button');
    const focusOnUndo = await page!.evaluate(focusIn('Launch post with walkthrough'));
    await press('Enter');
    await waitFor(`${rowState('Launch post with walkthrough')}?.undo === false`, 'the row open again after Undo');
    await waitFor(`document.activeElement?.tagName === 'BUTTON'`, 'focus on a button');
    const afterUndo = await page!.evaluate(rowState('Launch post with walkthrough'));
    const focusAfterUndo = await page!.evaluate(focusIn('Launch post with walkthrough'));
    const storeAfterUndo = await page!.evaluate('window.followUpsOf("r4")');
    // Live work has no follow-up save path in the store: no Done, and the limit in words.
    await page!.evaluate('window.showAsLive()');
    await waitFor('document.body.textContent.includes("These can’t be marked done from My Work yet.")', 'the live limit');
    const liveButtons = await page!.evaluate(`[...document.querySelectorAll('[data-follow-up] button')].map((button) => button.innerText.trim())`);

    expect(justSaved).toEqual({ struck: 'line-through', saved: true, undo: true });
    expect(focusAfterDone).toEqual({ inRow: true, button: 'Undo' });
    expect(savedSaid).toBe(1);
    expect(focusOnUndo).toEqual({ inRow: true, button: 'Undo' });
    expect(focusAfterUndo).toEqual({ inRow: true, button: 'Done' });
    expect(stillSaved).toEqual(justSaved);
    // The save went through the store's one follow-up path (the sample's), and Undo through the same.
    expect(storeAfterSave).toEqual(['Write the release notes:true', 'Launch post with walkthrough:false', 'Telemetry dashboard:true']);
    expect(storeAfterUndo).toEqual(['Write the release notes:true', 'Launch post with walkthrough:false', 'Telemetry dashboard:true']);
    expect(afterUndo).toEqual({ struck: 'none', saved: false, undo: false });
    expect(liveButtons).toEqual([]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/** The save buttons request-card.tsx draws (the follow-ups' Done and Undo), counted from its source. */
const CARD_SAVE_BUTTON_CALLERS = (readFileSync(resolve(REPOSITORY_ROOT, 'src/ui/my-work/src/components/request-card.tsx'), 'utf8').match(/<SaveButton\b/g) ?? []).length;

it.skipIf(!chromeExecutablePath)('every save button on the card draws an icon in its slot at rest, and lays every look out at its one width (V12)', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("follow-ups")');
    await waitFor('document.querySelectorAll("[data-follow-up]").length === 2', 'the two open follow-ups');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const rowButton = (label: string) => `[...document.querySelectorAll('[data-follow-up] button[data-save-state]')].find((button) => button.textContent.trim().startsWith(${JSON.stringify(label)}))`;
    // Every state a save button on the card draws after it was first drawn, with the button's width then.
    await page!.evaluate(`(() => { window.statesDrawn = []; new MutationObserver((changes) => { for (const change of changes) window.statesDrawn.push({
      words: change.target.textContent.trim().slice(0, 4), state: change.target.dataset.saveState, width: Math.round(change.target.getBoundingClientRect().width * 100) / 100 }); })
      .observe(document.getElementById('root'), { subtree: true, attributes: true, attributeFilter: ['data-save-state'] }); })()`);
    const looks: Record<string, SaveButtonLook> = { Done: await page!.evaluate(saveButtonLooks(rowButton('Done'))) };
    await page!.evaluate(`${rowButton('Done')}.click()`);
    await waitFor(rowButton('Undo'), 'Undo in place of Done');
    looks.Undo = await page!.evaluate(saveButtonLooks(rowButton('Undo')));
    await page!.evaluate(`${rowButton('Undo')}.click()`);
    await waitFor(`!${rowButton('Undo')}`, 'Done back in place of Undo');
    const statesDrawn = await page!.evaluate('window.statesDrawn') as { words: string; state: string; width: number }[];
    console.log(`[request-card-parts] card save buttons: ${JSON.stringify({ looks, statesDrawn })}`);

    // Every save button request-card.tsx draws was seen.
    expect(Object.keys(looks).length).toBe(CARD_SAVE_BUTTON_CALLERS);
    for (const [name, look] of Object.entries(looks)) {
      // At rest the slot draws the caller's icon, never an empty gap.
      expect({ name, state: look.state, icon: look.cells[REST].drawsIcon, inSlot: look.cells[REST].markInSlot }).toEqual({ name, state: REST, icon: true, inSlot: true });
      // Every look's words are laid out in the button at rest, so it is as wide as the widest of them in every look.
      for (const [state, cell] of Object.entries(look.cells)) expect({ name, state, laidOut: cell.contentWidth > 0 }).toEqual({ name, state, laidOut: true });
    }
    // These saves are synchronous: a press swaps the row's button for the other in the same frame, so neither draws
    // "Saving…" or "Saved" (none did on 2026-11-17); any state one does draw keeps the width it rests at.
    for (const drawn of statesDrawn) expect({ ...drawn, sameWidth: Math.abs(drawn.width - looks[drawn.words === 'Done' ? 'Done' : 'Undo'].width) <= 0.5 }).toEqual({ ...drawn, sameWidth: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a deliverable chip shows its full words on keyboard focus, and "+N more" counts the rest and opens the request', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("chips")');
    await waitFor('document.querySelectorAll("[data-deliverable-chip]").length === 3', 'three chips');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const chips = await page!.evaluate(`[...document.querySelectorAll('[data-deliverable-chip]')].map((chip) => { const words = chip.querySelector('.line-clamp-2');
      return { words: words.textContent, height: chip.getBoundingClientRect().height, width: chip.getBoundingClientRect().width, clamp: getComputedStyle(words).webkitLineClamp }; })`);
    await tabUntil('active.matches("[data-deliverable-chip]") && active.textContent.includes("endless-mode")');
    await waitFor('document.querySelector("[role=tooltip]")', 'the chip tooltip');
    const tooltip = await page!.evaluate('document.querySelector("[role=tooltip]").textContent');
    const more = await page!.evaluate(`(() => { const more = document.querySelector('[data-slot="badge-more"]'); return { text: more.innerText.trim(), label: more.getAttribute('aria-label'), tag: more.tagName, height: more.getBoundingClientRect().height }; })()`);
    await click('[data-slot="badge-more"]');
    const opens = await page!.evaluate('window.calls.open');

    expect(chips.map((chip: { words: string }) => chip.words)).toEqual([
      'Doc · endless-mode-claude-code-mod-research-notes-for-the-owner-with-every-decision-and-its-reason.md',
      'PR · claude-mem #6229', 'Page · index.html',
    ]);
    // 36px on a desktop at the 16px root; two lines at most, then the tooltip.
    for (const chip of chips) expect(chip.height).toBeGreaterThanOrEqual(36);
    expect(chips[0].clamp).toBe('2');
    // The width cap (16rem, 256px at the 16px root): a long name wraps instead of stretching the chip.
    expect(chips[0].width).toBeLessThanOrEqual(272.5);
    expect(tooltip).toBe('Doc · endless-mode-claude-code-mod-research-notes-for-the-owner-with-every-decision-and-its-reason.md');
    expect(more).toMatchObject({ text: '+2 more', label: 'Open the request to see 2 more deliverables', tag: 'BUTTON' });
    expect(more.height).toBeGreaterThanOrEqual(36);
    expect(opens).toBe(1);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/** The rendered heights of the card's area link, its deliverable chips and its "+N more". */
const cardControlHeights = `(() => ({
  area: document.querySelector('[data-focus-area="placed"]').getBoundingClientRect().height,
  chips: [...document.querySelectorAll('[data-deliverable-chip]')].map((chip) => chip.getBoundingClientRect().height),
  more: document.querySelector('[data-slot="badge-more"]').getBoundingClientRect().height }))()`;

it.skipIf(!chromeExecutablePath)('the area link, the deliverable chips and "+N more" are at least 44px tall on touch, and 24, 36 and 36px on a desktop', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("chips")');
    await waitFor('document.querySelectorAll("[data-deliverable-chip]").length === 3', 'three chips');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const desktop = await page!.evaluate(cardControlHeights);
    // A touch phone (plan rule 6's coarse pointer), as app-shell.browser.test.ts emulates it.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(await page!.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
    await page!.settle();
    // The Button's transition-all eases a size change over 150ms; a page that opens on touch starts at its touch size, so
    // measure once the switch has finished.
    await waitFor('document.getAnimations().length === 0', 'the switch to touch sizes to finish');
    const touch = await page!.evaluate(cardControlHeights);

    expect(desktop.area).toBeGreaterThanOrEqual(24);
    for (const height of [...desktop.chips, desktop.more]) expect(height).toBeGreaterThanOrEqual(36);
    for (const height of [touch.area, ...touch.chips, touch.more]) expect(height).toBeGreaterThanOrEqual(44);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/** Every Badge on the page (components/ui/badge.tsx, BadgeMore among them): what it is drawn as, its words, its height. */
const badgeBoxes = `[...document.querySelectorAll('[data-slot="badge"], [data-slot="badge-more"]')].map((badge) => ({
  tag: badge.tagName, words: badge.textContent.trim(), height: Math.round(badge.getBoundingClientRect().height * 100) / 100 }))`;

it.skipIf(!chromeExecutablePath)('on a touch phone every Badge drawn as a button or link is at least 44px tall, the follow-ups’ "+N more" too, and a Badge that only labels keeps its size (R3)', async () => {
  try {
    await open();
    // A touch phone (plan rule 6's coarse pointer), as app-shell.browser.test.ts emulates it, before anything is drawn.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(await page!.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
    await page!.evaluate('window.mount("badges-card")');
    await waitFor(`document.querySelectorAll('[data-slot="badge-more"]').length === 2`, 'the card’s two "+N more"');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    await waitFor('document.getAnimations().length === 0', 'the card at rest');
    const card = await page!.evaluate(badgeBoxes);
    // The drawer for the same request, with the folds that hold label Badges open: its rows' id chips, its records' kinds.
    await page!.evaluate('window.mount("badges-drawer")');
    for (const words of ['Where this came from', 'Latest records']) {
      await waitFor(`[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].some((trigger) => trigger.textContent.startsWith(${JSON.stringify(words)}))`, `the ${words} fold`);
      await page!.evaluate(`[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].find((trigger) => trigger.textContent.startsWith(${JSON.stringify(words)})).click()`);
    }
    await waitFor(`document.querySelectorAll('[data-slot="sheet-content"] [data-slot="badge"]').length >= 4`, 'the drawer’s label Badges');
    await waitFor('document.getAnimations().length === 0', 'the drawer at rest');
    // The card is gone now (the root draws the drawer alone), so every Badge on the page is the drawer's.
    const drawer = await page!.evaluate(badgeBoxes);
    console.log(`[request-card-parts] Badges at 390 touch: ${JSON.stringify({ card, drawer })}`);

    const controls = [...card, ...drawer].filter((badge) => badge.tag === 'BUTTON' || badge.tag === 'A');
    const labels = [...card, ...drawer].filter((badge) => badge.tag !== 'BUTTON' && badge.tag !== 'A');
    // Both of the card's "+N more" are buttons: the deliverables' and the follow-ups' (it was 24px tall on touch).
    expect(card.filter((badge) => badge.tag === 'BUTTON').map((badge) => badge.words)).toEqual(['+2 more', '+2 more']);
    for (const badge of controls) expect({ words: badge.words, tallEnough: badge.height >= 44 }).toEqual({ words: badge.words, tallEnough: true });
    // A Badge that only labels (the state, an id chip, a record's kind) keeps its own size.
    expect(labels.length).toBeGreaterThanOrEqual(4);
    for (const badge of labels) expect({ words: badge.words, keepsItsSize: badge.height < 44 }).toEqual({ words: badge.words, keepsItsSize: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a live card counts its deliverables from the worker’s count, not from the three it carries', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("live-chips")');
    await waitFor('document.querySelectorAll("[data-deliverable-chip]").length === 3', 'three chips');
    const counted = await page!.evaluate(`(() => ({
      heading: [...document.querySelectorAll('.section-label')].map((label) => label.textContent).find((text) => text.startsWith('Deliverables')),
      more: document.querySelector('[data-slot="badge-more"]')?.innerText.trim() ?? null }))()`);
    // Nine recorded, three on the card: "+6 more". A card that counted only what it carries would say nothing more.
    expect(counted).toEqual({ heading: 'Deliverables · 9', more: '+6 more' });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the card and the drawer count a request’s deliverables by one rule, and the drawer names the commits and branch it also lists', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("history-card")');
    await waitFor('document.querySelector("[data-deliverable-chip]")', 'the card');
    const card = await page!.evaluate(`[...document.querySelectorAll('.section-label')].map((label) => label.textContent).find((text) => text.startsWith('Deliverables'))`);
    await page!.evaluate('window.mount("history-drawer")');
    await waitFor(`[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].some((trigger) => trigger.textContent.startsWith('Deliverables'))`, 'the drawer');
    const drawer = await page!.evaluate(`[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].find((trigger) => trigger.textContent.startsWith('Deliverables')).querySelector('[data-slot="fold-trigger-count"]').textContent`);

    // Two docs and a PR are deliverables; two commits and a branch are the work's history, listed in the drawer only.
    expect(card).toBe('Deliverables · 3');
    expect(drawer.split(' ')[0]).toBe('3');
    expect(drawer).toContain('2 commits');
    expect(drawer).toContain('1 branch');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('records keep a fixed mark size, wrap a long row whole, and caption the long list that scrolls', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("records")');
    await waitFor('document.querySelector("[data-slot=sheet-content]")', 'the drawer');
    // The drawer folds its sections; open Latest records, then its earlier records.
    const openFold = async (words: string) => {
      await waitFor(`[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].some((trigger) => trigger.textContent.includes(${JSON.stringify(words)}))`, `the ${words} fold`);
      await page!.evaluate(`(() => { const trigger = [...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].find((each) => each.textContent.includes(${JSON.stringify(words)})); if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click(); })()`);
    };
    await openFold('Latest records');
    await waitFor('document.querySelectorAll("[data-record-kind]").length >= 2', 'the newest records');
    const rows = await page!.evaluate(`[...document.querySelectorAll('[data-record-kind]')].slice(0, 2).map((row) => {
      const mark = row.firstElementChild.getBoundingClientRect(); const words = row.children[2];
      // Whole: nothing cut below (a clamp) or to the side (a one-line cut runs past the box's width); lines: how many the
      // words take, so a long record that stays on one line fails.
      const lineHeight = parseFloat(getComputedStyle(words).lineHeight);
      return { kind: row.dataset.recordKind, mark: [Math.round(mark.width * 10) / 10, Math.round(mark.height * 10) / 10], rowHeight: row.getBoundingClientRect().height,
        lineHeight, whole: words.scrollHeight <= words.clientHeight + 1 && words.scrollWidth <= words.clientWidth + 1, text: words.textContent,
        lines: Math.round(words.getBoundingClientRect().height / lineHeight), time: getComputedStyle(row.children[1]).fontVariantNumeric }; })`);
    await openFold('earlier records');
    await waitFor('document.querySelector("[data-slot=scroll-area][data-overflowing]")', 'the boxed earlier records');
    const earlier = await page!.evaluate(`(() => { const area = document.querySelector('[data-slot="scroll-area"][data-overflowing]'); const viewport = area.querySelector('[data-slot="scroll-area-viewport"]');
      return { caption: document.querySelector('[data-slot="scroll-area-caption"]').textContent, focusable: viewport.tabIndex, region: viewport.getAttribute('role'), name: viewport.getAttribute('aria-label') }; })()`);
    const boxedMarks = await page!.evaluate(`[...document.querySelectorAll('[data-slot="scroll-area"][data-overflowing] [data-record-kind]')].slice(0, 4).map((row) => { const box = row.firstElementChild.getBoundingClientRect(); return [row.dataset.recordKind, Math.round(box.width * 10) / 10, Math.round(box.height * 10) / 10]; })`);

    expect(rows[0]).toMatchObject({ kind: 'work', whole: true, time: 'tabular-nums' });
    expect(rows[0].text).toContain('say how the cost scales past ten accounts');
    // Wrapped: the long record takes more than two lines of its own text, all of it shown.
    expect(rows[0].rowHeight).toBeGreaterThan(rows[0].lineHeight * 2);
    expect(rows[0].lines).toBeGreaterThanOrEqual(2);
    expect(rows[1]).toMatchObject({ kind: 'memory', whole: true });
    // The mark is square and keeps its size whatever the text beside it (it was squeezed to 5×11px).
    expect(rows[0].mark[0]).toBe(rows[0].mark[1]);
    expect(rows[1].mark[0]).toBe(rows[1].mark[1]);
    for (const [kind, width, height] of boxedMarks) {
      expect(width).toBe(height);
      expect(width).toBe(kind === 'work' ? rows[0].mark[0] : rows[1].mark[0]);
    }
    // 32 records: the newest 5 show, the other 27 fold and scroll in their box.
    expect(earlier).toEqual({ caption: '27 records · scroll to read them all', focusable: 0, region: 'region', name: 'Latest records' });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the records’ time column holds the longest short time on one line in English and cuts no time in any language (R4)', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("record-times")');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const shown: Record<string, unknown> = {};
    for (const language of LOCALES) {
      await page!.evaluate(`window.setLocale(${JSON.stringify(language)})`);
      const fold = `[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].find((trigger) => trigger.textContent.startsWith(window.t('Latest records')))`;
      await waitFor(fold, `the Latest records fold in ${language}`);
      await page!.evaluate(`(() => { const trigger = ${fold}; if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click(); })()`);
      await waitFor('document.querySelectorAll("[data-record-kind]").length === 4', `the four records in ${language}`);
      // Each time cell: its words, whether all of them show (no cut to the side or below), how many lines they take, and
      // whether the cell ends before the record's words begin. In English, the width of "12:59 pm" against the column's.
      shown[language] = await page!.evaluate(`[...document.querySelectorAll('[data-record-kind]')].map((row) => {
        const time = row.children[1]; const words = row.children[2];
        const range = document.createRange(); range.selectNodeContents(time);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        return { time: time.textContent, whole: time.scrollWidth <= time.clientWidth + 1 && time.scrollHeight <= time.clientHeight + 1, lines,
          beforeTheWords: time.getBoundingClientRect().right <= words.getBoundingClientRect().left + 0.5,
          textWidth: Math.round(range.getBoundingClientRect().width * 100) / 100, columnWidth: Math.round(time.getBoundingClientRect().width * 100) / 100 };
      })`);
    }
    console.log(`[request-card-parts] record time column: ${JSON.stringify(shown)}`);
    const english = shown.en as { time: string; lines: number; textWidth: number; columnWidth: number }[];
    expect(english.map((cell) => cell.time)).toEqual(['12:59 pm', '10:59 am', 'Sep 30', 'Nov 16']);
    // The longest short time the mapper writes keeps one line in the column it was sized for.
    expect(english[0].lines).toBe(1);
    expect(english[0].textWidth).toBeLessThanOrEqual(english[0].columnWidth);
    for (const [language, cells] of Object.entries(shown)) {
      for (const cell of cells as { time: string; whole: boolean; beforeTheWords: boolean }[]) {
        expect({ language, time: cell.time, whole: cell.whole, beforeTheWords: cell.beforeTheWords }).toEqual({ language, time: cell.time, whole: true, beforeTheWords: true });
      }
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a build story step’s time column holds only its time, "Date not recorded" when none was, and a description stays a description', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("story")');
    await waitFor(`[...document.querySelectorAll('[data-slot="collapsible-trigger"]')].some((trigger) => trigger.textContent.includes('Build story'))`, 'the build story row');
    await page!.evaluate(`[...document.querySelectorAll('[data-slot="collapsible-trigger"]')].find((trigger) => trigger.textContent.includes('Build story')).click()`);
    await waitFor('document.querySelectorAll("[data-step-status]").length === 3', 'the three steps');
    const steps = await page!.evaluate(`[...document.querySelectorAll('[data-step-status]')].map((step) => ({
      time: step.querySelector('[data-slot="chain-of-thought-step-time"]')?.textContent ?? null,
      description: step.querySelector('[data-slot="chain-of-thought-step-description"]')?.textContent ?? null,
      monospace: [...step.querySelectorAll('.mono-number')].map((line) => line.textContent) }))`);

    expect(steps).toEqual([
      { time: null, description: '466 prompts, 15 sections', monospace: [] },
      { time: 'Date not recorded', description: null, monospace: ['Date not recorded'] },
      { time: '2:44 pm', description: null, monospace: ['2:44 pm'] },
    ]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a refused copy of a name says so in plain words with the browser’s own words under Details, and a copy that works says Copied', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("copy-name")');
    const copy = `document.querySelector('[data-slot="deliverable-list"] button[aria-label^="Copy"]')`;
    await waitFor(copy, 'the Copy button');
    await page!.evaluate(`${copy}.click()`);
    await waitFor('document.querySelector("[data-slot=deliverable-list] [role=alert]")', 'the refusal');
    const details = `[...document.querySelectorAll('[data-slot="deliverable-list"] [data-slot="collapsible-fold-trigger"]')].find((trigger) => trigger.textContent === 'Details')`;
    await waitFor(details, 'the Details fold');
    await page!.evaluate(`${details}.click()`);
    const refused = await page!.evaluate(`({ alert: document.querySelector('[data-slot="deliverable-list"] [role="alert"]').textContent,
      cause: document.querySelector('[data-slot="deliverable-list"] [data-slot="collapsible-content"] .font-mono')?.textContent ?? null })`);
    await page!.evaluate('window.clipboardRefuses = false');
    await page!.evaluate(`${copy}.click()`);
    await waitFor('window.copiedText === "feature/cards"', 'the copy');
    await waitFor(`document.querySelector('[data-slot="deliverable-list"] [role="status"]').textContent === 'Copied'`, 'Copied');
    const copied = await page!.evaluate(`({ alert: !!document.querySelector('[data-slot="deliverable-list"] [role="alert"]'), details: !!(${details}) })`);

    expect(refused).toEqual({ alert: 'Could not copy. Select the name to copy it.', cause: 'Write permission denied.' });
    expect(copied).toEqual({ alert: false, details: false });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('a live update that empties the chosen group shows every deliverable left, with no filter to undo', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("filter-empties")');
    const list = `document.querySelector('[data-slot="deliverable-list"]')`;
    const docsFilter = `[...${list}.querySelectorAll('[data-slot="toggle-group-item"]')].find((item) => item.textContent.startsWith('Docs and pages'))`;
    await waitFor(docsFilter, 'the Docs and pages filter');
    await page!.evaluate(`${docsFilter}.click()`);
    const rows = `${list}.querySelectorAll(':scope > ul > li').length`;
    await waitFor(`${rows} === 1`, 'the document alone');
    await page!.evaluate('window.dropTheDocument()');
    const after = await page!.evaluate(`({ rows: ${rows}, filters: !!${list}.querySelector('[data-slot="toggle-group"]'),
      words: ${list}.textContent.includes('feature/cards') })`);

    expect(after).toEqual({ rows: 2, filters: false, words: true });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('under reduced motion the shimmer and the decrypting title are plain and nothing moves', async () => {
  try {
    await open({ reducedMotion: true });
    await page!.evaluate('window.mount("shimmer")');
    await waitFor('document.querySelector("[data-slot=shimmer]")', 'the shimmer');
    const shimmer = await page!.evaluate(`(() => { const text = document.querySelector('[data-slot="shimmer-text"]'); const style = getComputedStyle(text);
      return { mark: document.querySelector('[data-slot="shimmer-mark"]').children.length, background: style.backgroundImage, fill: style.webkitTextFillColor, color: style.color,
        muted: getComputedStyle(document.body).getPropertyValue('--muted-foreground').trim(), moving: document.getAnimations().length }; })()`);
    await page!.evaluate('window.mount("encrypted")');
    await waitFor('document.querySelector("h3[data-renders]")', 'the title');
    const encrypted = await page!.evaluate(`({ letters: document.querySelectorAll('[data-letter]').length, text: document.querySelector('h3').textContent, moving: document.getAnimations().length })`);

    // Three still dots in front, the words in their solid colour, no sweep (it ran 2s forever, MotionConfig or not).
    expect(shimmer.mark).toBe(3);
    expect(shimmer.background).toBe('none');
    expect(shimmer.fill).not.toBe('rgba(0, 0, 0, 0)');
    expect(shimmer.moving).toBe(0);
    expect(encrypted).toEqual({ letters: 0, text: 'Show real usage on the price forecast page', moving: 0 });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the decrypting title fades its real letters in once, and a refresh or a new mount does not play it again', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("encrypted")');
    await waitFor('document.querySelector("[data-letter]")', 'the revealing title');
    // On its first frame the real letters are there, only lighter: no symbols, the words read at once.
    const first = await page!.evaluate(`(() => { const letters = [...document.querySelectorAll('[data-letter]')]; return {
      text: letters.map((letter) => letter.textContent).join(''), lastOpacity: Number(getComputedStyle(letters.at(-1)).opacity), fades: document.getAnimations().length }; })()`);
    // About half a second, plus one letter's fade: every animation is done by then.
    await waitFor('document.getAnimations().length === 0', 'the fade to end', 3_000);
    await page!.evaluate('window.rerenderEncrypted()');
    await page!.settle();
    const afterRefresh = await page!.evaluate(`({ renders: document.querySelector('h3').dataset.renders, fades: document.getAnimations().length })`);
    await page!.evaluate('window.remountEncrypted()');
    await page!.settle();
    const afterRemount = await page!.evaluate(`({ letters: document.querySelectorAll('[data-letter]').length, fades: document.getAnimations().length, text: document.querySelector('h3').textContent })`);

    expect(first.text).toBe('Show real usage on the price forecast page');
    expect(first.lastOpacity).toBeLessThan(1);
    expect(first.fades).toBe(first.text.length);
    expect(afterRefresh).toEqual({ renders: '1', fades: 0 });
    expect(afterRemount).toEqual({ letters: 0, fades: 0, text: 'Show real usage on the price forecast page' });
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

it.skipIf(!chromeExecutablePath)('the card opens from its title by Enter and from a click on it, not from its area link, and keyboard focus rings the whole card', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("card")');
    await waitFor('document.querySelector("[data-request-card-open]")', 'the card');
    await tabUntil('active.matches("[data-request-card-open]")');
    const ring = await page!.evaluate(`(() => { const style = getComputedStyle(document.querySelector('[data-slot="card"]')); return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset }; })()`);
    await press('Enter');
    const afterEnter = await page!.evaluate('window.calls.open');
    // A click on the card away from its controls (its bottom-left corner, the footer's stage word) opens it.
    await click('[data-slot="card-footer"] dd');
    const afterCardClick = await page!.evaluate('window.calls.open');
    await click('[data-focus-area="placed"]');
    const afterAreaClick = await page!.evaluate('({ open: window.calls.open, focus: window.calls.openFocus })');
    const edge = await page!.evaluate(`(() => { const edge = document.querySelector('[data-glow-edge]'); return edge && { display: getComputedStyle(edge).display, bar: !!edge.querySelector('[data-glow-bar]') }; })()`);
    const cursor = await page!.evaluate(`getComputedStyle(document.querySelector('[data-slot="card"]')).cursor`);

    expect(ring).toEqual({ style: 'solid', width: '2px', offset: '2px' });
    expect(afterEnter).toBe(1);
    expect(afterCardClick).toBe(2);
    expect(afterAreaClick).toEqual({ open: 2, focus: 1 });
    // The card that needs you keeps its edge and left bar at rest, with no pointer near it.
    expect(edge).toEqual({ display: 'block', bar: true });
    expect(cursor).toBe('pointer');
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

/**
 * Each unplaced area chip of the "not-sorted" mount: its row's width, the words it shows, whether all of them show (no
 * cut to the side or below, so no ellipsis), whether the chip stays inside its row, how many lines the words take, and
 * the chip's rendered height.
 */
const notSortedChips = `[...document.querySelectorAll('[data-chip-width]')].map((row) => {
  const chip = row.querySelector('[data-focus-area="not-sorted"]');
  const words = chip.lastElementChild;
  const range = document.createRange(); range.selectNodeContents(words);
  const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  const box = chip.getBoundingClientRect();
  return { width: Number(row.dataset.chipWidth), words: words.innerText, whole: words.scrollWidth <= words.clientWidth + 1 && words.scrollHeight <= words.clientHeight + 1,
    inside: box.right <= row.getBoundingClientRect().right + 0.5, lines, height: Math.round(box.height * 100) / 100 };
})`;

it.skipIf(!chromeExecutablePath)('"Not sorted yet" wraps its words instead of cutting them at every width, in every language, and is at least 44px tall on touch (L5)', async () => {
  try {
    await open();
    await page!.evaluate('window.mount("not-sorted")');
    await waitFor('document.querySelectorAll("[data-focus-area=not-sorted]").length === 6', 'the six unplaced chips');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    const measure = async () => {
      const shown: Record<string, { width: number; words: string; whole: boolean; inside: boolean; lines: number; height: number }[]> = {};
      for (const language of LOCALES) {
        await page!.evaluate(`window.setLocale(${JSON.stringify(language)})`);
        await waitFor(`document.querySelector('[data-focus-area="not-sorted"]').innerText === window.t('Not sorted yet')`, `the chip in ${language}`);
        await page!.settle();
        shown[language] = await page!.evaluate(notSortedChips);
      }
      return shown;
    };
    const desktop = await measure();
    // A touch phone (plan rule 6's coarse pointer), as app-shell.browser.test.ts emulates it.
    await page!.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(await page!.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
    await page!.settle();
    const touch = await measure();
    console.log(`[request-card-parts] unplaced area chip: ${JSON.stringify({ desktop, touch })}`);

    for (const [view, shown] of Object.entries({ desktop, touch })) {
      for (const [language, chips] of Object.entries(shown)) {
        const expected = await page!.evaluate(`(() => { window.setLocale(${JSON.stringify(language)}); return window.t('Not sorted yet'); })()`);
        for (const chip of chips) {
          // Every word shows, inside its row, at every width.
          expect({ view, language, width: chip.width, words: chip.words, whole: chip.whole, inside: chip.inside })
            .toEqual({ view, language, width: chip.width, words: expected, whole: true, inside: true });
          // 24px or more on a desktop (WCAG 2.5.8, the placed link's size), 44px or more on touch.
          expect({ view, language, width: chip.width, tallEnough: chip.height >= (view === 'touch' ? 44 : 24) }).toEqual({ view, language, width: chip.width, tallEnough: true });
        }
        // A row wide enough holds the words on one line.
        expect({ view, language, lines: chips.at(-1)!.lines }).toEqual({ view, language, lines: 1 });
      }
      // Too narrow for them, they wrap rather than cut.
      expect({ view, lines: shown.en[0].lines >= 2 }).toEqual({ view, lines: true });
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await closePage();
  }
}, TEST_LIMIT_MS);

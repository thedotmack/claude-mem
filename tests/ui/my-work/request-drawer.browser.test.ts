import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, myWorkFontResponse, scriptResponse, SCROLLBAR_MODES, scrollbarStyleFor, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { CONTINUATION_STATE_WORDS, REPLY_CARD_STATES } from '../../../src/ui/my-work/src/live/conversation-continuation';
import { STATEFUL_BUTTON_STATE } from '../../../src/ui/my-work/src/components/aceternity/stateful-button-state';
import { saveButtonLooks, type SaveButtonLook } from './save-button-looks';

failOnCiWithoutChrome('CI requires Chrome for the My Work request drawer regressions.');

/**
 * Phase 5 of the pro-max-v16 plan (page-05, c-request-detail, c-conversation-continue, c-request-detail-move-to) and its
 * fix round, on the real drawer with the app's compiled stylesheet and a fake source that answers every conversation
 * read, save and grouping decision by hand. No worker is reached: Send, Stop, Open, Move, checks and joins go to the
 * fake source, which counts them.
 * - the reply card sits right under the progress line in every state, never in a fold (V0): your move, Send is the one
 *   orange button; done and not checked, Mark checked comes first and is the one orange; otherwise Send is outlined
 *   until words are typed;
 * - a 37-conversation request draws one text box (it drew 37), and its button count and height are reported;
 * - Close is at least 44×44 and Move to… at least 44px tall on a touch phone; Move to… is a searchable list (G15);
 * - focus goes back to what opened the drawer after Escape and after Close (F 344), also when the drawer opens in two
 *   frames (its detail read, App.tsx's loading frame while the drawer's code arrives);
 * - the reply card's states (idle, sending, a running turn with Stop, cannot continue, read failure), "Reply here", and
 *   the fix round: failures in plain words with the raw cause under Details (M1), one moving running turn and one live
 *   region (M2), "Reply here" waiting for a Send (L2, Q4), earlier exchanges and whole names (L5), names that say which
 *   conversation (L6, Q13), focus asked once (Q12), Join and Mark checked keeping focus and saying what was saved (Q2,
 *   Q3, Q5, V7, V8), the suggestion's title wrapping (V1) and the gone-folder line at 390 (V2).
 * State values come from their one definition (state-machines.md), never typed again here.
 */
const [READING, IDLE, SENDING, TURN_RUNNING, CANNOT_CONTINUE, READ_FAILURE] = REPLY_CARD_STATES;

const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
let styles = '';
let bundle = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];
let markReady: () => void = () => {};

/** A recorded title too long for the picker's line (L5): its whole words must stay reachable. */
const LONG_TITLE = 'Carry the price page forecast through review, then compare both drafts against current usage';
/** The suggested request's title: long, with one long word, as real titles carry file and branch names (V1). */
const SUGGESTED_TITLE = 'Spec and wireframe the new work viewer, then trace every element back to it in the requirement ledger: pro-max-ui-v16-drawer-request-detail-suggestion';

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // The application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  styles = css.build(scanner.scan());
  bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { MotionConfig } from './src/ui/my-work/node_modules/motion/react';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { Button } from './src/ui/my-work/src/components/ui/button';
    import { RequestDetail } from './src/ui/my-work/src/components/request-detail';
    import { ConversationReplyCard } from './src/ui/my-work/src/components/conversation-continue';
    import { RequestDrawerLoading, RequestDrawerSheet } from './src/ui/my-work/src/components/request-drawer';
    import { SAMPLE_REQUESTS } from './src/ui/my-work/src/data';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    import { setLocale, t } from './src/ui/my-work/src/lib/i18n';
    window.React = React;
    const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
    const params = new URLSearchParams(location.search);
    // The page's language (lang=, else English), and its words for what a test looks for (R2, R4: other languages).
    if (params.get('lang')) setLocale(params.get('lang'));
    window.setLocale = setLocale;
    window.t = t;
    const conversationCount = Number(params.get('conversations') ?? '2');
    const state = params.get('state') ?? 'your-move';
    // How the drawer opens: in one frame, with its detail read in flight first, or with App.tsx's loading frame first.
    const stages = params.get('stages') ?? 'one';
    // What is mounted: the drawer, or the reply card alone, as a layout that asks it to focus its box and is never told
    // that it did (Q12: page-03's main card in Phase 6).
    const mount = params.get('mount') ?? 'drawer';
    // Session ids that are UUIDs, so each conversation can be continued (isContinuableConversation), and that differ in
    // their first eight characters, as Claude Code's random ids do.
    const sessionId = (index) => index.toString(16).padStart(8, '0') + '-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    window.sessionId = sessionId;
    // A conversation's title as the worker sends it: none recorded (null, as the mapper writes it since fix round R2),
    // the English "Conversation <first eight>" that workers before 16.0.0 wrote instead (titles=legacy, G19), or, with
    // titles=long, one recorded title too long for the picker's line, at long-at (the second conversation by default).
    const titles = params.get('titles') ?? 'missing';
    const longAt = Number(params.get('long-at') ?? '1');
    const conversations = Array.from({ length: conversationCount }, (_, index) => ({
      tool: 'Claude Code', at: 'Time not recorded', platform: 'claude', conversationSessionId: sessionId(index),
      title: titles === 'long' && index === longAt ? ${JSON.stringify(LONG_TITLE)} : titles === 'legacy' ? 'Conversation ' + sessionId(index).slice(0, 8) : null }));
    const BASE_OF_STATE = { 'your-move': 'r5', 'needs-check': 'r3', working: 'r1' };
    const sample = SAMPLE_REQUESTS.find((entry) => entry.id === BASE_OF_STATE[state]);
    // r1's sample images stay out: this file is about the drawer's own parts.
    const base = { ...sample, media: undefined, granular: sample.granular.map(({ media, ...record }) => record) };
    // A shared review whose viewers disagree (Q3, Q5): Mark checked and Keep unchecked both show. With the worker's own
    // words beside it (shared-reviews.mjs readSharedReview), a review it cannot offer yet and one whose viewers disagree (R1).
    const REVIEWS = {
      'shared-conflict': { mode: 'shared', hash: 'review-read', available: true, conflict: true },
      unavailable: { mode: 'shared', hash: 'review-read', available: false,
        message: 'UNAVAILABLE_MESSAGE: Some recorded evidence has not arrived on this viewer. Sync it before sharing a review.' },
      'conflict-message': { mode: 'shared', hash: 'review-read', available: true, conflict: true,
        message: 'CONFLICT_MESSAGE: Two devices saved different review decisions. Read the latest evidence and choose again.' },
    };
    const review = REVIEWS[params.get('review')] ?? base.review;
    const SUGGESTED_GROUP = 'group-suggested';
    const suggestion = params.get('suggestion') === '1' ? { conversationKey: 'conversation-read', requestId: SUGGESTED_GROUP,
      requestTitle: ${JSON.stringify(SUGGESTED_TITLE)}, evidence: 'Same feature, same files, asked a day apart', confidence: 0.74, expectedSuggestionHash: 'suggestion-read' } : undefined;
    const request = { ...base, id: 'drawer-request', conversations, evidence: [{ title: 'Observation: where it started', href: '#' }], contentFingerprint: 'a'.repeat(64),
      review, ...(suggestion ? { suggestion } : {}) };
    // The suggested request is in today's work, so its title is a link that opens it (SuggestionAction).
    const suggestedRequest = { ...SAMPLE_REQUESTS.find((entry) => entry.id === 'r1'), id: JSON.stringify(['overall-request', SUGGESTED_GROUP]), title: ${JSON.stringify(SUGGESTED_TITLE)}, media: undefined };
    const shown = stages === 'detail' ? { ...request, detailLoaded: false, detailRevision: 'a'.repeat(64) } : request;
    /** The request as the fake worker has it now; a check or a join changes it, as the worker's answer would. */
    let current = shown;
    const modelWith = async () => ({ ...(await sampleSource.loadWorkModel()), sourceKind: 'local', requests: suggestion && current.suggestion ? [current, suggestedRequest] : [current] });
    // A long recorded folder, so the folder line has to cut it.
    window.folderOf = (id) => '/Users/owner/.paradev/worktrees/CM-OSS/a-long-worktree-folder-name-' + id.slice(0, 8);
    window.answers = {};
    window.reads = [];
    window.sends = [];
    window.stops = [];
    window.opens = [];
    window.focusSaves = [];
    window.checks = [];
    window.suggestionAnswers = [];
    window.pendingSend = null;
    window.pendingCheck = null;
    window.pendingSuggestion = null;
    window.stopAnswer = 'ok';
    // How "Open in Claude" goes: it opens and the CLI prints nothing ('ok'), it opens and prints a line ('printed'), or
    // the CLI fails ('fail').
    window.openAnswer = 'ok';
    // How a focus change goes: saved ('ok'), or refused with the words local-source puts the worker's answer in ('fail').
    window.focusAnswer = 'ok';
    // The browser's clipboard, as the test sets it: it takes the command ('ok'), or refuses with the browser's own words.
    window.clipboardAnswer = 'ok';
    window.copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
      if (window.clipboardAnswer === 'fail') throw new Error('CLIPBOARD_REFUSED: Write permission denied.');
      window.copied.push(text);
    } } });
    const listeners = new Set();
    const answerFor = (id) => window.answers[id] ?? {
      target: { canContinue: true, recordedFolder: window.folderOf(id), runsInFolder: window.folderOf(id), recordedFolderIsGone: false, opensInAppNamed: 'Claude' }, exchanges: [] };
    const source = Object.create(sampleSource, {
      sourceKind: { value: 'local' },
      loadWorkModel: { value: modelWith },
      loadRequestDetail: { value: () => new Promise((resolve) => { window.releaseDetail = () => resolve(request); }) },
      saveFocusChange: { value: async (change) => {
        window.focusSaves.push(change);
        if (window.focusAnswer === 'fail') throw new Error('FOCUS_REFUSED: The focus change was not saved: the worker answered 409 Conflict.');
        return modelWith();
      } },
      setRequestChecked: { value: (requestId, fingerprint, checked) => { window.checks.push({ requestId, checked }); return new Promise((resolve, reject) => { window.pendingCheck = { resolve, reject, checked }; }); } },
      answerRequestSuggestion: { value: (answered, action) => { window.suggestionAnswers.push(action); return new Promise((resolve, reject) => { window.pendingSuggestion = { resolve, reject }; }); } },
      loadConversationContinuation: { value: (platform, id) => {
        window.reads.push(id);
        const answer = answerFor(id);
        if (answer === 'fail') return Promise.reject(new Error('READ_FAILED: the worker could not be reached'));
        return Promise.resolve(JSON.parse(JSON.stringify(answer)));
      } },
      continueConversation: { value: (platform, id, message) => { window.sends.push({ id, message }); return new Promise((resolve, reject) => { window.pendingSend = { resolve, reject }; }); } },
      stopConversationContinuation: { value: (platform, id) => {
        window.stops.push(id);
        return window.stopAnswer === 'fail' ? Promise.reject(new Error('STOP_FAILED: Nothing sent from here is running in this conversation.')) : Promise.resolve({});
      } },
      subscribeToConversationContinuations: { value: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
      openConversationInApp: { value: (platform, id) => {
        window.opens.push(id);
        if (window.openAnswer === 'fail') return Promise.reject(new Error('OPEN_FAILED: Claude Code exited with code 1.'));
        return Promise.resolve({ printedText: window.openAnswer === 'printed' ? 'CLI_PRINTED: Opening session ' + id + ' in Claude Desktop' : null });
      } },
    });
    /**
     * How the fake worker answers the check in flight: saved (the request is checked and back to you to ship), saved
     * while the shared review still conflicts, saved with the request as this view has it until its next refresh (so the
     * pressed button stays and says "Saved"), refused (409, the version as it is), or no answer at all.
     */
    window.settleCheck = async (kind) => {
      const { resolve, reject, checked } = window.pendingCheck;
      window.pendingCheck = null;
      if (kind === 'throws') return reject(new Error('CHECK_THREW: the connection closed before the worker answered'));
      if (kind === 'saved-unchanged') return resolve({ outcome: 'saved', model: await modelWith() });
      if (kind === 'refused') return resolve({ outcome: 'refused', serverMessage: 'REFUSED_BY_WORKER: This request has not been reported complete.', model: await modelWith() });
      if (kind === 'unavailable') return resolve({ outcome: 'unavailable', serverMessage: 'UNAVAILABLE_BY_WORKER: Local review storage is unavailable.' });
      if (kind === 'saved-with-conflict') {
        current = { ...current, review: { ...current.review, conflict: true, pending: true } };
        return resolve({ outcome: 'saved', model: await modelWith(), save: { scope: 'shared', state: 'queued' } });
      }
      current = checked ? { ...current, state: 'your-move', checkedAt: 'Nov 16, 3:10 pm', next: { who: 'human', kind: 'ship' } } : shown;
      resolve({ outcome: 'saved', model: await modelWith() });
    };
    /**
     * How the fake worker answers the grouping decision in flight: saved (the suggestion is answered), saved with the
     * suggestion still in this view until its next refresh (so the pressed button stays and says "Saved"), or no answer.
     */
    window.settleSuggestion = async (kind) => {
      const { resolve, reject } = window.pendingSuggestion;
      window.pendingSuggestion = null;
      if (kind === 'throws') return reject(new Error('SUGGESTION_THREW: the worker could not be reached'));
      if (kind === 'saved-unchanged') return resolve({ model: await modelWith(), save: { scope: 'local', state: 'saved' } });
      const { suggestion: answered, ...withoutSuggestion } = current;
      current = withoutSuggestion;
      resolve({ model: await modelWith(), save: { scope: 'local', state: 'saved' } });
    };
    // A notice about every conversation, as a reopened live stream gives: each open box and row reads again.
    window.notifyAll = () => listeners.forEach((listener) => listener('live-updates-reconnected'));
    window.exchangeOf = (id, fields) => ({ exchangeId: 1, platform: 'claude', conversationSessionId: id, state: 'running', ownerMessage: 'A message', startedAtEpochMs: 1000, ranInFolder: window.folderOf(id), ...fields });
    window.runningExchange = (id, message) => ({ target: answerFor(id).target, exchanges: [window.exchangeOf(id, { ownerMessage: message })] });
    useStore.getState().startWorkSource(source);
    function Fixture() {
      const open = useStore((store) => store.view.openRequest);
      // The drawer shows the request as the model has it, as App.tsx passes it, so a check or a join shows its result.
      const inModel = useStore((store) => store.work.load.state === 'loaded' && open ? store.work.load.model.requests.find((entry) => entry.id === open.id) ?? null : null);
      const [codeArrived, setCodeArrived] = React.useState(stages !== 'code');
      window.codeArrives = () => setCodeArrived(true);
      const close = () => useStore.getState().closeRequestDrawer();
      if (mount === 'reply-card') {
        return (
          <main style={{ padding: 24, display: 'grid', gap: 12, maxWidth: 640 }}>
            <Button data-testid="elsewhere" variant="outline">Somewhere else on the page</Button>
            <ConversationReplyCard conversations={conversations} focusBox />
          </main>
        );
      }
      return (
        <main style={{ padding: 24, display: 'flex', gap: 12 }}>
          <Button data-testid="opener" onClick={() => useStore.getState().openRequestDrawer(shown)}>Open the request</Button>
          <Button data-testid="reply-opener" variant="outline" onClick={() => useStore.getState().openRequestDrawer(shown, { reply: true })}>Reply</Button>
          {open && !codeArrived
            ? <RequestDrawerSheet onClose={close}><RequestDrawerLoading title={shown.title} /></RequestDrawerSheet>
            : <RequestDetail request={inModel} onClose={close} onOpenFocus={() => {}} />}
        </main>
      );
    }
    createRoot(document.getElementById('root')).render(<MotionConfig reducedMotion="user"><TooltipProvider delayDuration={150}><Fixture /></TooltipProvider></MotionConfig>);
    (function waitForModel() {
      if (useStore.getState().work.load.state === 'loaded') document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForModel);
    })();
    window.sheet = () => document.querySelector('[data-slot="sheet-content"]');
    // The drawer, or the page when the reply card is mounted alone.
    window.scope = () => window.sheet() ?? document.querySelector('main');
    window.visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight; };
    window.box = () => window.scope()?.querySelector('textarea') ?? null;
    window.replyCard = () => window.scope()?.querySelector('[data-slot="reply-card"]') ?? null;
    window.rows = () => [...(window.sheet()?.querySelectorAll('[data-slot="conversation-row"]') ?? [])];
    window.buttonNamed = (words, within) => [...((within ?? window.scope())?.querySelectorAll('button') ?? [])].find((button) => window.shownSaveLabel(button).trim().startsWith(words));
    window.foldRow = (words, within) => [...((within ?? window.scope())?.querySelectorAll('[data-slot="collapsible-fold-trigger"]') ?? [])].find((row) => row.textContent.startsWith(words));
    // Solid orange buttons: the Button's default variant, also when a save button borrows its classes (buttonVariants()).
    window.orangeButtons = () => [...(window.sheet()?.querySelectorAll('button') ?? [])].filter((button) => button.className.includes('from-primary-bright') && window.visible(button)).map((button) => window.shownSaveLabel(button).trim());
    // A save button lays every state's label in one place and shows one (aceternity/stateful-button.tsx): read that one.
    window.shownSaveLabel = (button) => button.querySelector('[data-stateful-label]:not(.invisible)')?.textContent ?? button.textContent;
    // A save button by the label it rests with, whatever it shows now (its rest label comes first in its text).
    window.saveButton = (words) => [...(window.sheet()?.querySelectorAll('button[data-save-state]') ?? [])].find((button) => button.textContent.trim().startsWith(words)) ?? null;
    window.send = () => window.replyCard()?.querySelector('button[aria-keyshortcuts]') ?? null;
    // An alert that holds these words, and the raw cause it folds under Details (G17): null until Details is opened.
    window.alertSaying = (words, within) => [...((within ?? window.scope())?.querySelectorAll('[role="alert"]') ?? [])].find((alert) => alert.textContent.includes(words)) ?? null;
    window.openDetails = (container) => { const details = window.foldRow('Details', container); if (details && details.getAttribute('aria-expanded') !== 'true') details.click(); return Boolean(details); };
    /**
     * What moves in the drawer (plan rule 8: at most two per view): every running animation's element, and the shimmer's
     * sweep, which motion runs in JavaScript (a gradient on the words), so it is counted from the page too. A transition
     * (a fold's chevron turning, a button's colour) ends in a moment, so it is not one of the moving things.
     */
    window.movingThings = () => {
      const scope = window.scope();
      const moving = new Set();
      for (const animation of document.getAnimations()) {
        const target = animation.effect?.target;
        if (animation instanceof CSSTransition) continue;
        if (animation.playState === 'running' && target instanceof Element && scope.contains(target)) moving.add(target);
      }
      for (const swept of scope.querySelectorAll('[data-slot="shimmer-text"]')) if (getComputedStyle(swept).backgroundImage !== 'none') moving.add(swept);
      return [...moving].map((element) => element.getAttribute('data-slot') ?? element.getAttribute('class')?.slice(0, 60));
    };
    // The regions a screen reader hears updates from that say these words.
    window.liveRegionsSaying = (words) => [...window.scope().querySelectorAll('[aria-live]')].filter((region) => region.textContent.includes(words)).length;
  `, ['--loader:.webp=empty', '--loader:.css=empty']);
  // The stylesheet's @font-face rules ask for ./files/<name>.woff2 (Geist and Geist Mono); widths depend on the font,
  // so the real files are served (myWorkFontResponse).
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(`<meta name="viewport" content="width=device-width,initial-scale=1">${scrollbarStyleFor(request.url)}<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>`);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    const font = myWorkFontResponse(path);
    if (font) return font;
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (path === '/fixture-error') { fixtureErrors.push(await request.text()); return new Response('noted'); }
    return new Response('not found', { status: 404 });
  } });
// Compiling the app's stylesheet and the fixture took 2-4s here, and over bun's 5s default for a hook once while other
// agents' tests ran on this Mac (2026-11-16, esbuild killed mid-compile); 60s covers a loaded machine or CI runner.
}, 60_000);

afterAll(() => { server?.stop(true); });

/** A touch phone (plan rule 6's coarse pointer): 390×844 with touch events, as app-shell.browser.test.ts emulates it. */
const PHONE = { width: 390, height: 844, touch: true };
const DESKTOP = { width: 1440, height: 900 };

async function openFixture(query: string, viewport: { width: number; height: number; touch?: boolean }) {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${server!.url.href}?${query}`;
  chrome = launchChrome(url, { profilePrefix: 'claude-mem-request-drawer-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The sample model loads in about 1s here, like the home-board fixture; 20s is for a cold Chrome on a shared CI runner.
  await withTimeout(ready, 20_000, `request drawer fixture (${query}) did not draw`);
  page = await connectToPage(chrome, url);
  await page.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: !!viewport.touch });
  if (viewport.touch) {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(await page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
  }
  await page.settle();
}
async function closeFixture() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/**
 * Waits for `expression` to be true in the page. A press's result draws within a frame or two (17–33ms), so the default
 * 5s only covers a loaded CI runner. Each check is one DevTools round trip, every 50ms: about three frames.
 */
async function waitFor(expression: string, what: string, timeoutMs = 5_000, shown?: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page!.evaluate(`Boolean(${expression})`)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}${shown ? `; the page showed ${JSON.stringify(await page!.evaluate(shown))}` : ''}`);
}

/**
 * Opens the drawer as a keyboard user would: focus on the opener, then a press. Measures wait until the panel is at rest:
 * it slides in over 0.2s (ui/sheet.tsx), 40px from the right, so a measure taken meanwhile is off by up to that much.
 */
async function openDrawer(opener = 'opener') {
  await page!.evaluate(`(() => { const opener = document.querySelector('[data-testid="${opener}"]'); opener.focus(); opener.click(); })()`);
  await waitFor(`window.sheet() && window.sheet().getAnimations().every((animation) => animation.playState !== 'running')`, 'the drawer at rest');
}

async function pressKey(key: string, code = key, keyCode = 0) {
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

/** Types into the reply box, as a person does: focus in the box, then the words. */
async function typeInTheBox(words: string) {
  await page!.evaluate('window.box().focus()');
  await page!.send('Input.insertText', { text: words });
}

/** What a screen reader hears for the element `expression` finds, from Chrome's own accessibility tree. */
async function accessibleNode(expression: string): Promise<{ name: string; value: string; description: string }> {
  const { result } = await page!.send('Runtime.evaluate', { expression });
  if (!result.objectId) throw new Error(`no element for ${expression}`);
  const { nodes } = await page!.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
  return { name: nodes[0]?.name?.value ?? '', value: String(nodes[0]?.value?.value ?? ''), description: nodes[0]?.description?.value ?? '' };
}
const accessibleName = async (expression: string) => (await accessibleNode(expression)).name;

for (const viewport of [DESKTOP, PHONE]) {
  (chromeExecutablePath ? it : it.skip)(`a two-conversation request opens with its reply box in the drawer's first screen at ${viewport.width} (page-05), with one orange button (G1)`, async () => {
    await openFixture('conversations=2', viewport);
    try {
      await openDrawer();
      await waitFor(`window.box()`, 'the reply box');
      const box = await page!.evaluate(`(() => { const rect = window.box().getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height, screen: innerHeight }; })()`);
      console.log(`[request-drawer] reply box at ${viewport.width}: ${JSON.stringify(box)}`);
      expect(box.top).toBeGreaterThan(0);
      expect(box.bottom).toBeLessThanOrEqual(box.screen);
      // The Textarea's own height (D b21 M 441: about three lines, min-h-20), not the one-line box it was overridden to.
      expect(box.height).toBeGreaterThanOrEqual(80);
      // A visible "Your reply" label stands over the box (F 270, M 440).
      expect(await page!.evaluate(`document.querySelector('label[for="' + window.box().id + '"]')?.textContent`)).toBe('Your reply');
      // Its name, Send's and Stop's say which conversation they answer, as its row names it (Q13, L6): the tool's words for
      // a conversation with no recorded title, then its id chip, never the mapper's English "Conversation 00000000".
      expect(await accessibleName('window.box()')).toBe('Your reply to Claude Code conversation 00000000');
      expect(await accessibleName('window.send()')).toBe('Send to Claude Code conversation 00000000');
      // Two conversations: a picker says which one the reply goes to.
      expect(await page!.evaluate(`window.sheet().textContent.includes('Reply to')`)).toBe(true);
      expect(await page!.evaluate(`window.orangeButtons()`)).toEqual([expect.stringContaining('Send')]);
      // The folder runs under the box as its helper line, cut at a folder boundary when the line is too narrow, with the
      // folder's own name whole and the whole path as the button's name.
      const folder = await page!.evaluate(`(() => {
        const button = window.sheet().querySelector('[data-slot="field-helper-text"] button[aria-label]');
        // Nothing of the shown text is hidden, so no CSS ellipsis cuts it inside a folder's name (textContent alone would
        // not tell), and how many lines it takes (a Range gives one box per line of the text).
        const line = button.querySelector('span');
        const range = document.createRange();
        range.selectNodeContents(line);
        return { name: button.getAttribute('aria-label'), shown: button.textContent, fits: line.scrollWidth <= line.clientWidth + 1, lines: range.getClientRects().length,
          below: button.getBoundingClientRect().top >= window.box().getBoundingClientRect().bottom, height: button.getBoundingClientRect().height };
      })()`);
      console.log(`[request-drawer] folder line at ${viewport.width}: ${JSON.stringify(folder)}`);
      expect(folder.below).toBe(true);
      expect(folder.name).toBe(await page!.evaluate(`window.folderOf(window.sessionId(0))`));
      expect(folder.shown.endsWith('a-long-worktree-folder-name-00000000')).toBe(true);
      expect(folder.shown === folder.name || folder.shown.includes('/…/')).toBe(true);
      expect(folder.fits).toBe(true);
      // At 1440 a cut fits one line. At 390 even "/…/" and this 37-character folder name are wider than the line, so that
      // shortest cut wraps instead of losing the end of the folder's name.
      if (!viewport.touch) expect(folder.lines).toBe(1);
      else expect(folder.shown).toBe('/…/a-long-worktree-folder-name-00000000');
      // WCAG 2.5.8 at the desktop size (it was 16px); 44px on touch.
      expect(folder.height).toBeGreaterThanOrEqual(viewport.touch ? 44 : 24);
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-16); 60s for a slow CI runner.
  }, 60_000);
}

(chromeExecutablePath ? it : it.skip)('a 37-conversation request draws one text box, closed and with its conversations open; button count and height reported', async () => {
  await openFixture('conversations=37', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.box()`, 'the reply box');
    const measure = () => page!.evaluate(`({ textBoxes: window.sheet().querySelectorAll('textarea').length, buttons: window.sheet().querySelectorAll('button').length, height: window.sheet().scrollHeight })`);
    const closed = await measure();
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    // Each of the 37 rows reads its conversation; once read, each that can take a reply offers "Reply here".
    await waitFor(`[...window.sheet().querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Reply here').length === 37`, '37 rows read', 10_000);
    const opened = await measure();
    console.log(`[request-drawer] 37 conversations: ${JSON.stringify({ closed, opened })}`);
    expect(closed.textBoxes).toBe(1);
    expect(opened.textBoxes).toBe(1);
    // Past ten conversations the picker is a searchable list (G15), with where the chosen one sits.
    expect(await page!.evaluate(`window.sheet().textContent.includes('1 of 37')`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 4s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

/** Where the reply card sits: under the progress line, on the first screen, in no fold (V0). */
const REPLY_CARD_PLACE = `(() => {
  const box = window.box().getBoundingClientRect();
  const progress = window.sheet().querySelector('[data-slot="progress"]').getBoundingClientRect();
  return { underTheProgressLine: box.top > progress.bottom, onTheFirstScreen: box.top > 0 && box.bottom <= innerHeight,
    inAFold: Boolean(window.box().closest('[data-slot="collapsible-content"]')) };
})()`;

(chromeExecutablePath ? it : it.skip)('done, not checked: Mark checked comes first and is the one orange button; the reply card follows it, never in a fold, Send outlined (V0, G1)', async () => {
  await openFixture('conversations=2&state=needs-check', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.buttonNamed('Mark checked') && window.box()`, 'Mark checked and the reply box');
    expect(await page!.evaluate(REPLY_CARD_PLACE)).toEqual({ underTheProgressLine: true, onTheFirstScreen: true, inAFold: false });
    expect(await page!.evaluate(`window.buttonNamed('Mark checked').getBoundingClientRect().bottom < window.replyCard().getBoundingClientRect().top`)).toBe(true);
    expect(await page!.evaluate(`window.orangeButtons()`)).toEqual(['Mark checked']);
    expect(await page!.evaluate(`window.send().dataset.variant`)).toBe('outline');
    // Words typed do not make Send a second orange button: Mark checked stays the decision.
    await typeInTheBox('Looks right to me');
    await waitFor(`window.send().getAttribute('aria-disabled') === null`, 'Send ready once there are words');
    expect(await page!.evaluate(`window.send().dataset.variant`)).toBe('outline');
    expect(await page!.evaluate(`window.orangeButtons()`)).toEqual(['Mark checked']);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('any other state: the reply card under the progress line on the first screen, in no fold; Send outlined until words are typed, then the one orange (V0)', async () => {
  await openFixture('conversations=2&state=working', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.box()`, 'the reply box without opening a fold');
    expect(await page!.evaluate(REPLY_CARD_PLACE)).toEqual({ underTheProgressLine: true, onTheFirstScreen: true, inAFold: false });
    expect(await page!.evaluate(`window.send().dataset.variant`)).toBe('outline');
    expect(await page!.evaluate(`window.orangeButtons()`)).toEqual([]);
    await typeInTheBox('Please carry on');
    await waitFor(`window.send().dataset.variant === 'default'`, 'Send solid once there are words');
    expect(await page!.evaluate(`window.orangeButtons()`)).toEqual([expect.stringContaining('Send')]);
    // "Where this came from" keeps every row with Open, Copy and "Reply here".
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    await waitFor(`window.rows().length === 2 && window.rows().every((row) => row.textContent.includes('Reply here') && row.textContent.includes('Open in Claude') && row.textContent.includes('Copy resume command'))`, 'both rows with their ways in');
    expect(await page!.evaluate(`window.sheet().querySelectorAll('textarea').length`)).toBe(1);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('on a touch phone Close is at least 44×44 and Move to… at least 44px; Move to… is a searchable, grouped list that saves one move', async () => {
  await openFixture('conversations=2', PHONE);
  try {
    await openDrawer();
    await waitFor(`window.buttonNamed('Move to…')`, 'Move to…');
    const sizes = await page!.evaluate(`(() => {
      const close = window.sheet().querySelector('[data-slot="sheet-close"]').getBoundingClientRect();
      const move = window.buttonNamed('Move to…').getBoundingClientRect();
      return { close: { width: close.width, height: close.height, right: close.right }, move: { height: move.height }, screen: innerWidth };
    })()`);
    console.log(`[request-drawer] sizes at 390: ${JSON.stringify(sizes)}`);
    expect(sizes.close.width).toBeGreaterThanOrEqual(44);
    expect(sizes.close.height).toBeGreaterThanOrEqual(44);
    expect(sizes.close.right).toBeLessThanOrEqual(sizes.screen);
    expect(sizes.move.height).toBeGreaterThanOrEqual(44);
    // A visible label in front of it (F 270).
    expect(await page!.evaluate(`window.sheet().querySelector('[role="group"]').textContent.startsWith('Focus area')`)).toBe(true);
    await page!.evaluate(`window.buttonNamed('Move to…').click()`);
    await waitFor(`document.querySelector('[data-slot="command-input"]')`, 'the search field');
    const list = await page!.evaluate(`({
      headings: [...document.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent),
      count: document.querySelector('[data-slot="popover-content"] p')?.textContent,
      focused: document.activeElement?.getAttribute('data-slot'),
    })`);
    expect(list.headings).toEqual(['Your focus areas', 'Suggested']);
    expect(list.count).toMatch(/^\d+ areas · type to narrow$/);
    expect(list.focused).toBe('command-input');
    await page!.send('Input.insertText', { text: 'team' });
    await waitFor(`[...document.querySelectorAll('[data-slot="command-item"]')].map((item) => item.textContent).join('|') === 'Team workspaces'`, 'the list narrowed to one area', 5_000,
      `[...document.querySelectorAll('[data-slot="command-item"]')].map((item) => item.textContent)`);
    await page!.evaluate(`document.querySelector('[data-slot="command-item"]').click()`);
    await waitFor(`window.focusSaves.length === 1`, 'one move saved');
    expect(await page!.evaluate(`window.focusSaves[0]`)).toEqual({ action: 'move-request', requestId: 'drawer-request', focusAreaId: 'fa-team' });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

for (const [stages, how] of [['one', 'Escape'], ['detail', 'Close'], ['code', 'Escape']] as const) {
  (chromeExecutablePath ? it : it.skip)(`focus goes back to the opener after ${how} (F 344), the drawer opening in ${stages === 'one' ? 'one frame' : stages === 'detail' ? 'two frames: its detail read' : 'two frames: App’s loading frame'}`, async () => {
    await openFixture(`conversations=2&stages=${stages}`, DESKTOP);
    try {
      await openDrawer();
      if (stages === 'detail') {
        await waitFor(`window.sheet().textContent.includes('Loading request detail')`, 'the loading shape');
        await page!.evaluate(`window.releaseDetail()`);
      }
      if (stages === 'code') {
        await waitFor(`window.sheet().textContent.includes('Loading request detail')`, 'App’s loading frame');
        await page!.evaluate(`window.codeArrives()`);
      }
      await waitFor(`window.foldRow('Deliverables')`, 'the loaded drawer');
      // The frame that gave way did not pull focus out of the drawer (it is still inside the panel).
      await page!.settle();
      expect(await page!.evaluate(`window.sheet().contains(document.activeElement)`)).toBe(true);
      if (how === 'Escape') await pressKey('Escape', 'Escape', 27);
      else await page!.evaluate(`window.sheet().querySelector('[data-slot="sheet-close"]').click()`);
      await waitFor(`!window.sheet()`, 'the drawer to close');
      await waitFor(`document.activeElement === document.querySelector('[data-testid="opener"]')`, 'focus back on the opener', 5_000, `document.activeElement?.outerHTML.slice(0, 120)`);
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-16); 60s for a slow CI runner.
  }, 60_000);
}

(chromeExecutablePath ? it : it.skip)('the reply card: idle, sending (one press starts one turn), a running turn with Stop, cannot continue, read failure, and "Reply here"', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    await openDrawer('reply-opener');
    // Reply (G2): the box takes focus once its conversation is read.
    await waitFor(`document.activeElement === window.box()`, 'focus in the reply box');
    const stateLine = `window.replyCard().querySelector('[data-reply-state] p[role="status"]')?.textContent ?? null`;
    // Idle: Send stays the orange button, dimmed and focusable, and the line under it says what it waits for (G16).
    expect(await page!.evaluate(`({ state: window.replyCard().querySelector('[data-reply-state]').dataset.replyState, disabled: window.send().getAttribute('aria-disabled'), line: ${stateLine} })`))
      .toEqual({ state: IDLE, disabled: 'true', line: CONTINUATION_STATE_WORDS[IDLE] });
    await page!.send('Input.insertText', { text: 'Please carry on with the next step' });
    await waitFor(`window.send().getAttribute('aria-disabled') === null`, 'Send ready once there are words');
    expect(await page!.evaluate(stateLine)).toBe(null);
    // Sending: one press starts one turn; a second press while it is on its way starts nothing.
    await page!.evaluate(`window.send().click()`);
    await waitFor(`window.sends.length === 1 && window.replyCard().querySelector('[data-reply-state=${JSON.stringify(SENDING)}]')`, 'sending');
    await page!.evaluate(`window.send().click()`);
    expect(await page!.evaluate(`({ sends: window.sends.length, readOnly: window.box().readOnly, line: ${stateLine}, label: [...window.send().querySelectorAll('span > span')].find((label) => !label.classList.contains('invisible'))?.textContent })`))
      .toEqual({ sends: 1, readOnly: true, line: CONTINUATION_STATE_WORDS[SENDING], label: 'Sending…' });
    expect(await page!.evaluate(`window.sends[0]`)).toEqual({ id: await page!.evaluate(`window.sessionId(0)`), message: 'Please carry on with the next step' });
    // The worker started the turn: the box stays, dimmed, and Stop sits on the running line.
    await page!.evaluate(`(() => { window.answers[window.sessionId(0)] = window.runningExchange(window.sessionId(0), 'Please carry on with the next step'); window.pendingSend.resolve({}); })()`);
    await waitFor(`window.replyCard().querySelector('[data-reply-state=${JSON.stringify(TURN_RUNNING)}]')`, 'the running turn');
    const stop = `window.replyCard().querySelector('button[aria-label^="Stop"]')`;
    expect(await page!.evaluate(`({ readOnly: window.box().readOnly, value: window.box().value, line: ${stateLine}, stop: Boolean(${stop}), sendDisabled: window.send().getAttribute('aria-disabled') })`))
      .toEqual({ readOnly: true, value: '', line: CONTINUATION_STATE_WORDS[TURN_RUNNING], stop: true, sendDisabled: 'true' });
    expect(await accessibleName(stop)).toBe('Stop the turn in Claude Code conversation 00000000');
    await page!.evaluate(`${stop}.click()`);
    await waitFor(`window.stops.length === 1 && ${stop}.disabled`, 'one Stop sent, and Stop waiting for the turn to end');
    // The conversation's row keeps its own Stop on its running line, already waiting: a second Stop would change nothing.
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    await waitFor(`window.sheet().querySelectorAll('[data-slot="conversation-row"] button[aria-label^="Stop"]').length === 1`, 'the row’s Stop');
    expect(await page!.evaluate(`window.sheet().querySelector('[data-slot="conversation-row"] button[aria-label^="Stop"]').disabled`)).toBe(true);
    // Cannot continue: plain words, the worker's reason folded under Details (fix round R1), and no box.
    await page!.evaluate(`(() => { window.answers[window.sessionId(1)] = { target: { canContinue: false, refusalText: 'NO_FOLDER: no folder was recorded for this conversation.', recordedFolder: null }, exchanges: [] }; })()`);
    const row = (index: number) => `window.rows()[${index}]`;
    // That row's own read answered before this answer was set; a notice makes every open row and box read again.
    await page!.evaluate(`window.notifyAll()`);
    await waitFor(`${row(1)}.textContent.includes('This conversation can’t be continued from here.')`, 'the second row saying it cannot be continued');
    expect(await page!.evaluate(`${row(1)}.textContent.includes('NO_FOLDER')`)).toBe(false);
    expect(await page!.evaluate(`window.openDetails(${row(1)})`)).toBe(true);
    await waitFor(`${row(1)}.textContent.includes('NO_FOLDER: no folder was recorded for this conversation.')`, 'the worker’s reason under Details');
    // Read failure, then "Reply here": the card answers that conversation; its first read fails, so the plain reason and
    // Try again show, with the raw cause folded under Details (G17, M1); once a read answers, the box shows with focus in it.
    await page!.evaluate(`(() => { delete window.answers[window.sessionId(1)]; window.notifyAll(); })()`);
    await waitFor(`[...${row(1)}.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Reply here')`, 'Reply here on the second row');
    await page!.evaluate(`(() => { window.answers[window.sessionId(1)] = 'fail'; [...${row(1)}.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Reply here').click(); })()`);
    await waitFor(`window.replyCard().querySelector('[data-reply-state=${JSON.stringify(READ_FAILURE)}]')`, 'the read failure in the card');
    const failure = `window.alertSaying('Could not read this conversation.', window.replyCard())`;
    expect(await page!.evaluate(`${failure}?.textContent.includes('READ_FAILED')`)).toBe(false);
    expect(await page!.evaluate(`window.openDetails(${failure})`)).toBe(true);
    await waitFor(`${failure}.textContent.includes('READ_FAILED: the worker could not be reached')`, 'the raw cause under Details');
    expect(await page!.evaluate(`window.replyCard().querySelector('textarea')`)).toBe(null);
    // The picker now names the second conversation.
    expect(await page!.evaluate(`window.replyCard().querySelector('[data-slot="select-trigger"]').textContent`)).toContain('00000001');
    await page!.evaluate(`(() => { delete window.answers[window.sessionId(1)]; [...window.replyCard().querySelectorAll('button')].find((button) => button.textContent.includes('Try again')).click(); })()`);
    await waitFor(`document.activeElement === window.replyCard().querySelector('textarea')`, 'focus in the box for the second conversation', 5_000,
      `document.activeElement?.outerHTML.slice(0, 120)`);
    // The words typed before stay with the card, wherever it points (they were sent, so the box is empty now).
    expect(await page!.evaluate(`window.box().value`)).toBe('');
    // A recorded folder that is gone: one line under the box with its own icon, saying where the turn will run instead.
    await page!.evaluate(`(() => { window.answers[window.sessionId(1)] = { target: { canContinue: true, recordedFolder: window.folderOf(window.sessionId(1)),
      runsInFolder: '/Users/owner/work', recordedFolderIsGone: true, opensInAppNamed: null }, exchanges: [] }; window.notifyAll(); })()`);
    await waitFor(`window.replyCard().querySelector('[data-folder-gone]')`, 'the folder-gone line');
    expect(await page!.evaluate(`(() => { const line = window.replyCard().querySelector('[data-folder-gone]');
      return { words: line.textContent, icon: Boolean(line.querySelector('svg.lucide-folder-x')), lines: window.replyCard().querySelectorAll('[data-slot="field-helper-text"]').length }; })()`))
      .toEqual({ words: 'Its folder is gone, so this turn will run in /Users/owner/work.', icon: true, lines: 1 });
    // Every state above came from the one definition, and none was left unseen.
    expect([READING, IDLE, SENDING, TURN_RUNNING, CANNOT_CONTINUE, READ_FAILURE].length).toBe(REPLY_CARD_STATES.length);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 4s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the card says why Send, Stop or Open did not happen and why a turn did not finish in plain words, the raw cause under Details (M1, G17)', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    await openDrawer('reply-opener');
    await waitFor(`document.activeElement === window.box()`, 'focus in the reply box');
    // Send: the worker refuses. The plain sentence shows; the worker's own sentence is folded; the words stay in the box.
    await page!.send('Input.insertText', { text: 'One more thing' });
    await page!.evaluate(`window.send().click()`);
    await waitFor(`window.pendingSend`, 'the Send on its way');
    await page!.evaluate(`window.pendingSend.reject(new Error('SEND_FAILED: This conversation is still answering your last message from here.'))`);
    const sendFailure = `window.alertSaying('Your reply was not sent.', window.replyCard())`;
    await waitFor(sendFailure, 'the Send failure in plain words');
    expect(await page!.evaluate(`${sendFailure}.textContent.includes('SEND_FAILED')`)).toBe(false);
    await page!.evaluate(`window.openDetails(${sendFailure})`);
    await waitFor(`${sendFailure}.textContent.includes('SEND_FAILED: This conversation is still answering your last message from here.')`, 'the worker’s sentence under Details');
    expect(await page!.evaluate(`window.box().value`)).toBe('One more thing');
    // Stop: the worker refuses it.
    await page!.evaluate(`(() => { window.answers[window.sessionId(0)] = window.runningExchange(window.sessionId(0), 'One more thing'); window.stopAnswer = 'fail'; window.notifyAll(); })()`);
    await waitFor(`window.replyCard().querySelector('button[aria-label^="Stop"]')`, 'the running turn’s Stop');
    await page!.evaluate(`window.replyCard().querySelector('button[aria-label^="Stop"]').click()`);
    const stopFailure = `window.alertSaying('Could not stop this turn.', window.replyCard())`;
    await waitFor(stopFailure, 'the Stop failure in plain words');
    expect(await page!.evaluate(`${stopFailure}.textContent.includes('STOP_FAILED')`)).toBe(false);
    await page!.evaluate(`window.openDetails(${stopFailure})`);
    await waitFor(`${stopFailure}.textContent.includes('STOP_FAILED')`, 'the Stop failure’s cause under Details');
    // A turn that did not finish: its state words, and what the CLI printed folded under Details.
    await page!.evaluate(`(() => { window.answers[window.sessionId(0)] = { target: window.runningExchange(window.sessionId(0), '').target, exchanges: [
      window.exchangeOf(window.sessionId(0), { state: 'failed', ownerMessage: 'One more thing', endedAtEpochMs: 2000, failureText: 'CLI_OUTPUT: error: the session file is locked by another process' })] }; window.notifyAll(); })()`);
    await waitFor(`window.replyCard().textContent.includes('Did not finish')`, 'the turn that did not finish');
    expect(await page!.evaluate(`window.replyCard().textContent.includes('CLI_OUTPUT')`)).toBe(false);
    const failedTurn = `[...window.replyCard().querySelectorAll('[data-slot="collapsible"]')].find((fold) => fold.textContent.startsWith('Details') && fold.closest('[data-exchange-state="failed"]'))`;
    await page!.evaluate(`window.openDetails(${failedTurn})`);
    await waitFor(`window.replyCard().textContent.includes('CLI_OUTPUT: error: the session file is locked by another process')`, 'the CLI’s output under Details');
    // Open in Claude: the CLI did not open it.
    await page!.evaluate(`(() => { window.openAnswer = 'fail'; [...window.replyCard().querySelectorAll('button')].find((button) => button.textContent.includes('Open in Claude')).click(); })()`);
    const openFailure = `window.alertSaying('Could not open this conversation in its app.', window.replyCard())`;
    await waitFor(openFailure, 'the Open failure in plain words');
    expect(await page!.evaluate(`${openFailure}.textContent.includes('OPEN_FAILED')`)).toBe(false);
    await page!.evaluate(`window.openDetails(${openFailure})`);
    await waitFor(`${openFailure}.textContent.includes('OPEN_FAILED: Claude Code exited with code 1.')`, 'what the CLI printed under Details');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 4s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('a running turn moves in one place with "Where this came from" open: at most two moving things, one live region (M2, plan rule 8)', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    await page!.evaluate(`window.answers[window.sessionId(0)] = window.runningExchange(window.sessionId(0), 'RUNNING_MESSAGE: finish the forecast')`);
    await openDrawer();
    await waitFor(`window.replyCard() && window.replyCard().querySelector('[data-reply-state=${JSON.stringify(TURN_RUNNING)}]')`, 'the running turn in the card');
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    await waitFor(`window.rows()[0]?.querySelector('button[aria-label^="Stop"]')`, 'the row’s running line with Stop');
    await page!.settle();
    const moving: string[] = await page!.evaluate(`window.movingThings()`);
    console.log(`[request-drawer] moving things with a running turn: ${JSON.stringify(moving)}`);
    expect(moving.length).toBeLessThanOrEqual(2);
    // The row's running line is still: the static working ring and its words, with Stop (G11).
    expect(await page!.evaluate(`({ ring: Boolean(window.rows()[0].querySelector('[data-state-mark="working"]')), words: window.rows()[0].textContent.includes('Working…'), shimmer: Boolean(window.rows()[0].querySelector('[data-slot="shimmer"]')) })`))
      .toEqual({ ring: true, words: true, shimmer: false });
    expect(await page!.evaluate(`window.liveRegionsSaying('RUNNING_MESSAGE')`)).toBe(1);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('"Reply here" waits while a Send is on its way: nothing moves, one send, and the Send\'s failure is seen (L2, Q4)', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    await openDrawer('reply-opener');
    await waitFor(`document.activeElement === window.box()`, 'focus in the reply box');
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    const replyHereOnB = `[...window.rows()[1].querySelectorAll('button')].find((button) => button.textContent.trim() === 'Reply here')`;
    await waitFor(replyHereOnB, 'Reply here on the second row');
    await typeInTheBox('WORDS_FOR_A: carry on');
    await page!.evaluate(`window.send().click()`);
    await waitFor(`window.pendingSend`, 'the Send on its way to the first conversation');
    expect(await page!.evaluate(`${replyHereOnB}.getAttribute('aria-disabled')`)).toBe('true');
    await page!.evaluate(`${replyHereOnB}.click()`);
    await page!.settle();
    // Nothing moved: the card still answers the first conversation, its words are still on their way, and no box for
    // the second conversation holds them.
    const stillOnA = `({ picker: window.replyCard().querySelector('[data-slot="select-trigger"]').textContent.includes('00000000'), boxes: window.sheet().querySelectorAll('textarea').length,
      value: window.box().value, sends: window.sends.length })`;
    expect(await page!.evaluate(stillOnA)).toEqual({ picker: true, boxes: 1, value: 'WORDS_FOR_A: carry on', sends: 1 });
    // The Send fails: the card says so, and the words stay for the first conversation.
    await page!.evaluate(`window.pendingSend.reject(new Error('SEND_FAILED: the worker could not be reached'))`);
    await waitFor(`window.alertSaying('Your reply was not sent.', window.replyCard())`, 'the Send failure in the card');
    expect(await page!.evaluate(stillOnA)).toEqual({ picker: true, boxes: 1, value: 'WORDS_FOR_A: carry on', sends: 1 });
    expect(await page!.evaluate(`${replyHereOnB}.getAttribute('aria-disabled')`)).toBe(null);
    // Sent again, and it goes through: "Reply here" waited all along, and the box empties for the words that went.
    await page!.evaluate(`window.send().click()`);
    await waitFor(`window.sends.length === 2 && window.pendingSend`, 'the second Send on its way');
    await page!.evaluate(`${replyHereOnB}.click()`);
    await page!.evaluate(`window.pendingSend.resolve({})`);
    await waitFor(`window.box().value === ''`, 'the box empty once the words went');
    expect(await page!.evaluate(`({ picker: window.replyCard().querySelector('[data-slot="select-trigger"]').textContent.includes('00000000'), sends: window.sends.map((sent) => sent.id) })`))
      .toEqual({ picker: true, sends: [await page!.evaluate(`window.sessionId(0)`), await page!.evaluate(`window.sessionId(0)`)] });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the reply card says how many earlier exchanges there are and shows them on request (L5)', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    await page!.evaluate(`(() => { const id = window.sessionId(0); window.answers[id] = { target: window.runningExchange(id, '').target, exchanges: [
      window.exchangeOf(id, { exchangeId: 1, state: 'replied', ownerMessage: 'EARLIER_ONE: which forecast?', replyText: 'The second.', endedAtEpochMs: 1500 }),
      window.exchangeOf(id, { exchangeId: 2, state: 'replied', ownerMessage: 'EARLIER_TWO: and the usage table?', replyText: 'Kept.', startedAtEpochMs: 2000, endedAtEpochMs: 2500 }),
      window.exchangeOf(id, { exchangeId: 3, state: 'replied', ownerMessage: 'LATEST: ship it', replyText: 'Shipped.', startedAtEpochMs: 3000, endedAtEpochMs: 3500 })] }; })()`);
    await openDrawer();
    await waitFor(`window.replyCard()?.textContent.includes('LATEST: ship it')`, 'the latest exchange in the card');
    expect(await page!.evaluate(`window.replyCard().textContent.includes('EARLIER_ONE')`)).toBe(false);
    const earlier = `window.foldRow('2 earlier exchanges', window.replyCard())`;
    expect(await page!.evaluate(`Boolean(${earlier})`)).toBe(true);
    await page!.evaluate(`${earlier}.click()`);
    await waitFor(`window.replyCard().textContent.includes('EARLIER_ONE: which forecast?') && window.replyCard().textContent.includes('EARLIER_TWO: and the usage table?')`, 'the earlier exchanges, shown on request');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

for (const [count, picker] of [[2, 'Select'], [12, 'searchable list']] as const) {
  (chromeExecutablePath ? it : it.skip)(`a conversation name cut on the ${picker}'s line stays whole for pointer, keyboard and screen reader (L5)`, async () => {
    await openFixture(`conversations=${count}&titles=long`, DESKTOP);
    try {
      await openDrawer();
      await waitFor(`window.box()`, 'the reply box');
      const trigger = count === 2 ? `window.replyCard().querySelector('[data-slot="select-trigger"]')` : `window.replyCard().querySelector('button[aria-haspopup="dialog"]')`;
      // Open the list: a Select opens from the keyboard, the searchable list on a press.
      await page!.evaluate(`${trigger}.focus()`);
      if (count === 2) await pressKey('Enter', 'Enter', 13);
      else await page!.evaluate(`${trigger}.click()`);
      const items = count === 2 ? `[...document.querySelectorAll('[data-slot="select-item"]')]` : `[...document.querySelectorAll('[data-slot="command-item"]')]`;
      await waitFor(`${items}.some((item) => item.textContent.includes(${JSON.stringify(LONG_TITLE)}))`, 'the long name in the list');
      // In the list the name is whole: it wraps, nothing of it is cut away.
      expect(await page!.evaluate(`(() => { const item = ${items}.find((entry) => entry.textContent.includes(${JSON.stringify(LONG_TITLE)}));
        return [...item.querySelectorAll('span')].every((part) => part.scrollWidth <= part.clientWidth + 1); })()`)).toBe(true);
      // Chosen, the trigger's line cuts it, and the whole name is its hover text and what a screen reader hears (the
      // trigger's name, value or description).
      await page!.evaluate(`${items}.find((item) => item.textContent.includes(${JSON.stringify(LONG_TITLE)})).click()`);
      await waitFor(`${trigger}.textContent.includes(${JSON.stringify(LONG_TITLE.slice(0, 20))})`, 'the long name chosen');
      // A modal list hides the rest of the page from screen readers while it is open: read the trigger once it has closed.
      await waitFor(`!document.querySelector('[data-slot="popover-content"], [data-slot="select-content"]') && !window.sheet().closest('[aria-hidden="true"]')`, 'the list closed');
      await page!.settle();
      expect(await page!.evaluate(`${trigger}.title`)).toContain(LONG_TITLE);
      const heard = await accessibleNode(trigger);
      console.log(`[request-drawer] ${picker} trigger heard as ${JSON.stringify(heard)}`);
      expect(`${heard.name} ${heard.value} ${heard.description}`).toContain(LONG_TITLE);
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-16); 60s for a slow CI runner.
  }, 60_000);
}

(chromeExecutablePath ? it : it.skip)('a layout that asks the reply card to focus its box, and is never told it did, gets focus once, not on every read (Q12)', async () => {
  await openFixture('conversations=2&mount=reply-card', DESKTOP);
  try {
    await waitFor(`document.activeElement === window.box()`, 'focus in the box once its conversation is read');
    await page!.evaluate(`document.querySelector('[data-testid="elsewhere"]').focus()`);
    const reads = await page!.evaluate(`window.reads.length`);
    // A notice makes the card read its conversation again; the read answers with a new copy of the record.
    await page!.evaluate(`window.notifyAll()`);
    await waitFor(`window.reads.length > ${reads}`, 'the card reading again');
    await page!.settle();
    expect(await page!.evaluate(`document.activeElement?.getAttribute('data-testid')`)).toBe('elsewhere');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('Join keeps its question open while it saves and keeps focus; a failure stays in the question; a saved join puts focus on its result (Q2)', async () => {
  await openFixture('conversations=2&suggestion=1', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.buttonNamed('Join that request')`, 'the suggestion');
    await page!.evaluate(`window.buttonNamed('Join that request').click()`);
    const joinButton = `window.saveButton('Join')`;
    await waitFor(`${joinButton} && !${joinButton}.closest('[hidden]')`, 'the question with Join');
    await page!.evaluate(`(() => { const button = ${joinButton}; button.focus(); button.click(); })()`);
    await waitFor(`window.pendingSuggestion`, 'the join on its way');
    // While it saves: the question stays open, Join keeps focus and says it is saving.
    expect(await page!.evaluate(`({ open: !${joinButton}.closest('[hidden]'), focused: document.activeElement === ${joinButton}, busy: ${joinButton}.getAttribute('aria-busy'), label: window.shownSaveLabel(${joinButton}) })`))
      .toEqual({ open: true, focused: true, busy: 'true', label: 'Saving…' });
    // It fails: the question stays open with the failure in it, and Join keeps focus.
    await page!.evaluate(`window.settleSuggestion('throws')`);
    await waitFor(`${joinButton}.dataset.saveState === 'not-saved'`, 'Join not saved');
    const question = `${joinButton}.closest('[id]')`;
    expect(await page!.evaluate(`({ open: !${joinButton}.closest('[hidden]'), focused: document.activeElement === ${joinButton}, failure: ${question}.textContent.includes('Your grouping decision was not saved.') })`))
      .toEqual({ open: true, focused: true, failure: true });
    // Pressed again, it saves: the suggestion is answered and its result line takes focus.
    await page!.evaluate(`${joinButton}.click()`);
    await waitFor(`window.pendingSuggestion`, 'the second join on its way');
    await page!.evaluate(`window.settleSuggestion('saved')`);
    await waitFor(`!window.buttonNamed('Join that request')`, 'the suggestion answered');
    await waitFor(`document.activeElement?.textContent.includes('Joined the request.')`, 'focus on the result line', 5_000, `document.activeElement?.outerHTML.slice(0, 160)`);
    expect(await page!.evaluate(`window.sheet().contains(document.activeElement)`)).toBe(true);
    expect(await page!.evaluate(`window.suggestionAnswers`)).toEqual(['join', 'join']);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('a save keeps focus on the button pressed, which waits busy while its sibling waits; saved with a caveat says Saved, never "Not saved" (Q3, Q5)', async () => {
  await openFixture('conversations=2&state=needs-check&review=shared-conflict', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.saveButton('Mark checked') && window.saveButton('Keep unchecked')`, 'the conflicting review’s two decisions');
    await page!.evaluate(`(() => { const button = window.saveButton('Mark checked'); button.focus(); button.click(); })()`);
    await waitFor(`window.pendingCheck`, 'the check on its way');
    const waiting = (label: string) => `(() => { const button = window.saveButton(${JSON.stringify(label)});
      return { focused: document.activeElement === button, disabled: button.disabled, busy: button.getAttribute('aria-busy'), waits: button.getAttribute('aria-disabled') }; })()`;
    expect(await page!.evaluate(waiting('Mark checked'))).toEqual({ focused: true, disabled: false, busy: 'true', waits: 'true' });
    expect(await page!.evaluate(waiting('Keep unchecked'))).toEqual({ focused: false, disabled: false, busy: null, waits: 'true' });
    // The decision was saved, but the viewers still disagree: the button says Saved; the notice gives the caveat.
    await page!.evaluate(`window.settleCheck('saved-with-conflict')`);
    const markChecked = `window.saveButton('Mark checked')`;
    await waitFor(`${markChecked}.dataset.saveState === 'saved'`, 'Mark checked saved');
    expect(await page!.evaluate(`window.shownSaveLabel(${markChecked}).trim()`)).toBe('Saved');
    expect(await page!.evaluate(`window.sheet().textContent.includes('Your review decision was saved here, but your viewers still have conflicting decisions.')`)).toBe(true);
    expect(await page!.evaluate(`[...window.sheet().querySelectorAll('[role="alert"]')].some((alert) => alert.textContent.trim() === 'Not saved')`)).toBe(false);
    expect(await page!.evaluate(`document.activeElement === ${markChecked}`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

for (const [answer, plainWords, cause] of [
  ['refused', 'Your review decision was not saved. The worker refused this version as it is.', 'REFUSED_BY_WORKER: This request has not been reported complete.'],
  ['unavailable', 'Your review decision was not saved. Local work is unavailable right now.', 'UNAVAILABLE_BY_WORKER: Local review storage is unavailable.'],
] as const) {
  (chromeExecutablePath ? it : it.skip)(`a check the worker answers ${answer} says "Not saved" and why in plain words, its reason under Details (V7, M1)`, async () => {
    await openFixture('conversations=2&state=needs-check', DESKTOP);
    try {
      await openDrawer();
      await waitFor(`window.saveButton('Mark checked')`, 'Mark checked');
      await page!.evaluate(`(() => { const button = window.saveButton('Mark checked'); button.focus(); button.click(); })()`);
      await waitFor(`window.pendingCheck`, 'the check on its way');
      await page!.evaluate(`window.settleCheck(${JSON.stringify(answer)})`);
      const button = `window.saveButton('Mark checked')`;
      await waitFor(`${button}.dataset.saveState === 'not-saved'`, 'Mark checked not saved');
      expect(await page!.evaluate(`[...window.sheet().querySelectorAll('[role="alert"]')].some((alert) => alert.textContent.trim() === 'Not saved')`)).toBe(true);
      const reason = `window.alertSaying(${JSON.stringify(plainWords)})`;
      expect(await page!.evaluate(`Boolean(${reason})`)).toBe(true);
      expect(await page!.evaluate(`${reason}.textContent.includes(${JSON.stringify(cause.slice(0, 12))})`)).toBe(false);
      await page!.evaluate(`window.openDetails(${reason})`);
      await waitFor(`${reason}.textContent.includes(${JSON.stringify(cause)})`, 'the worker’s reason under Details');
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-16); 60s for a slow CI runner.
  }, 60_000);
}

(chromeExecutablePath ? it : it.skip)('right after Mark checked the drawer says when and where it was checked, and focus lands on that line (V8)', async () => {
  await openFixture('conversations=2&state=needs-check', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.buttonNamed('Mark checked')`, 'Mark checked');
    await page!.evaluate(`(() => { const button = window.buttonNamed('Mark checked'); button.focus(); button.click(); })()`);
    await waitFor(`window.pendingCheck`, 'the check on its way');
    await page!.evaluate(`window.settleCheck('saved')`);
    await waitFor(`window.buttonNamed('Undo')`, 'the checked block with Undo');
    const receipt = await page!.evaluate(`[...window.buttonNamed('Undo').parentElement.querySelectorAll('p')].map((line) => line.textContent.trim())`);
    expect(receipt).toEqual(['Checked Nov 16, 3:10 pm.', 'Saved on this machine only. Shipping is still your call.']);
    await waitFor(`document.activeElement?.textContent.includes('Checked Nov 16, 3:10 pm.')`, 'focus on the checked line', 5_000, `document.activeElement?.outerHTML.slice(0, 160)`);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

/** The save buttons request-detail.tsx draws, counted from its source: every one of them is in the drawer. */
const DRAWER_SAVE_BUTTON_CALLERS = (readFileSync(resolve(app, 'src/components/request-detail.tsx'), 'utf8').match(/<SaveButton\b/g) ?? []).length;

(chromeExecutablePath ? it : it.skip)('every save button in the drawer draws an icon in its slot at rest, and keeps one width resting, saving and saved (V12)', async () => {
  const { rest: REST, saving: SAVING, saved: SAVED } = STATEFUL_BUTTON_STATE;
  /** Each save button, by the block it is in and its words: at rest, while its save is held, and saved when that look shows. */
  const seen: Record<string, { rest: SaveButtonLook; saving: SaveButtonLook; saved: SaveButtonLook | null }> = {};
  const read = async (button: string) => await page!.evaluate(saveButtonLooks(button)) as SaveButtonLook;
  /** Presses `button`, reads it while the fake worker holds its save, then has the worker answer saved and reads it again. */
  const pressAndRead = async (name: string, button: string, pending: 'pendingCheck' | 'pendingSuggestion', settle: 'settleCheck' | 'settleSuggestion') => {
    const rest = await read(button);
    await page!.evaluate(`${button}.click()`);
    await waitFor(`window.${pending}`, `${name} on its way`);
    const saving = await read(button);
    await page!.evaluate(`window.${settle}('saved-unchanged')`);
    await waitFor(`${button}.dataset.saveState !== ${JSON.stringify(SAVING)}`, `${name} answered`);
    seen[name] = { rest, saving, saved: await page!.evaluate(`!${button}.closest('[hidden]')`) ? await read(button) : null };
  };
  // Done, not checked: Mark checked. Checked: Undo, once a check is saved.
  await openFixture('conversations=2&state=needs-check', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.saveButton('Mark checked')`, 'Mark checked');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    await pressAndRead('done, not checked: Mark checked', `window.saveButton('Mark checked')`, 'pendingCheck', 'settleCheck');
    await page!.evaluate(`window.saveButton('Mark checked').click()`);
    await waitFor(`window.pendingCheck`, 'the check that is saved as checked');
    await page!.evaluate(`window.settleCheck('saved')`);
    await waitFor(`window.saveButton('Undo')`, 'the checked block with Undo');
    await pressAndRead('checked: Undo', `window.saveButton('Undo')`, 'pendingCheck', 'settleCheck');
  } finally { await closeFixture(); }
  // A shared review whose viewers disagree: Mark checked and Keep unchecked.
  await openFixture('conversations=2&state=needs-check&review=shared-conflict', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.saveButton('Mark checked') && window.saveButton('Keep unchecked')`, 'the conflicting review’s two decisions');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    await pressAndRead('viewers disagree: Mark checked', `window.saveButton('Mark checked')`, 'pendingCheck', 'settleCheck');
    await pressAndRead('viewers disagree: Keep unchecked', `window.saveButton('Keep unchecked')`, 'pendingCheck', 'settleCheck');
  } finally { await closeFixture(); }
  // The suggestion: Join, in the question "Join that request" opens, and Keep separate.
  await openFixture('conversations=2&suggestion=1', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.buttonNamed('Join that request')`, 'the suggestion');
    await page!.evaluate('document.fonts.ready.then(() => true)');
    await page!.evaluate(`window.buttonNamed('Join that request').click()`);
    await waitFor(`window.saveButton('Join') && !window.saveButton('Join').closest('[hidden]')`, 'the question with Join');
    await pressAndRead('suggestion: Join', `window.saveButton('Join')`, 'pendingSuggestion', 'settleSuggestion');
    await pressAndRead('suggestion: Keep separate', `window.saveButton('Keep separate')`, 'pendingSuggestion', 'settleSuggestion');
  } finally { await closeFixture(); }
  console.log(`[request-drawer] save buttons: ${JSON.stringify(seen)}`);

  // Every save button request-detail.tsx draws was seen.
  expect(Object.keys(seen).length).toBe(DRAWER_SAVE_BUTTON_CALLERS);
  for (const [name, { rest, saving, saved }] of Object.entries(seen)) {
    // At rest the slot draws an icon that says what the button does, never an empty gap.
    expect({ name, state: rest.state, icon: rest.cells[REST].drawsIcon }).toEqual({ name, state: REST, icon: true });
    // Every look's words are laid out in the button at rest, so it is as wide as the widest of them in every look.
    for (const [state, cell] of Object.entries(rest.cells)) expect({ name, state, laidOut: cell.contentWidth > 0 }).toEqual({ name, state, laidOut: true });
    // One width resting, saving and saved.
    expect({ name, state: saving.state, sameWidth: Math.abs(saving.width - rest.width) <= 0.5 }).toEqual({ name, state: SAVING, sameWidth: true });
    if (saved) expect({ name, state: saved.state, sameWidth: Math.abs(saved.width - rest.width) <= 0.5 }).toEqual({ name, state: SAVED, sameWidth: true });
  }
  // A saved join closes its question, so Join's saved look never shows; every other button showed it.
  expect(Object.entries(seen).filter(([, looks]) => looks.saved === null).map(([name]) => name)).toEqual(['suggestion: Join']);
  expect(fixtureErrors).toEqual([]);
// Three drawers, about 3s each here (2026-11-17); 120s for a slow CI runner.
}, 120_000);

for (const viewport of [DESKTOP, PHONE]) {
  (chromeExecutablePath ? it : it.skip)(`the suggestion's linked title wraps inside its section at ${viewport.width} (V1)`, async () => {
    await openFixture('conversations=2&suggestion=1', viewport);
    try {
      await openDrawer();
      await waitFor(`window.buttonNamed('Join that request')`, 'the suggestion');
      const edges = await page!.evaluate(`(() => {
        const link = [...window.sheet().querySelectorAll('button')].find((button) => button.textContent === ${JSON.stringify(SUGGESTED_TITLE)});
        const section = link.closest('section').getBoundingClientRect();
        const rect = link.getBoundingClientRect();
        return { left: rect.left, right: rect.right, sectionLeft: section.left, sectionRight: section.right, height: rect.height };
      })()`);
      console.log(`[request-drawer] suggestion link at ${viewport.width}: ${JSON.stringify(edges)}`);
      expect(edges.right).toBeLessThanOrEqual(edges.sectionRight + 0.5);
      expect(edges.left).toBeGreaterThanOrEqual(edges.sectionLeft - 0.5);
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-16); 60s for a slow CI runner.
  }, 60_000);
}

(chromeExecutablePath ? it : it.skip)('at 390 the "folder is gone" line never breaks into a one-letter column: the folder is one line cut at a folder boundary (V2)', async () => {
  await openFixture('conversations=2', PHONE);
  try {
    // Real-shaped: a worktree that was removed, so the turn runs in the folder above it.
    await page!.evaluate(`window.answers[window.sessionId(0)] = { target: { canContinue: true, recordedFolder: '/Users/owner/.paradev/worktrees/CM-OSS/pollen-direction-ea27d252',
      runsInFolder: '/Users/owner/.paradev/worktrees/CM-OSS', recordedFolderIsGone: true, opensInAppNamed: 'Claude' }, exchanges: [] }`);
    await openDrawer();
    await waitFor(`window.replyCard()?.querySelector('[data-folder-gone] button[aria-label]')`, 'the folder-gone line');
    // The column showed where the words before the folder just fit beside the icon and left the folder a sliver, so
    // phone widths around 390 are each measured (every 6px from 360 to 480), 390 itself among them.
    const widths = [390, ...Array.from({ length: 21 }, (_, step) => 360 + step * 6)];
    for (const width of widths) {
      await page!.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      // The folder line measures itself on resize (ResizeObserver), then draws the cut that fits: two frames or so.
      await page!.settle();
      await page!.settle();
      const line = await page!.evaluate(`(() => {
        const helper = window.replyCard().querySelector('[data-folder-gone]');
        const button = helper.querySelector('button[aria-label]');
        const shown = button.querySelector('span');
        const range = document.createRange();
        range.selectNodeContents(shown);
        const helperBox = helper.getBoundingClientRect();
        // The words around the folder stay inside the line: nothing runs past its right edge.
        const words = [...helper.querySelectorAll(':scope > span > span')].map((part) => part.getBoundingClientRect().right);
        return { name: button.getAttribute('aria-label'), shown: shown.textContent, fits: shown.scrollWidth <= shown.clientWidth + 1, lines: range.getClientRects().length,
          width: Math.round(button.getBoundingClientRect().width), helperHeight: Math.round(helperBox.height), wordsInside: words.every((right) => right <= helperBox.right + 1),
          text: helper.textContent };
      })()`);
      console.log(`[request-drawer] folder-gone line at ${width}: ${JSON.stringify({ ...line, text: undefined })}`);
      expect(line.name).toBe('/Users/owner/.paradev/worktrees/CM-OSS');
      expect(line.shown.endsWith('CM-OSS')).toBe(true);
      expect(line.shown === line.name || line.shown.includes('/…/')).toBe(true);
      expect({ width, fits: line.fits, lines: line.lines, wordsInside: line.wordsInside }).toEqual({ width, fits: true, lines: 1, wordsInside: true });
      expect(line.text).toBe(`Its folder is gone, so this turn will run in ${line.shown}.`);
    }
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

/**
 * A removed worktree, real-shaped: the folder the turn runs in is as long as the owner's own (43 characters in a
 * monospace face, so as wide), which left the sentence's full stop alone on its last line at 390.
 */
const GONE_WORKTREE = { recorded: '/Users/maintainer/.paradev/worktrees/CM-OSS/pollen-direction-ea27d252', runsIn: '/Users/maintainer/.paradev/worktrees/CM-OSS' };

/**
 * Where the folder-gone line's ends are drawn: the sentence's last character (its full stop) and the one before it (the
 * folder's last, or a word's), and the first character written right against the folder's end, if any ("." in English,
 * "에" in Korean), each with the middle of the line it is on.
 */
const FOLDER_LINE_ENDS = `(() => {
  const helper = window.replyCard().querySelector('[data-folder-gone]');
  const button = helper.querySelector('button[aria-label]');
  const characters = [];
  const walker = document.createTreeWalker(helper, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let index = 0; index < node.textContent.length; index++) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const box = range.getBoundingClientRect();
      characters.push({ text: node.textContent[index], folder: button.contains(node), middle: (box.top + box.bottom) / 2, height: box.height });
    }
  }
  const drawn = characters.filter((character) => character.text.trim() !== '');
  const sameLine = (a, b) => Math.abs(a.middle - b.middle) < Math.min(a.height, b.height) / 2;
  const folderEnd = characters.findLastIndex((character) => character.folder);
  const joined = characters[folderEnd + 1];
  const joinedText = joined && joined.text.trim() !== '' ? joined.text : null;
  return { text: helper.textContent, shown: button.textContent, stop: drawn.at(-1).text, stopWithTheOneBefore: sameLine(drawn.at(-1), drawn.at(-2)),
    joined: joinedText, joinedWithTheFolder: joinedText === null ? null : sameLine(joined, characters[folderEnd]),
    lines: new Set(drawn.map((character) => Math.round(character.middle))).size };
})()`;

for (const language of ['en', 'fr', 'ko', 'zh-CN', 'tr']) {
  (chromeExecutablePath ? it : it.skip)(`at 390 the "folder is gone" line keeps its full stop with the folder or word before it, with a real-shaped path (${language})`, async () => {
    await openFixture(`conversations=2&lang=${language}`, PHONE);
    try {
      await page!.evaluate(`window.answers[window.sessionId(0)] = { target: { canContinue: true, recordedFolder: ${JSON.stringify(GONE_WORKTREE.recorded)},
        runsInFolder: ${JSON.stringify(GONE_WORKTREE.runsIn)}, recordedFolderIsGone: true, opensInAppNamed: 'Claude' }, exchanges: [] }`);
      await openDrawer();
      await waitFor(`window.replyCard()?.querySelector('[data-folder-gone] button[aria-label]')`, 'the folder-gone line');
      // 390, where it was seen; in English also every 6px from 360 to 480, the phone widths V2 measures.
      const widths = language === 'en' ? [390, ...Array.from({ length: 21 }, (_, step) => 360 + step * 6)] : [390];
      for (const width of widths) {
        await page!.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
        // The folder line measures itself on resize (ResizeObserver), then draws the cut that fits: two frames or so.
        await page!.settle();
        await page!.settle();
        const line = await page!.evaluate(FOLDER_LINE_ENDS);
        console.log(`[request-drawer] folder-gone line ends (${language}) at ${width}: ${JSON.stringify({ ...line, text: undefined })}`);
        expect(line.text.includes(line.shown)).toBe(true);
        expect(['.', '。']).toContain(line.stop);
        // The full stop is never alone at the start of a line: it shares one with the character before it.
        expect({ language, width, stopWithTheOneBefore: line.stopWithTheOneBefore }).toEqual({ language, width, stopWithTheOneBefore: true });
        // What is written right against the folder's end stays on the folder's line.
        if (line.joined !== null) expect({ language, width, joined: line.joined, withTheFolder: line.joinedWithTheFolder }).toEqual({ language, width, joined: line.joined, withTheFolder: true });
      }
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here, 6s with English's 22 widths (2026-11-17); 60s for a slow CI runner.
  }, 60_000);
}

/** Points the reply card at the listed conversation whose name holds `words`, through its picker (a Select). */
async function chooseConversation(words: string) {
  await page!.evaluate(`window.replyCard().querySelector('[data-slot="select-trigger"]').focus()`);
  await pressKey('Enter', 'Enter', 13);
  await waitFor(`[...document.querySelectorAll('[data-slot="select-item"]')].some((item) => item.textContent.includes(${JSON.stringify(words)}))`, `the picker listing ${words}`);
  await page!.evaluate(`[...document.querySelectorAll('[data-slot="select-item"]')].find((item) => item.textContent.includes(${JSON.stringify(words)})).click()`);
  await waitFor(`window.replyCard().querySelector('[data-slot="select-trigger"]').textContent.includes(${JSON.stringify(words)})`, `the card answering ${words}`);
}

(chromeExecutablePath ? it : it.skip)('what the worker, the browser or the CLI wrote shows only under Details, beside plain words: a conversation that cannot be continued, a refused copy, an open that worked (R1, G17)', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    const refusal = 'NO_FOLDER: No folder was recorded for this Claude Code conversation, so it can’t be continued from here.';
    await page!.evaluate(`window.answers[window.sessionId(1)] = { target: { canContinue: false, refusalText: ${JSON.stringify(refusal)}, recordedFolder: null }, exchanges: [] }`);
    await openDrawer();
    await waitFor(`window.box()`, 'the reply box');
    // The clipboard refuses the resume command: a plain sentence, then where to copy it from by hand; the browser's words
    // are folded under Details.
    await page!.evaluate(`(() => { window.clipboardAnswer = 'fail'; window.buttonNamed('Copy resume command', window.replyCard()).click(); })()`);
    const copyFailure = `window.alertSaying('Could not copy the command.', window.replyCard())`;
    await waitFor(copyFailure, 'the refused copy in plain words', 5_000, `window.replyCard().textContent`);
    expect(await page!.evaluate(`window.replyCard().textContent.includes('CLIPBOARD_REFUSED')`)).toBe(false);
    expect(await page!.evaluate(`window.replyCard().textContent.includes('Copy it from here:') && window.replyCard().textContent.includes('claude --resume ' + window.sessionId(0))`)).toBe(true);
    expect(await page!.evaluate(`window.openDetails(${copyFailure})`)).toBe(true);
    await waitFor(`${copyFailure}.textContent.includes('CLIPBOARD_REFUSED: Write permission denied.')`, 'the browser’s words under Details');
    // "Open in Claude" works and the CLI prints a line: what happened, in plain words; what it printed, under Details.
    await page!.evaluate(`(() => { window.openAnswer = 'printed'; window.buttonNamed('Open in Claude', window.replyCard()).click(); })()`);
    const opened = `[...window.replyCard().querySelectorAll('[role="status"]')].find((line) => line.textContent.includes('Opened in Claude.'))`;
    await waitFor(opened, 'the open in plain words', 5_000, `window.replyCard().textContent`);
    expect(await page!.evaluate(`window.replyCard().textContent.includes('CLI_PRINTED')`)).toBe(false);
    expect(await page!.evaluate(`window.openDetails(${opened})`)).toBe(true);
    await waitFor(`${opened}.textContent.includes('CLI_PRINTED: Opening session ' + window.sessionId(0) + ' in Claude Desktop')`, 'what the CLI printed under Details');
    // The conversation that cannot be continued, on its row: the plain sentence, the worker's reason under Details.
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    await waitFor(`window.rows()[1]?.textContent.includes('This conversation can’t be continued from here.')`, 'the second row in plain words', 5_000, `window.rows()[1]?.textContent`);
    expect(await page!.evaluate(`window.rows()[1].textContent.includes('NO_FOLDER')`)).toBe(false);
    expect(await page!.evaluate(`window.openDetails(window.rows()[1])`)).toBe(true);
    await waitFor(`window.rows()[1].textContent.includes(${JSON.stringify(refusal)})`, 'the worker’s reason under the row’s Details');
    // And in the card, pointed at it.
    await chooseConversation('00000001');
    await waitFor(`window.replyCard().querySelector('[data-reply-state=${JSON.stringify(CANNOT_CONTINUE)}]')`, 'the card on the conversation that cannot be continued');
    await waitFor(`window.replyCard().textContent.includes('This conversation can’t be continued from here.')`, 'the card in plain words');
    expect(await page!.evaluate(`window.replyCard().textContent.includes('NO_FOLDER')`)).toBe(false);
    expect(await page!.evaluate(`window.openDetails(window.replyCard())`)).toBe(true);
    await waitFor(`window.replyCard().textContent.includes(${JSON.stringify(refusal)})`, 'the worker’s reason under the card’s Details');
    // In another language the plain words are that language's (rule 4); the worker's words stay as it wrote them.
    await page!.evaluate(`window.setLocale('zh-CN')`);
    await waitFor(`window.replyCard().textContent.includes(window.t('This conversation can’t be continued from here.')) && window.rows()[1].textContent.includes(window.t('This conversation can’t be continued from here.'))`,
      'the plain words in Chinese', 5_000, `window.replyCard().textContent`);
    expect(await page!.evaluate(`window.t('This conversation can’t be continued from here.') !== 'This conversation can’t be continued from here.'`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 4s here (2026-11-17); 60s for a slow CI runner.
}, 60_000);

for (const [review, plainWords, workerWords] of [
  ['unavailable', 'This review is unavailable until the shared state is complete. Nothing was changed.', 'UNAVAILABLE_MESSAGE: Some recorded evidence has not arrived on this viewer. Sync it before sharing a review.'],
  ['conflict-message', 'Your viewers recorded different review decisions. Read this version, then choose the decision to keep.', 'CONFLICT_MESSAGE: Two devices saved different review decisions. Read the latest evidence and choose again.'],
] as const) {
  (chromeExecutablePath ? it : it.skip)(`a shared review the worker sends with its own words (${review}) shows the drawer's plain words, the worker's under Details (R1, G17)`, async () => {
    await openFixture(`conversations=2&state=needs-check&review=${review}`, DESKTOP);
    try {
      await openDrawer();
      const line = `[...window.sheet().querySelectorAll('[role="status"]')].find((status) => status.textContent.includes(${JSON.stringify(plainWords)}))`;
      await waitFor(line, 'the review’s plain words', 5_000, `[...window.sheet().querySelectorAll('[role="status"]')].map((status) => status.textContent)`);
      expect(await page!.evaluate(`window.sheet().textContent.includes(${JSON.stringify(workerWords.split(':')[0])})`)).toBe(false);
      expect(await page!.evaluate(`window.openDetails(${line})`)).toBe(true);
      await waitFor(`${line}.textContent.includes(${JSON.stringify(workerWords)})`, 'the worker’s words under Details');
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-17); 60s for a slow CI runner.
  }, 60_000);
}

(chromeExecutablePath ? it : it.skip)('a move the worker refuses says so in plain words, with the words it was refused in under Details (R1, G17)', async () => {
  await openFixture('conversations=2', DESKTOP);
  try {
    await openDrawer();
    await waitFor(`window.buttonNamed('Move to…')`, 'Move to…');
    await page!.evaluate(`(() => { window.focusAnswer = 'fail'; window.buttonNamed('Move to…').click(); })()`);
    await waitFor(`document.querySelector('[data-slot="command-input"]')`, 'the search field');
    await page!.send('Input.insertText', { text: 'team' });
    await waitFor(`[...document.querySelectorAll('[data-slot="command-item"]')].map((item) => item.textContent).join('|') === 'Team workspaces'`, 'the list narrowed to one area');
    await page!.evaluate(`document.querySelector('[data-slot="command-item"]').click()`);
    await waitFor(`window.focusSaves.length === 1 && [...window.sheet().querySelectorAll('[role="alert"]')].length > 0`, 'the refused move', 5_000,
      `[...window.sheet().querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)`);
    // The drawer's own change row names the move it did not save, in the saved note's words (Phase 6 fix Q-M1).
    const refused = `window.alertSaying('Not saved: Moved “Fix the admin model price page” to Team workspaces.')`;
    await waitFor(refused, 'the refused move in plain words', 5_000, `[...window.sheet().querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)`);
    expect(await page!.evaluate(`window.sheet().textContent.includes('FOCUS_REFUSED')`)).toBe(false);
    expect(await page!.evaluate(`window.openDetails(${refused})`)).toBe(true);
    await waitFor(`${refused}.textContent.includes('FOCUS_REFUSED: The focus change was not saved: the worker answered 409 Conflict.')`, 'the refusal’s words under Details');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
// About 3s here (2026-11-17); 60s for a slow CI runner.
}, 60_000);

for (const titles of ['missing', 'legacy'] as const) {
  (chromeExecutablePath ? it : it.skip)(`in another language no conversation is named in English, on screen or for a screen reader, when the worker sends ${titles === 'missing' ? 'no title (16.0.0)' : 'the English title workers before 16.0.0 wrote (G19)'} (R2)`, async () => {
    await openFixture(`conversations=2&titles=${titles}&lang=zh-CN`, DESKTOP);
    try {
      await openDrawer();
      await waitFor(`window.box()`, 'the reply box');
      await page!.evaluate(`window.foldRow(window.t('Where this came from')).click()`);
      await waitFor(`window.rows().length === 2 && window.rows().every((row) => [...row.querySelectorAll('button')].some((button) => button.textContent.trim() === window.t('Reply here')))`, 'both rows read');
      await page!.settle();
      // What shows, and every name a control or the box carries, in the drawer; then what Chrome gives a screen reader.
      const inTheDrawer = await page!.evaluate(`(() => {
        const sheet = window.sheet();
        const names = [...sheet.querySelectorAll('[aria-label], [title], [placeholder]')].flatMap((element) =>
          ['aria-label', 'title', 'placeholder'].map((name) => element.getAttribute(name)).filter(Boolean));
        return { shown: sheet.innerText, names, rows: window.rows().map((row) => row.querySelector('p').innerText.replace(/\\s+/g, ' ').trim()),
          picker: window.replyCard().querySelector('[data-slot="select-trigger"]').innerText.replace(/\\s+/g, ' ').trim() };
      })()`);
      const { nodes } = await page!.send('Accessibility.getFullAXTree', {}) as { nodes: { name?: { value?: string } }[] };
      const heard = nodes.map((node) => node.name?.value ?? '').filter(Boolean);
      // Read while no modal list is open: an open list hides the rest of the page from a screen reader.
      const box = await accessibleName('window.box()');
      const send = await accessibleName('window.send()');
      // The picker's list, open.
      await page!.evaluate(`window.replyCard().querySelector('[data-slot="select-trigger"]').focus()`);
      await pressKey('Enter', 'Enter', 13);
      await waitFor(`document.querySelectorAll('[data-slot="select-item"]').length === 2`, 'the picker’s two items');
      const items: string[] = await page!.evaluate(`[...document.querySelectorAll('[data-slot="select-item"]')].map((item) => item.innerText.replace(/\\s+/g, ' ').trim())`);
      console.log(`[request-drawer] conversation names in Chinese (${titles}): ${JSON.stringify({ rows: inTheDrawer.rows, picker: inTheDrawer.picker, items, box, send })}`);
      const english = /conversation/i;
      expect(inTheDrawer.shown).not.toMatch(english);
      expect(inTheDrawer.names.filter((name: string) => english.test(name))).toEqual([]);
      expect(heard.filter((name) => english.test(name))).toEqual([]);
      expect(items.filter((item) => english.test(item))).toEqual([]);
      // Each is named as its row is, in Chinese: the tool's words for a conversation with no recorded title, then its id chip.
      const named = (index: number) => `Claude Code 对话 0000000${index}`;
      expect(inTheDrawer.rows).toEqual([named(0), named(1)]);
      expect(items).toEqual([named(0), named(1)]);
      expect(inTheDrawer.picker).toBe(named(0));
      expect({ box, send }).toEqual({ box: `您的回复：${named(0)}`, send: `发送到 ${named(0)}` });
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-17); 60s for a slow CI runner.
  }, 60_000);
}

// The drawer panel scrolls, so where a browser draws a classic 15px scrollbar (Chrome on Linux CI and on Windows) its
// rows are 15px narrower: the reply row had 509px there, not 524 (PR #6210's CI). Each run has one or none (SCROLLBAR_MODES).

for (const [count, picker] of [[10, 'Select'], [37, 'searchable list']] as const) {
  for (const scrollbar of SCROLLBAR_MODES) {
  (chromeExecutablePath ? it : it.skip)(`at 1440 with ${scrollbar.label} the ${picker} keeps "Reply to", a long name cut at its width cap and "${count} of ${count}" on one line in every language, the whole name reachable (R4)`, async () => {
    // The long name on the last conversation, so the count beside it is the widest it gets ("37 of 37").
    await openFixture(`conversations=${count}&titles=long&long-at=${count - 1}${scrollbar.query}`, DESKTOP);
    try {
      await openDrawer();
      await waitFor(`window.box()`, 'the reply box');
      const trigger = count === 10 ? `window.replyCard().querySelector('[data-slot="select-trigger"]')` : `window.replyCard().querySelector('button[aria-haspopup="dialog"]')`;
      await page!.evaluate(`${trigger}.focus()`);
      if (count === 10) await pressKey('Enter', 'Enter', 13);
      else await page!.evaluate(`${trigger}.click()`);
      const items = count === 10 ? `[...document.querySelectorAll('[data-slot="select-item"]')]` : `[...document.querySelectorAll('[data-slot="command-item"]')]`;
      await waitFor(`${items}.some((item) => item.textContent.includes(${JSON.stringify(LONG_TITLE)}))`, 'the long name in the list');
      await page!.evaluate(`${items}.find((item) => item.textContent.includes(${JSON.stringify(LONG_TITLE)})).click()`);
      await waitFor(`!document.querySelector('[data-slot="popover-content"], [data-slot="select-content"]') && ${trigger}.textContent.includes(${JSON.stringify(LONG_TITLE.slice(0, 20))})`, 'the long name chosen');
      const rows: Record<string, unknown> = {};
      for (const language of ['en', 'zh-CN', 'ko', 'tr', 'fr']) {
        await page!.evaluate(`window.setLocale(${JSON.stringify(language)})`);
        await page!.settle();
        rows[language] = await page!.evaluate(`(() => {
          const trigger = ${trigger}; const row = trigger.parentElement; const label = row.querySelector('label'); const position = row.lastElementChild;
          const box = (element) => element.getBoundingClientRect(); const middle = (element) => box(element).top + box(element).height / 2;
          // Cut: some line in the trigger holds more than it shows (the Select's name line, or the searchable trigger's).
          const cut = [...trigger.querySelectorAll('.truncate')].some((line) => line.scrollWidth > line.clientWidth);
          const gap = parseFloat(getComputedStyle(row).columnGap);
          return { label: label.textContent, position: position.textContent, rowWidth: Math.round(box(row).width * 100) / 100, triggerWidth: Math.round(box(trigger).width * 100) / 100,
            // The cap, as the stylesheet sets it (its one definition is the trigger's class).
            cap: parseFloat(getComputedStyle(trigger).maxWidth),
            // Room left on the line once the label, the trigger at its cap, the count and the two gaps between them are in it.
            roomLeft: Math.round((box(row).width - box(label).width - box(trigger).width - box(position).width - 2 * gap) * 100) / 100,
            oneLine: Math.abs(middle(label) - middle(trigger)) < 4 && Math.abs(middle(position) - middle(trigger)) < 4,
            // Nothing runs past the row's end: one line by giving way, never by sticking out.
            insideTheRow: box(position).right <= box(row).right + 0.5,
            cut, title: trigger.title };
        })()`);
      }
      console.log(`[request-drawer] ${picker} row at 1440 with ${scrollbar.label}: ${JSON.stringify(rows)}`);
      for (const [language, row] of Object.entries(rows) as [string, { position: string; triggerWidth: number; cap: number; oneLine: boolean; insideTheRow: boolean; cut: boolean; title: string }][]) {
        expect({ language, oneLine: row.oneLine, insideTheRow: row.insideTheRow, atMostTheCap: row.triggerWidth <= row.cap + 0.5, cut: row.cut, wholeInTitle: row.title.includes(LONG_TITLE) })
          .toEqual({ language, oneLine: true, insideTheRow: true, atMostTheCap: true, cut: true, wholeInTitle: true });
        expect(row.position).toContain(String(count));
      }
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  // About 3s here (2026-11-17); 60s for a slow CI runner.
  }, 60_000);
  }
}

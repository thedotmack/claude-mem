import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, myWorkFontResponse, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { REFRESH_LINE_STATES, type RefreshLineState } from '../../../src/ui/my-work/src/live/refresh-line';
import { TICKER_STEP_MS } from '../../../src/ui/my-work/src/live/change-ticker';

failOnCiWithoutChrome('CI requires Chrome for the My Work home page regressions.');

/**
 * Phase 3 of the pro-max-v16 plan, on the real components with the app's compiled stylesheet:
 * - the refresh line's four states (c-bits-refresh-controls): what each says, that a failure is one alert in plain
 *   words with its raw cause folded under Details, that the worker's own sentences show as they are, that Try again
 *   comes with no prop wherever this page can start a refresh, and that every press shows its outcome (a fake source,
 *   never a worker); Details is 44px on a touch phone;
 * - the change ticker (c-live-motion-change-ticker): its pause by button, hover and keyboard focus; its line is the
 *   Button primitive, 44px on touch; while the feed connects it says so, and Reconnect shows only where it can help;
 * - the home page (page-01) on the sample: what needs you comes first, with exactly one solid orange button on the
 *   first screen (G1), Shipped is one folded line until opened (G4), and the build story's recap tells times in the
 *   page's one clock; a suggested area's page also has one orange button;
 * - Reply (G2) on a request whose conversation cannot be continued lands on the drawer's line saying so.
 */

const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
let styles = '';
let bundle = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
const fixtureErrors: string[] = [];
let markReady: () => void = () => {};

/** The refresh record behind each of the line's states (RefreshLineState is the one list; the fixture draws one each). */
const CAUSE = 'Claude Code: reviews: g_8f5a02b65d34: database is locked';
const NO_AGENT = 'No logged-in Claude Code, Codex or Gemini on this computer yet.';
const REFRESH_CASES: Record<RefreshLineState, object> = {
  'up-to-date': { state: 'ok', finishedAt: 'Nov 16 at 12:19 pm', finishedAtIso: '2026-11-16T20:19:00.000Z', error: null },
  updating: { state: 'running', finishedAt: null, error: null },
  failed: { state: 'failed', finishedAt: 'Nov 16 at 12:19 pm', finishedAtIso: '2026-11-16T20:19:00.000Z', error: CAUSE },
  'waiting-for-agent': { state: 'waiting-for-agent', finishedAt: null, error: NO_AGENT },
};

beforeAll(async () => {
  if (!chromeExecutablePath) return;
  // Compile the application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  styles = css.build(scanner.scan());
  // The page imports its focus artwork (.webp) and the focus board's stylesheet; neither is measured here.
  bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { MotionConfig } from './src/ui/my-work/node_modules/motion/react';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { RefreshStatus } from './src/ui/my-work/src/components/bits';
    import { ChangeTicker } from './src/ui/my-work/src/components/live-motion';
    import { RequestDetail } from './src/ui/my-work/src/components/request-detail';
    import { MyWork } from './src/ui/my-work/src/pages/my-work';
    import { FocusOverview } from './src/ui/my-work/src/components/focus-overview';
    import { RefreshNotStartedError, SAMPLE_REQUESTS } from './src/ui/my-work/src/data';
    import { getConnectionStatus } from './src/ui/my-work/src/live/connection-status';
    import { REFRESH_LINE_STATES } from './src/ui/my-work/src/live/refresh-line';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    window.React = React;
    const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
    const view = new URLSearchParams(location.search).get('view');
    // The sample, with its refresh counted instead of run, and answered as the test says (window.nextAnswer): Try again
    // starts one refresh and nothing else. A page this computer's worker serves ('local') is the one that can start
    // one; the views that need it say so.
    const local = view === 'refresh-default' || view === 'ticker-connection' || view === 'reply';
    const source = Object.create(sampleSource, local ? { sourceKind: { value: 'local' } } : {});
    window.refreshStarts = 0;
    window.nextAnswer = { state: 'running' };
    source.refreshWork = () => {
      window.refreshStarts++;
      const answer = window.nextAnswer;
      return answer.refuse ? Promise.reject(new RefreshNotStartedError(answer.status, answer.refuse)) : Promise.resolve(answer);
    };
    if (view === 'reply') {
      // A page that can continue conversations (live/conversation-continuation.ts canContinueConversations); none of
      // these is reached for a conversation that cannot be continued.
      source.loadConversationContinuation = () => new Promise(() => {});
      source.continueConversation = () => Promise.reject(new Error('not in this fixture'));
      source.stopConversationContinuation = () => Promise.reject(new Error('not in this fixture'));
      source.subscribeToConversationContinuations = () => () => {};
    }
    useStore.getState().startWorkSource(source);
    const ignore = () => {};
    const run = { label: 'request-progress', lastRunAt: 'Nov 16 at 1:32 am', deviceName: 'this computer' };
    const cases = ${JSON.stringify(REFRESH_CASES)};
    const root = createRoot(document.getElementById('root'));
    const Providers = ({ children }) => <MotionConfig reducedMotion="user"><TooltipProvider delayDuration={150}>{children}</TooltipProvider></MotionConfig>;
    if (view === 'refresh') {
      root.render(<Providers><main style={{ padding: 16, display: 'grid', gap: 24, maxWidth: 900 }}>
        {REFRESH_LINE_STATES.map((name) => <section key={name} data-case={name}><RefreshStatus refresh={cases[name]} run={run} label="Last reviewed" ids={['R14.12']} canStartRefresh /></section>)}
      </main></Providers>);
    } else if (view === 'refresh-default') {
      // No button prop, as My Rules and Past focus mount it; the record changes when the test says (window.setRefresh).
      function DefaultLine() {
        const [refresh, setRefresh] = React.useState(cases.failed);
        window.setRefresh = setRefresh;
        return <RefreshStatus refresh={refresh} run={run} label="Last reviewed" ids={['R14.12']} />;
      }
      const raw = { state: 'waiting-for-agent', finishedAt: null, error: 'None of the allowed agents (Codex) is logged in on this computer.' };
      root.render(<Providers><main style={{ padding: 16, display: 'grid', gap: 24, maxWidth: 900 }}>
        <section data-case="default"><DefaultLine /></section>
        <section data-case="waiting-other"><RefreshStatus refresh={raw} run={run} label="Last reviewed" ids={['R14.12']} /></section>
      </main></Providers>);
    } else if (view === 'ticker' || view === 'ticker-connection') {
      root.render(<Providers><main style={{ padding: 16, maxWidth: 1100 }}><ChangeTicker onOpen={ignore} /></main></Providers>);
      if (view === 'ticker') {
        // Three changes the screen saw, newest first, so the ticker has something to cycle through.
        const now = Date.now();
        useStore.setState((state) => { state.work.recentChanges = [
          { kind: 'state', requestId: 'r5', title: 'Fix the admin model price page', from: 'working', to: 'your-move', at: now },
          { kind: 'progress', requestId: 'r1', title: 'Spec and wireframe the new work viewer', from: 55, to: 70, at: now - 60000 },
          { kind: 'new', requestId: 'r2', title: 'Show real usage on the price forecast page', at: now - 120000 },
        ]; });
      }
      window.setChanges = (count) => { const now = Date.now(); useStore.setState((state) => { state.work.recentChanges = Array.from({ length: count }, (_, index) => (
        { kind: 'new', requestId: ['r1', 'r2', 'r3', 'r4', 'r5'][index % 5] + (index < 5 ? '' : '-' + index), title: 'Change ' + (index + 1), at: now - index * 60000 })); }); };
      // Live models one after another, each with one more request, through the store as the feed delivers them: every
      // one is a change the screen saw (live/update-queue.ts), merged the way the store merges them.
      window.mergeNewRequests = (count) => {
        useStore.setState((state) => { state.work.recentChanges = []; });
        for (let index = 1; index <= count; index++) {
          const model = useStore.getState().work.load.model;
          useStore.getState().receiveWorkModel({ ...model, requests: [...model.requests, { ...SAMPLE_REQUESTS[0], id: 'merged-' + index, title: 'Merged request ' + index, contentFingerprint: 'merged-' + index }] });
        }
      };
      // The feed's evidence, as live/local-source.ts gathers it (times on the page's own clock), on a model this
      // computer's worker serves (the sample's model is always live).
      window.setConnection = (evidence) => useStore.setState((state) => {
        if (state.work.load.state === 'loaded') state.work.load.model.sourceKind = 'local';
        state.work.connection = getConnectionStatus({ now: performance.now(), ...evidence });
      });
    } else if (view === 'board') {
      // Twelve kept areas: past the board's search threshold (eight) and its first four.
      const areas = Array.from({ length: 12 }, (_, index) => ({ id: 'fa-' + index, name: (index % 2 ? 'Viewer ' : 'Docs ') + index, goal: null,
        status: 'kept', ownerRank: index + 1, priorityRank: null, source: 'owner', mergedInto: null, evidence: null, timesAsked: null, latestAt: null, quotes: [], asks: [] }));
      function Board() {
        const [expandAllOn, setExpandAllOn] = React.useState(0);
        window.showAllAreas = () => setExpandAllOn((value) => value + 1);
        return <FocusOverview areas={areas} requests={[]} onOpenArea={ignore} artwork={new URLSearchParams(location.search).get('artwork') ?? 'compact'} onArtworkChange={ignore} expandAllOn={expandAllOn} />;
      }
      root.render(<Providers><main style={{ padding: 16, maxWidth: 1200 }}><Board /></main></Providers>);
    } else if (view === 'suggested') {
      // A suggested area (its header holds Keep) with a request that needs you filed under it, once the sample is read.
      (function fileUnderSuggestedArea() {
        if (useStore.getState().work.load.state !== 'loaded') return requestAnimationFrame(fileUnderSuggestedArea);
        useStore.setState((state) => { state.work.load.model.requests.find((request) => request.id === 'r3').focusAreaId = 'fa-team'; });
      })();
      root.render(<Providers><main style={{ padding: 16 }}><MyWork focusAreaId="fa-team" onOpen={ignore} onOpenFocus={ignore} onOpenRules={ignore} /></main></Providers>);
    } else if (view === 'reply') {
      // Reply on a request whose one conversation is Gemini's, which cannot be continued from here, or on one with none.
      const conversations = new URLSearchParams(location.search).get('conversations') === 'none' ? []
        : [{ tool: 'Gemini', at: 'Oct 20, 12:40 pm', title: 'Forecast choices', platform: 'gemini', conversationSessionId: '0f6c9c38-6a63-4f5e-9d39-2f2b0b6c1a11' }];
      const request = { ...SAMPLE_REQUESTS.find((entry) => entry.id === 'r5'), conversations };
      // Reply's open drawer (store openRequestDrawer with reply), set without writing the address, so the DevTools
      // target keeps the URL the test looks it up by.
      useStore.setState((state) => { state.view.openRequest = { id: request.id, fromLiveFeed: null, fallback: request, replyAsked: true }; });
      root.render(<Providers><RequestDetail request={request} onClose={ignore} onOpenFocus={ignore} /></Providers>);
    } else {
      root.render(<Providers><main style={{ padding: 16 }}><MyWork focusAreaId={null} onOpen={ignore} onOpenFocus={ignore} onOpenRules={ignore} /></main></Providers>);
    }
    (function waitForPage() {
      const drawn = view === 'refresh' ? document.querySelectorAll('[data-refresh-line]').length === REFRESH_LINE_STATES.length
        : view === 'refresh-default' ? document.querySelectorAll('[data-refresh-line]').length === 2
          : view === 'ticker' ? document.querySelector('[data-ticker="changes"]')
            : view === 'ticker-connection' ? document.querySelector('[data-ticker]')
              : view === 'board' ? document.querySelector('.focus-area-card')
                : view === 'suggested' ? document.querySelector('[data-slot="button"]') && document.querySelector('h2')
                  : view === 'reply' ? document.querySelector('[role="dialog"]')
                    : document.querySelector('[data-line-section]');
      if (drawn) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForPage);
    })();
    window.lineOf = (name) => document.querySelector('[data-case="' + name + '"]');
    window.visibleText = (element) => element.innerText;
    window.tickerTitle = () => document.querySelector('[data-ticker] button .truncate')?.textContent ?? null;
    // The build story with dated chapters as request-progress writes their headings (24-hour times), for the recap.
    // The headings' days and times are UTC, as request-progress writes them; writtenAtIso dates them (Nov 17, 02:12 UTC).
    window.useDatedStory = () => useStore.setState((state) => { const load = state.work.load; if (load.state === 'loaded') load.model.buildStory = {
      recap: 'Opening paragraph.', paragraphs: ['Opening paragraph.'], writtenAt: '3:10 pm', writtenAtIso: '2026-11-17T02:12:00.000Z',
      chapters: [{ heading: null, paragraphs: ['Opening paragraph.'] }, { heading: 'Nov 13-14: first entry', paragraphs: ['a.'] },
        { heading: 'Nov 15 22:05: second entry', paragraphs: ['b.'] }, { heading: 'Nov 16 01:56: third entry', paragraphs: ['c.'] },
        { heading: 'Nov 16 13:20: fourth entry', paragraphs: ['d.'] }],
    }; });
    // A story as long as the owner's (24 dated entries on Nov 16), so the newest entry sits at the rail's lower end.
    window.useLongStory = (entries) => useStore.setState((state) => { const load = state.work.load; if (load.state === 'loaded') load.model.buildStory = {
      recap: 'Opening paragraph.', paragraphs: ['Opening paragraph.'], writtenAt: '3:10 pm',
      chapters: [{ heading: null, paragraphs: ['Opening paragraph, long enough to wrap past three lines in the sheet so its Read all fold has something to fold. '.repeat(4)] },
        ...Array.from({ length: entries }, (_, index) => ({ heading: 'Nov ' + (index + 1) + ': entry ' + (index + 1), paragraphs: ['What happened that day, in a sentence or two.'] }))],
    }; });
    // A new request on the board, recording the arriving card's inline style the moment it is added (rule 8 check).
    window.addRequestAndWatch = () => new Promise((resolve) => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) for (const node of mutation.addedNodes) {
          // The board's card (it holds the card itself), not the home page's one-line "Moving now" row.
          if (node.nodeType === 1 && node.textContent.includes('A request that just arrived') && node.querySelector('[data-slot="card"]')) { observer.disconnect(); resolve({ opacity: node.style.opacity, transform: node.style.transform }); return; }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      useStore.setState((state) => { const load = state.work.load; if (load.state === 'loaded') load.model.requests.push({ ...SAMPLE_REQUESTS[0], id: 'r-new', title: 'A request that just arrived' }); });
    });
    window.orangeOnFirstScreen = () => [...document.querySelectorAll('[data-slot="button"][data-variant="default"]')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.width > 0 && rect.height > 0;
    }).map((button) => button.textContent);
  `, ['--loader:.webp=empty', '--loader:.css=empty']);
  // The stylesheet's @font-face rules ask for ./files/<name>.woff2 (Geist and Geist Mono); widths depend on the font,
  // so the real files are served (myWorkFontResponse).
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    const font = myWorkFontResponse(path);
    if (font) return font;
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (path === '/fixture-error') { fixtureErrors.push(await request.text()); return new Response('noted'); }
    return new Response('not found', { status: 404 });
  } });
});

afterAll(() => { server?.stop(true); });

/** A touch phone (plan rule 6's coarse pointer): 390×844 with touch events, as app-shell.browser.test.ts emulates it. */
const PHONE = { width: 390, height: 844, touch: true };

async function openFixture(query: string, viewport: { width: number; height: number; touch?: boolean }) {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${server!.url.href}?${query}`;
  chrome = launchChrome(url, { profilePrefix: 'claude-mem-home-board-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The sample page draws in about 1s here (2026-11-16, like the toggle-width fixture's 0.78–0.85s); 20s is for a cold
  // Chrome on a shared CI runner.
  await withTimeout(ready, 20_000, `home board fixture (${query}) did not draw`);
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
 * Waits for `expression` to be true in the page. A click's result draws within a frame or two (17–33ms), so the default
 * 5s only covers a loaded CI runner; a wait on something slower passes its own deadline. Each check is one DevTools
 * round trip, every 50ms: about three frames, so a change is seen soon after it draws without a stream of evaluations.
 */
async function waitFor(expression: string, what: string, timeoutMs = 5_000, shown?: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page!.evaluate(`Boolean(${expression})`)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}${shown ? `; the page showed ${JSON.stringify(await page!.evaluate(shown))}` : ''}`);
}

/** What one refresh line shows, read in the page. */
const readLine = (name: string) => page!.evaluate(`(() => {
  const line = window.lineOf(${JSON.stringify(name)});
  const root = line.querySelector('[data-refresh-line]');
  const button = [...line.querySelectorAll('button')].find((element) => /Refresh now|Try again/.test(element.textContent));
  return {
    state: root?.getAttribute('data-refresh-line'),
    text: window.visibleText(line),
    alerts: [...line.querySelectorAll('[role="alert"]')].map((alert) => alert.innerText),
    button: button ? { text: button.textContent, ariaDisabled: button.getAttribute('aria-disabled') } : null,
    details: [...line.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].map((trigger) => ({ expanded: trigger.getAttribute('aria-expanded'), height: trigger.getBoundingClientRect().height })),
    spinning: [...line.querySelectorAll('svg')].filter((svg) => getComputedStyle(svg).animationName !== 'none').length,
  };
})()`);
const pressTryAgain = (name: string) => page!.evaluate(`[...window.lineOf(${JSON.stringify(name)}).querySelectorAll('button')].find((element) => element.textContent === 'Try again').click()`);

(chromeExecutablePath ? it : it.skip)('the refresh line says each of its four states, and a failure is one plain alert with Try again and folded Details', async () => {
  await openFixture('source=sample&view=refresh', { width: 1100, height: 900 });
  try {
    expect(await page!.evaluate('document.querySelectorAll("[data-refresh-line]").length')).toBe(REFRESH_LINE_STATES.length);
    const upToDate = await readLine('up-to-date');
    expect(upToDate.state).toBe('up-to-date');
    expect(upToDate.text).toContain('Last refreshed');
    expect(upToDate.alerts).toEqual([]);
    expect(upToDate.button).toEqual({ text: 'Refresh now', ariaDisabled: null });

    const updating = await readLine('updating');
    expect(updating.state).toBe('updating');
    expect(updating.text).toContain('Updating your goals and progress');
    // The worker runs it: the button waits and says why beside it; one spinner turns, not two (rule 8).
    expect(updating.button?.ariaDisabled).toBe('true');
    expect(updating.spinning).toBe(1);

    // The worker's own sentence for why it waits is the visible line (#5535), nothing folded.
    const waiting = await readLine('waiting-for-agent');
    expect(waiting.state).toBe('waiting-for-agent');
    expect(waiting.text).toContain(`Waiting to refresh: ${NO_AGENT}`);
    expect(waiting.alerts).toEqual([]);
    expect(waiting.details).toEqual([]);

    const failed = await readLine('failed');
    expect(failed.state).toBe('failed');
    // One alert: when it failed and how old the shown review is, in plain words; no internal id, no database message.
    expect(failed.alerts).toHaveLength(1);
    expect(failed.alerts[0]).toContain('Could not refresh at');
    expect(failed.alerts[0]).toContain('Last reviewed');
    expect(failed.text).not.toContain('g_8f5a02b65d34');
    expect(failed.text).not.toContain('database is locked');
    expect(failed.button?.text).toBe('Try again');
    expect(failed.details.map((detail: { expanded: string }) => detail.expanded)).toEqual(['false']);
    // Details opens on the raw cause, in monospace.
    await page!.evaluate(`window.lineOf('failed').querySelector('[data-slot="collapsible-fold-trigger"]').click()`);
    await waitFor(`window.visibleText(window.lineOf('failed')).includes('database is locked')`, 'the raw cause under Details');
    const cause = await page!.evaluate(`(() => { const shown = [...window.lineOf('failed').querySelectorAll('p')].find((element) => element.textContent.includes('database is locked')); return getComputedStyle(shown).fontFamily })()`);
    expect(cause).toMatch(/mono|Menlo|Courier/i);
    // Try again starts one refresh through the page's source (a counting fake here, never a worker).
    expect(await page!.evaluate('window.refreshStarts')).toBe(0);
    await pressTryAgain('failed');
    await waitFor('window.refreshStarts === 1', 'Try again to start a refresh');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // The whole test takes about 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('with no prop the refresh line still offers Try again, and every press shows its outcome', async () => {
  await openFixture('view=refresh-default', { width: 1100, height: 900 });
  try {
    // My Rules and Past focus mount it with no prop: this page can start a refresh, so the failure carries Try again.
    expect((await readLine('default')).button).toEqual({ text: 'Try again', ariaDisabled: null });
    // Nothing was due: the worker keeps its failed record, and the line says so instead of looking dead.
    await page!.evaluate(`window.nextAnswer = { state: 'idle' }`);
    await pressTryAgain('default');
    await waitFor(`window.visibleText(window.lineOf('default')).includes('Nothing new to refresh')`, 'the nothing-new outcome');
    expect((await readLine('default')).state).toBe('failed');
    // A run started: the line reads updating at once, before the worker's record says so.
    await page!.evaluate(`window.nextAnswer = { state: 'running' }`);
    await pressTryAgain('default');
    await waitFor(`window.lineOf('default').querySelector('[data-refresh-line="updating"]')`, 'the line to read updating');
    expect((await readLine('default')).text).toContain('Updating your goals and progress');
    // The worker's record catches up with a new failure: the line shows it, at its own time.
    await page!.evaluate(`window.setRefresh({ state: 'failed', finishedAt: 'Nov 16 at 2:36 pm', finishedAtIso: '2026-11-16T22:36:00.000Z', error: 'a newer cause' })`);
    await waitFor(`window.lineOf('default').querySelector('[data-refresh-line="failed"]')`, 'the newer failure');
    const newer = await readLine('default');
    expect(newer.alerts[0]).toContain(await page!.evaluate(`new Date('2026-11-16T22:36:00.000Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\\s?(AM|PM)$/, (_, half) => ' ' + half.toLowerCase())`));
    // A start the worker refused with a raw error: a plain line, the raw text folded under Details (G17).
    const raw = "EACCES: permission denied, open '/Users/someone/.claude-mem/work-view/refresh.json'";
    await page!.evaluate(`window.nextAnswer = { refuse: ${JSON.stringify(raw)}, status: 500 }`);
    await pressTryAgain('default');
    await waitFor(`window.lineOf('default').querySelectorAll('[role="alert"]').length === 2`, 'the refusal alert');
    const refused = await readLine('default');
    expect(refused.alerts[1]).toContain('Refresh could not start. The worker refused it.');
    expect(refused.text).not.toContain('EACCES');
    // A refusal sentence the route sends on purpose shows as it is.
    await page!.evaluate(`window.nextAnswer = { refuse: 'Refresh is unavailable until setup finishes.', status: 409 }`);
    await pressTryAgain('default');
    await waitFor(`window.visibleText(window.lineOf('default')).includes('Refresh could not start: Refresh is unavailable until setup finishes.')`, 'the known refusal');
    // A waiting reason that is not one of the worker's fixed sentences goes under Details below the plain line.
    const other = await readLine('waiting-other');
    expect(other.text).toContain('Waiting for an agent to run the refresh');
    expect(other.text).not.toContain('Codex');
    expect(other.details.map((detail: { expanded: string }) => detail.expanded)).toEqual(['false']);
    expect(await page!.evaluate('window.refreshStarts')).toBe(4);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('on a touch phone the Details row is 44px tall, as the fold row and the touch rule make it', async () => {
  await openFixture('view=refresh-default', PHONE);
  try {
    const heights = await page!.evaluate(`[...document.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].map((trigger) => trigger.getBoundingClientRect().height)`);
    // The failed line's Details and the waiting line's Details (a reason not shown as it is).
    expect(heights).toHaveLength(2);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the change ticker pauses with its button, and on hover and on keyboard focus', async () => {
  await openFixture('source=sample&view=ticker', { width: 1200, height: 600 });
  try {
    const paused = () => page!.evaluate(`document.querySelector('[data-ticker]').hasAttribute('data-paused')`);
    // It cycles: the newest change shows first, and within one step the next one replaces it. Two steps' time: a loaded
    // runner may draw the first step late.
    const first = await page!.evaluate('window.tickerTitle()');
    expect(first).toBe('Fix the admin model price page');
    await waitFor(`window.tickerTitle() && window.tickerTitle() !== ${JSON.stringify(first)}`, 'the ticker to move on', 2 * TICKER_STEP_MS);
    // The pause button stops it, says it is pressed, and the line stays where it is through a whole step.
    const pause = `[...document.querySelectorAll('[data-ticker] button')].find((element) => element.getAttribute('aria-label') === 'Pause the changes')`;
    expect(await page!.evaluate(`Boolean(${pause})`)).toBe(true);
    await page!.evaluate(`${pause}.click()`);
    await waitFor(`document.querySelector('[data-ticker] button[aria-pressed="true"]')`, 'the pause button to be pressed');
    expect(await page!.evaluate(`document.querySelector('[data-ticker] button[aria-pressed="true"]').getAttribute('aria-label')`)).toBe('Play the changes');
    const held = await page!.evaluate('window.tickerTitle()');
    // Longer than one step, so a running ticker would have moved.
    await Bun.sleep(TICKER_STEP_MS + 700);
    expect(await page!.evaluate('window.tickerTitle()')).toBe(held);
    expect(await paused()).toBe(true);
    // Played again, it is not paused; the pointer on it and keyboard focus in it each pause it.
    await page!.evaluate(`document.querySelector('[data-ticker] button[aria-pressed="true"]').click()`);
    await waitFor(`!document.querySelector('[data-ticker]').hasAttribute('data-paused')`, 'the ticker to play');
    const box = await page!.evaluate(`(() => { const rect = document.querySelector('[data-ticker]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`);
    await page!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await waitFor(`document.querySelector('[data-ticker]').hasAttribute('data-paused')`, 'hover to pause the ticker');
    await page!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 590 });
    await waitFor(`!document.querySelector('[data-ticker]').hasAttribute('data-paused')`, 'the ticker to play when the pointer leaves');
    await page!.evaluate(`document.querySelector('[data-ticker] button').focus()`);
    await waitFor(`document.querySelector('[data-ticker]').hasAttribute('data-paused')`, 'keyboard focus to pause the ticker');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 12s here, two steps included (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the ticker cycles the newest five changes and counts the older ones beside them', async () => {
  await openFixture('source=sample&view=ticker', { width: 1200, height: 600 });
  try {
    expect(await page!.evaluate(`document.querySelector('[data-ticker]').innerText`)).not.toMatch(/older change/);
    await page!.evaluate(`window.setChanges(7)`);
    await waitFor(`document.querySelector('[data-ticker]').innerText.includes('2 older changes')`, 'the count of older changes');
    // Five position dots, one per change it cycles (the mockup's five).
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-ticker] span')].filter((dot) => dot.classList.contains('size-1.5') && dot.classList.contains('rounded-full')).length`)).toBe(5);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('no change the screen saw is dropped: after 17 new requests in a row the ticker shows five and counts the other 12', async () => {
  await openFixture('source=sample&view=ticker', { width: 1200, height: 600 });
  try {
    // The 13th change used to fall off a cap of 12 without a word, and the ticker counted 7 older changes.
    await page!.evaluate('window.mergeNewRequests(17)');
    await waitFor(`document.querySelector('[data-ticker]').innerText.includes('12 older changes')`, 'every older change counted', 5_000, `document.querySelector('[data-ticker]').innerText`);
    // The newest shows first, once the one it replaces has slid out (0.4s, TICKER_SLIDE).
    await waitFor(`window.tickerTitle() === 'Merged request 17'`, 'the newest change first', 5_000, 'window.tickerTitle()');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('on a touch phone the ticker’s change is the Button primitive, 44px tall', async () => {
  await openFixture('source=sample&view=ticker', PHONE);
  try {
    const change = await page!.evaluate(`(() => { const button = document.querySelector('[data-ticker] [data-slot="button"] .truncate')?.closest('button'); return button ? { height: button.getBoundingClientRect().height, slot: button.getAttribute('data-slot') } : null })()`);
    expect(change?.slot).toBe('button');
    expect(change!.height).toBeGreaterThanOrEqual(44);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('while the feed connects the ticker says so; Reconnect shows only when the stream itself is down', async () => {
  await openFixture('view=ticker-connection', { width: 1200, height: 600 });
  try {
    const ticker = () => page!.evaluate(`({ state: document.querySelector('[data-ticker]').getAttribute('data-ticker'), text: document.querySelector('[data-ticker]').innerText, reconnect: [...document.querySelectorAll('[data-ticker] button')].some((button) => button.textContent === 'Reconnect') })`);
    await page!.evaluate('window.setConnection({})');
    await waitFor(`document.querySelector('[data-ticker="connecting"]')`, 'the connecting line');
    const connecting = await ticker();
    expect(connecting.text).toContain('Connecting');
    expect(connecting.text).not.toContain('Not live');
    expect(connecting.reconnect).toBe(false);
    // The stream dropped and is reconnecting: a reload can start it over now. (A message "just now": a page younger
    // than a second would make "a second ago" a negative time, which connection-status.ts reads as no message.)
    await page!.evaluate('window.setConnection({ reconnecting: true, lastEventAt: performance.now() })');
    await waitFor(`document.querySelector('[data-ticker="stream-down"]')`, 'the stream-down line');
    expect((await ticker()).reconnect).toBe(true);
    // Messages arrive, but the saved work cannot be read: not live, and a reload would change nothing.
    await page!.evaluate('window.setConnection({ transportConnected: true, lastEventAt: performance.now(), sourceConnected: false })');
    await waitFor(`document.querySelector('[data-ticker="source-behind"]')`, 'the source-behind line', 5_000, `document.querySelector('[data-ticker]').getAttribute('data-ticker')`);
    const behind = await ticker();
    expect(behind.text).toContain('Not live');
    expect(behind.reconnect).toBe(false);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('home leads with what needs you and has exactly one solid orange button on its first screen; Shipped is one folded line', async () => {
  await openFixture('source=sample', { width: 1440, height: 900 });
  try {
    const home = await page!.evaluate(`(() => {
      const needsYou = [...document.querySelectorAll('h2')].find((heading) => /Needs you/i.test(heading.textContent));
      const board = document.querySelector('section.focus-overview');
      const shipped = document.querySelector('[data-line-section="shipped"]');
      return {
        orange: window.orangeOnFirstScreen(),
        needsYouTop: needsYou?.getBoundingClientRect().top ?? null,
        needsYouBeforeBoard: !!(needsYou && board && (needsYou.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING)),
        shippedTrigger: shipped?.querySelector('[data-slot="collapsible-fold-trigger"]')?.getAttribute('aria-expanded') ?? null,
        shippedRows: shipped?.querySelectorAll('[data-request-line]').length ?? null,
        shippedCards: [...document.querySelectorAll('[data-state-badge="shipped"]')].filter((badge) => badge.closest('[data-slot="card"]')).length,
      };
    })()`);
    expect(home.orange).toHaveLength(1);
    // The sample cannot continue a conversation, so the first card's one button reads "Open request" (G2).
    expect(home.orange[0]).toContain('Open request');
    expect(home.needsYouTop).not.toBeNull();
    expect(home.needsYouTop!).toBeLessThan(900);
    expect(home.needsYouBeforeBoard).toBe(true);
    // Shipped folds to one line until opened (G4): no shipped request draws a card.
    expect(home.shippedTrigger).toBe('false');
    expect(home.shippedRows).toBe(0);
    expect(home.shippedCards).toBe(0);
    await page!.evaluate(`document.querySelector('[data-line-section="shipped"] [data-slot="collapsible-fold-trigger"]').click()`);
    await waitFor(`document.querySelector('[data-line-section="shipped"] [data-request-line]')`, 'the Shipped rows to open');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the build story’s headings read their UTC times in the reader’s own zone, in the page’s twelve-hour notation; a range of days stays as written', async () => {
  await openFixture('source=sample', { width: 1440, height: 900 });
  try {
    // A fixed zone, so the test reads the same on every machine (CI runs in UTC).
    await page!.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    await page!.evaluate('window.useDatedStory()');
    await waitFor(`[...document.querySelectorAll('h2')].some((heading) => heading.textContent === 'Build story')`, 'the recap');
    const recap: string = await page!.evaluate(`[...document.querySelectorAll('h2')].find((heading) => heading.textContent === 'Build story').closest('.space-y-4').innerText`);
    expect(recap).toContain('written 3:10 pm');
    // "Nov 16 13:20", "Nov 16 01:56" and "Nov 15 22:05" are UTC: 8 hours earlier in Los Angeles in November.
    expect(recap).toContain('Nov 16, 5:20 am');
    expect(recap).toContain('Nov 15, 5:56 pm');
    expect(recap).toContain('Nov 15, 2:05 pm');
    // Never the UTC wall times, in either notation.
    for (const utc of ['Nov 16, 1:20 pm', 'Nov 16, 1:56 am', 'Nov 15, 10:05 pm', '13:20', '01:56', '22:05']) expect(recap).not.toContain(utc);
    // Three dated lines, newest first; the fourth is counted, not dropped (plan rule 5).
    expect(recap).toContain('1 more dated entry in the build story');
    // Two numbers: "shipped within the story's period" cannot be derived, so it is left out.
    expect(recap).not.toMatch(/shipped/i);
    // The sheet's headings: the same converted time, and the range of days as written.
    await page!.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.startsWith('Read the build story')).click()`);
    await waitFor(`document.querySelector('[role="dialog"] ol li')`, 'the story sheet');
    const sheet: string = await page!.evaluate(`document.querySelector('[role="dialog"]').innerText`);
    expect(sheet).toContain('Nov 16, 5:20 am');
    expect(sheet).toContain('Nov 13-14');
    expect(sheet).not.toContain('13:20');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('a suggested area that has a request needing you still has one solid orange button: its Keep', async () => {
  await openFixture('source=sample&view=suggested', { width: 1440, height: 900 });
  try {
    await waitFor(`[...document.querySelectorAll('button')].some((button) => button.textContent.includes('Keep'))`, 'the suggested area header');
    await waitFor(`[...document.querySelectorAll('button')].some((button) => button.textContent.includes('Open request'))`, 'the request that needs you, in the summary');
    const orange: string[] = await page!.evaluate('window.orangeOnFirstScreen()');
    expect(orange).toHaveLength(1);
    expect(orange[0]).toContain('Keep');
    // The summary still offers the request, outlined.
    expect(await page!.evaluate(`[...document.querySelectorAll('[data-slot="button"][data-variant="outline"]')].some((button) => button.textContent.includes('Open request'))`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('Reply on a request whose conversation cannot be continued lands on the drawer’s line saying so (G2)', async () => {
  await openFixture('view=reply', { width: 1200, height: 900 });
  try {
    // The line itself, not the drawer around it (whose text holds the line too).
    await waitFor(`document.activeElement && document.activeElement.textContent.trim() === 'This conversation can’t be continued from here.'`, 'focus on the line saying the conversation cannot be continued', 5_000, `document.activeElement && document.activeElement.tagName + ': ' + document.activeElement.textContent.slice(0, 60)`);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // With no conversation recorded, Reply lands on the "Where this came from" row it opened.
  await openFixture('view=reply&conversations=none', { width: 1200, height: 900 });
  try {
    await waitFor(`document.activeElement && document.activeElement.textContent.startsWith('Where this came from')`, 'focus on the opened section');
    expect(await page!.evaluate(`document.activeElement.getAttribute('aria-expanded')`)).toBe('true');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('a search on the focus board says it filters, and "All N" ends it to show every area', async () => {
  await openFixture('source=sample&view=board', { width: 1200, height: 900 });
  try {
    const board = () => page!.evaluate(`({ cards: document.querySelectorAll('.focus-area-card').length, query: document.querySelector('.focus-area-search input').value, filtering: document.querySelector('.focus-area-filtering [role="status"]')?.textContent ?? null })`);
    // The board opens on its first four areas.
    expect(await board()).toEqual({ cards: 4, query: '', filtering: null });
    // Typing filters it, and the board says so with a way back.
    await page!.evaluate(`document.querySelector('.focus-area-search input').focus()`);
    await page!.send('Input.insertText', { text: 'Viewer' });
    await waitFor(`document.querySelector('.focus-area-filtering [role="status"]')`, 'the filtering line');
    const filtered = await board();
    expect(filtered.cards).toBe(6);
    expect(filtered.filtering).toBe('6 of 12 focus areas match “Viewer”');
    // "All N" (the rail's link to the whole board) shows every area: the search ends.
    await page!.evaluate('window.showAllAreas()');
    await waitFor(`document.querySelectorAll('.focus-area-card').length === 12`, 'every area to show');
    expect(await board()).toEqual({ cards: 12, query: '', filtering: null });
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the story sheet: Read all is the shared fold row, four learned rules with the rest counted, every rail mark on the rail', async () => {
  for (const theme of ['light', 'dark'] as const) {
    await openFixture('source=sample', { width: 1440, height: 900 });
    try {
      if (theme === 'dark') await page!.evaluate(`document.documentElement.classList.add('dark')`);
      await page!.evaluate('window.useLongStory(24)');
      await page!.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.startsWith('Read the build story')).click()`);
      await waitFor(`document.querySelector('[role="dialog"] ol li')`, 'the story sheet');
      const sheet = await page!.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const learned = [...dialog.querySelectorAll('section')].find((section) => /What it learned/.test(section.textContent));
        return {
          readAll: [...dialog.querySelectorAll('[data-slot="collapsible-fold-trigger"]')].some((trigger) => trigger.textContent.includes('Read all')),
          learnedNamed: learned.querySelectorAll('li').length,
          learnedMore: (learned.textContent.match(/(\\d+) more in My Rules/) ?? [null, null])[1],
        };
      })()`);
      expect(sheet.readAll).toBe(true);
      expect(sheet.learnedNamed).toBe(4);
      expect(Number(sheet.learnedMore)).toBeGreaterThan(0);
      // Every entry's mark is on the drawn rail (the rail's own path, hit-tested), the newest at its lower end included.
      await page!.evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); dialog.scrollTop = dialog.scrollHeight })()`);
      await page!.settle();
      const offRail = await page!.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const svg = dialog.querySelector('svg[viewBox^="0 0 20"]');
        const path = svg.querySelector('path');
        const box = svg.getBoundingClientRect();
        return [...dialog.querySelectorAll('ol > li > span[aria-hidden="true"]')].map((mark, index) => {
          const rect = mark.getBoundingClientRect();
          const x = rect.left + rect.width / 2 - box.left, y = rect.top + rect.height / 2 - box.top;
          const onRail = [-1, -0.5, 0, 0.5, 1].some((dx) => path.isPointInStroke(new DOMPoint(x + dx, y)));
          return onRail ? null : { index, x: Math.round(x * 10) / 10, y: Math.round(y) };
        }).filter(Boolean);
      })()`);
      expect(offRail).toEqual([]);
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  }
  // About 4s here, both themes (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('under reduced motion a card arrives on the board without its fade and slide, in the component itself (rule 8)', async () => {
  await openFixture('source=sample', { width: 1440, height: 900 });
  try {
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page!.settle();
    const arrived = await page!.evaluate('window.addRequestAndWatch()');
    // With motion, a card starts at opacity 0 and 8px down (MotionConfig's "user" setting still fades opacity).
    expect(arrived.opacity === '' || arrived.opacity === '1').toBe(true);
    expect(arrived.transform === '' || arrived.transform === 'none').toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('one-line rows are the small button’s height at desktop and 44px on a touch phone, by the primitive’s own rule', async () => {
  for (const viewport of [{ width: 1440, height: 900 }, PHONE]) {
    await openFixture('source=sample', viewport);
    try {
      await page!.evaluate(`document.querySelector('[data-line-section="shipped"] [data-slot="collapsible-fold-trigger"]').click()`);
      await waitFor(`document.querySelector('[data-line-section="shipped"] [data-request-line]')`, 'the Shipped rows to open');
      const height = await page!.evaluate(`document.querySelector('[data-line-section="shipped"] [data-request-line]').getBoundingClientRect().height`);
      if (viewport.touch) expect(height).toBeGreaterThanOrEqual(44);
      // h-9 at the 17px desktop root: 38.25px, the small button's size (it set 44px at every width itself).
      else expect(Math.round(height * 100) / 100).toBe(38.25);
      expect(fixtureErrors).toEqual([]);
    } finally { await closeFixture(); }
  }
  // About 2s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('a Full focus card folds its work under the shared fold row, “Work & evidence” (G5)', async () => {
  await openFixture('source=sample&view=board&artwork=full', { width: 1200, height: 900 });
  try {
    const fold = `[...document.querySelectorAll('.focus-area-card [data-slot="collapsible-fold-trigger"]')].find((trigger) => trigger.textContent.includes('Work & evidence'))`;
    expect(await page!.evaluate(`${fold}?.getAttribute('aria-expanded') ?? null`)).toBe('false');
    await page!.evaluate(`${fold}.click()`);
    await waitFor(`${fold}.getAttribute('aria-expanded') === 'true' && ${fold}.closest('.focus-area-card').querySelector('.focus-area-evidence')`, 'the area’s work to open in place');
    expect(fixtureErrors).toEqual([]);
  } finally { await closeFixture(); }
  // About 1s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

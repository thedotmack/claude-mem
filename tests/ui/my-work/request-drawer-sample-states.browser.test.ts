import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { LOCALES } from '../../../src/ui/i18n/locale';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, myWorkFontResponse, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { THEME_PRE_PAINT_SCRIPT } from '../../../src/ui/my-work/src/lib/theme-pre-paint';
import { REPLY_CARD_STATES } from '../../../src/ui/my-work/src/live/conversation-continuation';
import { SAMPLE_STATES } from '../../../src/ui/my-work/src/live/sample-source';

failOnCiWithoutChrome('CI requires Chrome for the request drawer sample states.');

/**
 * The drawer's states the owner's real data does not have, each seen from ?source=sample without writing anything (plan
 * rule 10: add sample cases where none exist; fix round V5), on the real App with the app's stylesheet and fonts:
 * - `&sample-state=reply-card`: the sample your-move request's reply card answers a running turn with Stop and the
 *   exchanges sent before it, a conversation that cannot be continued, a read that fails, and one ready for a reply
 *   (whose recorded folder is gone); a Send there is a demonstration that sends nothing;
 * - `&sample-state=check-save-waits`: Mark checked is on its way and stays "Saving…";
 * - `&sample-state=check-save-fails`: Mark checked is refused: "Not saved", the reason in plain words, the cause folded.
 * State values come from their one definitions (state-machines.md), never typed again here.
 */
const [, IDLE, , TURN_RUNNING, CANNOT_CONTINUE, READ_FAILURE] = REPLY_CARD_STATES;
const sampleState = (name: (typeof SAMPLE_STATES)[number]) => {
  const state = SAMPLE_STATES.find((entry) => entry === name);
  if (!state) throw new Error(`No sample state ${name} in SAMPLE_STATES`);
  return state;
};

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
    import { setLocale, t } from './src/ui/my-work/src/lib/i18n';
    window.React = React;
    // The page's language, as a test sets it, and its words for what a test looks for.
    window.setLocale = setLocale;
    window.t = t;
    const report = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => report(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason?.stack ?? event.reason));
    // The star count would come from GitHub; a test never calls out. Nothing else leaves the page: the sample source
    // answers every read and save in memory.
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).startsWith('https://api.github.com/')
      ? Promise.resolve(new Response(JSON.stringify({ stargazers_count: 1 }), { headers: { 'Content-Type': 'application/json' } }))
      : realFetch(input, init);
    window.store = useStore;
    createRoot(document.getElementById('root')).render(<App />);
    (function waitForPage() {
      if (document.querySelector('[data-slot="work-shell"] main section, [data-slot="work-shell"] main [data-slot="empty"]')) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForPage);
    })();
    window.sheet = () => document.querySelector('[data-slot="sheet-content"]');
    window.replyCard = () => window.sheet()?.querySelector('[data-slot="reply-card"]') ?? null;
    window.replyState = () => window.replyCard()?.querySelector('[data-reply-state]')?.dataset.replyState ?? null;
    window.rows = () => [...(window.sheet()?.querySelectorAll('[data-slot="conversation-row"]') ?? [])];
    window.foldRow = (words, within) => [...((within ?? window.sheet())?.querySelectorAll('[data-slot="collapsible-fold-trigger"]') ?? [])].find((row) => row.textContent.startsWith(words));
    window.saveButton = (words) => [...(window.sheet()?.querySelectorAll('button[data-save-state]') ?? [])].find((button) => button.textContent.trim().startsWith(words)) ?? null;
    window.alertSaying = (words, within) => [...((within ?? window.sheet())?.querySelectorAll('[role="alert"]') ?? [])].find((alert) => alert.textContent.includes(words)) ?? null;
    window.openDetails = (container) => { const details = window.foldRow('Details', container); if (details && details.getAttribute('aria-expanded') !== 'true') details.click(); return Boolean(details); };
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
// Compiling the App and its stylesheet took 4-8s here while other agents' tests ran (2026-11-16); 60s for a CI runner.
}, 60_000);

afterAll(async () => {
  await closePage();
  server?.stop(true);
});

async function openPage(query: string) {
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const url = `${fixtureUrl}${query}`;
  chrome = launchChrome(url, { profilePrefix: 'claude-mem-drawer-sample-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
  // The App with sample data drew its first page in 1.0–2.0s in app-shell.browser.test.ts (2026-11-16); 20s is for a
  // cold Chrome on a CI runner.
  await withTimeout(ready, 20_000, 'My Work fixture did not draw its page');
  page = await connectToPage(chrome, url);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.settle();
}

async function closePage() {
  page?.close();
  page = undefined;
  await chrome?.close();
  chrome = undefined;
}

/** Waits for `expression` to be true; a press's result draws in a frame or two, and 5s covers a loaded CI runner. */
async function waitFor(expression: string, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page!.evaluate(`Boolean(${expression})`)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}; the drawer showed ${JSON.stringify(await page!.evaluate(`window.sheet()?.textContent.slice(0, 400) ?? null`))}`);
}

async function pressKey(key: string, code = key, keyCode = 0) {
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

/** Points the reply card at the listed conversation whose name holds `words`, through its picker (a Select). */
async function chooseConversation(words: string) {
  await page!.evaluate(`window.replyCard().querySelector('[data-slot="select-trigger"]').focus()`);
  await pressKey('Enter', 'Enter', 13);
  await waitFor(`[...document.querySelectorAll('[data-slot="select-item"]')].some((item) => item.textContent.includes(${JSON.stringify(words)}))`, `the picker listing ${words}`);
  await page!.evaluate(`[...document.querySelectorAll('[data-slot="select-item"]')].find((item) => item.textContent.includes(${JSON.stringify(words)})).click()`);
  await waitFor(`window.replyCard().querySelector('[data-slot="select-trigger"]').textContent.includes(${JSON.stringify(words)})`, `the card answering ${words}`);
}

(chromeExecutablePath ? it : it.skip)('reply-card: a running turn with Stop and its exchanges, cannot continue, a read failure, and a conversation ready for a reply, without sending anything', async () => {
  await openPage(`&sample-state=${sampleState('reply-card')}&request=r5`);
  try {
    await waitFor(`window.replyCard() && window.replyState()`, 'the reply card in the sample your-move drawer');
    // The first conversation listed runs a turn: Stop on its running line, the earlier exchange counted and folded.
    expect(await page!.evaluate(`window.replyState()`)).toBe(TURN_RUNNING);
    expect(await page!.evaluate(`Boolean(window.replyCard().querySelector('button[aria-label^="Stop"]'))`)).toBe(true);
    expect(await page!.evaluate(`Boolean(window.foldRow('1 earlier exchange', window.replyCard()))`)).toBe(true);
    // Cannot continue: the worker's reason, and no box.
    await chooseConversation('Codex conversation');
    await waitFor(`window.replyState() === ${JSON.stringify(CANNOT_CONTINUE)}`, 'the conversation that cannot be continued');
    expect(await page!.evaluate(`window.replyCard().querySelector('textarea')`)).toBe(null);
    // A read that fails: plain words, the cause under Details, Try again.
    await chooseConversation('Forecast drafts');
    await waitFor(`window.replyState() === ${JSON.stringify(READ_FAILURE)}`, 'the read failure');
    const failure = `window.alertSaying('Could not read this conversation.', window.replyCard())`;
    expect(await page!.evaluate(`Boolean(${failure})`)).toBe(true);
    await page!.evaluate(`window.openDetails(${failure})`);
    await waitFor(`${failure}.textContent.includes('503')`, 'the read failure’s cause under Details');
    // Ready for a reply, in a folder that is gone: the box, and the line saying where the turn would run instead.
    await chooseConversation('Scaling estimates below');
    await waitFor(`window.replyState() === ${JSON.stringify(IDLE)}`, 'the conversation ready for a reply');
    expect(await page!.evaluate(`Boolean(window.replyCard().querySelector('textarea') && window.replyCard().querySelector('[data-folder-gone]'))`)).toBe(true);
    // A Send is a demonstration: nothing is sent, and the card says so.
    await page!.evaluate(`window.replyCard().querySelector('textarea').focus()`);
    await page!.send('Input.insertText', { text: 'Keep the usage table first' });
    await waitFor(`window.replyCard().querySelector('button[aria-keyshortcuts]').getAttribute('aria-disabled') === null`, 'Send ready once there are words');
    await page!.evaluate(`window.replyCard().querySelector('button[aria-keyshortcuts]').click()`);
    await waitFor(`window.alertSaying('Your reply was not sent.', window.replyCard())`, 'the sample Send saying nothing was sent');
    // "Where this came from" draws each conversation's row: the running one still, with its Stop.
    await page!.evaluate(`window.foldRow('Where this came from').click()`);
    await waitFor(`window.rows().length === 4 && window.rows()[0].querySelector('button[aria-label^="Stop"]')`, 'the four rows, the running one with Stop');
    expect(await page!.evaluate(`Boolean(window.rows()[0].querySelector('[data-state-mark="working"]'))`)).toBe(true);
    expect(fixtureErrors).toEqual([]);
  } finally { await closePage(); }
// About 4s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('check-save-waits: Mark checked stays "Saving…", busy, and keeps focus', async () => {
  await openPage(`&sample-state=${sampleState('check-save-waits')}&request=r3`);
  try {
    await waitFor(`window.saveButton('Mark checked')`, 'Mark checked in the sample done-not-checked drawer');
    await page!.evaluate(`(() => { const button = window.saveButton('Mark checked'); button.focus(); button.click(); })()`);
    await waitFor(`window.saveButton('Mark checked').dataset.saveState === 'saving'`, 'the save on its way');
    await page!.settle();
    expect(await page!.evaluate(`(() => { const button = window.saveButton('Mark checked');
      return { state: button.dataset.saveState, busy: button.getAttribute('aria-busy'), focused: document.activeElement === button }; })()`))
      .toEqual({ state: 'saving', busy: 'true', focused: true });
    expect(fixtureErrors).toEqual([]);
  } finally { await closePage(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('check-save-fails: Mark checked says "Not saved", the reason in plain words and the cause under Details', async () => {
  await openPage(`&sample-state=${sampleState('check-save-fails')}&request=r3`);
  try {
    await waitFor(`window.saveButton('Mark checked')`, 'Mark checked in the sample done-not-checked drawer');
    await page!.evaluate(`(() => { const button = window.saveButton('Mark checked'); button.focus(); button.click(); })()`);
    await waitFor(`window.saveButton('Mark checked').dataset.saveState === 'not-saved'`, 'the refused save');
    expect(await page!.evaluate(`[...window.sheet().querySelectorAll('[role="alert"]')].some((alert) => alert.textContent.trim() === 'Not saved')`)).toBe(true);
    const reason = `window.alertSaying('Your review decision was not saved.')`;
    expect(await page!.evaluate(`Boolean(${reason})`)).toBe(true);
    await page!.evaluate(`window.openDetails(${reason})`);
    await waitFor(`${reason}.textContent.includes('reported complete')`, 'the refusal under Details');
    // Nothing was written: the request is still done and not checked.
    expect(await page!.evaluate(`window.store.getState().work.load.model.requests.find((request) => request.id === 'r3').state`)).toBe('needs-check');
    expect(fixtureErrors).toEqual([]);
  } finally { await closePage(); }
// About 3s here (2026-11-16); 60s for a slow CI runner.
}, 60_000);

(chromeExecutablePath ? it : it.skip)('the sample’s check receipt has a full stop between its two sentences, at home and on the web, in every language', async () => {
  await openPage('&request=r3');
  try {
    await waitFor(`window.saveButton('Mark checked')`, 'Mark checked in the sample done-not-checked drawer');
    // Sample mode saves the check in the page; nothing leaves it.
    await page!.evaluate(`(() => { const button = window.saveButton('Mark checked'); button.focus(); button.click(); })()`);
    // The receipt: the line that ends with "Shipping is still your call." in the page's language.
    const receipt = `[...window.sheet().querySelectorAll('p')].find((line) => line.textContent.endsWith(window.t('Shipping is still your call.')))`;
    await waitFor(receipt, 'the check receipt');
    const read: Record<string, { receipt: string; second: string }> = {};
    for (const language of LOCALES) {
      // At home (the local worker) and on the web (cmem.ai): the wireframe strip's switch in sample mode.
      for (const mode of ['home', 'web'] as const) {
        await page!.evaluate(`(() => { window.setLocale(${JSON.stringify(language)}); window.store.getState().setWorkspace({ mode: ${JSON.stringify(mode)} }); })()`);
        await page!.settle();
        await waitFor(receipt, `the receipt in ${language}, ${mode}`);
        read[`${language} ${mode}`] = await page!.evaluate(`({ receipt: ${receipt}.textContent, second: window.t('Shipping is still your call.') })`);
      }
    }
    console.log(`[request-drawer-sample-states] check receipts: ${JSON.stringify(read)}`);

    expect(read['en home'].receipt).toBe('Saved on this machine (demonstration). Shipping is still your call.');
    expect(read['en web'].receipt).toMatch(/^Saved from the web · syncing to \d+ machines \(demonstration\)\. Shipping is still your call\.$/);
    // In every language the first sentence ends with its full stop before the second begins.
    for (const [where, { receipt: words, second }] of Object.entries(read)) {
      const first = words.slice(0, words.length - second.length).trimEnd();
      expect({ where, endsWithTheSecond: words.endsWith(second), firstEndsWithAStop: /[.。]$/.test(first), first })
        .toEqual({ where, endsWithTheSecond: true, firstEndsWithAStop: true, first });
    }
    expect(fixtureErrors).toEqual([]);
  } finally { await closePage(); }
// About 3s here (2026-11-17); 60s for a slow CI runner.
}, 60_000);

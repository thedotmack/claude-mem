import { expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, connectToPage, failOnCiWithoutChrome, htmlResponse,
  launchChrome, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { resolveTheme, THEME_CHOICES } from '../../../src/ui/my-work/src/lib/theme';
import { THEME_PRE_PAINT_MARK, THEME_PRE_PAINT_SCRIPT, withThemePrePaintScript } from '../../../src/ui/my-work/src/lib/theme-pre-paint';
import { OLDEST_MIGRATED_PREFERENCES_VERSION, PREFERENCES_STORAGE_KEY, PREFERENCES_VERSION } from '../../../src/ui/my-work/src/store/preferences';
import { createBoundStore } from '../../../src/ui/my-work/src/store/create-store';
import { themeChoiceInUse } from '../../../src/ui/my-work/src/store/slices/view-slice';

failOnCiWithoutChrome('CI requires Chrome for the My Work first-paint theme regression.');

/**
 * Decision G8: the theme is on <html> before the first paint, so a dark user never sees the loading or error screen
 * light (the review shot both light for a dark system: the class was set only after the first data load). This runs
 * the pre-paint script vite.config.ts writes into index.html (lib/theme-pre-paint.ts), with the app's real stylesheet
 * and no app code, and reads the class and the page colour in the first animation frame, which runs before the browser
 * paints anything. Each case's answer is also asked of the store itself with the same saved preferences and address, so
 * the first frame and the app agree: saved choices, `?theme=`, unreadable or unknown values, preferences saved by an
 * older version the store migrates (their theme is kept) or by one it cannot read (dropped), and setup, which stays light.
 */
const INDEX_HTML = resolve(REPOSITORY_ROOT, 'src/ui/my-work/index.html');
const BUILT_INDEX_HTML = resolve(REPOSITORY_ROOT, 'plugin/ui/work-view/index.html');
const INLINE_SCRIPT = `<script>${THEME_PRE_PAINT_SCRIPT}</script>`;

// index.css: --background in :root (light) and .dark.
const PAGE_COLOUR = { light: 'rgb(247, 241, 233)', dark: 'rgb(15, 12, 10)' } as const;

/** What the store shows for these saved preferences and this address: the theme the app keeps on <html> after load. */
function storeTheme(saved: string | null, query: string, systemDark: boolean): 'dark' | 'light' {
  const items = new Map(saved === null ? [] : [[PREFERENCES_STORAGE_KEY, saved]]);
  const href = `http://localhost/${query}`;
  const store = createBoundStore({
    href: () => href, writeUrl: () => {}, reportsUsage: false, sendUsage: () => {}, scrollToTop: () => {},
    storage: { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: (key) => { items.delete(key); } },
  });
  const { page } = store.getState().view;
  return page === 'setup' ? 'light' : resolveTheme(themeChoiceInUse(store.getState().view), systemDark);
}

(chromeExecutablePath ? it : it.skip)('the theme is on <html> in the first frame, as the store will draw it, for every case; setup stays light', async () => {
  // The page has one mark where the script goes, and the build writes the script there from its one definition.
  const source = readFileSync(INDEX_HTML, 'utf8');
  expect(source.split(THEME_PRE_PAINT_MARK).length).toBe(2);
  expect(/<script>/.test(source)).toBe(false);
  expect(withThemePrePaintScript(source)).toContain(INLINE_SCRIPT);
  expect(() => withThemePrePaintScript(source.replace(THEME_PRE_PAINT_MARK, ''))).toThrow(/pre-paint theme script/);
  // The shipped page carries the same script (plugin/ is the committed build the worker serves).
  if (existsSync(BUILT_INDEX_HTML)) expect(readFileSync(BUILT_INDEX_HTML, 'utf8')).toContain(INLINE_SCRIPT);
  // It reads the saved choice where and in the version the store saves it, and every choice comes from lib/theme.ts.
  expect(THEME_PRE_PAINT_SCRIPT).toContain(JSON.stringify(PREFERENCES_STORAGE_KEY));
  expect(THEME_PRE_PAINT_SCRIPT).toContain(JSON.stringify(THEME_CHOICES));

  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const styles = css.build(new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] }).scan());

  // Each case's saved preferences ride in a parameter neither the script nor the store reads (`saved`); this runs
  // before the page's own scripts: it saves them, then records the first frame with the case it belongs to.
  const setUpCase = `
    const params = new URLSearchParams(location.search);
    localStorage.clear();
    if (params.has('saved')) localStorage.setItem(${JSON.stringify(PREFERENCES_STORAGE_KEY)}, params.get('saved'));
    requestAnimationFrame(() => {
      window.firstFrame = { case: params.get('case'), dark: document.documentElement.classList.contains('dark'), colour: getComputedStyle(document.body).backgroundColor };
    });`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">${INLINE_SCRIPT}<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div></body></html>`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(page);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    return new Response('not found', { status: 404 });
  } });
  let chrome: OwnedChrome | undefined;
  let devtools: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-theme-first-paint-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
    devtools = await connectToPage(chrome, server.url.href);
    await devtools.send('Page.enable');
    await devtools.send('Page.addScriptToEvaluateOnNewDocument', { source: setUpCase });
    let caseNumber = 0;
    const firstFrame = async (query: string, saved: string | null, system: 'dark' | 'light') => {
      const thisCase = String(++caseNumber);
      await devtools!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: system }] });
      const params = new URLSearchParams(query);
      if (saved !== null) params.set('saved', saved);
      params.set('case', thisCase);
      await devtools!.send('Page.navigate', { url: `${server.url.href}?${params}` });
      // Waits for this case's own document: until it commits, the page still answers from the one before. A failed
      // read is that moment (the old document is going away) and is asked again on the next turn.
      // The static page is ready in a few milliseconds here; 10s is for a cold Chrome on a shared CI runner.
      return withTimeout((async () => {
        for (;;) {
          const frame = await devtools!.evaluate('window.firstFrame ?? null').catch(() => null);
          if (frame?.case === thisCase) return frame;
          // One poll every 5ms: a page here is ready in a few milliseconds, so a case costs a poll or two, and the 10s
          // limit above bounds the wait.
          await Bun.sleep(5);
        }
      })(), 10_000, `no first frame for ${query} saved=${saved} system=${system}`);
    };
    const preferences = (theme: unknown, version = PREFERENCES_VERSION) => JSON.stringify({ state: { listView: 'cards', theme }, version });
    const cases: { query: string; saved: string | null; system: 'dark' | 'light'; expected: 'dark' | 'light' }[] = [];
    for (const system of ['dark', 'light'] as const) {
      const other = system === 'dark' ? 'light' : 'dark';
      // Nothing saved, or saved preferences that cannot be read, or a theme this version does not know: follow the system.
      cases.push({ query: '', saved: null, system, expected: system }, { query: '', saved: '{not json', system, expected: system },
        { query: '', saved: preferences('sepia'), system, expected: system });
      // Preferences saved by a version the store cannot migrate are dropped, by the store and the script alike; the
      // versions it migrates keep their theme in both.
      for (const version of [OLDEST_MIGRATED_PREFERENCES_VERSION - 1, PREFERENCES_VERSION + 1]) cases.push({ query: '', saved: preferences(other, version), system, expected: system });
      for (let version = OLDEST_MIGRATED_PREFERENCES_VERSION; version < PREFERENCES_VERSION; version++) cases.push({ query: '', saved: preferences(other, version), system, expected: other });
      for (const choice of THEME_CHOICES) {
        cases.push({ query: '', saved: preferences(choice), system, expected: resolveTheme(choice, system === 'dark') });
        // ?theme= wins over the saved choice for this visit.
        const savedOther = THEME_CHOICES.find((candidate) => candidate !== choice)!;
        cases.push({ query: `?theme=${choice}`, saved: preferences(savedOther), system, expected: resolveTheme(choice, system === 'dark') });
      }
      // An unknown ?theme= leaves the saved choice.
      cases.push({ query: '?theme=sepia', saved: preferences(other), system, expected: other });
      // The install funnel is light only, whatever the address, the saved choice or the system says.
      cases.push({ query: '?setup=1&theme=dark', saved: preferences('dark'), system, expected: 'light' });
    }
    for (const { query, saved, system, expected } of cases) {
      const frame = await firstFrame(query, saved, system);
      const app = storeTheme(saved, query, system === 'dark');
      expect({ query, saved, system, firstFrame: frame.dark ? 'dark' : 'light', colour: frame.colour, app })
        .toEqual({ query, saved, system, firstFrame: expected, colour: PAGE_COLOUR[expected], app: expected });
    }
    expect(caseNumber).toBe(cases.length);
  } finally {
    devtools?.close();
    await chrome?.close();
    server.stop(true);
  }
  // The 26 page loads, Chrome start and the stylesheet compile take about 2.1s here (2026-11-16); 60s leaves room for a
  // slow CI runner.
}, 60_000);

import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the My Work toggle width regression.');

/**
 * D b22 M462: a chosen View or Filter item shows a check and heavier text, and keeps the width it has when it is not
 * chosen, so the row does not shift on every switch. Measured on the real My Work page (pages/my-work.tsx on the sample
 * source) with the app's real stylesheet and its Geist font, at 1440 and at 390: every item is chosen once, and after
 * each choice every item's width is read. The chosen item's check must show and the others' must not, so hiding the
 * check cannot pass.
 */
// The brief's limit: room for sub-pixel layout rounding only. The check and the heavier weight once added 19–23px.
const WIDTH_TOLERANCE_PX = 0.5;

type ItemSamples = { label: string; chosen: number[]; notChosen: number[]; checkWhenChosen: boolean[]; checkWhenNotChosen: boolean[] };

(chromeExecutablePath ? it : it.skip)('choosing a View or Filter item keeps every item the same width', async () => {
  // Compile the application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  const styles = css.build(scanner.scan());
  // The stylesheet's @font-face rules ask for ./files/<name>.woff2; widths depend on the font, so serve the real one.
  const fontFiles = resolve(app, 'node_modules/@fontsource-variable/geist/files');
  // The page imports its focus artwork (.webp) and the focus overview's stylesheet. Neither styles the toggles, and
  // the one-file fixture bundle has nowhere to put them, so both load empty.
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { MotionConfig } from './src/ui/my-work/node_modules/motion/react';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { MyWork } from './src/ui/my-work/src/pages/my-work';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    window.React = React;
    const reportFixtureError = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
    window.addEventListener('error', (event) => reportFixtureError(event.error?.stack ?? event.message));
    window.addEventListener('unhandledrejection', (event) => reportFixtureError(event.reason?.stack ?? event.reason));
    const ignore = () => {};
    useStore.getState().startWorkSource(sampleSource);
    // App.tsx mounts the page inside these two providers.
    createRoot(document.getElementById('root')).render(
      <MotionConfig reducedMotion="user"><TooltipProvider delayDuration={150}><main style={{ padding: 16 }}>
        <MyWork focusAreaId={null} onOpen={ignore} onOpenFocus={ignore} onOpenRules={ignore} />
      </main></TooltipProvider></MotionConfig>);
    const group = (name) => document.querySelector('[data-slot="toggle-group"][aria-label="' + name + '"]');
    const items = (name) => [...(group(name)?.querySelectorAll('[data-slot="toggle-group-item"]') ?? [])];
    // Tell the runner once the sample work has loaded, both groups are drawn and the fonts they use have loaded.
    (function waitForGroups() {
      if (items('View').length > 0 && items('Filter').length > 0) document.fonts.ready.then(() => fetch('/fixture-ready'));
      else requestAnimationFrame(waitForGroups);
    })();
    window.geistLoaded = () => [...document.fonts].some((face) => face.family.replace(/["']/g, '') === 'Geist Variable' && face.status === 'loaded');
    const settle = async (name) => {
      // React commits a choice before the next frame; two frames, so the new look is styled and laid out.
      for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
      // Items ease their colours (transition-all), so read them once those transitions end; a replaced one rejects.
      await Promise.all(group(name).getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => {})));
    };
    // The smallest check is size-3.5, 14px at the 16px phone root; under 12px it would be squashed or clipped.
    const checkShown = (item) => {
      const check = item.querySelector('[data-slot="toggle-check"]');
      if (!check) return false;
      const look = getComputedStyle(check), box = check.getBoundingClientRect();
      return look.display !== 'none' && look.visibility === 'visible' && box.width >= 12 && box.height >= 12;
    };
    // Chooses each item of a group in turn and, after each choice, reads every item's width and whether its check shows.
    window.chooseEach = async (name) => {
      const labels = items(name).map((item) => item.textContent);
      const samples = labels.map((label) => ({ label, chosen: [], notChosen: [], checkWhenChosen: [], checkWhenNotChosen: [] }));
      for (let index = 0; index < labels.length; index++) {
        items(name)[index].click();
        await settle(name);
        const now = items(name);
        // The same items in the same order, or the widths below would belong to different items.
        if (now.map((item) => item.textContent).join('|') !== labels.join('|')) throw new Error(name + ' items changed on a switch: ' + now.map((item) => item.textContent).join('|'));
        now.forEach((item, position) => {
          const chosen = item.getAttribute('data-state') === 'on';
          samples[position][chosen ? 'chosen' : 'notChosen'].push(Math.round(item.getBoundingClientRect().width * 100) / 100);
          samples[position][chosen ? 'checkWhenChosen' : 'checkWhenNotChosen'].push(checkShown(item));
        });
      }
      return samples;
    };
  `, ['--loader:.webp=empty', '--loader:.css=empty']);
  let markReady!: () => void;
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const fixtureErrors: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    const font = /^\/files\/([a-z0-9-]+\.woff2)$/.exec(path);
    if (font) return new Response(Bun.file(resolve(fontFiles, font[1])), { headers: { 'Content-Type': 'font/woff2' } });
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    if (path === '/fixture-error') { fixtureErrors.push(await request.text()); return new Response('noted'); }
    return new Response('not found', { status: 404 });
  } });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-toggle-width-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
    // Chrome starts and draws both groups with the font loaded in 0.78–0.85s here (3 runs, 2026-11-16); 15s is about
    // 18× that, for a cold Chrome on a shared CI runner.
    await withTimeout(ready, 15_000, 'My Work page fixture did not draw its View and Filter groups');
    page = await connectToPage(chrome, server.url.href);
    expect(await page.evaluate('window.geistLoaded()')).toBe(true);

    const moved: string[] = [], checks: object[] = [], expectedChecks: object[] = [];
    // 1440 is the review's desktop (17px root); 390 is its phone (16px root, 44px-tall items).
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
      await page.settle();
      for (const [name, fewestItems] of [['View', 3], ['Filter', 4]] as const) {
        const samples: ItemSamples[] = await page.evaluate(`window.chooseEach(${JSON.stringify(name)})`);
        // Cards, List, By agent; All, Needs you, Working, Shipped (Team and Closed only show with team work or closed requests).
        expect(samples.length).toBeGreaterThanOrEqual(fewestItems);
        for (const { label, chosen, notChosen, checkWhenChosen, checkWhenNotChosen } of samples) {
          const item = `${viewport.width} ${name} "${label}"`;
          const widths = [...chosen, ...notChosen];
          if (Math.max(...widths) - Math.min(...widths) > WIDTH_TOLERANCE_PX) moved.push(`${item}: ${chosen.join(' / ')}px chosen, ${[...new Set(notChosen)].join(' / ')}px not chosen`);
          // Each item was chosen once with its check showing, and seen unchosen with no check.
          checks.push({ item, timesChosen: chosen.length, checkWhenChosen, checkHiddenWhenNotChosen: checkWhenNotChosen.every((shown) => !shown) });
          expectedChecks.push({ item, timesChosen: 1, checkWhenChosen: [true], checkHiddenWhenNotChosen: true });
        }
      }
    }
    expect(moved).toEqual([]);
    expect(checks).toEqual(expectedChecks);
    expect(fixtureErrors).toEqual([]);
  } finally {
    page?.close();
    await chrome?.close();
    server.stop(true);
  }
  // The whole test, stylesheet compile and page bundle included, takes 3.4–4.4s here (3 runs, 2026-11-16); 90s is about
  // 20× that, for a slow CI runner.
}, 90_000);

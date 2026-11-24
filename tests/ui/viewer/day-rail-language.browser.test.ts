import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the day rail language check.');

// The day rail drew its dates once per set of rows, so after a language switch it kept the old language until
// the rows changed (Phase 9 re-verify, new finding 1). A mark holding one more day was named "… and 1 more days"
// (finding 2). 120 rows over six days: the rail shows the first day alone, the second with the third merged
// under it ("+1"), and the fourth with the fifth and sixth ("+2"). Rows are about 6px of rail each, far under
// the 24px mark plus its 4px gap, so the merges do not depend on measured row heights.
const DAYS = [40, 1, 39, 1, 1, 38];

type Mark = { label: string; more: string | null; name: string | null };

(chromeExecutablePath ? it : it.skip)('the day rail follows a language switch, and names a one-day merge in the singular', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Feed } from './src/ui/viewer/components/Feed';
    import { setLocale } from './src/ui/i18n';
    const days = ${JSON.stringify(DAYS)};
    const items = [];
    days.forEach((rows, day) => {
      for (let row = 0; row < rows; row++) {
        const id = items.length + 1;
        // Local noon, a minute apart: every row of a day falls on the same local day in the page's own time zone.
        const at = new Date(2026, 10, 15 - day, 12, -row).getTime();
        items.push({ itemType: 'prompt', id, project: 'fixture', platform_source: 'claude', content_session_id: 'session',
          prompt_number: id, prompt_text: 'Prompt number ' + id, created_at_epoch: at, created_at: new Date(at).toISOString() });
      }
    });
    window.__dayStarts = days.map((_, day) => new Date(2026, 10, 15 - day, 12, 0).getTime());
    window.__setLocale = setLocale;
    createRoot(document.getElementById('root')).render(
      <Feed items={items} onLoadMore={() => {}} onDeleted={() => {}} isLoading={false} hasMore={false} />);
    fetch('/ready');
  `);
  const html = readViewerTemplateHtml();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(html);
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(bundle);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    return Response.json({});
  } });
  let chrome: OwnedChrome | undefined, page: DevToolsPage | undefined;
  const readRail = async (): Promise<Mark[]> => page!.evaluate(`[...document.querySelectorAll('.feed-day-rail-mark')].map(mark => ({
    label: mark.childNodes[0].textContent, more: mark.querySelector('.feed-day-rail-more')?.textContent ?? null, name: mark.getAttribute('aria-label') }))`);
  /** The first, second and fourth days' dates as the page formats them in `locale`. */
  const expectedLabels = (locale: string): Promise<string[]> => page!.evaluate(`[0, 1, 3].map(day =>
    new Date(window.__dayStarts[day]).toLocaleDateString(${JSON.stringify(locale)}, { month: 'short', day: 'numeric' }))`);
  try {
    chrome = launchChrome(server.url.href, { remoteDebugging: true, profilePrefix: 'claude-mem-day-rail-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, '--window-size=1440,900'] });
    await withTimeout(ready, 30_000, 'Day-rail browser did not become ready');
    page = await connectToPage(chrome, server.url.href);
    await page.evaluate(`new Promise(resolve => { const check = () => document.querySelectorAll('.feed-day-rail-mark').length ? resolve(true) : setTimeout(check, 30); check(); })`);
    await page.settle();
    expect(await page.evaluate(`document.querySelector('[data-windowed]').dataset.windowed`)).toBe('true');

    const english = await readRail();
    const [first, second, fourth] = await expectedLabels('en');
    expect(english).toEqual([
      { label: first, more: null, name: null },
      { label: second, more: '+1', name: `${second} and 1 more day` },
      { label: fourth, more: '+2', name: `${fourth} and 2 more days` },
    ]);

    // The reader switches to French: the rows stay the same, and the dates and names follow the language.
    await page.evaluate(`window.__setLocale('fr')`);
    await page.settle();
    const french = await readRail();
    const [premier, deuxieme, quatrieme] = await expectedLabels('fr');
    expect([premier, deuxieme, quatrieme]).not.toEqual([first, second, fourth]);
    expect(french).toEqual([
      { label: premier, more: null, name: null },
      { label: deuxieme, more: '+1', name: `${deuxieme} et 1 autre jour` },
      { label: quatrieme, more: '+2', name: `${quatrieme} et 2 autres jours` },
    ]);

    await page.evaluate(`window.__setLocale('pt-BR')`);
    await page.settle();
    const [primeiro, segundo, quarto] = await expectedLabels('pt-BR');
    expect(await readRail()).toEqual([
      { label: primeiro, more: null, name: null },
      { label: segundo, more: '+1', name: `${segundo} e mais 1 dia` },
      { label: quarto, more: '+2', name: `${quarto} e mais 2 dias` },
    ]);
  } finally { page?.close(); await chrome?.close(); server.stop(true); }
}, 60_000);

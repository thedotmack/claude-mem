import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome,
  readViewerTemplateHtml, scriptResponse, UNTHROTTLED_TIMER_FLAGS, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the error card and welcome card checks.');

// G17: plain words first; the raw cause only under the folded "Error details", in
// monospace, with Copy. Rule 6: controls 44px tall on touch; the welcome card's
// footer links at least 24px on a laptop.
const RAW = 'Minified React error #185; visit https://react.dev/errors/185 for the full message';

const bundle = () => compileBrowserFixture(`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ErrorBoundary } from './src/ui/viewer/components/ErrorBoundary';
  import { WelcomeCard } from './src/ui/viewer/components/WelcomeCard';
  function Thrower() { throw new Error(${JSON.stringify(RAW)}); }
  const original = console.error.bind(console);
  console.error = (...args) => { if (!String(args[0]).includes('ErrorBoundary')) original(...args); };
  const which = new URLSearchParams(location.search).get('show');
  createRoot(document.getElementById('root')).render(which === 'welcome'
    ? <WelcomeCard onDismiss={() => {}} onOpenSettings={() => {}} />
    : <ErrorBoundary withHeader><Thrower /></ErrorBoundary>);
  fetch('/ready');
`);

async function open(width: number, height: number, show: 'error' | 'welcome') {
  const script = bundle();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return htmlResponse(readViewerTemplateHtml());
    if (url.pathname === '/viewer-bundle.js') return scriptResponse(script);
    if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
    return Response.json({});
  } });
  const pageUrl = `${server.url.href}?show=${show}`;
  const chrome = launchChrome(pageUrl, { remoteDebugging: true, profilePrefix: 'claude-mem-error-card-', extraFlags: [...UNTHROTTLED_TIMER_FLAGS, `--window-size=${width},${height}`] });
  await withTimeout(ready, 30_000, 'Error card browser did not become ready');
  const page = await connectToPage(chrome, pageUrl);
  await page.settle();
  // The welcome card slides in (0.28s); measure the card at rest, not mid-animation.
  await page.evaluate('Promise.all(document.getAnimations().map(animation => animation.finished)).then(() => true)');
  return { server, chrome, page };
}

const heights = (selectors: string) => `Object.fromEntries([...document.querySelectorAll(${JSON.stringify(selectors)})]
  .filter(element => element.getClientRects().length).map(element => [element.textContent.trim() || element.className, Math.round(element.getBoundingClientRect().height)]))`;

for (const [width, height, touch] of [[1440, 900, false], [390, 844, true]] as const) {
  (chromeExecutablePath ? it : it.skip)(`the error card keeps the raw cause folded, with sized controls, at ${width}px`, async () => {
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      opened = await open(width, height, 'error');
      const { page } = opened;
      const card = await page.evaluate(`(() => {
        const card = document.querySelector('.viewer-error-card');
        const outside = card.cloneNode(true);
        outside.querySelectorAll('details').forEach(details => details.remove());
        const pre = card.querySelector('details pre');
        return { shown: !!card, rawOutsideFold: outside.textContent.includes('React error'), folded: !card.querySelector('details').open,
          rawInFold: pre.textContent.includes(${JSON.stringify(RAW)}), mono: getComputedStyle(pre).fontFamily, copy: !!card.querySelector('.viewer-error-copy') };
      })()`);
      expect(card).toEqual({ shown: true, rawOutsideFold: false, folded: true, rawInFold: true, mono: expect.stringContaining('monospace'), copy: true });
      const sizes = await page.evaluate(heights('.viewer-error-actions .btn-primary, .viewer-error-actions .button-link, .viewer-error-details summary, .viewer-error-copy'));
      expect(Object.keys(sizes).length).toBe(4);
      for (const size of Object.values(sizes) as number[]) expect(size).toBeGreaterThanOrEqual(touch ? 44 : 36);
    } finally { opened?.page.close(); await opened?.chrome.close(); opened?.server.stop(true); }
  }, 60_000);

  (chromeExecutablePath ? it : it.skip)(`the welcome card's footer links are big enough to hit at ${width}px`, async () => {
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      opened = await open(width, height, 'welcome');
      const sizes = await opened.page.evaluate(heights('.welcome-modal-footer-links a'));
      expect(Object.keys(sizes)).toEqual(['How it works', 'Read the docs']);
      for (const size of Object.values(sizes) as number[]) expect(size).toBeGreaterThanOrEqual(touch ? 44 : 24);
    } finally { opened?.page.close(); await opened?.chrome.close(); opened?.server.stop(true); }
  }, 60_000);
}

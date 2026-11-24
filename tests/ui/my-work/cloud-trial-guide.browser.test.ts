import { expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, REPOSITORY_ROOT,
  type DevToolsPage,
} from '../../helpers/chrome-devtools.ts';

failOnCiWithoutChrome('Cloud trial onboarding browser tests need Chromium.');
const browserTest = chromeExecutablePath ? it : it.skip;

async function waitFor(page: DevToolsPage, expression: string) {
  const deadline = Date.now() + 8000;
  while (!(await page.evaluate(expression))) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + expression);
    await Bun.sleep(25);
  }
}

browserTest('private Work View supports a full trial handoff and card setup on a phone', async () => {
  const bundle = join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  const snapshot = Bun.file(join(REPOSITORY_ROOT, 'src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json'));
  const now = Date.now();
  const startedAt = new Date(now - 4 * 86_400_000).toISOString();
  const endsAt = new Date(now + 26 * 86_400_000).toISOString();
  let status: { trialEndsAt: string | null; onboarding: { startedAt: string; endsAt: string } | null } = {
    trialEndsAt: endsAt, onboarding: { startedAt, endsAt },
  };
  let statusReads = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/viewer/cloud-sync-trial') {
      statusReads++;
      return Response.json(status);
    }
    if (path === '/api/work-view/overview') return new Response(snapshot, { headers: { 'Content-Type': 'application/json' } });
    if (path.startsWith('/api/')) return new Response(null, { status: 404 });
    const file = Bun.file(join(bundle, path === '/' ? 'index.html' : path.replace(/^\/work-view\//, '')));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  }});
  const url = 'http://owner.localhost:' + server.port + '/';
  const chrome = launchChrome(url, { remoteDebugging: true, extraFlags: ['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  const banner = 'section[aria-label="Cloud Sync trial"]';
  const guide = 'section:has(a[href="https://cmem.ai/connect"]):has(textarea[readonly])';
  try {
    page = await connectToPage(chrome, url);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
    await waitFor(page, `!!document.querySelector('${guide}') && !!document.querySelector('${banner}')`);
    expect(statusReads).toBe(1);
    expect(await page.evaluate(`(() => {
      const b = document.querySelector('${banner}'), a = b.querySelector('a');
      return [a.getAttribute('href'), b.getBoundingClientRect().top, b.scrollWidth, a.getBoundingClientRect().height >= 44, b.textContent.includes('$12/month')];
    })()`)).toEqual(['/api/viewer/cloud-sync-renew', 0, 320, true, true]);
    expect(await page.evaluate(`document.querySelector('${guide} select').value`)).toBe('3');

    // A clipboard refusal gives the person a selected prompt they can copy manually.
    await page.evaluate(`(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
      const g = document.querySelector('${guide}');
      [...g.querySelectorAll('button')].find(b => b.textContent === 'Copy prompt').click();
    })()`);
    await waitFor(page, `document.querySelector('${guide} [role="status"]').textContent.includes('selected')`);
    expect(await page.evaluate(`(() => {
      const t = document.querySelector('${guide} textarea');
      return document.activeElement === t && t.selectionStart === 0 && t.selectionEnd === t.value.length && t.value.includes('Search Claude-Mem');
    })()`)).toBe(true);

    // Hiding persists across reload and the same control can reopen it.
    await page.evaluate(`document.querySelector('${guide} button[aria-expanded]').click()`);
    await waitFor(page, `document.querySelector('${guide} button[aria-expanded]').getAttribute('aria-expanded') === 'false'`);
    await page.send('Page.reload');
    await waitFor(page, `document.querySelector('${guide} button[aria-expanded]')?.getAttribute('aria-expanded') === 'false'`);
    await page.evaluate(`document.querySelector('${guide} button[aria-expanded]').click()`);
    await waitFor(page, `document.querySelector('${guide} button[aria-expanded]').getAttribute('aria-expanded') === 'true'`);

    // An opted-in trial keeps the guide. At expiry neither trial surface remains.
    status.trialEndsAt = null;
    await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    await waitFor(page, `!document.querySelector('${banner}') && !!document.querySelector('${guide}')`);
    status.onboarding = null;
    await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    await waitFor(page, `!document.querySelector('${banner}') && !document.querySelector('${guide}')`);

    const beforeLocal = statusReads;
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + server.port + '/' });
    await waitFor(page, "location.hostname === '127.0.0.1' && !!document.querySelector('#main-content')");
    expect(statusReads).toBe(beforeLocal);
    expect(await page.evaluate(`document.querySelector('${banner}, ${guide}') === null`)).toBe(true);
  } finally {
    page?.close();
    await chrome.close();
    server.stop(true);
  }
}, 35000);

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

const GUIDE = 'section:has(select):has(textarea[readonly])';

/** Select a visible action by its accessible label, including disclosure summaries. */
async function clickGuideAction(page: DevToolsPage, name: string) {
  await page.evaluate(`(() => {
    const actions = document.querySelector('${GUIDE}').querySelectorAll('button, summary');
    const action = [...actions].find(el => el.getClientRects().length &&
      (el.getAttribute('aria-label') || el.textContent.trim()) === ${JSON.stringify(name)});
    if (!action) throw new Error('Missing guide action ' + ${JSON.stringify(name)});
    action.click();
  })()`);
}

browserTest('private Work View supports a full trial handoff and card setup on a phone', async () => {
  const bundle = join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  const snapshot = await Bun.file(join(REPOSITORY_ROOT, 'src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json')).json();
  let overview = snapshot;
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
    if (path === '/api/work-view/overview') return Response.json(overview);
    if (path.startsWith('/api/')) return new Response(null, { status: 404 });
    const file = Bun.file(join(bundle, path === '/' ? 'index.html' : path.replace(/^\/work-view\//, '')));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  }});
  const url = 'http://owner.localhost:' + server.port + '/';
  const chrome = launchChrome(url, { remoteDebugging: true, extraFlags: ['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  const banner = 'section[aria-label="Cloud Sync trial"]';
  const guide = GUIDE;
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

    // Copy on one tap, retaining the exact payload so the fixture never opens an external agent.
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async value => { window.copiedValue = value; } } });`);
    const webClients = [
      ['ChatGPT', 'https://chatgpt.com/'],
      ['Claude', 'https://claude.ai/'],
      ['Gemini', 'https://gemini.google.com/app'],
    ];
    for (const [name, openUrl] of webClients) {
      const copyName = 'Copy prompt for ' + name;
      await page.evaluate('window.copiedValue = null');
      await clickGuideAction(page, copyName);
      await waitFor(page, `document.querySelector('${guide} textarea').labels[0]?.textContent === ${JSON.stringify('Prompt for ' + name)} && window.copiedValue === document.querySelector('${guide} textarea').value`);
      expect(await page.evaluate(`(() => {
        const card = document.querySelector('${guide} [aria-label="${copyName}"]');
        const rect = card.getBoundingClientRect();
        return !!card.querySelector('img[alt=""]') && card.getAttribute('aria-pressed') === 'true'
          && rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth;
      })()`)).toBe(true);
      expect(await page.evaluate('window.copiedValue')).toContain('Cloud Sync handoff');
      expect(await page.evaluate(`!!document.querySelector('${guide} a[href="${openUrl}"]')`)).toBe(true);
    }

    // A clipboard refusal while switching agents selects the newly requested prompt for manual copy.
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) } });`);
    await clickGuideAction(page, 'Copy prompt for Claude');
    await waitFor(page, `(() => {
      const t = document.querySelector('${guide} textarea');
      return t.labels[0]?.textContent === 'Prompt for Claude' && document.activeElement === t && t.selectionStart === 0 && t.selectionEnd === t.value.length;
    })()`);

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

    // With no synced work, the first guide action connects a client before asking it to recall a note.
    overview = { ...snapshot, agents: [], humanRequests: [], unlinkedWork: [] };
    status = { trialEndsAt: endsAt, onboarding: { startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt } };
    await page.send('Page.reload');
    await waitFor(page, `document.querySelector('${guide} select')?.value === 'connect' && !!document.querySelector('${banner}')`);
    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async value => { window.copiedValue = value; } } });`);
    await clickGuideAction(page, 'Copy setup for ChatGPT');
    await waitFor(page, `typeof window.copiedValue === 'string' && window.copiedValue === document.querySelector('${guide} textarea').value`);
    const firstPrompt = await page.evaluate('window.copiedValue');
    expect(firstPrompt).toMatch(/Claude-Mem|CMEM/i);
    expect(firstPrompt).not.toMatch(/^(https?:\/\/|gemini mcp|claude mcp|codex mcp)/);
    expect(await page.evaluate(`document.querySelector('${guide}').scrollWidth <= document.documentElement.clientWidth`)).toBe(true);

    // The copy button for a prompt and the copy button for a connection setting have different payloads.
    await clickGuideAction(page, 'Set up ChatGPT');
    await clickGuideAction(page, 'Copy URL');
    await waitFor(page, `window.copiedValue === 'https://cmem.ai/api/mcp'`);
    await clickGuideAction(page, 'Copy setup for Gemini');
    await waitFor(page, `document.querySelector('${guide} textarea').labels[0]?.textContent === 'Prompt for Gemini' && window.copiedValue === document.querySelector('${guide} textarea').value`);
    expect(await page.evaluate('window.copiedValue')).toContain('Connected Apps');
    expect(await page.evaluate('window.copiedValue')).not.toContain('gemini mcp add');

    await clickGuideAction(page, 'More agents');
    await clickGuideAction(page, 'Copy setup for Gemini CLI');
    await waitFor(page, `document.querySelector('${guide} textarea').labels[0]?.textContent === 'Prompt for Gemini CLI'`);
    await clickGuideAction(page, 'Copy command');
    await waitFor(page, `typeof window.copiedValue === 'string' && window.copiedValue.startsWith('gemini mcp add ')`);
    expect(await page.evaluate('window.copiedValue')).toContain('https://cmem.ai/api/mcp');
    expect(await page.evaluate(`document.querySelector('${guide}').scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
    await clickGuideAction(page, 'Continue to handoff');
    await waitFor(page, `document.querySelector('${guide} select').value === '1' && document.querySelector('${guide} textarea').labels[0]?.textContent === 'Prompt for Gemini CLI'`);
    expect(await page.evaluate(`document.querySelector('${guide} textarea').value`)).toContain('choose a project name');

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

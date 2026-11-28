import { expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, REPOSITORY_ROOT,
  type DevToolsPage,
} from '../../helpers/chrome-devtools.ts';

failOnCiWithoutChrome('Cloud trial onboarding browser tests need Chromium.');
const browserTest = chromeExecutablePath ? it : it.skip;

async function waitFor(page: DevToolsPage, expression: string, { afterNavigation = false } = {}) {
  const deadline = Date.now() + 8000;
  while (true) {
    try {
      if (await page.evaluate(expression)) return;
    } catch (error) {
      // Chrome may discard this evaluation as the expected destination replaces the old document.
      if (!afterNavigation || !(error instanceof Error) || error.message !== 'Inspected target navigated or closed') throw error;
    }
    if (Date.now() > deadline) throw new Error('Timed out: ' + expression);
    await Bun.sleep(25);
  }
}

// Identify the guide through its use-case selector across preview and schedule setup.
const GUIDE = 'section:has(select option[value="connect"])';

async function chooseUseCase(page: DevToolsPage, day: number) {
  await page.evaluate(`(() => {
    const select = document.querySelector('${GUIDE} select');
    select.value = '${day}';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(page, `document.querySelector('${GUIDE} select').value === '${day}'`);
}

async function setScheduleTime(page: DevToolsPage, value: string) {
  await page.evaluate(`(() => {
    const input = document.querySelector('${GUIDE} input[type=time]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

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
  const usage: { hostname: string; path: string; event: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/viewer-usage' || path === '/api/work-view/usage') {
      usage.push({ hostname: new URL(request.url).hostname, path, event: (await request.json()).event });
      return new Response(null, { status: 204 });
    }
    if (path === '/api/work-view/session') return Response.json({ ok: true });
    if (path === '/api/cloud-sync/renewal-status') {
      expect(request.headers.get('x-work-session')).toBe('first-owner');
      statusReads++;
      return Response.json(status);
    }
    if (path === '/api/work-view/overview') return Response.json(overview);
    if (path.startsWith('/api/')) return new Response(null, { status: 404 });
    if ((path === '/' || path === '/work') && new URL(request.url).hostname === 'owner.localhost') {
      const html = await Bun.file(join(bundle, 'index.html')).text();
      return new Response(html.replace('<head>', '<head><meta name="cmem-work-owner" content="first-owner">'), { headers: { 'Content-Type': 'text/html' } });
    }
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
    await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
    await waitFor(page, `!!document.querySelector('${guide}') && !!document.querySelector('${banner}')`);
    expect(statusReads).toBe(1);
    expect(await page.evaluate(`(() => {
      const b = document.querySelector('${banner}'), a = b.querySelector('a');
      return [a.getAttribute('href'), b.getBoundingClientRect().top, b.scrollWidth, a.getBoundingClientRect().height >= 44, b.textContent.includes('$12/month')];
    })()`)).toEqual(['/cloud-sync/renew?owner=first-owner', 0, 320, true, true]);
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
    expect(await page.evaluate(`document.querySelector('${guide} textarea').value`)).toContain('which project and action');

    // A new customer can start a routine on day one, then pick a different example.
    await clickGuideAction(page, 'Try a morning brief');
    await waitFor(page, `document.querySelector('${guide} select').value === '7'`);
    expect(await page.evaluate(`document.querySelector('${guide} select').labels[0].textContent`)).toContain('What would you like to try?');
    await chooseUseCase(page, 6);
    await clickGuideAction(page, 'Copy prompt for ChatGPT');
    await waitFor(page, `window.copiedValue === document.querySelector('${guide} textarea').value`);
    expect(await page.evaluate('window.copiedValue')).toMatch(/reason.+dated source/i);

    await clickGuideAction(page, 'Next: Get a weekday morning brief');
    await waitFor(page, `document.querySelector('${guide} select').value === '7'`);
    await clickGuideAction(page, 'Copy prompt for Gemini');
    await waitFor(page, `window.copiedValue === document.querySelector('${guide} textarea').value`);
    const preview = await page.evaluate('window.copiedValue');
    expect(preview).toContain('previous weekday morning');
    expect(preview).not.toContain('Schedule “Morning work brief”');
    await clickGuideAction(page, 'Set up this schedule');
    const timeInput = `${guide} input[type=time]`;
    expect(await page.evaluate(`document.querySelector('${timeInput}').labels[0].textContent`)).toContain('America/Los_Angeles');
    expect(await page.evaluate(`document.querySelector('${timeInput}').value`)).toBe('09:00');
    expect(await page.evaluate(`!!document.querySelector('${guide} [aria-label="Copy prompt for Gemini"]')`)).toBe(false);
    await setScheduleTime(page, '');
    await waitFor(page, `!document.querySelector('${guide} textarea')`);
    await setScheduleTime(page, '08:30');
    await waitFor(page, `document.querySelector('${guide} textarea')?.value.includes('08:30')`);
    for (const name of ['ChatGPT', 'Claude']) {
      await clickGuideAction(page, 'Copy prompt for ' + name);
      await waitFor(page, `document.querySelector('${guide} textarea').labels[0]?.textContent === ${JSON.stringify('Prompt for ' + name)} && window.copiedValue === document.querySelector('${guide} textarea').value`);
      const schedule = await page.evaluate('window.copiedValue');
      expect(schedule).toContain('every weekday at 08:30 in America/Los_Angeles');
      expect(schedule).toContain('next run');
      expect(schedule).toContain('Create only one.');
      expect(schedule).toContain('previous weekday morning');
      expect(await page.evaluate(`document.querySelector('${guide}').textContent`)).toMatch(/edit it, or pause it/i);
    }
    expect(await page.evaluate(`document.querySelector('${guide}').scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
    await setScheduleTime(page, '08:45');
    await waitFor(page, `document.querySelector('${guide} textarea')?.value.includes('08:45') && document.querySelector('${guide} [role="status"]').textContent === ''`);
    expect(await page.evaluate('window.copiedValue')).toContain('08:30');
    await clickGuideAction(page, 'Back to preview');
    await waitFor(page, `!!document.querySelector('${guide} [aria-label="Copy prompt for Gemini"]') && !document.querySelector('${timeInput}')`);

    await chooseUseCase(page, 10);
    expect(await page.evaluate(`document.querySelector('${guide} textarea').value`)).toContain('unresolved blocker');
    // Each opens its page (Focus areas opens the home page at its board for now, design pass Phase 3; Requests is its
    // own page, Phase 5). The guide sits on My Work's home page, so Back returns to it, where the next action is tried.
    for (const [action, view, landed] of [['Open Focus Areas', 'focus', '#focus-areas'], ['All requests', 'requests', '[data-requests-lead]']]) {
      await chooseUseCase(page, 10);
      await clickGuideAction(page, action);
      await waitFor(page, `new URLSearchParams(location.search).get('view') === '${view}' && !!document.querySelector('${landed}')`);
      await page.evaluate('history.back()');
      await waitFor(page, `!new URLSearchParams(location.search).get('view') && !!document.querySelector('${guide} select')`);
    }

    await chooseUseCase(page, 14);
    await clickGuideAction(page, 'Set up this schedule');
    expect(await page.evaluate(`document.querySelector('${guide} textarea').value`)).toContain('every Friday at 16:00 in America/Los_Angeles');

    expect(usage).toEqual([]);
    const beforeLocal = statusReads;
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + server.port + '/' });
    await waitFor(page, "location.hostname === '127.0.0.1' && !!document.querySelector('#main-content')");
    const usageDeadline = Date.now() + 3000;
    while (!usage.some(row => row.event === 'opened') && Date.now() < usageDeadline) await Bun.sleep(10);
    expect(usage).toContainEqual({ hostname: '127.0.0.1', path: '/api/work-view/usage', event: 'opened' });
    expect(statusReads).toBe(beforeLocal);
    expect(await page.evaluate(`document.querySelector('${banner}, ${guide}') === null`)).toBe(true);
  } finally {
    page?.close();
    await chrome.close();
    server.stop(true);
  }
}, 35000);

browserTest('a restored shared Work View covers cards and portal drawers until its owner is revalidated', async () => {
  const bundle = join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  const html = await Bun.file(join(bundle, 'index.html')).text();
  const snapshot = await Bun.file(join(REPOSITORY_ROOT, 'src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json')).json();
  let owner: string | null = 'owner-a';
  const eventStreams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  let signedOutOverviewReads = 0;
  let resume: (() => void) | null = null;
  let delay = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/work') {
      return new Response(owner ? html.replace('<head>', `<head><meta name="cmem-work-owner" content="${owner}">`)
        : '<!doctype html><h1>Sign in</h1>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store' } });
    }
    if (url.pathname.startsWith('/api/work-view/')) {
      const pinned = request.headers.get('X-Work-Session') ?? url.searchParams.get('session');
      if (url.pathname.endsWith('/session') && delay) {
        delay = false;
        await new Promise<void>(resolve => { resume = resolve; });
      }
      if (!owner) {
        if (url.pathname.endsWith('/overview')) signedOutOverviewReads++;
        return Response.json({ error: 'Sign in' }, { status: 401 });
      }
      if (owner !== pinned) return Response.json({ code: 'owner_changed' }, { status: 409 });
      if (url.pathname.endsWith('/session')) return Response.json({ ok: true });
      if (url.pathname.endsWith('/overview')) return Response.json(snapshot);
      if (url.pathname.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        eventStreams.set(pinned!, controller);
        controller.enqueue(new TextEncoder().encode(': connected\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.pathname.startsWith('/api/')) return new Response(null, { status: 404 });
    const file = Bun.file(join(bundle, url.pathname.replace(/^\/work-view\//, '')));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  }});
  const url = `http://shared.localhost:${server.port}/work`;
  const chrome = launchChrome(url, { remoteDebugging: true, extraFlags: ['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  try {
    page = await connectToPage(chrome, url);
    await waitFor(page, "document.querySelector('#main-content') && !document.documentElement.hasAttribute('data-work-session-checking')");
    delay = true;
    await page.evaluate(`(() => {
      const portal = document.createElement('aside'); portal.id = 'private-portal'; portal.textContent = 'Owner A drawer';
      document.body.appendChild(portal); history.replaceState(null, '', '/work#request-a');
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    })()`);
    await waitFor(page, "document.querySelector('#root').getClientRects().length === 0 && document.querySelector('#private-portal').getClientRects().length === 0");
    owner = 'owner-b';
    const deadline = Date.now() + 3000;
    while (!resume && Date.now() < deadline) await Bun.sleep(10);
    expect(resume).toBeFunction();
    (resume as unknown as () => void)();
    await waitFor(page, "document.querySelector('meta[name=cmem-work-owner]')?.content === 'owner-b' && !document.querySelector('#private-portal') && location.hash === ''",
      { afterNavigation: true });
    const streamDeadline = Date.now() + 3000;
    while (!eventStreams.has('owner-b') && Date.now() < streamDeadline) await Bun.sleep(10);
    expect(eventStreams.has('owner-b')).toBe(true);
    owner = null;
    // Sign out in a different tab while this tab keeps its original EventSource open.
    eventStreams.get('owner-b')!.enqueue(new TextEncoder().encode('event: work-view-changed\ndata: {}\n\n'));
    await waitFor(page, "document.querySelector('h1')?.textContent === 'Sign in' && !document.querySelector('#root')",
      { afterNavigation: true });
    expect(signedOutOverviewReads).toBeGreaterThan(0);
  } finally {
    if (resume) (resume as () => void)();
    page?.close();
    await chrome.close();
    server.stop(true);
  }
}, 35000);

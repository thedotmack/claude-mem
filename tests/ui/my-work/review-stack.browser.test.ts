import { expect, it } from 'bun:test';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ReviewStackRoutes } from '../../../src/services/worker/http/routes/ReviewStackRoutes.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../../src/shared/worker-http-limits.js';
import { chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, REPOSITORY_ROOT, type DevToolsPage } from '../../helpers/chrome-devtools.ts';

failOnCiWithoutChrome('Review Stack browser tests need Chromium.');
const browserTest = chromeExecutablePath ? it : it.skip;
const stack = '/api/work-view/review-stack';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=';
const cards = ['First original study', 'Second original study', 'Other project study'].map((title, index) => ({
  key: 'browser-original-' + index, focus: index === 2 ? 'Other' : 'Illustrations', title,
  what: 'This image records one design variation in our original illustration project.',
  context: 'The design team made these illustrations to compare visual ideas together.',
  source: `https://original.example/studies/${index}`, imageData: image, excerpt: 'Original excerpt ' + index,
}));

const button = (label: string, scope = '.review-stack') => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(el => el.textContent.trim() === ${JSON.stringify(label)} && el.getClientRects().length)`;
async function waitFor(page: DevToolsPage, expr: string) {
  const deadline = Date.now() + 9000;
  while (!(await page.evaluate(expr))) {
    if (Date.now() > deadline) throw new Error('Waiting for ' + expr + '\n' + await page.evaluate('document.body.innerText.slice(-1200)'));
    await Bun.sleep(30);
  }
}
async function click(page: DevToolsPage, label: string, scope?: string) {
  const expr = button(label, scope);
  await waitFor(page, `!!(${expr}) && !(${expr}).disabled`);
  await page.evaluate(`(${expr}).click()`);
}
async function drag(page: DevToolsPage, offset: number, hold: 'complete' | 'abandon' | undefined = undefined) {
  const { x, y } = await page.evaluate(`(() => { const el = document.querySelector('.stack-copy'); el.scrollIntoView({block:'center'}); const box = el.getBoundingClientRect(); return {x:box.left+box.width/2,y:box.top+10} })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + offset, y, button: 'left', buttons: 1 });
  if (hold === 'complete') await waitFor(page, `document.querySelector('.stack-feedback')?.textContent.includes('marked seen in Illustrations')`);
  if (hold === 'abandon') {
    await waitFor(page, `!!document.querySelector('.stack-hold')`);
    await page.evaluate(`window.dispatchEvent(new Event('blur'))`);
    await Bun.sleep(3050);
    expect(await page.evaluate(`document.querySelector('.review-stack').innerText.includes('0 XP') && !document.querySelector('.stack-hold')`)).toBe(true);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + offset, y, button: 'left', buttons: 0, clickCount: 1 });
}

browserTest('the built phone and desktop reviewer reads private thumbnails and keeps Work actions out of Browse', async () => {
  const bundle = process.env.CMEM_TEST_WORK_VIEW_BUNDLE || join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  const overview = await Bun.file(join(REPOSITORY_ROOT, 'src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json')).json();
  const store = new SessionStore(':memory:');
  store.setLocalSyncDeviceId('review-browser-test');
  const auth: Array<{ path: string; owner?: string; token?: string }> = [];
  const app = express();
  app.use(express.json({ limit: WORKER_JSON_BODY_LIMIT_BYTES }));
  app.use(stack, (req, res, next) => {
    auth.push({ path: req.path, owner: req.get('X-Work-Session'), token: req.get('X-Claude-Mem-Token') });
    if (req.get('X-Work-Session') !== 'fixture-owner' && req.get('X-Claude-Mem-Token') !== 'fixture-token') { res.sendStatus(401); return; }
    next();
  });
  new ReviewStackRoutes(store.db, 'review-browser-test', () => {}).setupRoutes(app);
  app.get('/api/work-view/overview', (_req, res) => res.json(overview));
  app.get('/api/work-view/session', (_req, res) => res.json({ ok: true }));
  app.get('/api/cloud-sync/renewal-status', (_req, res) => res.json({ trialEndsAt: null, onboarding: null }));
  app.use('/api', (_req, res) => res.sendStatus(404));
  app.use('/work-view', express.static(bundle));
  const html = await Bun.file(join(bundle, 'index.html')).text();
  app.get('/', (_req, res) => res.type('html').send(html));
  app.get('/work', (_req, res) => res.type('html').send(html.replace('<head>', '<head><meta name="cmem-work-owner" content="fixture-owner">')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = origin + '/work?view=review-stack';
  const chrome = launchChrome(url, { remoteDebugging: true, extraFlags: ['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  try {
    page = await connectToPage(chrome, url);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
    await waitFor(page, `document.querySelector('.stack-empty h2')?.textContent.includes('empty')`);
    await click(page, 'My Rules', 'nav');
    await waitFor(page, `new URLSearchParams(location.search).get('view') === 'rules'`);
    await click(page, 'Review', 'nav');
    await waitFor(page, `new URLSearchParams(location.search).get('view') === 'review-stack'`);
    await click(page, 'Import');
    await waitFor(page, `!!document.querySelector('[type=file]')`);
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify({ cards }))}], 'cards.json', {type:'application/json'})); const input=document.querySelector('[type=file]'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await click(page, 'Import cards', '[role=dialog]');
    await waitFor(page, `document.querySelector('[role=dialog] [role=status]')?.textContent.includes('3 added')`);
    await click(page, 'View cards', '[role=dialog]');
    await waitFor(page, `document.querySelector('.stack-preview img')?.naturalWidth === 1`);
    expect(auth.some(call => call.path.startsWith('/media/') && call.owner === 'fixture-owner')).toBe(true);
    expect(await page.evaluate(`document.querySelector('.stack-source').rel`)).toContain('noreferrer');
    expect(await page.evaluate(`document.querySelector('.stack-preview img').referrerPolicy`)).toBe('no-referrer');
    expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
    await page.evaluate(`(() => { const select=document.querySelector('.stack-select'); select.value='Illustrations'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await click(page, 'Save', '.stack-actions');
    await waitFor(page, `!!(${button('Saved', '.stack-actions')})`);
    const first = await page.evaluate(`document.querySelector('.stack-card h2').textContent`);
    await click(page, 'Follow up', '.stack-actions');
    await waitFor(page, `!!document.querySelector('textarea')`);
    await page.evaluate(`(() => {const field=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Make the final word larger.'); field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(page, 'Save follow-up', '[role=dialog]');
    await waitFor(page, `!document.querySelector('[role=dialog]')`);
    expect(await page.evaluate(`document.querySelector('.stack-card h2').textContent`)).toBe(first);
    await click(page, 'Browse', '.stack-modes');
    await waitFor(page, `!!document.querySelector('.stack-guide') && !document.querySelector('.stack-actions')`);
    await drag(page, -75);
    await waitFor(page, `document.querySelector('.stack-card h2')?.textContent !== ${JSON.stringify(first)}`);
    await drag(page, 75);
    await waitFor(page, `document.querySelector('.stack-card h2')?.textContent === ${JSON.stringify(first)}`);
    await click(page, 'Work', '.stack-modes');
    await drag(page, 90, 'abandon');
    await drag(page, 90, 'complete');
    await waitFor(page, `!!document.querySelector('.stack-empty') && document.querySelector('.stack-toolbar') && document.querySelector('.review-stack').innerText.includes('20 XP')`);
    await click(page, 'Undo group', '.stack-feedback');
    await waitFor(page, `document.querySelector('.stack-card h2')?.textContent === ${JSON.stringify(first)} && document.querySelector('.review-stack').innerText.includes('0 XP')`);
    await click(page, 'Skip for now', '.stack-actions');
    await waitFor(page, `document.querySelector('.stack-card h2')?.textContent !== ${JSON.stringify(first)}`);
    await click(page, 'Seen', '.stack-actions');
    await click(page, 'Revisit 1 skipped', '.stack-empty');
    await waitFor(page, `document.querySelector('.stack-card h2')?.textContent === ${JSON.stringify(first)}`);
    await click(page, 'History');
    await waitFor(page, `document.querySelector('section[aria-label="Review history"]')?.innerText.includes('Make the final word larger.')`);
    await click(page, 'Complete follow-up', 'section[aria-label="Review history"]');
    await waitFor(page, `!!(${button('Reopen follow-up', 'section[aria-label="Review history"]')})`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: origin + '/?view=review-stack&token=fixture-token' });
    await waitFor(page, `!!document.querySelector('.stack-preview img') && !location.search.includes('token=')`);
    await waitFor(page, `document.querySelector('.stack-preview img').naturalWidth === 1`);
    expect(auth.some(call => call.path.startsWith('/media/') && call.token === 'fixture-token')).toBe(true);
    await click(page, 'History');
    await waitFor(page, `!!(${button('Reopen follow-up', 'section[aria-label="Review history"]')})`);
    expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  } finally { page?.close(); await chrome.close(); server.closeAllConnections(); server.close(); store.close(); }
}, 60_000);

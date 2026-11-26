import { expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { WorkViewRoutes } from '../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { ReviewStackRoutes } from '../../../src/services/worker/http/routes/ReviewStackRoutes.js';
import { chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, REPOSITORY_ROOT, type DevToolsPage } from '../../helpers/chrome-devtools.ts';

failOnCiWithoutChrome('Live Review Stack tests need Chromium.');
const browserTest = chromeExecutablePath ? it : it.skip;
const stack = '/api/work-view/review-stack';
async function visible(page: DevToolsPage, selector: string, contains: string) {
  const deadline = Date.now() + 8000;
  const expression = `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(contains)})`;
  while (Date.now() < deadline) { if (await page.evaluate(expression)) return; await Bun.sleep(25); }
  throw new Error('The open Review Stack did not show ' + contains);
}

browserTest('an open reviewer follows native imports, synced decisions and owner-pinned hosted changes while preserving gestures and drafts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-review-stack-'));
  const databasePath = join(directory, 'memory.sqlite');
  const store = new SessionStore(databasePath), remote = new SessionStore(':memory:');
  store.setLocalSyncDeviceId('laptop'); remote.setLocalSyncDeviceId('phone');
  const work = new WorkViewRoutes({ databasePath, reviewPath: join(directory, 'reviews.json'), humanCopy: null, ledgerDir: null,
    autoRefresh: null, setupStatePath: join(directory, 'setup.json') });
  const app = express(), peer = express();
  const hosted = new Set<express.Response>();
  const callers: Array<string | undefined> = [];
  app.use(express.json()); peer.use(express.json());
  app.get('/api/work-view/session', (req, res) => { res.status(req.get('X-Work-Session') === 'fixture-owner' ? 200 : 401).json({ ok: true }); });
  app.get('/api/cloud-sync/renewal-status', (_req, res) => res.json({ trialEndsAt: null, onboarding: null }));
  app.get('/api/work-view/events', (req, res, next) => {
    if (!req.query.session) { next(); return; }
    if (req.query.session !== 'fixture-owner') { res.sendStatus(401); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('event: work-view-changed\ndata: {}\n\n');
    hosted.add(res); res.on('close', () => hosted.delete(res));
  });
  app.use(stack, (req, _res, next) => { if (req.method === 'GET') callers.push(req.get('X-Work-Session')); next(); });
  work.setupRoutes(app);
  new ReviewStackRoutes(store.db, 'laptop', () => {
    work.publishReviewStackChanged();
    for (const stream of hosted) stream.write('event: work-view-changed\ndata: {}\n\n');
  }).setupRoutes(app);
  new ReviewStackRoutes(remote.db, 'phone', () => {}).setupRoutes(peer);
  const bundle = process.env.CMEM_TEST_WORK_VIEW_BUNDLE || join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  app.use('/work-view', express.static(bundle));
  const html = await Bun.file(join(bundle, 'index.html')).text();
  app.get('/', (_req, res) => res.type('html').send(html));
  app.get('/work', (_req, res) => res.type('html').send(html.replace('<head>', '<head><meta name="cmem-work-owner" content="fixture-owner">')));
  const server = app.listen(0, '127.0.0.1'), other = peer.listen(0, '127.0.0.1');
  await Promise.all([server, other].map(s => new Promise<void>(resolve => s.once('listening', resolve))));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const remoteOrigin = 'http://127.0.0.1:' + (other.address() as AddressInfo).port;
  const url = origin + '/?view=review-stack';
  const browser = launchChrome(url, { remoteDebugging: true, extraFlags: ['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  const write = async (target: string, operation: string, body: unknown) => {
    const response = await fetch(target + stack + '/' + operation, { method: 'POST', headers: {
      Origin: target, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
    }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return response.json();
  };
  const add = (target: string, title: string) => write(target, 'import', { cards: [{ key: title, title, focus: 'Launch',
    what: 'An original draft introduces the spring release on the homepage.',
    context: 'The design team is choosing artwork for the spring release.', excerpt: 'Original artwork note.' }] });
  try {
    page = await connectToPage(browser, url);
    await visible(page, '.stack-empty', 'empty');
    await add(origin, 'First Native Artwork');
    await visible(page, '.stack-card h2', 'First Native Artwork');
    const { x, y } = await page.evaluate(`(() => { const el = document.querySelector('.stack-copy'); el.scrollIntoView(); const box = el.getBoundingClientRect(); return { x: box.left + box.width/2, y: box.top+10 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    const before = callers.length;
    const second = await add(origin, 'Second Native Artwork');
    await Bun.sleep(150);
    expect(callers.length).toBe(before);
    await visible(page, '.stack-card h2', 'First Native Artwork');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await visible(page, '.stack-card h2', 'Second Native Artwork');

    // The phone receives the current cards before it makes its own decision. Deliver the true replica rows both ways.
    function sync(from: SessionStore, fromId: string, to: SessionStore, toId: string) {
      const ids = from.db.query('SELECT CAST(id AS TEXT) AS source FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as { source: string }[];
      const apply = new SyncApply(to.db, { deviceId: toId });
      const cursor = BigInt(apply.getCursor());
      const ops = ids.map(({ source }, i) => ({ seq: String(cursor + BigInt(i + 1)), ...getNativeContentOperation(from.db, 'work_state', source, fromId)!.operation }));
      apply.applyOps(decodeChanges(ops), { epoch: '1' });
    }
    sync(store, 'laptop', remote, 'phone');
    await write(remoteOrigin, 'action', { action: 'seen', cardId: second.firstId, expectedReviewId: null });
    sync(remote, 'phone', store, 'laptop');
    await visible(page, '.stack-card h2', 'First Native Artwork');
    await visible(page, '.review-stack', '1 of 2 seen');

    await page.send('Page.navigate', { url: origin + '/work?view=review-stack' });
    await visible(page, 'head meta[name=cmem-work-owner]', '');
    await visible(page, '.stack-card h2', 'First Native Artwork');
    const deadline = Date.now() + 8000;
    while (!hosted.size && Date.now() < deadline) await Bun.sleep(25);
    expect(hosted.size).toBe(1);
    await page.evaluate(`[...document.querySelectorAll('.stack-actions button')].find(b => b.textContent.trim() === 'Follow up').click()`);
    await visible(page, '[role=dialog]', 'Follow up');
    await page.evaluate(`(() => {const input = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, 'Keep this draft'); input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const pinned = callers.filter(owner => owner === 'fixture-owner').length;
    await add(origin, 'Third Hosted Artwork');
    await Bun.sleep(150);
    expect(callers.filter(owner => owner === 'fixture-owner').length).toBe(pinned);
    expect(await page.evaluate("document.querySelector('textarea').value")).toBe('Keep this draft');
    await page.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Save follow-up').click()`);
    await visible(page, '.stack-card h2', 'Third Hosted Artwork');
    const readsAfterSave = callers.length;
    await add(origin, 'Fourth Hosted Artwork');
    await visible(page, '.stack-card h2', 'Fourth Hosted Artwork');
    expect(callers.slice(readsAfterSave)).toContain('fixture-owner');
  } finally {
    await page?.close(); await browser.close();
    for (const stream of hosted) stream.end();
    work.close();
    await Promise.all([server, other].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    store.close(); remote.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

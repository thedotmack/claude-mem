import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ReviewStackRoutes } from '../../../src/services/worker/http/routes/ReviewStackRoutes.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../../src/shared/worker-http-limits.js';
import { _resetRedactionConfigCache } from '../../../src/utils/redaction.js';
import { chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, REPOSITORY_ROOT, type DevToolsPage } from '../../helpers/chrome-devtools.ts';

failOnCiWithoutChrome('Review Stack browser tests need Chromium.');
const browserTest = chromeExecutablePath ? it : it.skip;
const stack = '/api/work-view/review-stack';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=';
const cards = ['First original study', 'Second original study', 'Other project study'].map((title, index) => ({
  key: 'browser-original-' + index, focus: 'Illustrations ' + (index === 2 ? 'PRIVATE_SECOND' : 'PRIVATE_FIRST'), title,
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
/** One of the phone's bottom-bar places (components/app-bar.tsx): links, pressed as a person presses them. */
const placeLink = (label: string) => `[...document.querySelectorAll('[data-slot="bottom-bar"] a[href]')].find(el => el.textContent.trim() === ${JSON.stringify(label)} && el.getClientRects().length)`;
async function pressPlace(page: DevToolsPage, label: string) {
  await waitFor(page, `!!(${placeLink(label)})`);
  await page.evaluate(`(${placeLink(label)}).click()`);
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
  const previousEnabled = process.env.CLAUDE_MEM_REDACT_ENABLED, previousPatterns = process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS;
  const auth: Array<{ path: string; owner?: string; token?: string }> = [];
  const groupAnchors: string[] = [];
  const app = express();
  app.use(express.json({ limit: WORKER_JSON_BODY_LIMIT_BYTES }));
  app.use(stack, (req, res, next) => {
    auth.push({ path: req.path, owner: req.get('X-Work-Session'), token: req.get('X-Claude-Mem-Token') });
    if (req.path === '/action' && req.body?.action === 'seen-group') groupAnchors.push(req.body.cardId);
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
    process.env.CLAUDE_MEM_REDACT_ENABLED = 'false';
    _resetRedactionConfigCache();
    page = await connectToPage(chrome, url);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
    await waitFor(page, `document.querySelector('.stack-empty h2')?.textContent.includes('empty')`);
    await pressPlace(page, 'My Rules');
    await waitFor(page, `new URLSearchParams(location.search).get('view') === 'rules'`);
    await pressPlace(page, 'Review');
    await waitFor(page, `new URLSearchParams(location.search).get('view') === 'review-stack'`);
    await click(page, 'Import');
    await waitFor(page, `!!document.querySelector('[type=file]')`);
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify({ cards }))}], 'cards.json', {type:'application/json'})); const input=document.querySelector('[type=file]'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await click(page, 'Import cards', '[role=dialog]');
    await waitFor(page, `document.querySelector('[role=dialog] [role=status]')?.textContent.includes('3 added')`);
    await click(page, 'View cards', '[role=dialog]');
    process.env.CLAUDE_MEM_REDACT_ENABLED = 'true';
    process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS = JSON.stringify([{name:'area',regex:'PRIVATE_(FIRST|SECOND)'}]);
    _resetRedactionConfigCache();
    await page.send('Page.navigate', {url});
    await waitFor(page, `document.querySelector('.stack-preview img')?.naturalWidth === 1`);
    expect(auth.some(call => call.path.startsWith('/media/') && call.owner === 'fixture-owner')).toBe(true);
    expect(await page.evaluate(`document.querySelector('.stack-source').rel`)).toContain('noreferrer');
    expect(await page.evaluate(`document.querySelector('.stack-preview img').referrerPolicy`)).toBe('no-referrer');
    expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
    const projected = await (await fetch(origin + stack, {headers:{'X-Work-Session':'fixture-owner'}})).json();
    const focusId = projected.cards.find((item: {title:string}) => item.title === cards[0].title).focusId;
    const labels = await page.evaluate(`Array.from(document.querySelectorAll('.stack-select option'), o => o.textContent)`) as string[];
    expect(labels.filter(label => label.includes("<redacted type='area'/>"))).toHaveLength(2);
    expect(new Set(labels).size).toBe(3);
    await page.evaluate(`(() => { const select=document.querySelector('.stack-select'); select.value=${JSON.stringify(focusId)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
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
    expect(groupAnchors).toEqual([projected.cards.find((item: {title:string}) => item.title === first).id]);
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
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_MEM_REDACT_ENABLED; else process.env.CLAUDE_MEM_REDACT_ENABLED = previousEnabled;
    if (previousPatterns === undefined) delete process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS; else process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS = previousPatterns;
    _resetRedactionConfigCache();
    page?.close(); await chrome.close(); server.closeAllConnections(); server.close(); store.close();
  }
}, 60_000);

browserTest('a new winning image for the same card clears the losing preview and fetches the authenticated version', async () => {
  const bundle = process.env.CMEM_TEST_WORK_VIEW_BUNDLE || join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  const overview = await Bun.file(join(REPOSITORY_ROOT, 'src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json')).json();
  const id = 'weekly-' + 'c'.repeat(64);
  const originals = [
    image.split(',')[1],
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGM8ranGwMAAAAY1ARyCBs22AAAAAElFTkSuQmCC',
  ];
  const hashes = originals.map(encoded => createHash('sha256').update(encoded).digest('hex'));
  const titles = ['First original study', 'Updated original title', 'Winning offline study'];
  let stage = 0, allowImage: (() => void) | undefined;
  const newImageGate = new Promise<void>(resolve => { allowImage = resolve; });
  const requests: Array<{ revision: unknown; owner: string | undefined }> = [];
  const app = express();
  app.get(stack, (_req, res) => {
    const preview = stack + '/media/' + id + '?revision=' + hashes[stage === 2 ? 1 : 0];
    res.json({ revision:String(stage).repeat(64), cards:[{...cards[0], id, createdAt:1, title:titles[stage], imageData:undefined, preview}],
      reviews:[], bookmarks:[], followUps:[], groups:[], nextCursor:null });
  });
  app.get(stack + '/media/' + id, async (req, res) => {
    const revision = req.query.revision, owner = req.get('X-Work-Session');
    requests.push({ revision, owner });
    const index = hashes.indexOf(String(revision));
    if (owner !== 'fixture-owner' || index < 0) { res.sendStatus(403); return; }
    if (index === 1) await newImageGate;
    res.type('png').send(Buffer.from(originals[index], 'base64'));
  });
  app.get('/api/work-view/overview', (_req, res) => res.json(overview));
  app.get('/api/work-view/session', (_req, res) => res.json({ ok:true }));
  app.get('/api/work-view/events', (_req, res) => { res.type('text/event-stream'); res.write(': connected\n\n'); });
  app.get('/api/cloud-sync/renewal-status', (_req, res) => res.json({ trialEndsAt:null, onboarding:null }));
  app.use('/api', (_req, res) => res.sendStatus(404));
  app.use('/work-view', express.static(bundle));
  const html = (await Bun.file(join(bundle, 'index.html')).text()).replace('<head>', '<head><meta name="cmem-work-owner" content="fixture-owner">');
  app.get('/work', (_req, res) => res.type('html').send(html));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/work?view=review-stack`;
  const chrome = launchChrome(url, { remoteDebugging:true, extraFlags:['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  const img = "document.querySelector('.stack-preview img')";
  const bytes = `fetch(${img}.src).then(r => r.arrayBuffer()).then(b => btoa(String.fromCharCode(...new Uint8Array(b))))`;
  try {
    page = await connectToPage(chrome, url);
    await waitFor(page, img + '?.naturalWidth === 1');
    expect(await page.evaluate(bytes)).toBe(originals[0]);
    const initialBlob = await page.evaluate(img + '.src');
    stage = 1;
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await waitFor(page, img + '.alt === "Updated original title"');
    expect(await page.evaluate(img + '.src')).toBe(initialBlob);
    expect(requests).toEqual([{revision:hashes[0], owner:'fixture-owner'}]);
    stage = 2;
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await waitFor(page, "document.querySelector('.review-stack')?.textContent.includes('Winning offline study') && !" + img);
    allowImage!();
    await waitFor(page, img + '?.naturalWidth === 2');
    expect(await page.evaluate(bytes)).toBe(originals[1]);
    expect(requests).toEqual(hashes.map(revision => ({ revision, owner:'fixture-owner' })));
  } finally {
    allowImage?.(); page?.close(); await chrome.close(); server.closeAllConnections(); server.close();
  }
}, 30_000);

// Design pass Phase 3 fixes (M1): Review Stack reads its cards again each time it is shown, so Back to it draws a short
// loading card first. The app holds the position the person left until the cards have drawn, then lands there.
browserTest('Back to Review Stack lands where the person left it scrolled, once its cards have been read again', async () => {
  const bundle = process.env.CMEM_TEST_WORK_VIEW_BUNDLE || join(REPOSITORY_ROOT, 'plugin/ui/work-view');
  const overview = await Bun.file(join(REPOSITORY_ROOT, 'src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json')).json();
  const heldReads: Array<() => void> = [];
  let holdReads = false;
  const snapshot = { revision: 'a'.repeat(64), cards: cards.map((card, index) => ({ ...card, id: 'scroll-card-' + index, createdAt: index + 1 })),
    reviews: [], bookmarks: [], followUps: [], groups: [], nextCursor: null };
  const app = express();
  app.get(stack, async (_req, res) => {
    if (holdReads) await new Promise<void>(resolve => heldReads.push(resolve));
    res.json(snapshot);
  });
  app.get('/api/work-view/overview', (_req, res) => res.json(overview));
  app.get('/api/work-view/session', (_req, res) => res.json({ ok:true }));
  app.get('/api/work-view/events', (_req, res) => { res.type('text/event-stream'); res.write(': connected\n\n'); });
  app.get('/api/cloud-sync/renewal-status', (_req, res) => res.json({ trialEndsAt:null, onboarding:null }));
  app.use('/api', (_req, res) => res.sendStatus(404));
  app.use('/work-view', express.static(bundle));
  const html = (await Bun.file(join(bundle, 'index.html')).text()).replace('<head>', '<head><meta name="cmem-work-owner" content="fixture-owner">');
  app.get('/work', (_req, res) => res.type('html').send(html));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/work?view=review-stack`;
  const chrome = launchChrome(url, { remoteDebugging:true, extraFlags:['--no-proxy-server', '--disable-dev-shm-usage'] });
  let page: DevToolsPage | undefined;
  try {
    page = await connectToPage(chrome, url);
    // A short window, so the card and its controls run past it.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 480, deviceScaleFactor: 1, mobile: false });
    await waitFor(page, `!!document.querySelector('.stack-card h2')`);
    expect(await page.evaluate('history.scrollRestoration')).toBe('manual');
    const bottom: number = await page.evaluate('Math.floor(document.documentElement.scrollHeight - innerHeight)');
    // The loading card is far shorter than that, so landing there proves the wait for the cards.
    expect(bottom).toBeGreaterThan(200);
    await page.evaluate(`window.scrollTo(0, ${bottom})`);
    await waitFor(page, `Math.abs(scrollY - ${bottom}) <= 1`);
    const myRules = `[...document.querySelectorAll('[data-slot="app-bar"] nav a[href]')].find(el => el.textContent.trim() === 'My Rules')`;
    await waitFor(page, `!!(${myRules})`);
    await page.evaluate(`(${myRules}).click()`);
    // My Rules has drawn, so Review Stack has left the page (until then React keeps it, hidden, behind the loading page).
    await waitFor(page, `new URLSearchParams(location.search).get('view') === 'rules' && document.querySelector('main h1')?.textContent === 'My Rules' && !document.querySelector('.review-stack') && !document.querySelector('main [aria-busy="true"]')`);
    holdReads = true;
    await page.evaluate('history.back()');
    await waitFor(page, `new URLSearchParams(location.search).get('view') === 'review-stack' && document.querySelector('main')?.textContent.includes('Loading review cards')`);
    expect(await page.evaluate('Math.round(scrollY)')).toBeLessThan(bottom - 100);
    holdReads = false;
    for (const answer of heldReads.splice(0)) answer();
    await waitFor(page, `!!document.querySelector('.stack-card h2') && Math.abs(scrollY - ${bottom}) <= 1`);
  } finally {
    holdReads = false;
    for (const answer of heldReads.splice(0)) answer();
    page?.close(); await chrome.close(); server.closeAllConnections(); server.close();
  }
}, 30_000);

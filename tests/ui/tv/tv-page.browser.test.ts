import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPOSITORY_ROOT, chromeExecutablePath, connectToPage, failOnCiWithoutChrome, htmlResponse, launchChrome, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

// plugin/ui/tv.html is a verbatim copy of src/ui/tv.html made by scripts/build-viewer.js, so the source is what to test.
const TV_HTML = readFileSync(join(REPOSITORY_ROOT, 'src/ui/tv.html'), 'utf8');

failOnCiWithoutChrome('The TV page browser tests need Chrome on CI.');

/** Plain words up to exactly `length` characters (the longest live title in the review was 116). */
function wordsOfLength(length: number): string {
  const words = ['observation', 'title', 'made', 'of', 'plain', 'words', 'for', 'the', 'television', 'page', 'fit', 'check'];
  let text = '';
  for (let i = 0; text.length < length; i++) text += (text ? ' ' : '') + words[i % words.length];
  return text.slice(0, length).trimEnd();
}

interface Fixture {
  server: ReturnType<typeof Bun.serve>;
  url: (query: string) => string;
  emit: (value: unknown) => void;
  closeStreams: () => void;
}

/**
 * Serves the real TV page, a fixed /api/observations per `project`, and an event stream the test writes to.
 * `streamAnswers` says whether /stream answers (a worker that is down refuses it with 503).
 */
function serveTv(itemsByProject: Record<string, object[]>, streamAnswers: () => boolean = () => true): Fixture {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/tv') return htmlResponse(TV_HTML);
    if (url.pathname === '/api/observations') {
      return Response.json({ items: itemsByProject[url.searchParams.get('project') ?? ''] ?? [], hasMore: false });
    }
    if (url.pathname === '/stream' && !streamAnswers()) return new Response('worker down', { status: 503 });
    if (url.pathname === '/stream') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.push(controller);
        controller.enqueue(new TextEncoder().encode(': open\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    }
    return new Response('not found', { status: 404 });
  } });
  // A stream the page left (a reload, a reconnect) refuses writes; it is dropped instead of failing the test.
  const write = (controller: ReadableStreamDefaultController<Uint8Array>, act: () => void) => {
    try { act(); } catch { streams.splice(streams.indexOf(controller), 1); }
  };
  return {
    server,
    url: query => new URL(`/tv${query}`, server.url).href,
    emit: value => {
      const frame = new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
      for (const controller of [...streams]) write(controller, () => controller.enqueue(frame));
    },
    closeStreams: () => { for (const controller of [...streams]) write(controller, () => controller.close()); streams.length = 0; },
  };
}

const observation = (id: number, project: string, fields: Record<string, unknown>) => ({
  id, project, type: 'discovery', platform_source: 'claude', created_at_epoch: Date.now() - 60_000,
  title: null, subtitle: null, text: null, ...fields,
});

async function waitFor(page: DevToolsPage, expression: string, what: string, milliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  // Before the page's document exists the expression throws; that counts as "not yet".
  while (!await page.evaluate(expression).catch(() => false)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** Opens the page at a viewport size, then waits until a title is on screen. */
async function openAt(page: DevToolsPage, url: string, width: number, height: number): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url });
  await waitFor(page, `document.readyState === 'complete' && innerWidth === ${width} && document.getElementById('card').classList.contains('show')`, `the title at ${width}x${height}`);
  await page.settle();
}

/**
 * Where the title, its meta line and the top row land, read from layout boxes (the card's fade scale left out).
 * The title's lines are counted from its words' own line boxes (one client rect per line of the text, grouped by
 * top), not from the page's height-over-line-height formula, so a wrong formula in fitTitle cannot pass itself.
 * A line the clamp hid has its middle below the title's box and is not counted (its glyph box can start a few pixels
 * inside the box: the 1.06 line height is tighter than the font's own ascent and descent).
 */
const MEASURE = `(() => {
  const title = document.getElementById('title');
  const box = id => document.getElementById(id).getBoundingClientRect();
  const fontSize = parseFloat(getComputedStyle(title).fontSize);
  const card = document.getElementById('card');
  const cardTop = (innerHeight - card.offsetHeight) / 2;
  const range = document.createRange();
  range.selectNodeContents(title);
  const titleBottom = title.getBoundingClientRect().bottom;
  const lineTops = new Set([...range.getClientRects()]
    .filter(rect => rect.width > 0 && rect.height > 0 && (rect.top + rect.bottom) / 2 < titleBottom)
    .map(rect => Math.round(rect.top)));
  return {
    text: title.textContent, fullText: title.title, fontSize, clamped: title.classList.contains('clamped'),
    lines: lineTops.size,
    cardWidth: card.offsetWidth, viewportWidth: innerWidth, viewportHeight: innerHeight,
    titleTop: box('title').top, metaBottom: box('meta').bottom, topbarBottom: box('topbar').bottom,
    topbar: ['pipBtn', 'fsBtn', 'status'].map(id => ({ middle: Math.round((box(id).top + box(id).bottom) / 2), left: box(id).left, right: box(id).right })),
    cardTop,
  };
})()`;

(chromeExecutablePath ? it : it.skip)('fits the longest title on screen in at most three balanced lines, then clamps with the full title kept', async () => {
  const longest = wordsOfLength(116);
  const veryLong = wordsOfLength(600);
  const fixture = serveTv({
    longest: [observation(1, 'longest', { title: longest })],
    // A text-only observation: the TV falls back to the text, which has no length limit.
    clamp: [observation(2, 'clamp', { text: veryLong })],
  });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    const first = fixture.url('?project=longest&dwell=60000');
    chrome = launchChrome(first, { profilePrefix: 'claude-mem-tv-fit-', remoteDebugging: true });
    page = await connectToPage(chrome, first);

    for (const [width, height] of [[1440, 900], [1920, 1080]]) {
      await openAt(page, fixture.url('?project=longest&dwell=60000'), width, height);
      const fit = await page.evaluate(MEASURE);
      expect(fit.text).toBe(longest);
      expect(fit.fullText).toBe(longest);
      // B4: the box is 80% of the screen wide (it was 22ch of the 16px body type).
      expect(Math.abs(fit.cardWidth - width * 0.8)).toBeLessThanOrEqual(1);
      expect(fit.lines).toBeLessThanOrEqual(3);
      expect(fit.clamped).toBe(false);
      // Fully on screen, under the status row (the review measured 1,323px of title on a 900px screen).
      expect(fit.titleTop).toBeGreaterThanOrEqual(fit.topbarBottom);
      expect(fit.metaBottom).toBeLessThanOrEqual(height);
      // Never below 3vw: twice the meta line's 1.5vw, so the title stays the card's heading.
      expect(fit.fontSize).toBeGreaterThanOrEqual(Math.ceil(width * 0.03));
    }

    // Still more than three lines at the smallest size: three lines, an ellipsis, every word in the title attribute.
    await openAt(page, fixture.url('?project=clamp&dwell=60000'), 1440, 900);
    const clamped = await page.evaluate(MEASURE);
    expect(clamped.clamped).toBe(true);
    expect(clamped.lines).toBe(3);
    expect(clamped.fontSize).toBe(Math.ceil(1440 * 0.03));
    expect(clamped.fullText).toBe(veryLong);
    expect(await page.evaluate(`getComputedStyle(document.getElementById('title')).webkitLineClamp`)).toBe('3');
    expect(clamped.metaBottom).toBeLessThanOrEqual(900);

    // A phone keeps its 32px type: up to six lines in portrait, every control in one row on screen.
    await openAt(page, fixture.url('?project=longest&dwell=60000'), 390, 844);
    const phone = await page.evaluate(MEASURE);
    expect(phone.fontSize).toBeGreaterThanOrEqual(24);
    expect(phone.lines).toBeLessThanOrEqual(6);
    expect(phone.clamped).toBe(false);
    expect(phone.titleTop).toBeGreaterThanOrEqual(phone.topbarBottom);
    expect(phone.metaBottom).toBeLessThanOrEqual(844);
    // One row: the status and both buttons share a centre line.
    expect(new Set(phone.topbar.map((item: { middle: number }) => item.middle)).size).toBe(1);
    for (const item of phone.topbar) {
      expect(item.left).toBeGreaterThanOrEqual(0);
      expect(item.right).toBeLessThanOrEqual(390);
    }
  } finally {
    page?.close();
    await chrome?.close();
    fixture.server.stop(true);
  }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('words the stream state, counts only new observations not yet shown, and wakes the controls on any key', async () => {
  const fixture = serveTv({ live: [observation(1, 'live', { title: 'A short seeded title' })] });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    const first = fixture.url('?project=live&dwell=60000');
    chrome = launchChrome(first, { profilePrefix: 'claude-mem-tv-live-', remoteDebugging: true });
    page = await connectToPage(chrome, first);
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await openAt(page, first, 1440, 900);
    const word = () => page!.evaluate(`document.getElementById('streamWord').textContent`);
    const queue = () => page!.evaluate(`(() => { const q = document.getElementById('queue'); return q.hidden ? null : q.textContent; })()`);

    await waitFor(page, `document.getElementById('dot').classList.contains('live')`, 'the stream to open');
    expect(await word()).toBe('Live');
    expect(await queue()).toBeNull();

    // Three new observations arrive while the first title stays (60 s dwell): all three wait, and the page says so.
    for (const id of [11, 12, 13]) fixture.emit({ type: 'new_observation', observation: observation(id, 'live', { title: `New title ${id}` }) });
    await waitFor(page, `document.getElementById('queue').textContent === '3 new observations waiting'`, 'the queue count');
    // An observation another project's filter would drop is not counted.
    fixture.emit({ type: 'new_observation', observation: observation(14, 'elsewhere', { title: 'Filtered out' }) });
    await Bun.sleep(200);
    expect(await queue()).toBe('3 new observations waiting');

    // The stream drops: the word says so beside the grey dot, then the page reconnects by itself.
    fixture.closeStreams();
    await waitFor(page, `document.getElementById('streamWord').textContent === 'Reconnecting'`, 'the reconnecting word');
    expect(await page.evaluate(`document.getElementById('dot').classList.contains('live')`)).toBe(false);
    await waitFor(page, `document.getElementById('streamWord').textContent === 'Live'`, 'the reconnect', 10_000);

    // Controls: worded, at least 44px tall; hidden after their time, back on any key (a TV remote has no pointer).
    const buttons = await page.evaluate(`[...document.querySelectorAll('#hud button')].map(b => ({ text: b.textContent, height: b.getBoundingClientRect().height }))`);
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(['Picture in picture', 'Full screen']);
    for (const button of buttons) expect(button.height).toBeGreaterThanOrEqual(44);
    await waitFor(page, `!document.getElementById('hud').classList.contains('show')`, 'the controls to hide', 6_000);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    expect(await page.evaluate(`document.getElementById('hud').classList.contains('show')`)).toBe(true);
    // A control reached with Tab stays visible after the timer runs out.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    expect(await page.evaluate(`document.activeElement.id`)).toBe('pipBtn');
    await waitFor(page, `!document.getElementById('hud').classList.contains('show')`, 'the timer to run out', 6_000);
    await page.settle();
    expect(await page.evaluate(`getComputedStyle(document.getElementById('hud')).opacity`)).toBe('1');
    // A control focused by the pointer does not hold the controls on screen: they still hide after their time.
    const fs = await page.evaluate(`(() => { const b = document.getElementById('fsBtn').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fs.x, y: fs.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400, button: 'left' });
    // Released away from the button, so it is focused without being pressed (no full screen in the test browser).
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 400, button: 'left', clickCount: 1 });
    expect(await page.evaluate(`document.activeElement.id`)).toBe('fsBtn');
    await waitFor(page, `getComputedStyle(document.getElementById('hud')).opacity === '0'`, 'the controls to hide after a pointer focus', 6_000);
  } finally {
    page?.close();
    await chrome?.close();
    fixture.server.stop(true);
  }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('says on screen that it is not connected while the worker is down, keeps trying, and goes live when it answers', async () => {
  let workerUp = false;
  const fixture = serveTv({ down: [observation(1, 'down', { title: 'A seeded title shown while the stream is down' })] }, () => workerUp);
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    const first = fixture.url('?project=down&dwell=60000');
    chrome = launchChrome(first, { profilePrefix: 'claude-mem-tv-down-', remoteDebugging: true });
    page = await connectToPage(chrome, first);
    await openAt(page, first, 1440, 900);
    // The first connection fails: the corner says so in words beside the grey dot, and that the page keeps trying.
    await waitFor(page, `document.getElementById('streamWord').textContent === 'Not connected · retrying every 3 s'`, 'the down words');
    expect(await page.evaluate(`document.getElementById('dot').classList.contains('live')`)).toBe(false);
    // A retry that fails too stays down (it never flickers back to "Connecting" or "Reconnecting").
    await Bun.sleep(3_500);
    expect(await page.evaluate(`document.getElementById('streamWord').textContent`)).toBe('Not connected · retrying every 3 s');

    // On a phone the longer words take their own row in the corner: no word wraps, every button stays 44px, all on screen.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await page.settle();
    const phone = await page.evaluate(`(() => {
      const box = id => document.getElementById(id).getBoundingClientRect();
      const status = box('status');
      return {
        statusOneLine: box('streamWord').height < 30, statusRight: status.right, statusTop: status.top,
        buttons: ['pipBtn', 'fsBtn'].map(id => ({ height: Math.round(box(id).height), left: box(id).left, right: box(id).right, top: box(id).top })),
        titleTop: box('title').top, topbarBottom: box('topbar').bottom,
      };
    })()`);
    expect(phone.statusOneLine).toBe(true);
    expect(phone.statusRight).toBeLessThanOrEqual(390);
    for (const button of phone.buttons) {
      expect(button.height).toBe(44);
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(390);
      expect(button.top).toBeGreaterThanOrEqual(phone.statusTop);
    }
    expect(phone.titleTop).toBeGreaterThanOrEqual(phone.topbarBottom);

    // The worker answers again: the next try opens the stream.
    workerUp = true;
    await waitFor(page, `document.getElementById('streamWord').textContent === 'Live'`, 'the stream to open once the worker answers', 10_000);
    expect(await page.evaluate(`document.getElementById('dot').classList.contains('live')`)).toBe(true);
  } finally {
    page?.close();
    await chrome?.close();
    fixture.server.stop(true);
  }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('shows each waiting observation once and counts down as it does', async () => {
  const fixture = serveTv({ countdown: [] });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    // The shortest dwell and fade the page accepts, so two new titles play within a few seconds.
    const first = fixture.url('?project=countdown&dwell=1200&fade=100&replay=0');
    chrome = launchChrome(first, { profilePrefix: 'claude-mem-tv-countdown-', remoteDebugging: true });
    page = await connectToPage(chrome, first);
    await waitFor(page, `document.getElementById('dot').classList.contains('live')`, 'the stream to open');
    for (const id of [21, 22]) fixture.emit({ type: 'new_observation', observation: observation(id, 'countdown', { title: `Waiting title ${id}` }) });
    await waitFor(page, `document.getElementById('title').textContent === 'Waiting title 22'`, 'the second new title', 15_000);
    // Both have been taken off the queue: nothing waits, so the line is gone.
    expect(await page.evaluate(`document.getElementById('queue').hidden`)).toBe(true);
  } finally {
    page?.close();
    await chrome?.close();
    fixture.server.stop(true);
  }
}, 60_000);

(chromeExecutablePath ? it : it.skip)('meets 7:1 for the kind word and dim text, 3:1 for control edges, and keeps the fade off under reduced motion', async () => {
  const fixture = serveTv({ colours: [observation(1, 'colours', { title: 'Colour check' })] });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    const first = fixture.url('?project=colours&dwell=60000');
    chrome = launchChrome(first, { profilePrefix: 'claude-mem-tv-colours-', remoteDebugging: true });
    page = await connectToPage(chrome, first);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await openAt(page, first, 1440, 900);
    const ratios = await withTimeout(page.evaluate(`(() => {
      const parse = value => value.match(/[\\d.]+/g).map(Number);
      const background = parse(getComputedStyle(document.body).backgroundColor);
      // A colour with alpha is laid over the page background, as the screen shows it.
      const over = ([r, g, b, a = 1]) => [r, g, b].map((channel, i) => channel * a + background[i] * (1 - a));
      const luminance = rgb => { const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = colour => { const [a, b] = [luminance(over(parse(colour))), luminance(background)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
      const style = selector => getComputedStyle(document.querySelector(selector));
      return {
        kind: ratio(style('#meta .type').color), meta: ratio(style('#meta').color), source: ratio(style('#meta .source').color),
        status: ratio(style('#status').color), buttonEdge: ratio(style('#pipBtn').borderTopColor),
        fade: style('#card').transitionDuration,
      };
    })()`), 10_000, 'colour read timed out');
    expect(ratios.kind).toBeGreaterThanOrEqual(7);
    expect(ratios.meta).toBeGreaterThanOrEqual(7);
    expect(ratios.source).toBeGreaterThanOrEqual(7);
    expect(ratios.status).toBeGreaterThanOrEqual(7);
    expect(ratios.buttonEdge).toBeGreaterThanOrEqual(3);
    for (const duration of ratios.fade.split(',')) expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  } finally {
    page?.close();
    await chrome?.close();
    fixture.server.stop(true);
  }
}, 60_000);

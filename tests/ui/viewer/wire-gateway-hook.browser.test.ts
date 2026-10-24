import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, type OwnedChrome,
} from '../../helpers/chrome-devtools';

// useWireGateway (the viewer's Wire page, plan Phase 15) in a real browser,
// against a fake worker: where it sends its requests, the live feed across a
// gateway restart, the pause while the tab is hidden, consent kept out of the
// browser, and every request let go when the page is left.

failOnCiWithoutChrome('CI requires Chrome for the Wire page hook tests');

interface SeenRequest {
  path: string;
  search: string;
  method: string;
  atMs: number;
  aborted: boolean;
}

const call = (id: string, seq: number, done: boolean, minute: number) => ({
  id, seq, time: `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`, agentId: 'codex', routeId: 'codex', protocol: 'openai-responses',
  method: 'POST', path: '/v1/responses', kind: 'turn', sessionId: 's', done, hasBodies: true,
});

const consent = (recording: boolean) => ({ recording, forcedOff: false, effective: recording, decidedAt: null, retentionDays: 7, recordingsDirectory: '/r' });

(chromeExecutablePath ? it : it.skip)('useWireGateway: worker routes only, restart, hidden pause, no localStorage, aborts on leave', async () => {
  let chrome: OwnedChrome | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const seen: SeenRequest[] = [];
  let usageAnswered = 0;
  let report!: (value: unknown) => void;
  const result = new Promise<any>(resolve => { report = resolve; });
  try {
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {useWireGateway} from './src/ui/viewer/hooks/useWireGateway';
      let hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      const setHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
      let latest = null;
      function Fixture() {
        const wire = useWireGateway();
        latest = wire;
        return <pre id="state">{JSON.stringify({ calls: wire.calls.map(c => c.id), connected: wire.trace.connected, recording: wire.consent.data && wire.consent.data.recording })}</pre>;
      }
      const root = createRoot(document.getElementById('root'));
      root.render(<Fixture/>);
      const state = () => JSON.parse(document.getElementById('state')?.textContent || '{}');
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function until(what, test, ms = 8000) {
        const deadline = Date.now() + ms;
        while (!test()) {
          if (Date.now() > deadline) throw Error('Timed out waiting for ' + what + ': ' + JSON.stringify(state()));
          await sleep(10);
        }
      }
      async function run() {
        await fetch('/ready');
        const out = {};
        await until('the old feed', () => state().calls?.includes('old-in-flight'));
        await fetch('/mark?name=sawOld');
        await until('the restarted feed', () => state().calls?.includes('new-latest'));
        out.callsAfterRestart = state().calls;
        await sleep(200);
        await fetch('/mark?name=hidden');
        setHidden(true);
        await sleep(10500);
        await fetch('/mark?name=visible');
        setHidden(false);
        await sleep(500);
        await latest.setRecording(true);
        await until('the saved consent', () => state().recording === true);
        out.localStorageKeys = Object.keys(localStorage);
        out.sessionStorageKeys = Object.keys(sessionStorage);
        latest.loadCallBodies('new-latest').catch(() => {});
        await sleep(300);
        await fetch('/mark?name=unmount');
        root.unmount();
        await sleep(500);
        await fetch('/result', { method: 'POST', body: JSON.stringify(out) });
      }
      run().catch(error => fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }));
    `);
    const marks: Record<string, number> = {};
    let restartGateway!: () => void;
    const gatewayRestarted = new Promise<void>(resolve => { restartGateway = resolve; });
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === '/') return htmlResponse(FIXTURE_PAGE_HTML);
        if (path === '/fixture.js') return scriptResponse(bundle);
        if (path === '/ready') {
          clearTimeout(timeout);
          timeout = setTimeout(() => report({ failure: 'Browser page timed out' }), 45000);
          return new Response('ready');
        }
        if (path === '/mark') {
          marks[url.searchParams.get('name')!] = Date.now();
          if (url.searchParams.get('name') === 'sawOld') restartGateway();
          return new Response('marked');
        }
        if (path === '/result') {
          report(await request.json());
          return new Response('received');
        }
        if (!path.startsWith('/api/wire/')) return new Response('not found', { status: 404 });
        const entry: SeenRequest = { path, search: url.search, method: request.method, atMs: Date.now(), aborted: false };
        seen.push(entry);
        request.signal.addEventListener('abort', () => { entry.aborted = true; });
        const heldUntilAborted = () => new Promise<Response>(resolve => {
          request.signal.addEventListener('abort', () => resolve(new Response('gone')));
        });
        if (path === '/api/wire/trace') {
          const feed = url.searchParams.get('feed');
          // First the old gateway: one call still in flight. Then a restarted one already
          // past the old seq: a cursor from the old feed gets all of its calls (as the gateway does).
          if (feed === null) return Response.json({ feedId: 'feed-old', seq: 5, now: '', calls: [call('old-in-flight', 5, false, 0)] });
          if (feed === 'feed-old') {
            // The old gateway's long-poll ends when it stops; the page asks again and reaches the new one.
            await gatewayRestarted;
            return Response.json({ feedId: 'feed-new', seq: 9, now: '', calls: [call('new-first', 1, true, 1), call('new-latest', 9, false, 2)] });
          }
          return heldUntilAborted();
        }
        if (path === '/api/wire/status') return Response.json({ generatedAt: '', gateway: { origin: 'x', running: true }, capture: null, problems: [], agents: [] });
        if (path === '/api/wire/routes') return Response.json({ routes: [] });
        if (path === '/api/wire/usage') {
          // After the first answer (the one at mount), a usage read is held: leaving the page must let it go.
          if (++usageAnswered > 1) return heldUntilAborted();
          return Response.json({ usageDays: 7, requests: 0, unreadableLines: 0, endless: [], injectedMemory: [], context: [] });
        }
        if (path === '/api/wire/consent' && request.method === 'POST') return Response.json(consent(true));
        if (path === '/api/wire/consent') return Response.json(consent(false));
        if (path === '/api/wire/call') return heldUntilAborted();
        return new Response('unexpected', { status: 500 });
      },
    });
    timeout = setTimeout(() => report({ failure: 'Chrome startup timed out' }), 30000);
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-wire-hook-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    const received = await result;
    expect(received.failure).toBeUndefined();

    // Every request went to the worker's own /api/wire/* routes (relative), none to the gateway's port.
    expect(seen.every(entry => entry.path.startsWith('/api/wire/'))).toBe(true);
    // The live feed always asks to wait for a change, and names its feed once it has one.
    const traces = seen.filter(entry => entry.path === '/api/wire/trace');
    expect(traces.every(entry => new URLSearchParams(entry.search).get('wait') === '1')).toBe(true);
    expect(traces.slice(0, 3).map(entry => entry.search)).toEqual([
      '?after=0&wait=1', '?after=5&wait=1&feed=feed-old', '?after=9&wait=1&feed=feed-new',
    ]);
    // A restart drops the old gateway's calls (none stays "in flight") and shows all of the new one's.
    expect(received.callsAfterRestart).toEqual(['new-latest', 'new-first']);

    // Hidden: the held long-poll was let go, and nothing was asked until visible again (a 10 s refresh included).
    const heldBeforeHidden = traces.filter(entry => entry.atMs < marks.hidden);
    expect(heldBeforeHidden.at(-1)?.aborted).toBe(true);
    expect(seen.filter(entry => entry.atMs > marks.hidden + 100 && entry.atMs < marks.visible)).toEqual([]);
    // Visible again: a refresh at once, and the feed goes on from where it stopped.
    const afterVisible = seen.filter(entry => entry.atMs >= marks.visible && entry.atMs < marks.unmount);
    expect(afterVisible.some(entry => entry.path === '/api/wire/status')).toBe(true);
    expect(afterVisible.find(entry => entry.path === '/api/wire/trace')?.search).toBe('?after=9&wait=1&feed=feed-new');

    // Consent lives only in the worker: nothing kept in the browser.
    expect(received.localStorageKeys).toEqual([]);
    expect(received.sessionStorageKeys).toEqual([]);

    // Leaving the page aborted every request still going: the long-poll, a call's bodies, a refresh.
    const goingAtUnmount = seen.filter(entry => entry.atMs < marks.unmount && entry.method === 'GET'
      && ['/api/wire/trace', '/api/wire/call', '/api/wire/usage'].includes(entry.path) && entry.atMs >= marks.visible);
    expect(goingAtUnmount.map(entry => entry.path).sort()).toEqual(['/api/wire/call', '/api/wire/trace', '/api/wire/usage']);
    expect(goingAtUnmount.every(entry => entry.aborted)).toBe(true);
  } finally {
    clearTimeout(timeout);
    await chrome?.close();
    server?.stop(true);
  }
}, 90000);

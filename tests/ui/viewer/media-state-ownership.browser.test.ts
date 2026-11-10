import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for media read ownership.');

(chromeExecutablePath ? it : it.skip)('keeps media responses and polls with their current selection and retry', async () => {
  const bundle = compileBrowserFixture(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { useMediaStates } from './src/ui/viewer/hooks/useMediaStates';
    import { MEDIA_PENDING_POLL_MS } from './src/ui/viewer/utils/media';
    const send = window.fetch.bind(window);
    const requests = [], polls = new Map();
    const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    let nextTimer = 1000000, api;
    // Control only media polling: React and the fixture keep their real timers.
    window.setTimeout = (callback, ms, ...args) => {
      if (ms !== MEDIA_PENDING_POLL_MS) return nativeTimeout(callback, ms, ...args);
      const id = ++nextTimer;
      polls.set(id, () => { polls.delete(id); callback(...args); });
      return id;
    };
    window.clearTimeout = id => { if (!polls.delete(id)) nativeClear(id); };
    window.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    const id = n => '0000000' + n + '-aaaa-4aaa-8aaa-00000000000' + n;
    function Probe({ ids }) {
      api = useMediaStates(ids);
      return <div>{ids.map(each => <span key={each} data-id={each}>{api.states[each]?.kind ?? 'loading'}</span>)}</div>;
    }
    async function until(test, what) {
      const end = Date.now() + 5000;
      while (!test()) {
        if (Date.now() >= end) throw new Error('Media fixture did not reach ' + what);
        await new Promise(resolve => nativeTimeout(resolve, 5));
      }
    }
    const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => nativeTimeout(resolve, 0)); };
    const complete = (request, state) => request.resolve({ status: 200, json: async () => ({ id: request.url.split('/').at(-1), state }) });
    const shown = n => document.querySelector('[data-id="' + id(n) + '"]')?.textContent;
    let root = createRoot(document.getElementById('root'));
    const render = ns => flushSync(() => root.render(<Probe ids={ns.map(id)} />));
    (async () => {
      try {
        render([1]); await until(() => requests.length === 1, 'initial read');
        const old = requests[0];
        // A live manifest adds an image while the first image's read is pending.
        render([1, 2]); await until(() => requests.length === 3, 'new selection reads');
        complete(requests[1], 'ready'); complete(requests[2], 'ready');
        await until(() => shown(1) === 'ready' && shown(2) === 'ready', 'current images ready');
        complete(old, 'converting'); await settle();
        const selection = { state: shown(1), polls: polls.size };

        render([3]); await until(() => requests.length === 4, 'removed image read');
        const removed = requests[3];
        render([4]); await until(() => requests.length === 5, 'replacement image read');
        complete(requests[4], 'ready'); await until(() => shown(4) === 'ready', 'replacement ready');
        complete(removed, 'converting'); await settle();
        const retired = { state: shown(4), polls: polls.size, removedPublished: Boolean(api.states[id(3)]) };

        // Both retries remain pending; the latest reply owns the image state.
        api.retry(id(4)); api.retry(id(4));
        await until(() => requests.length === 7, 'overlapping retries');
        complete(requests[6], 'ready'); await until(() => shown(4) === 'ready', 'latest retry ready');
        complete(requests[5], 'converting'); await settle();
        const retry = { state: shown(4), polls: polls.size };

        api.retry(id(4)); await until(() => requests.length === 8, 'read before unmount');
        flushSync(() => root.unmount()); complete(requests[7], 'converting'); await settle();
        const unmountedPolls = polls.size;

        root = createRoot(document.getElementById('root'));
        render([5]); await until(() => requests.length === 9, 'fresh mount read');
        complete(requests[8], 'converting'); await until(() => polls.size === 1, 'current pending poll');
        [...polls.values()][0](); await until(() => requests.length === 10, 'current poll dispatched');
        complete(requests[9], 'ready'); await until(() => shown(5) === 'ready', 'current poll ready');
        const current = { state: shown(5), polls: polls.size };
        flushSync(() => root.unmount());
        await send('/result', { method: 'POST', body: JSON.stringify({ selection, retired, retry, unmountedPolls, current }) });
      } catch (error) {
        await send('/result', { method: 'POST', body: JSON.stringify({ error: String(error) }) });
      }
    })();
  `);
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/result') { report(await request.json()); return new Response('received'); }
    return new Response('not found', { status: 404 });
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-media-owner-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 30000, 'Media browser did not report')).toEqual({
      selection: { state: 'ready', polls: 0 },
      retired: { state: 'ready', polls: 0, removedPublished: false },
      retry: { state: 'ready', polls: 0 },
      unmountedPolls: 0,
      current: { state: 'ready', polls: 0 },
    });
  } finally {
    await chrome?.close(); server.stop(true);
  }
}, 60000);

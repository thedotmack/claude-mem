// My Work's observation gallery in real Chrome: a live update that removes the open image closes the gallery
// instead of crashing it, and a failed image load recovers (thumbnail and full image fail separately; Try again
// asks again, keeping keyboard focus in the dialog). PR #5427 review threads.
import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the My Work gallery regression.');

(chromeExecutablePath ? it : it.skip)('closes on a list that lost the open image, and recovers failed image loads', async () => {
  const bundle = compileBrowserFixture(`
    import React, { useState } from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { flushSync } from './src/ui/my-work/node_modules/react-dom';
    import { ObsMediaStrip, MediaSourceContext } from './src/ui/my-work/src/components/observation-media/ObsMedia';
    window.React = React;
    const errors = [];
    window.addEventListener('error', event => errors.push(event.message));
    const id = n => '0000000' + n + '-aaaa-4aaa-8aaa-00000000000' + n;
    const refs = [1, 2, 3, 4, 5].map(n => ({ id: id(n), label: 'event1_image' + n, inspection: 'uninspected' }));
    const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    // Image 1's thumbnail fails until "the worker recovers"; its full image works.
    let thumbnailRecovered = false;
    const source = {
      status: async ids => new Map(ids.map(each => [each, 'ready'])),
      thumbnailUrl: each => each === id(1) && !thumbnailRecovered ? '/missing-thumbnail.webp' : PIXEL,
      imageUrl: () => PIXEL,
      descriptor: async () => ({}),
    };
    let setMedia;
    function Fixture() {
      const [media, set] = useState({ version: 1, attachments: refs });
      setMedia = set;
      return <MediaSourceContext.Provider value={source}><ObsMediaStrip media={media} title="Fixture" /></MediaSourceContext.Provider>;
    }
    async function until(test, what) {
      const end = Date.now() + 7000;
      while (!test()) {
        if (Date.now() > end) throw new Error('Gallery fixture did not reach: ' + what + ' — ' + document.body.textContent);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const thumbState = n => document.querySelectorAll('.obs-media-thumb')[n]?.dataset.state;
    (async () => {
      try {
        createRoot(document.getElementById('root')).render(<Fixture />);
        await until(() => thumbState(0) === 'failed' && thumbState(1) === 'ready', 'thumbnail 1 failed, 2 ready');
        // A broken thumbnail does not hide the full image.
        document.querySelectorAll('.obs-media-thumb')[0].click();
        await until(() => document.querySelector('.obs-media-galleryframe img'), 'full image 1 shown');
        const fullImageShown = document.querySelector('.obs-media-galleryframe').dataset.state === 'ready';
        document.querySelector('.obs-media-galleryclose').click();
        // Open image 5 ("+1"), then a live update drops it.
        await until(() => !document.querySelector('.obs-media-gallery'), 'gallery closed');
        document.querySelector('.obs-media-more').click();
        await until(() => document.querySelector('.obs-media-gallery h2')?.textContent.includes('5 of 5'), 'image 5 open');
        flushSync(() => setMedia({ version: 1, attachments: refs.slice(0, 3) }));
        await until(() => !document.querySelector('.obs-media-gallery'), 'gallery closed after the list shrank');
        const stripAfterShrink = document.querySelectorAll('.obs-media-thumb').length;
        // Try again: the worker recovered, the thumbnail loads.
        thumbnailRecovered = true;
        document.querySelectorAll('.obs-media-thumb')[0].click();
        await until(() => document.querySelector('.obs-media-gallery'), 'gallery reopened');
        // Force the full image to fail, then retry it.
        const frameImg = document.querySelector('.obs-media-galleryframe img');
        frameImg.dispatchEvent(new Event('error'));
        await until(() => document.querySelector('.obs-media-galleryretry'), 'Try again offered');
        document.querySelector('.obs-media-galleryretry').focus();
        document.querySelector('.obs-media-galleryretry').click();
        await until(() => document.querySelector('.obs-media-galleryframe img'), 'full image back after Try again');
        // The retry button is gone; focus stayed in the dialog, so Escape and arrows still work.
        const focusAfterRetry = document.activeElement?.getAttribute('aria-label');
        document.querySelector('.obs-media-galleryclose').click();
        await until(() => thumbState(0) === 'ready', 'thumbnail 1 ready after Try again');
        await fetch('/result', { method: 'POST', body: JSON.stringify({ fullImageShown, stripAfterShrink, focusAfterRetry, errors }) });
      } catch (error) {
        await fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error), errors }) });
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
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-my-work-gallery-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 30000, 'Gallery browser did not report')).toEqual({ fullImageShown: true, stripAfterShrink: 3, focusAfterRetry: 'Close image viewer (Escape)', errors: [] });
  } finally {
    await chrome?.close();
    server.stop(true);
  }
}, 60000);

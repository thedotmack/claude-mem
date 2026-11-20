import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the My Work glow lifecycle regression.');

(chromeExecutablePath ? it : it.skip)('coalesces glow frames and stops pointer work and tweens offscreen or after unmount', async () => {
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { flushSync } from './src/ui/my-work/node_modules/react-dom';
    import { GlowingEffect } from './src/ui/my-work/src/components/aceternity/glowing-effect';
    window.React = React;
    const errors = [];
    window.addEventListener('error', event => errors.push(event.message));
    const listeners = new Set();
    const add = document.body.addEventListener.bind(document.body);
    const remove = document.body.removeEventListener.bind(document.body);
    document.body.addEventListener = (type, listener, options) => {
      if (type === 'pointermove') listeners.add(listener);
      add(type, listener, options);
    };
    document.body.removeEventListener = (type, listener, options) => {
      if (type === 'pointermove') listeners.delete(listener);
      remove(type, listener, options);
    };
    const nativeFrame = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set();
    const cancelled = new Set();
    let lastFrame = 0;
    let scheduled = 0;
    window.requestAnimationFrame = callback => {
      const id = nativeFrame(time => { pending.delete(id); callback(time); });
      lastFrame = id; scheduled++; pending.add(id); return id;
    };
    window.cancelAnimationFrame = id => { cancelled.add(id); pending.delete(id); nativeCancel(id); };
    const until = async (test, label) => {
      const end = performance.now() + 5000;
      while (!test()) {
        if (performance.now() > end) throw new Error('Glow did not reach ' + label);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const frames = async () => { for(let i=0;i<4;i++) await new Promise(nativeFrame); };
    const move = () => document.body.dispatchEvent(new PointerEvent('pointermove', {clientX:310, clientY:100}));
    (async () => {
      try {
        const root = createRoot(document.getElementById('root'));
        flushSync(() => root.render(<div id="card" style={{position:'relative', width:300, height:200}}>
          <GlowingEffect disabled={false} proximity={64} inactiveZone={0.01} movementDuration={2} />
        </div>));
        const card = document.getElementById('card');
        const glow = card.querySelector('[style*="--blur"]');
        // The product's utility CSS positions this layer; use the same rectangle without loading the full app.
        Object.assign(glow.style, {position:'absolute', inset:'0'});
        let layoutReads = 0;
        const readRect = glow.getBoundingClientRect.bind(glow);
        glow.getBoundingClientRect = () => { layoutReads++; return readRect(); };
        let startWrites = 0;
        const setProperty = glow.style.setProperty.bind(glow.style);
        glow.style.setProperty = (name, value, priority) => {
          if (name === '--start') startWrites++;
          setProperty(name, value, priority);
        };
        await until(() => listeners.size === 1, 'visible listener');
        const beforeSchedule = scheduled;
        for(let i=0;i<30;i++) move();
        const framesForBurst = scheduled - beforeSchedule;
        await until(() => startWrites > 1, 'running tween');
        const activeVisible = glow.style.getPropertyValue('--active');
        card.style.marginTop = '2000px';
        await until(() => listeners.size === 0, 'offscreen cleanup');
        const hiddenReads = layoutReads;
        const hiddenWrites = startWrites;
        for(let i=0;i<30;i++) move();
        await frames();
        const offscreenIdle = layoutReads === hiddenReads && startWrites === hiddenWrites;
        const activeHidden = glow.style.getPropertyValue('--active');
        card.style.marginTop = '0';
        await until(() => listeners.size === 1, 'visible again');
        move();
        await until(() => startWrites > hiddenWrites, 'restarted tween');
        // Unmount with both a live tween and a pointer frame waiting to run.
        move();
        const frameAtUnmount = lastFrame;
        const pendingBeforeUnmount = pending.has(frameAtUnmount);
        flushSync(() => root.unmount());
        const writesAtUnmount = startWrites;
        await new Promise(resolve => setTimeout(resolve, 100));
        await fetch('/result', {method:'POST', body:JSON.stringify({
          framesForBurst, activeVisible, offscreenIdle, activeHidden,
          pendingBeforeUnmount, frameCancelled: cancelled.has(frameAtUnmount),
          listenersAfterUnmount: listeners.size, writesAfterUnmount: startWrites - writesAtUnmount, errors,
        })});
      } catch(error) { await fetch('/result', {method:'POST', body:JSON.stringify({error:String(error), errors})}); }
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
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-glow-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 20000, 'Glow browser did not report')).toEqual({
      framesForBurst: 1, activeVisible: '1', offscreenIdle: true, activeHidden: '0',
      pendingBeforeUnmount: true, frameCancelled: true, listenersAfterUnmount: 0,
      writesAfterUnmount: 0, errors: [],
    });
  } finally {
    await chrome?.close();
    server.stop(true);
  }
}, 60000);

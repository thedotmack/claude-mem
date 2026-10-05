import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

for (const mode of ['more', 'exhausted', 'loading'] as const) {
  (chrome ? it : it.skip)(`handles an empty filtered page while ${mode}`, async () => {
    const common = { itemType: 'observation', project: 'owned-project',
      content_session_id: 'owned-session', platform_source: 'claude',
      created_at_epoch: Date.now(), created_at: new Date().toISOString(),
      narrative: 'Owned fixture', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' };
    const items = [
      { ...common, id: 1, type: 'bugfix', title: 'OWNED_LOADED_BUGFIX' },
      { ...common, id: 2, type: 'discovery', title: 'OWNED_DISCOVERY' },
    ];
    const older = { ...common, id: 3, type: 'bugfix', title: 'OWNED_OLDER_BUGFIX' };
    const bundle = await build({
      write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { SessionDetailPage } from './src/ui/viewer/components/SessionDetailPage';
        import { removeLoadedRow } from './src/ui/viewer/utils/feed-deletion';
        window.confirm = () => true;
        function Probe() {
          const [items, setItems] = useState(${JSON.stringify(items)});
          const [loading, setLoading] = useState(${mode === 'loading'});
          const [hasMore, setHasMore] = useState(${mode !== 'exhausted'});
          async function loadMore() {
            setLoading(true);
            const response = await fetch('/older-page');
            const data = await response.json();
            setItems(previous => [...previous, ...data.items]);
            setHasMore(data.hasMore); setLoading(false);
          }
          return <SessionDetailPage tabs={null} title="Owned session"
            session={{ platformSource: 'claude', contentSessionId: 'owned-session' }}
            items={items} isLoading={loading} hasMore={hasMore}
            onLoadMore={loadMore} onBack={() => {}}
            onDeleted={(_type, id) => setItems(previous => removeLoadedRow(previous, id).rows)} />;
        }
        createRoot(document.getElementById('root')).render(<Probe />);
        async function settle() { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }
        (async () => {
          try {
            await fetch('/ready');
            const deadline = Date.now() + 6000;
            while (!document.querySelector('[title="Filter to Bugfix"]')) {
              if (Date.now() > deadline) throw new Error('Session did not render');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await settle();
            document.querySelector('[title="Filter to Bugfix"]').click(); await settle();
            const beforeDelete = [...document.querySelectorAll('.card-title')].map(x => x.textContent);
            document.querySelector('[title="Delete observation"]').click();
            const until = Date.now() + 1800;
            while (document.body.textContent.includes('OWNED_LOADED_BUGFIX') || !document.body.textContent.includes('OWNED_OLDER_BUGFIX')) {
              if (Date.now() > until) break;
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await settle();
            await fetch('/result', { method: 'POST', body: JSON.stringify({
              beforeDelete, afterDelete: [...document.querySelectorAll('.card-title')].map(x => x.textContent),
            }) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      ` },
    });
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    let resolveReport!: (report: unknown) => void;
    const result = new Promise(resolve => { resolveReport = resolve; });
    let deletes = 0; let pages = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response('<style>.card{min-height:2000px}</style><div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
      if (path === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
      if (path === '/ready') { markReady(); return new Response('ready'); }
      if (path === '/api/observation/1' && request.method === 'DELETE') { deletes++; return Response.json({ success: true }); }
      if (path === '/older-page') { pages++; return Response.json({ items: [older], hasMore: false }); }
      if (path === '/result') { resolveReport(await request.json()); return new Response('received'); }
      return new Response('not found', { status: 404 });
    } });
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-empty-filter-browser-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', `--user-data-dir=${profile}`, server.url.href],
      { stdout: 'ignore', stderr: 'ignore' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Chrome's first launch in a CI job can take 8-11 s, so startup gets its own
      // budget and the scenario keeps its 9 s.
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Browser page did not become ready')), 30000);
      })]);
      clearTimeout(timeout);
      const report = await Promise.race([result, new Promise(resolve => {
        timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 9000);
      })]);
      expect(deletes).toBe(1);
      expect(pages).toBe(mode === 'more' ? 1 : 0);
      expect(report).toEqual({ beforeDelete: ['OWNED_LOADED_BUGFIX'], afterDelete: mode === 'more' ? ['OWNED_OLDER_BUGFIX'] : [] });
    } finally {
      clearTimeout(timeout); child.kill(); await child.exited; server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 45000);

}

// The empty feed renders its sentinel on mount, so the mount observer can deliver
// its first notification after the initial page started loading (and failed),
// but before React's effect cleanup disconnects it. That stale notification must
// not load again: the failed page has to wait for Retry.
(chrome ? it : it.skip)('ignores a late notification from a sentinel that is no longer rendered', async () => {
  const bundle = await build({
    write: false, bundle: true, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
      import React, { useLayoutEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Feed } from './src/ui/viewer/components/Feed';
      // Notifications are delivered by hand, so the test decides when one arrives.
      const observers = [];
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
        observe(target) { this.targets.push(target); }
        unobserve() {}
        disconnect() { this.disconnected = true; }
      };
      const deliver = observer => observer.callback(observer.targets.map(target => ({ isIntersecting: true, target })), observer);
      let loads = 0;
      let deliveredBeforeCleanup = null;
      let setStep;
      function Probe() {
        const [step, set] = useState('mounted'); setStep = set;
        // Layout effects run in the commit that removed the sentinel, before the
        // passive cleanup that disconnects the mount observer.
        useLayoutEffect(() => {
          if (step !== 'loading') return;
          deliveredBeforeCleanup = !observers[0].disconnected;
          deliver(observers[0]);
        }, [step]);
        return <Feed items={[]} hasMore={true} isLoading={step === 'loading'}
          loadError={step === 'failed' ? 'Failed to load prompts' : null}
          onLoadMore={() => { loads++; }} onDeleted={() => {}} />;
      }
      createRoot(document.getElementById('root')).render(<Probe />);
      async function until(predicate) {
        const deadline = Date.now() + 6000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('Fixture did not reach expected state');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      (async () => {
        try {
          await fetch('/ready');
          await until(() => observers.length === 1 && observers[0].targets.length === 1);
          const mountSentinel = observers[0].targets[0];
          setStep('loading');
          await until(() => observers[0].disconnected);
          const lateLoads = loads;
          setStep('failed');
          await until(() => !!document.querySelector('[role="alert"]'));
          const retry = [...document.querySelectorAll('button')].some(button => button.textContent === 'Retry');
          setStep('recovered');
          await until(() => observers.length === 2 && observers[1].targets.length === 1);
          deliver(observers[1]);
          await fetch('/result', { method: 'POST', body: JSON.stringify({
            mountSentinelRemoved: !mountSentinel.isConnected, deliveredBeforeCleanup, lateLoads, retry, liveLoads: loads - lateLoads,
          }) });
        } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
      })();
    ` },
  });
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let resolveReport!: (report: unknown) => void;
  const result = new Promise(resolve => { resolveReport = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    if (path === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
    if (path === '/ready') { markReady(); return new Response('ready'); }
    if (path === '/result') { resolveReport(await request.json()); return new Response('received'); }
    return new Response('not found', { status: 404 });
  } });
  const profile = mkdtempSync(join(tmpdir(), 'claude-mem-late-sentinel-browser-'));
  const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
    '--disable-background-networking', '--no-first-run', `--user-data-dir=${profile}`, server.url.href],
    { stdout: 'ignore', stderr: 'ignore' });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Browser page did not become ready')), 30000);
    })]);
    clearTimeout(timeout);
    const report = await Promise.race([result, new Promise(resolve => {
      timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 9000);
    })]);
    expect(report).toEqual({ mountSentinelRemoved: true, deliveredBeforeCleanup: true, lateLoads: 0, retry: true, liveLoads: 1 });
  } finally {
    clearTimeout(timeout); child.kill(); await child.exited; server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}, 45000);

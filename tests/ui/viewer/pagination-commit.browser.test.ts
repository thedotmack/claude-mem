import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UI } from '../../../src/ui/viewer/constants/ui';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome or Chromium for committed feed regressions.');

for (const consumer of ['hook', 'app']) {
  for (const outcome of ['success', 'failure']) {
    (chrome ? it : it.skip)(`keeps committed A ${consumer} pagination after an abandoned B render and ${outcome}`, async () => {
      const root = resolve(import.meta.dir, '../../..');
      const esbuildBinary = createRequire(import.meta.url).resolve(
        `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
      );
      const ownedSource = mkdtempSync(join(import.meta.dir, '.commit-scope-'));
      let bundle: string;
      try {
        // App synchronizes feedScope internally in a passive effect. To isolate
        // render/commit ownership, this fixture-only copy supplies that one
        // scope through a parent prop. Its refs, pagination, callbacks and UI
        // remain production code; no product test API or hook mock is added.
        let app = readFileSync(join(root, 'src/ui/viewer/App.tsx'), 'utf8');
        const declaration = 'export function App() {';
        const stateDeclaration = 'const [feedScope, setFeedScope] = useState<FeedScope>(';
        const scopeUse = '  const scopeKey = feedScopeKey(feedScope);';
        for (const marker of [declaration, stateDeclaration, scopeUse]) {
          if (!app.includes(marker)) throw new Error('App scope fixture requires its explicit declaration: ' + marker);
        }
        app = app.replace(declaration, 'export function App({ ownedScope }: { ownedScope: FeedScope }) {')
          .replace(stateDeclaration, 'const [storedFeedScope, setFeedScope] = useState<FeedScope>(')
          .replace(scopeUse, '  const feedScope = ownedScope;\n' + scopeUse)
          .replace(/from '(\.[^']+)'/g, (_, path: string) => 'from ' + JSON.stringify(resolve(root, 'src/ui/viewer', path)));
        const appPath = join(ownedSource, 'App.tsx');
        writeFileSync(appPath, app);
        bundle = execFileSync(esbuildBinary, [
          '--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
          '--define:process.env.NODE_ENV="production"', '--log-level=error',
        ], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, input: `
          import React, { Suspense, startTransition, useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { App } from ${JSON.stringify(appPath)};
          import { usePagination } from './src/ui/viewer/hooks/usePagination';
          import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
          setStoredWelcomeDismissed(true);
          const originalFetch = window.fetch.bind(window);
          let pendingReading = false, pendingSettled = false;
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (response.headers.get('X-Owned-Pending') === 'A') {
              const read = response.json.bind(response);
              response.json = async () => { pendingReading = true; try { return await read(); } finally { pendingSettled = true; } };
            }
            return response;
          };
          const never = new Promise(() => {});
          function Gate({ scope }) {
            if (scope.project === 'B') { window.ownedBRendered = true; throw never; }
            return null;
          }
          function HookFeed({ scope }) {
            const pagination = usePagination(scope.project);
            const [rows, setRows] = useState([]);
            const [error, setError] = useState(null);
            async function load() {
              setError(null);
              try {
                const page = await pagination.observations.loadMore();
                setRows(previous => [...previous, ...page]);
              } catch (error) { setError(String(error)); }
            }
            useEffect(() => { setRows([]); void load(); }, [scope.project]);
            return <div>
              {rows.map(row => <p key={row.id}>{row.title}</p>)}
              {pagination.observations.isLoading && <p>Loading more...</p>}
              {error && <div role="alert">{error}<button disabled={pagination.observations.isLoading} onClick={load}>Retry</button></div>}
              <button id="owned-load" disabled={pagination.observations.isLoading} onClick={load}>Load more</button>
            </div>;
          }
          function Probe() {
            const [scope, setScope] = useState({ project: 'A', session: null });
            window.ownedSuspendB = () => startTransition(() => setScope({ project: 'B', session: null }));
            return <Suspense fallback={<p>UNEXPECTED_B_COMMIT</p>}>
              ${consumer === 'app' ? '<App ownedScope={scope} />' : '<HookFeed scope={scope} />'}
              <Gate scope={scope} />
            </Suspense>;
          }
          createRoot(document.getElementById('root')).render(<Probe />);
          async function until(predicate, stage) {
            const deadline = Date.now() + 6000;
            while (!predicate()) {
              if (Date.now() > deadline) throw new Error('Owned condition failed: ' + stage);
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
          async function paint() { for (let i=0; i<4; i++) await new Promise(requestAnimationFrame); }
          async function requestNext(title) {
            const deadline = Date.now() + 2000;
            while (!document.body.textContent.includes(title) && Date.now() < deadline) {
              ${consumer === 'app' ? "document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({ block: 'end' });" : "document.querySelector('#owned-load')?.click();"}
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          (async () => {
            try {
              await originalFetch('/ready');
              await until(() => document.body.textContent.includes('A_PAGE_1'), 'initial A page'); await paint();
              ${consumer === 'app' ? "document.querySelector('.feed-content')?.lastElementChild?.scrollIntoView({ block: 'end' });" : "document.querySelector('#owned-load').click();"}
              await originalFetch('/await-pending');
              await until(() => pendingReading, 'A JSON body began');
              window.ownedSuspendB();
              await until(() => window.ownedBRendered, 'B suspended'); await paint();
              const keptA = document.body.textContent.includes('A_PAGE_1') && !document.body.textContent.includes('UNEXPECTED_B_COMMIT');
              await originalFetch('/release-pending', { method: 'POST' });
              await until(() => pendingSettled, 'A pending JSON'); await paint();
              const alert = !!document.querySelector('[role="alert"]');
              const loading = document.body.textContent.includes('Loading more...');
              if (${JSON.stringify(outcome)} === 'failure') document.querySelector('[role="alert"] button')?.click();
              await requestNext('A_PAGE_2');
              const page2 = document.body.textContent.includes('A_PAGE_2');
              await requestNext('A_PAGE_3');
              await originalFetch('/result', { method: 'POST', body: JSON.stringify({
                keptA, alert, loading, page2, page3: document.body.textContent.includes('A_PAGE_3'),
                fallback: document.body.textContent.includes('UNEXPECTED_B_COMMIT'),
              }) });
            } catch (error) { await originalFetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
          })();
        ` });
      } finally { rmSync(ownedSource, { recursive: true, force: true }); }
      const html = readFileSync(join(root, 'src/ui/viewer-template.html'), 'utf8')
        .replace('src="viewer-bundle.js"', 'src="/fixture.js"');
      let releasePending!: () => void;
      const pendingGate = new Promise<void>(resolve => { releasePending = resolve; });
      let pendingStarted!: () => void;
      const pendingReady = new Promise<void>(resolve => { pendingStarted = resolve; });
      let markReady!: () => void;
      const ready = new Promise<void>(resolve => { markReady = resolve; });
      let report!: (value: unknown) => void;
      const result = new Promise<unknown>(resolve => { report = resolve; });
      const offsets: number[] = [];
      let bRequests = 0;
      let page2Attempts = 0;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        if (url.pathname === '/fixture.js') return new Response(bundle, { headers: { 'Content-Type': 'application/javascript' } });
        if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
        if (url.pathname === '/await-pending') { await pendingReady; return new Response('pending'); }
        if (url.pathname === '/release-pending') { releasePending(); return new Response('released'); }
        if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["A","B"]}\n\n'));
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
        if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) {
          if (url.searchParams.get('project') === 'B') bRequests++;
          if (url.pathname !== '/api/observations') return Response.json({ items: [], hasMore: false });
          const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
          const page = offset / UI.PAGINATION_PAGE_SIZE + 1;
          const items = Array.from({ length: page === 3 ? 1 : UI.PAGINATION_PAGE_SIZE }, (_, i) => ({
            id: offset + i + 1, project: 'A', content_session_id: 'owned-session', platform_source: 'claude',
            created_at_epoch: Date.now() - i, created_at: new Date().toISOString(), type: 'discovery',
            title: 'A_PAGE_' + page + '_' + i, narrative: 'Owned commit fixture',
            facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
          }));
          const data = JSON.stringify({ items, hasMore: page < 3 });
          if (page === 2 && ++page2Attempts === 1) {
            pendingStarted();
            return new Response(new ReadableStream({ async start(controller) {
              controller.enqueue(new TextEncoder().encode(' ')); await pendingGate;
              controller.enqueue(new TextEncoder().encode(outcome === 'failure' ? 'owned invalid JSON' : data)); controller.close();
            } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Owned-Pending': 'A' } });
          }
          return new Response(data, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
        return Response.json({});
      } });
      const profile = mkdtempSync(join(tmpdir(), 'claude-mem-committed-feed-'));
      const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--window-size=800,600', `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
        try { return await Promise.race([promise, new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned browser deadline exceeded')), milliseconds); })]); }
        finally { clearTimeout(timeout); }
      }
      try {
        await deadline(ready, 30000);
        expect(await deadline(result, 20000)).toEqual({ keptA: true, alert: outcome === 'failure', loading: false, page2: true, page3: true, fallback: false });
        expect(offsets).toEqual(outcome === 'failure'
          ? [0, UI.PAGINATION_PAGE_SIZE, UI.PAGINATION_PAGE_SIZE, UI.PAGINATION_PAGE_SIZE * 2]
          : [0, UI.PAGINATION_PAGE_SIZE, UI.PAGINATION_PAGE_SIZE * 2]);
        expect(bRequests).toBe(0);
      } finally {
        clearTimeout(timeout); releasePending(); child.kill(); await child.exited; server.stop(true);
        rmSync(profile, { recursive: true, force: true });
      }
    }, 75000);
  }
}

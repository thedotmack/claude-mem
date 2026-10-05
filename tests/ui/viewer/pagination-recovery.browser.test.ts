import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

if (process.env.CI && !chrome) {
  throw new Error('CI requires Chrome or Chromium for the pagination browser regressions.');
}

// Real App, React state/effects, HTTP and SSE; no mocked hook dispatcher.
for (const { scenario, buildDelayMs = 0, startupDelayMs = 0 } of [
  { scenario: 'partial' },
  { scenario: 'empty-timeline' },
  { scenario: 'empty-session' },
  { scenario: 'partial', buildDelayMs: 4000, startupDelayMs: 10000 },
]) {
  (chrome ? it : it.skip)(`recovers ${scenario} page failures without dropping successful rows${startupDelayMs ? ` after ${buildDelayMs}ms build setup and ${startupDelayMs}ms browser startup` : ''}`, async () => {
    if (buildDelayMs) await Bun.sleep(buildDelayMs);
    // The one-shot compiler exits before Chrome starts, keeping the browser
    // phase free of shared esbuild service handles.
    const esbuildBinary = createRequire(import.meta.url).resolve(
      `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`
    );
    const bundle = execFileSync(esbuildBinary, [
      '--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
      '--define:process.env.NODE_ENV="production"', '--log-level=error',
    ], {
      cwd: resolve(import.meta.dir, '../../..'),
      input: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { App } from './src/ui/viewer/App';
        localStorage.setItem('claude-mem-welcome-dismissed', 'true');
        if (${JSON.stringify(scenario)} === 'empty-session') location.hash = '#/sessions/claude/owned-session';
        let settled = 0;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (/\\/api\\/(observations|summaries|prompts)\\?/.test(String(args[0]))) {
            if (!response.ok) settled++;
            else {
              const read = response.json.bind(response);
              response.json = async () => { const data = await read(); settled++; return data; };
            }
          }
          return response;
        };
        createRoot(document.getElementById('root')).render(<App />);
        async function until(predicate) {
          const deadline = Date.now() + 6000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Fixture did not settle');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        async function renderSettled() { for (let i=0; i<6; i++) await new Promise(requestAnimationFrame); }
        (async () => {
          try {
            await fetch('/ready');
            await until(() => settled >= 3); await renderSettled();
            const initial = document.body.textContent;
            const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry');
            const report = { retainedObservation: initial.includes('OWNED_OBSERVATION'),
              retainedSummary: initial.includes('OWNED_SUMMARY'), loading: initial.includes('Loading more...'),
              retry: !!button, recovered: false, sessionView: !!document.querySelector('.session-detail-header') };
            if (button) {
              button.click(); await until(() => settled >= ${scenario === 'partial' ? 4 : 6}); await renderSettled();
              report.recovered = document.body.textContent.includes(${scenario === 'partial' ? "'OWNED_PROMPT'" : "'OWNED_OBSERVATION'"})
                && !document.body.textContent.includes('Loading more...')
                && !document.querySelector('[role="alert"]');
            }
            await fetch('/result', { method: 'POST', body: JSON.stringify(report) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      `,
      encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    });
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const attempts = new Map<string, number>();
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const common = { id: 1, project: 'owned-project', content_session_id: 'owned-session',
      platform_source: 'claude', created_at_epoch: Date.now(), created_at: new Date().toISOString() };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname === '/fixture.js') {
        if (startupDelayMs) await Bun.sleep(startupDelayMs);
        return new Response(bundle, { headers: { 'Content-Type': 'application/javascript' } });
      }
      if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
      if (url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":["owned-project"]}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (['/api/observations', '/api/summaries', '/api/prompts'].includes(url.pathname)) {
        const attempt = (attempts.get(url.pathname) ?? 0) + 1; attempts.set(url.pathname, attempt);
        if (attempt === 1 && (scenario !== 'partial' || url.pathname === '/api/prompts')) return new Response('owned outage', { status: 503 });
        const items = url.pathname === '/api/observations' ? [{ ...common, type: 'discovery', title: 'OWNED_OBSERVATION', narrative: 'Owned fixture', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' }]
          : url.pathname === '/api/summaries' ? [{ ...common, request: 'OWNED_SUMMARY', learned: 'Owned fixture', investigated: null, completed: null, next_steps: null }]
          : [{ ...common, prompt_text: 'OWNED_PROMPT', prompt_number: 1 }];
        return Response.json({ items, hasMore: false });
      }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return Response.json({});
    } });
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-pagination-browser-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
    let timeout: ReturnType<typeof setTimeout>;
    try {
      // Separate Chrome startup from the two rendered-page settlement phases.
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Owned pagination browser did not become ready')), 30000);
      })]);
      clearTimeout(timeout!);
      const reported = await Promise.race([result, new Promise(resolve => { timeout = setTimeout(() => resolve({ failure: 'Browser fixture timed out' }), 25000); })]);
      expect(reported).toEqual({ retainedObservation: scenario === 'partial', retainedSummary: scenario === 'partial', loading: false, retry: true, recovered: true, sessionView: scenario === 'empty-session' });
    } finally {
      clearTimeout(timeout!); child.kill(); await child.exited; server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 80000);
}

import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

// This regression needs real React effects, state updates, and HTTP ordering.
// It runs in headless Chrome when installed; no mocked React dispatcher.
for (const { oldStatus, emptySource } of [
  { oldStatus: 200, emptySource: false },
  { oldStatus: 500, emptySource: false },
  { oldStatus: 200, emptySource: true },
]) {
  (chrome ? it : it.skip)(`keeps the current preview after an older HTTP ${oldStatus} reply (emptySource=${emptySource})`, async () => {
    const root = resolve(import.meta.dir, '../../..');
    const bundle = await build({
      write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: root, loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useContextPreview } from './src/ui/viewer/hooks/useContextPreview';
        import { DEFAULT_SETTINGS } from './src/ui/viewer/constants/settings';
        let current;
        function Probe() { current = useContextPreview(DEFAULT_SETTINGS); return null; }
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
            await until(() => current?.selectedProject === 'project-a' && current.isLoading);
            await until(asyncSeen);
            if (${emptySource}) current.setSelectedSource('codex');
            else current.setSelectedProject('project-b');
            await until(() => current.selectedProject === ${emptySource ? 'null' : "'project-b'"}
              && current.preview === ${emptySource ? "'No project selected'" : "'PREVIEW_B'"} && !current.isLoading);
            await fetch('/release');
            await new Promise(resolve => setTimeout(resolve, 150));
            await fetch('/result', { method: 'POST', body: JSON.stringify({
              selectedProject: current.selectedProject, preview: current.preview,
              error: current.error, isLoading: current.isLoading,
            }) });
          } catch (error) {
            await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) });
          }
        })();
        let seen = false;
        function asyncSeen() {
          if (!seen) fetch('/seen').then(res => res.json()).then(value => { seen = value; });
          return seen;
        }
      ` },
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let seen = false;
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
      if (url.pathname === '/api/projects') return Response.json({ projects: ['project-a', 'project-b'], sources: ['claude'], projectsBySource: { claude: ['project-a', 'project-b'] } });
      if (url.pathname === '/seen') return Response.json(seen);
      if (url.pathname === '/api/context/preview') {
        if (url.searchParams.get('project') === 'project-a') { seen = true; await held; return new Response('PREVIEW_A', { status: oldStatus }); }
        return new Response('PREVIEW_B');
      }
      if (url.pathname === '/release') { release(); return new Response('released'); }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('Not found', { status: 404 });
    } });
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-preview-browser-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const reported = await Promise.race([result, new Promise(resolve => { timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 9000); })]);
      expect(reported).toEqual({ selectedProject: emptySource ? null : 'project-b', preview: emptySource ? 'No project selected' : 'PREVIEW_B', error: null, isLoading: false });
    } finally {
      clearTimeout(timeout!);
      release();
      child.kill();
      await child.exited;
      server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 12000);
}

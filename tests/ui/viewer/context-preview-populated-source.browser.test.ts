import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for context-preview regressions');
for (const source of ['codex', 'opencode']) {
  (chrome ? it : it.skip)(`selects the populated ${source} catalog instead of an empty default source`, async () => {
    const bundle = await build({ write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useContextPreview } from './src/ui/viewer/hooks/useContextPreview';
        import { DEFAULT_SETTINGS } from './src/ui/viewer/constants/settings';
        let current;
        function Probe() { current = useContextPreview(DEFAULT_SETTINGS); return null; }
        createRoot(document.getElementById('root')).render(<Probe />);
        (async () => {
          try {
            const deadline = Date.now() + 5000;
            while (!current?.sources.includes('${source}')) {
              if (Date.now() > deadline) throw new Error('Catalog did not load');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await new Promise(resolve => setTimeout(resolve, 700));
            await fetch('/result', { method: 'POST', body: JSON.stringify({
              source: current.selectedSource, project: current.selectedProject, preview: current.preview,
            }) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      ` } });
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
      if (url.pathname === '/api/projects') return Response.json({ projects: ['project'], sources: [source], projectsBySource: { [source]: ['project'] } });
      if (url.pathname === '/api/context/preview') return new Response(`PREVIEW:${url.searchParams.get('platformSource')}:${url.searchParams.get('project')}`);
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('Not found', { status: 404 });
    } });
    const profile = mkdtempSync(join(tmpdir(), 'cm-populated-preview-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const value = await Promise.race([result, new Promise(resolve => { timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 30000); })]);
      expect(value).toEqual({ source, project: 'project', preview: `PREVIEW:${source}:project` });
    } finally {
      clearTimeout(timeout!); child.kill(); await child.exited; server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 45000);
}

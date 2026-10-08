import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

(chrome ? it : it.skip)('turns every chip on when Select all is clicked with only some chips on', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'claude-mem-log-select-all-'));
  const profile = join(owned, 'browser');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const logs = [
      '[2026-10-08 10:00:00.000] [INFO ] [WORKER] OWNED_INFO',
      '[2026-10-08 10:00:01.000] [ERROR] [DB    ] OWNED_ERROR',
    ].join('\n');
    const bundle = await build({
      write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { LogsDrawer } from './src/ui/viewer/components/LogsModal';
        createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={() => {}} />);
        async function settle() { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }
        function messages() { return [...document.querySelectorAll('.log-message')].map(x => x.textContent); }
        function section(label) { return [...document.querySelectorAll('.console-filter-section')].find(x => x.textContent.startsWith(label)); }
        function chips(filters) {
          return {
            active: filters.querySelectorAll('.console-filter-chip.active').length,
            action: filters.querySelector('.console-filter-action').title,
          };
        }
        (async () => {
          try {
            const deadline = Date.now() + 6000;
            while (!document.querySelector('.log-message')) {
              if (Date.now() > deadline) throw new Error('Logs did not load');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await settle();
            const report = {};
            for (const [label, chip] of [['Levels:', 'Info'], ['Components:', 'Worker']]) {
              const filters = section(label);
              filters.querySelector('[title="' + chip + '"]').click(); await settle();
              const partial = chips(filters);
              filters.querySelector('.console-filter-action').click(); await settle();
              report[label] = { partial, clicked: { ...chips(filters), messages: messages() } };
            }
            await fetch('/result', { method: 'POST', body: JSON.stringify(report) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      ` },
    });
    let report!: (value: unknown) => void;
    const result = new Promise(resolve => { report = resolve; });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
      if (path === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
      if (path === '/api/logs') return Response.json({ logs });
      if (path === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('not found', { status: 404 });
    } });
    child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', `--user-data-dir=${profile}`, server.url.href],
      { stdout: 'ignore', stderr: 'ignore' });
    const received = await Promise.race([result, new Promise(resolve => {
      timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 25000);
    })]);
    const all = ['OWNED_INFO', 'OWNED_ERROR'];
    // With one chip off the button reads "Select all", so clicking it must turn that chip back on
    // rather than clearing the whole row.
    expect(received).toEqual({
      'Levels:': {
        partial: { active: 3, action: 'Select all' },
        clicked: { active: 4, action: 'Select none', messages: all },
      },
      'Components:': {
        partial: { active: 9, action: 'Select all' },
        clicked: { active: 10, action: 'Select none', messages: all },
      },
    });
  } finally {
    clearTimeout(timeout);
    if (child) { child.kill(); await child.exited; }
    server?.stop(true);
    rmSync(owned, { recursive: true, force: true });
  }
}, 40000);

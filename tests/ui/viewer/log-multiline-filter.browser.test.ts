import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

(chrome ? it : it.skip)('filters ordinary multiline logger records without orphaning their payloads', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'claude-mem-log-filter-'));
  const profile = join(owned, 'browser');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Load the real logger in its own process with paths isolated before any import.
    const emit = Bun.spawn([process.execPath, '--eval', `
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(process.env.CLAUDE_MEM_DATA_DIR, { recursive: true });
      writeFileSync(process.env.CLAUDE_MEM_DATA_DIR + '/settings.json', JSON.stringify({ CLAUDE_MEM_LOG_LEVEL: 'DEBUG' }));
      const { logger } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../src/utils/logger.ts'))});
      logger.debug('WORKER', 'OWNED_DEBUG', undefined, { payload: 'OWNED_DEBUG_PAYLOAD' });
      const error = new Error('OWNED_ERROR');
      error.stack = 'Error: OWNED_ERROR\\n    at OWNED_ERROR_FRAME (owned.ts:1:1)';
      logger.error('WORKER', 'OWNED_FAILURE', undefined, error);
      logger.info('DB', 'OWNED_DB');
    `], { env: { ...process.env, HOME: owned, CLAUDE_CONFIG_DIR: join(owned, 'config'),
      CLAUDE_MEM_DATA_DIR: join(owned, 'data') }, stdout: 'ignore', stderr: 'pipe' });
    expect(await emit.exited).toBe(0);
    const logDir = join(owned, 'data', 'logs');
    const logs = 'OWNED_UNCLASSIFIED\n' + readdirSync(logDir).map(name => readFileSync(join(logDir, name), 'utf8')).join('\n');
    const bundle = await build({
      write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { LogsDrawer } from './src/ui/viewer/components/LogsModal';
        createRoot(document.getElementById('root')).render(<LogsDrawer isOpen={true} onClose={() => {}} />);
        async function settle() { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }
        function messages() {
          const text = document.querySelector('.console-content').textContent;
          return {
            debug: text.includes('OWNED_DEBUG_PAYLOAD'),
            error: text.includes('OWNED_ERROR_FRAME'),
            db: text.includes('OWNED_DB'),
            raw: text.includes('OWNED_UNCLASSIFIED'),
            payloadRaw: [...document.querySelectorAll('.log-line-raw')].some(x => x.textContent.includes('OWNED_DEBUG_PAYLOAD')),
          };
        }
        function section(label) { return [...document.querySelectorAll('.console-filter-section')].find(x => x.textContent.startsWith(label)); }
        (async () => {
          try {
            const deadline = Date.now() + 10000;
            while (!document.querySelector('.log-message')) {
              if (Date.now() > deadline) throw new Error('Logs did not load');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await settle();
            const report = { initial: messages() };
            const levels = section('Levels:');
            for (const title of ['Debug', 'Info', 'Warn']) levels.querySelector('[title="' + title + '"]').click();
            await settle();
            report.errorOnly = messages();
            for (const title of ['Debug', 'Info', 'Warn']) levels.querySelector('[title="' + title + '"]').click();
            await settle();
            const components = section('Components:');
            components.querySelector('.console-filter-action').click(); await settle();
            report.none = messages();
            components.querySelector('[title="Worker"]').click(); await settle();
            report.worker = messages();
            components.querySelector('[title="Worker"]').click(); await settle();
            components.querySelector('.console-filter-action').click(); await settle();
            report.all = messages();
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
      timeout = setTimeout(() => resolve({ failure: 'Browser timed out' }), 20000);
    })]);
    const all = { debug: true, error: true, db: true, raw: true, payloadRaw: true };
    expect(received).toEqual({
      initial: all,
      errorOnly: { debug: false, error: true, db: false, raw: true, payloadRaw: false },
      none: { debug: false, error: false, db: false, raw: true, payloadRaw: false },
      worker: { debug: true, error: true, db: false, raw: true, payloadRaw: true },
      all,
    });
  } finally {
    clearTimeout(timeout);
    if (child) { child.kill(); await child.exited; }
    server?.stop(true);
    rmSync(owned, { recursive: true, force: true });
  }
}, 30000);

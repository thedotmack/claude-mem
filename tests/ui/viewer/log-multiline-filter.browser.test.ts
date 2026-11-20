import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FIXTURE_PAGE_HTML, chromeExecutablePath, compileBrowserFixture, htmlResponse, launchChrome, scriptResponse, withTimeout,
  type OwnedChrome,
} from '../../helpers/chrome-devtools';

for (const truncated of [false, true]) {
  (chromeExecutablePath ? it : it.skip)(`filters ${truncated ? 'a real 1,000-line tail starting inside' : 'complete'} multiline logger records`, async () => {
    const owned = mkdtempSync(join(tmpdir(), 'claude-mem-log-filter-'));
    let chrome: OwnedChrome | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      // Load the real logger in its own process with paths isolated before any import.
      const emit = Bun.spawn([process.execPath, '--eval', `
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(process.env.CLAUDE_MEM_DATA_DIR, { recursive: true });
        writeFileSync(process.env.CLAUDE_MEM_DATA_DIR + '/settings.json', JSON.stringify({ CLAUDE_MEM_LOG_LEVEL: 'DEBUG' }));
        const { logger } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../src/utils/logger.ts'))});
        logger.debug('WORKER', 'OWNED_DEBUG', undefined, { payload: ${truncated} ? Array.from({ length: 1100 }, () => 'OWNED_DEBUG_PAYLOAD') : 'OWNED_DEBUG_PAYLOAD' });
        const error = new Error('OWNED_ERROR');
        error.stack = 'Error: OWNED_ERROR\\n    at OWNED_ERROR_FRAME (owned.ts:1:1)';
        logger.error('WORKER', 'OWNED_FAILURE', undefined, error);
        logger.info('DB', 'OWNED_DB');
        if (${truncated}) {
          const { readdirSync } = await import('node:fs');
          const { readLastLines } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../src/services/worker/http/routes/LogsRoutes.ts'))});
          const dir = process.env.CLAUDE_MEM_DATA_DIR + '/logs';
          process.stdout.write(JSON.stringify(readLastLines(dir + '/' + readdirSync(dir)[0], 1000).lines));
        }
      `], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(owned, 'config'),
        CLAUDE_MEM_DATA_DIR: join(owned, 'data') }, stdout: 'pipe', stderr: 'pipe' });
      expect(await emit.exited).toBe(0);
      const logDir = join(owned, 'data', 'logs');
      const logs = truncated
        ? JSON.parse(await new Response(emit.stdout).text())
        : 'OWNED_UNCLASSIFIED\n' + readdirSync(logDir).map(name => readFileSync(join(logDir, name), 'utf8')).join('\n');
      if (truncated) {
        expect(logs.split('\n')).toHaveLength(1000);
        expect(logs).not.toStartWith('[');
      }
      const bundle = compileBrowserFixture(`
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
        `);
      let report!: (value: unknown) => void;
      const result = new Promise(resolve => { report = resolve; });
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/') return htmlResponse(FIXTURE_PAGE_HTML);
        if (path === '/fixture.js') return scriptResponse(bundle);
        if (path === '/api/logs') return Response.json({ logs });
        if (path === '/result') { report(await request.json()); return new Response('received'); }
        return new Response('not found', { status: 404 });
      } });
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-log-filter-browser-' });
      const received = await withTimeout(result, 20000, 'Browser timed out');
      const all = { debug: true, error: true, db: true, raw: !truncated, payloadRaw: true };
      expect(received).toEqual({
        initial: all,
        errorOnly: { debug: false, error: true, db: false, raw: false, payloadRaw: false },
        none: { debug: false, error: false, db: false, raw: false, payloadRaw: false },
        worker: { debug: !truncated, error: true, db: false, raw: false, payloadRaw: !truncated },
        all,
      });
    } finally {
      await chrome?.close();
      server?.stop(true);
      rmSync(owned, { recursive: true, force: true });
    }
  }, 30000);

}

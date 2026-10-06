import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { SettingsRoutes } from '../../../src/services/worker/http/routes/SettingsRoutes';
import { paths } from '../../../src/shared/paths';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

if (process.env.CI && !chrome) {
  throw new Error('CI requires Chrome or Chromium for the native settings-save regression tests.');
}

for (const [key, label, fallback, index] of [
  ['CLAUDE_MEM_CONTEXT_OBSERVATIONS', 'Observations', '50', 0],
  ['CLAUDE_MEM_CONTEXT_SESSION_COUNT', 'Sessions', '10', 1],
  ['CLAUDE_MEM_CONTEXT_FULL_COUNT', 'Full Observations Count', '5', 2],
] as const) {
  (chrome ? it : it.skip)(`saves the displayed fallback after clearing ${label}`, async () => {
    let posted: any;
    const bundle = await build({
      write: false, bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
      stdin: { resolveDir: resolve(import.meta.dir, '../../..'), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ContextSettingsModal } from './src/ui/viewer/components/ContextSettingsModal';
        import { useSettings } from './src/ui/viewer/hooks/useSettings';
        function Fixture() {
          const state = useSettings();
          return <ContextSettingsModal isOpen={true} onClose={() => {}} onSave={state.saveSettings}
            settings={state.settings} isSaving={state.isSaving} saveStatus={state.saveStatus} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      ` },
    });
    const styles = readFileSync(resolve(import.meta.dir, '../../../src/ui/viewer-template.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)![1];
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-count-save-'));
    const originalSettingsPath = paths.settings;
    paths.settings = () => join(profile, 'settings.json');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      if (request.path === '/api/settings' && request.method === 'POST') posted = request.body;
      next();
    });
    new SettingsRoutes({} as never).setupRoutes(app);
    app.get('/fixture.js', (_request, response) => response.type('application/javascript').send(bundle.outputFiles[0].text));
    app.get('/api/projects', (_request, response) => response.json({ projects: [], sources: [], projectsBySource: {} }));
    app.use((_request, response) => response.type('html').send('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, url], { stdout: 'ignore', stderr: 'ignore' });
    let socket: WebSocket | undefined;
    try {
      const startupDeadline = Date.now() + 10000;
      const portFile = join(profile, 'DevToolsActivePort');
      let port = '';
      while (!/^\d+$/.test(port)) {
        if (Date.now() > startupDeadline) throw new Error('Owned browser did not start');
        if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0];
        if (!/^\d+$/.test(port)) await Bun.sleep(10);
      }
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((entry: any) => entry.type === 'page' && entry.url === url);
      if (!target) throw new Error('Owned browser page was not found');
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener('open', () => resolve(), { once: true });
        socket!.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
      });
      let id = 0;
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
      socket.addEventListener('message', event => {
        const data = JSON.parse(String(event.data));
        const request = pending.get(data.id);
        if (request) {
          pending.delete(data.id);
          if (data.error) request.reject(new Error(data.error.message));
          else request.resolve(data.result);
        }
      });
      const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
        const requestId = ++id; pending.set(requestId, { resolve, reject });
        socket!.send(JSON.stringify({ id: requestId, method, params }));
      });
      const evaluate = async (expression: string) => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      const settle = () => evaluate('new Promise(async resolve => { for(let i=0;i<4;i++) await new Promise(requestAnimationFrame); resolve(true); })');
      const renderDeadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".section-header-btn")')) {
        if (Date.now() > renderDeadline) throw new Error('Settings did not render');
        await Bun.sleep(10);
      }
      const field = `document.querySelectorAll('input[type="number"]')[${index}]`;
      const fieldDeadline = Date.now() + 10000;
      while (!await evaluate(`!!(${field})`)) {
        if (Date.now() > fieldDeadline) throw new Error('Count field did not render');
        await Bun.sleep(10);
      }
      await evaluate(`${field}.focus();${field}.select()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await settle();
      expect(await evaluate(`${field}.value`)).toBe(fallback);
      await evaluate('document.querySelector(".save-btn").click()');
      const saveDeadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".save-status .success")')) {
        if (Date.now() > saveDeadline) throw new Error('Count save failed: ' + await evaluate('document.body.textContent'));
        await Bun.sleep(10);
      }
      expect(posted[key]).toBe(fallback);
      expect(JSON.parse(readFileSync(paths.settings(), 'utf8'))[key]).toBe(fallback);
    } finally {
      socket?.close(); child.kill(); await child.exited; await new Promise<void>(resolve => server.close(() => resolve()));
      paths.settings = originalSettingsPath;
      rmSync(profile, { recursive: true, force: true });
    }
  }, 30000);
}

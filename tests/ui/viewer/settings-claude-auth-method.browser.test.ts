import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

if (process.env.CI && !chrome) {
  throw new Error('CI requires Chrome or Chromium for the native settings-save regression tests.');
}

(chrome ? it : it.skip)('shows, changes and saves CLAUDE_MEM_CLAUDE_AUTH_METHOD from both Claude branches (#4598)', async () => {
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
            settings={state.settings} isLoaded={state.isLoaded} loadError={state.loadError}
            onRetryLoad={state.reload} isSaving={state.isSaving} saveStatus={state.saveStatus} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
        fetch('/ready');
      ` },
    });
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const styles = readFileSync(resolve(import.meta.dir, '../../../src/ui/viewer-template.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)![1];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
      if (path === '/ready') { markReady(); return new Response('ready'); }
      if (path === '/api/settings' && request.method === 'POST') {
        posted = await request.json();
        return Response.json({ success: true });
      }
      if (path === '/api/settings') return Response.json({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'api-key' });
      if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
      return new Response('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-auth-method-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
    let socket: WebSocket | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Separate Chrome's cold start from the settings steps. Chrome writes
      // DevToolsActivePort before it loads the page, so it exists by now.
      await Promise.race([ready, new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Owned browser did not become ready')), 30000);
      })]);
      clearTimeout(readyTimer);
      const startupDeadline = Date.now() + 10000;
      const portFile = join(profile, 'DevToolsActivePort');
      let port = '';
      while (!/^\d+$/.test(port)) {
        if (Date.now() > startupDeadline) throw new Error('Owned browser did not start');
        if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0];
        if (!/^\d+$/.test(port)) await Bun.sleep(10);
      }
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((entry: any) => entry.type === 'page' && entry.url === server.url.href);
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
      const deadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".section-header-btn:not(:disabled)")')) {
        if (Date.now() > deadline) throw new Error('Settings did not load');
        await Bun.sleep(10);
      }
      await evaluate('[...document.querySelectorAll(".section-header-btn")].find(x=>x.textContent.includes("Advanced")).click()');
      await settle();
      const authSelects = '[...document.querySelectorAll(".form-field")].filter(x=>x.textContent.startsWith("Claude Auth Method")).map(x=>x.querySelector("select"))';
      // The provider dropdowns' Claude options (other selects also carry a "claude" value, e.g. source filters).
      const claudeLabels = '[...document.querySelectorAll(\'option[value="claude"]\')].map(o=>o.textContent).filter(t=>t.startsWith("Claude ("))';
      while ((await evaluate(`${authSelects}.length`)) !== 2) {
        if (Date.now() > deadline) throw new Error('Auth method selects did not render');
        await Bun.sleep(10);
      }
      const loaded = { values: await evaluate(`${authSelects}.map(s=>s.value)`), labels: await evaluate(claudeLabels) };
      // Change the FALLBACK select: both selects and both labels follow the one setting.
      await evaluate(`(() => { const s = ${authSelects}[1]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'gateway'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await settle();
      const changed = { values: await evaluate(`${authSelects}.map(s=>s.value)`), labels: await evaluate(claudeLabels) };
      await evaluate('document.querySelector(".save-btn").click()');
      while (!posted) {
        if (Date.now() > deadline) throw new Error('Save did not reach owned endpoint');
        await Bun.sleep(10);
      }
      expect({ loaded, changed, saved: posted.CLAUDE_MEM_CLAUDE_AUTH_METHOD }).toEqual({
        loaded: { values: ['api-key', 'api-key'], labels: ['Claude (uses an API key)', 'Claude (uses an API key)'] },
        changed: { values: ['gateway', 'gateway'], labels: ['Claude (via a gateway)', 'Claude (via a gateway)'] },
        saved: 'gateway',
      });
    } finally {
      clearTimeout(readyTimer); socket?.close(); child.kill(); await child.exited; server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 80000);

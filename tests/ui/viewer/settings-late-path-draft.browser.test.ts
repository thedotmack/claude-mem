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

for (const succeeds of [true]) {
  (chrome ? it : it.skip)('retains a fresh unsaved modal edit after the late file-only path loads', async () => {
    let posted: any;
    let releaseLoad!:()=>void;
    const loadReady=new Promise<void>(resolve=>{releaseLoad=resolve});
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
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
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture.js') return new Response(bundle.outputFiles[0].text, { headers: { 'Content-Type': 'application/javascript' } });
      if (path === '/api/settings' && request.method === 'POST') {
        posted = await request.json(); await responseReady;
        return Response.json(succeeds ? { success: true } : { error: 'Owned rejection' }, { status: succeeds ? 200 : 400 });
      }
      if (path === '/api/settings') {await loadReady; return Response.json({ CLAUDE_MEM_PROVIDER:'claude', CLAUDE_MEM_CODEX_MODEL:'loaded-old', CLAUDE_CODE_PATH:'/owned/claude' });}
      if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
      return new Response('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-session-keyboard-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
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
      const renderDeadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".section-header-btn")')) {
        if (Date.now() > renderDeadline) throw new Error('Settings did not render');
        await Bun.sleep(10);
      }
      await evaluate('[...document.querySelectorAll(".section-header-btn")].find(x=>x.textContent.includes("Advanced")).click()');
      await settle();
      const model = '[...document.querySelectorAll(".form-field")].find(x=>x.textContent.startsWith("Codex Model")).querySelector("input")';
      await evaluate(`const select=[...document.querySelectorAll('.form-field')].find(x=>x.textContent.startsWith('AI Provider')).querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'codex'); select.dispatchEvent(new Event('change',{bubbles:true}));`);
      await settle();
      await evaluate(`${model}.focus();${model}.select()`);
      await send('Input.insertText', { text: 'owned-A' }); await settle();
      expect(await evaluate(`${model}.value`)).toBe('owned-A');
      await evaluate('document.querySelector(".save-btn").click()');
      const saveDeadline = Date.now() + 10000;
      while (!posted || !await evaluate('document.querySelector(".save-btn").disabled')) {
        if (Date.now() > saveDeadline) throw new Error('Save did not reach owned endpoint');
        await Bun.sleep(10);
      }
      release();
      while (await evaluate('document.querySelector(".save-btn").disabled')) {
        if(Date.now()>saveDeadline)throw Error('Save did not finish'); await Bun.sleep(10);
      }
      await settle();
      await evaluate(`${model}.focus();${model}.select()`);
      await send('Input.insertText',{text:'unsaved-B'}); await settle();
      expect(await evaluate(`${model}.value`)).toBe('unsaved-B');
      releaseLoad();
      const pathInput='[...document.querySelectorAll(".form-field")].find(x=>x.textContent.startsWith("Claude Code CLI path")).querySelector("input")';
      const loadDeadline=Date.now()+10000;
      while(!await evaluate(`${pathInput}.value === '/owned/claude'`)) {
        if(Date.now()>loadDeadline)throw Error('Late path did not render'); await Bun.sleep(10);
      }
      expect(await evaluate(`${model}.value`)).toBe('unsaved-B');
      expect(posted.CLAUDE_MEM_CODEX_MODEL).toBe('owned-A');
      expect(posted.CLAUDE_CODE_PATH).toBeUndefined();
    } finally {
      releaseLoad(); release(); socket?.close(); child.kill(); await child.exited; server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 30000);
}

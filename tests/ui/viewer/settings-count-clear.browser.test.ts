import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SettingsRoutes } from '../../../src/services/worker/http/routes/SettingsRoutes';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager';
import { paths } from '../../../src/shared/paths';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

if (process.env.CI && !chrome) {
  throw new Error('CI requires Chrome or Chromium for the native settings-save regression tests.');
}

// The stored counts differ from the defaults, so a clear the form ignored
// cannot pass for a clear that fell back to the default.
const COUNT_FIELDS = [
  { label: 'Observations', key: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS', stored: '75' },
  { label: 'Sessions', key: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT', stored: '20' },
  { label: 'Count', key: 'CLAUDE_MEM_CONTEXT_FULL_COUNT', stored: '3' },
] as const;

(chrome ? it : it.skip)('saves the shipped default when a count field is cleared', async () => {
  const shipped = COUNT_FIELDS.map(({ key }) => SettingsDefaultsManager.getAllDefaults()[key]);
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
  const styles = readFileSync(resolve(import.meta.dir, '../../../src/ui/viewer-template.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)![1];
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-count-clear-'));
  const profile = join(root, 'chrome');
  const settingsPath = join(root, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(Object.fromEntries(COUNT_FIELDS.map(({ key, stored }) => [key, stored]))));
  const originalSettingsPath = paths.settings;
  paths.settings = () => settingsPath;
  // GET applies environment overrides; these counts must come from the file.
  const priorEnvironment = COUNT_FIELDS.map(({ key }) => [key, process.env[key]] as const);
  for (const { key } of COUNT_FIELDS) delete process.env[key];
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  let posted: Record<string, unknown> | undefined;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    if (request.path === '/api/settings' && request.method === 'POST') posted = request.body;
    next();
  });
  // The real routes: the cleared value has to pass validation and reach the file.
  new SettingsRoutes({} as never).setupRoutes(app);
  app.get('/fixture.js', (_request, response) => response.type('application/javascript').send(bundle.outputFiles[0].text));
  app.get('/ready', (_request, response) => { markReady(); response.send('ready'); });
  app.get('/api/projects', (_request, response) => response.json({ projects: [], sources: [], projectsBySource: {} }));
  app.use((_request, response) => response.type('html').send('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { stdout: 'ignore', stderr: 'ignore' });
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
    const input = (label: string) => `[...document.querySelectorAll('.form-field')]
      .find(field => field.querySelector('.form-field-label')?.firstChild?.textContent === ${JSON.stringify(label)})?.querySelector('input')`;
    const shown = () => evaluate(`[${COUNT_FIELDS.map(({ label }) => input(label)).join(', ')}].map(field => field?.value ?? null)`);
    // The fieldset stays disabled until GET /api/settings succeeds, and a
    // disabled input ignores the keys. The stored counts show once it has.
    const loadDeadline = Date.now() + 20000;
    const stored = JSON.stringify(COUNT_FIELDS.map(({ stored }) => stored));
    while (!(await evaluate(`document.querySelector('fieldset.settings-column')?.disabled === false`)
      && JSON.stringify(await shown()) === stored)) {
      if (Date.now() > loadDeadline) throw new Error('Settings did not load: ' + JSON.stringify(await shown()));
      await Bun.sleep(10);
    }
    for (const { label } of COUNT_FIELDS) {
      await evaluate(`${input(label)}.focus()`);
      // DOM select() does not reliably select a number input's text, so use
      // the browser's own editing command, as a user's select-all would.
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await settle();
    }
    const displayed = await shown();
    await evaluate('document.querySelector(".save-btn").click()');
    const saveDeadline = Date.now() + 10000;
    while (!await evaluate('!!document.querySelector(".save-status .success")')) {
      if (Date.now() > saveDeadline) throw new Error('Save did not succeed: ' + await evaluate('document.querySelector(".save-status").textContent'));
      await Bun.sleep(10);
    }
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect({
      displayed,
      posted: COUNT_FIELDS.map(({ key }) => posted?.[key]),
      persisted: COUNT_FIELDS.map(({ key }) => persisted[key]),
    }).toEqual({ displayed: shipped, posted: shipped, persisted: shipped });
  } finally {
    clearTimeout(readyTimer); socket?.close(); child.kill(); await child.exited;
    await new Promise<void>(resolve => server.close(() => resolve()));
    paths.settings = originalSettingsPath;
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 80000);

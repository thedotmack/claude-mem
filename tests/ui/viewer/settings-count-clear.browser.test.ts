import { expect, it } from 'bun:test';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsRoutes } from '../../../src/services/worker/http/routes/SettingsRoutes';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager';
import { paths } from '../../../src/shared/paths';
import {
  UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, failOnCiWithoutChrome, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { compileSettingsFixture, connectLoadedSettings, launchSettingsFixture, settingsFixtureHtml } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

// The stored counts differ from the defaults, so a clear the form ignored
// cannot pass for a clear that fell back to the default.
const COUNT_FIELDS = [
  { label: 'Observations', key: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS', stored: '75' },
  { label: 'Sessions', key: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT', stored: '20' },
  { label: 'Count', key: 'CLAUDE_MEM_CONTEXT_FULL_COUNT', stored: '3' },
] as const;

(chromeExecutablePath ? it : it.skip)('saves the shipped default when a count field is cleared', async () => {
  const shipped = COUNT_FIELDS.map(({ key }) => SettingsDefaultsManager.getAllDefaults()[key]);
  const bundle = compileSettingsFixture();
  const html = settingsFixtureHtml();
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-count-clear-'));
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
  app.get('/fixture.js', (_request, response) => response.type('application/javascript').send(bundle));
  app.get('/ready', (_request, response) => { markReady(); response.send('ready'); });
  app.get('/api/projects', (_request, response) => response.json({ projects: [], sources: [], projectsBySource: {} }));
  app.use((_request, response) => response.type('html').send(html));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(url, ready, 'claude-mem-count-clear-chrome-', UNTHROTTLED_TIMER_FLAGS);
    page = await connectLoadedSettings(chrome, url, 20000);
    const { send, evaluate, settle } = page;
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
    page?.close(); await chrome?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    paths.settings = originalSettingsPath;
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 80000);

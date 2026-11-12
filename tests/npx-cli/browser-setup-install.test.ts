import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

// The installer's TTY flag and settings paths are read at import, so the cases run in a fresh Bun process
// (the same pattern as combined-installer-boundaries.test.ts). The child drives the public install command through
// controlled prompts and an in-process worker that serves the real setup endpoints, and plays the browser itself.
if (process.env.CLAUDE_MEM_BROWSER_SETUP_FIXTURE_CHILD !== import.meta.path) {
  describe('isolated browser-setup installer fixture', () => {
    it('passes every case in a fresh Bun process', () => {
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, CLAUDE_MEM_BROWSER_SETUP_FIXTURE_CHILD: import.meta.path },
        stdout: 'pipe', stderr: 'pipe', timeout: 180_000,
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      expect(child.exitCode).toBe(0);
    }, 210_000);
  });
} else {
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const fixture = mkdtempSync(join(scratchRoot, 'browser-setup-install-'));
const hostHome = join(fixture, 'host-home');
const data = join(fixture, 'data');
const bin = join(fixture, 'bin');
for (const dir of [hostHome, data, bin]) mkdirSync(dir, { recursive: true });
const realOs = { ...await import('node:os') };
const scopedOs = { ...realOs, homedir: () => hostHome };
const originalOsDefault = Object.getOwnPropertyDescriptor(realOs, 'default');
if (originalOsDefault) Object.defineProperty(scopedOs, 'default', { ...originalOsDefault, value: { ...originalOsDefault.value, homedir: scopedOs.homedir } });
mock.module('os', () => scopedOs);
mock.module('node:os', () => scopedOs);
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
// The checkout wait listens for Ctrl-C in raw mode, as on a real terminal.
if (typeof (process.stdin as { setRawMode?: unknown }).setRawMode !== 'function') {
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => process.stdin });
}
process.env.CLAUDE_MEM_DATA_DIR = data;
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'claude');
process.env.CLAUDE_MEM_ENV_FILE = join(data, '.env');
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.DO_NOT_TRACK = '1';
// CI hides the optional email question; these cases play a person at a terminal.
delete process.env.CI;
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_MEM_PROVIDER', 'CLAUDE_MEM_OPENROUTER_API_KEY']) delete process.env[key];

// A free loopback port for the fixture worker.
const port = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});
const workerBase = `http://127.0.0.1:${port}`;
const settingsPath = join(data, 'settings.json');
const statePath = join(data, 'setup-state.json');
const sessionPath = join(data, 'setup-session.json');
const intentCredentialsPath = join(data, 'intent-install.json');
const intentCredentials = { install_id: '1'.repeat(32), intent_token: '2'.repeat(64) };
// The worker is managed "externally" so the installer never tries to stop it: the fixture owns its lifecycle.
const baseSettings = { CLAUDE_MEM_WORKER_PORT: String(port), CLAUDE_MEM_WORKER_AUTOSTART: 'false' };

const prompts = { ...await import('@clack/prompts') };
const banner = { ...await import('../../src/npx-cli/banner.js') };
const usage = { ...await import('../../src/npx-cli/install/usage-summary.js') };
const spawnGate = { ...await import('../../src/shared/worker-spawn-gate.js') };
const spawner = { ...await import('../../src/services/worker-spawner.js') };
const cliPaths = { ...await import('../../src/npx-cli/utils/paths.js') };
const memoryCredentials = { ...await import('../../src/npx-cli/cmem-memory-credentials.js') };
const browserSetup = { ...await import('../../src/npx-cli/install/browser-setup.js') };
const skillSelection = { ...await import('../../src/shared/skill-selection.js') };
mock.module('../../src/shared/skill-selection.js', () => ({ ...skillSelection, applyConfiguredSkillSelection: () => ({ disabled: [], enabled: [], warnings: [] }) }));
let backgroundPolls = 0;
mock.module('../../src/npx-cli/install/browser-setup.js', () => ({
  ...browserSetup,
  runBrowserSetup: (deps: Parameters<typeof browserSetup.runBrowserSetup>[0]) => browserSetup.runBrowserSetup({ ...deps, pollIntervalMs: 10 }),
  waitForBackgroundWorkToFinish: (deps: Parameters<typeof browserSetup.waitForBackgroundWorkToFinish>[0]) => browserSetup.waitForBackgroundWorkToFinish({
    ...deps, pollIntervalMs: 10,
    sleep: async (ms) => { backgroundPolls++; await new Promise(resolve => setTimeout(resolve, ms)); },
  }),
}));
const packageVersion = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')).version;
mock.module('../../src/npx-cli/utils/paths.js', () => ({ ...cliPaths, readPluginVersion: () => packageVersion, npmPackagePluginDirectory: () => join(import.meta.dir, '..', '..', 'plugin') }));

const lines: string[] = [];
const questions: string[] = [];
const ranTasks: string[] = [];
const offeredTasks: string[] = [];
const providerMenus: Array<{ options: Array<{ value: string }>; initialValues: string[] }> = [];
let workerStarts = 0;
const workerStartStates: unknown[] = [];
const workerStartSessions: unknown[] = [];
const workerStartSettings: unknown[] = [];
let fixtureWorkerResult: 'ready' | 'dead' = 'ready';
let providerAnswer = 'cmem';
let passwordAnswer: string | symbol = 'new-provider-key';
mock.module('@clack/prompts', () => ({
  ...prompts,
  intro: () => {}, outro: (value: string) => lines.push(value), cancel: (value: string) => lines.push(value),
  note: (value: string, title?: string) => lines.push(`${title}\n${value}`),
  spinner: () => ({ start: (value: string) => lines.push(value), stop: (value: string) => lines.push(value), message: () => {} }),
  multiselect: async (options: { message: string; options: Array<{ value: string }>; initialValues: string[] }) => {
    questions.push(options.message);
    // The terminal flow's provider prompt: CMEM Pro, whose sign-in is the login boundary below.
    if (options.message.startsWith('Select Provider')) {
      providerMenus.push(options);
      return [providerAnswer];
    }
    return ['claude-code'];
  },
  select: async (options: { message: string }) => {
    questions.push(options.message);
    if (options.message.startsWith('Which runtime')) return 'worker';
    if (options.message.startsWith('Disable Claude Code auto-memory')) return 'leave-enabled';
    return 'claude-haiku-4-5-20251001';
  },
  confirm: async (options: { message: string }) => { questions.push(options.message); return false; },
  // The optional email opt-in: Enter (empty) skips it, so the note question never follows.
  text: async (options: { message: string }) => { questions.push(options.message); return ''; },
  password: async (options: { message: string }) => { questions.push(options.message); return passwordAnswer; },
  // Plugin copy and dependency installs are other suites' business; IDE hooks and the worker start run for real.
  tasks: async (tasks: Array<{ title: string; task: (message: (value: string) => void) => Promise<string> }>) => {
    for (const task of tasks) {
      offeredTasks.push(task.title);
      if (!/^(Starting worker daemon|Claude Code)/.test(task.title)) continue;
      ranTasks.push(task.title);
      lines.push(await task.task((value) => lines.push(value)));
    }
  },
  log: Object.fromEntries(['info', 'success', 'warn', 'error', 'message', 'step'].map(key => [key, (value: string) => lines.push(value)])),
}));
mock.module('../../src/npx-cli/banner.js', () => ({ ...banner, playBanner: async () => {} }));
// Host mode probes for an observer the user already runs; the host case only needs the settings it writes.
mock.module('../../src/npx-cli/cmem-memory-credentials.js', () => ({
  ...memoryCredentials,
  buildHostObserverSettings: () => ({ CLAUDE_MEM_PROVIDER: 'openrouter' }),
}));
mock.module('../../src/npx-cli/install/usage-summary.js', () => ({ ...usage, readUsageSummary: async () => null }));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({ ...spawnGate, holdSpawnLock: async () => () => {} }));

// The fixture worker: the real WorkViewRoutes setup endpoints on the configured port.
const express = (await import('express')).default;
const { WorkViewRoutes } = await import('../../src/services/worker/http/routes/WorkViewRoutes.js');
let worker: { server: Server; routes: InstanceType<typeof WorkViewRoutes> } | null = null;
/** The extraction run (the automatic refresh) as the routes see it: 'running' in this process until a case ends it. */
const extraction = {
  running: false,
  restartsWhileRunning: 0,
  status() { return this.running ? { state: 'running', pid: process.pid, reason: 'setup-scan', startedAt: new Date().toISOString() } : null; },
  start() {}, close() {}, async runNow() { return 'idle'; },
};
async function startFixtureWorker(): Promise<void> {
  if (worker) return;
  const routes = new WorkViewRoutes({
    databasePath: join(import.meta.dir, '..', 'fixtures', 'prompt-import', 'home', 'no-work-state.db'),
    reviewPath: ':memory:', humanCopy: null, ledgerDir: null, setupScan: null, setupStatePath: statePath, settingsPath,
    autoRefresh: extraction as never,
  });
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => { res.json({ port }); });
  routes.setupRoutes(app);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  worker = { server, routes };
}
async function stopFixtureWorker(): Promise<void> {
  if (!worker) return;
  worker.routes.close();
  await new Promise<void>((resolve) => worker!.server.close(() => resolve()));
  worker = null;
}
mock.module('../../src/services/worker-spawner.js', () => ({
  ...spawner,
  ensureWorkerStarted: async () => {
    workerStarts++;
    workerStartStates.push(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
    workerStartSessions.push(existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf8')) : null);
    workerStartSettings.push(JSON.parse(readFileSync(settingsPath, 'utf8')));
    if (extraction.running) extraction.restartsWhileRunning++;
    if (fixtureWorkerResult === 'dead') return 'dead';
    await startFixtureWorker();
    return 'ready';
  },
  getLastWorkerBootFailure: () => undefined,
}));

// The browser opener, observed instead of launching anything.
const childProcess = await import('node:child_process');
const realSpawnSync = childProcess.spawnSync;
const opened: string[] = [];
const spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: any) => {
  if (['open', 'xdg-open', 'cmd'].includes(command)) { opened.push(args[args.length - 1]); return { status: 0 } as any; }
  return realSpawnSync(command, args, options);
}) as typeof childProcess.spawnSync);

// Network: loopback to the fixture worker is real; cmem.ai answers only the pairing start; anything else is a failure.
const realFetch = globalThis.fetch;
const { CMEM_INSTALLER_OAUTH_START_URL, CMEM_INSTALLER_OAUTH_POLL_URL } = await import('../../src/npx-cli/cmem-pro-costs.js');
const pairingStarts: number[] = [];
const pairingStartHeaders: Headers[] = [];
/** What cmem.ai's pairing poll answers next, in order (a 410 is a cancelled or expired checkout). */
const pollAnswers: Array<{ status: number; body: unknown }> = [];
const READY_BODY = {
  status: 'ready', user_id: 'user-1', setup_token: 'sync-token', hub_url: 'https://cmem.ai/api/sync',
  memory_key: 'pro-memory-key', memory_base_url: 'https://cmem.ai/api/gateway/v1', memory_model: 'cmem-memory', plan: 'trial', trial: { ends_at: '2026-11-22T00:00:00.000Z' },
};
const setupRequests: string[] = [];
const unexpected: string[] = [];
const pairingId = 'a'.repeat(32);
const startOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(workerBase)) {
    if (url.includes('/api/setup/')) setupRequests.push(url.slice(workerBase.length));
    return realFetch(input, init);
  }
  if (url === CMEM_INSTALLER_OAUTH_POLL_URL) {
    const answer = pollAnswers.shift() ?? { status: 202, body: { status: 'pending', stage: 'awaiting_checkout' } };
    return Response.json(answer.body, { status: answer.status });
  }
  if (url === CMEM_INSTALLER_OAUTH_START_URL) {
    pairingStarts.push(Date.now());
    pairingStartHeaders.push(new Headers(init?.headers));
    return Response.json({
      pairing_id: pairingId, secret: 'b'.repeat(48), user_code: 'ABCD-EFGH', poll_interval: 3, expires_in: 900,
      authorization_url: `${startOrigin}/login?next=${encodeURIComponent(`/api/pro/trial/claim?pairing=${pairingId}&login_only=1`)}`,
      checkout_url: `${startOrigin}/api/pro/trial/claim?pairing=${pairingId}&trial=1`,
    });
  }
  unexpected.push(url);
  throw new Error(`Unexpected HTTP ${url}`);
}) as typeof fetch);
const exit = spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => { throw new Error('EXIT_' + code); });

const { runInstallCommand } = await import('../../src/npx-cli/commands/install.js');

beforeEach(async () => {
  await stopFixtureWorker();
  rmSync(statePath, { force: true });
  rmSync(sessionPath, { force: true });
  rmSync(intentCredentialsPath, { force: true });
  writeFileSync(settingsPath, JSON.stringify(baseSettings, null, 2));
  lines.length = 0; questions.length = 0; ranTasks.length = 0; offeredTasks.length = 0; opened.length = 0;
  pairingStarts.length = 0; pairingStartHeaders.length = 0; setupRequests.length = 0; unexpected.length = 0; workerStarts = 0; pollAnswers.length = 0;
  workerStartStates.length = 0;
  workerStartSessions.length = 0;
  workerStartSettings.length = 0;
  providerMenus.length = 0;
  backgroundPolls = 0;
  fixtureWorkerResult = 'ready';
  providerAnswer = 'cmem';
  passwordAnswer = 'new-provider-key';
  extraction.running = false; extraction.restartsWhileRunning = 0;
});
afterAll(async () => {
  await stopFixtureWorker();
  spawnSyncSpy.mockRestore(); fetchSpy.mockRestore(); exit.mockRestore();
  rmSync(fixture, { recursive: true, force: true });
});

const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, string>;
async function browserState(): Promise<any> {
  return (await realFetch(`${workerBase}/api/setup/state`)).json();
}
async function waitForInstall(status: string): Promise<any> {
  for (;;) {
    try { const state = await browserState(); if (state.install?.status === status) return state; } catch { /* worker not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function waitForStage(stage: string): Promise<any> {
  for (;;) {
    try {
      const state = await browserState();
      if (stage === 'waiting-for-choice' && state.install?.status === 'waiting') {
        const response = await browserPost('/api/setup/install', { ...state.install.catalog.defaults, agents: ['claude-code'], installClaudeCode: false });
        expect(response.status).toBe(200);
      }
      if (state.installer?.stage === stage && (stage !== 'waiting-for-choice' || state.install?.status === 'ready')) return state;
    } catch { /* worker not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function waitForCheckout(checkout: string): Promise<any> {
  for (;;) {
    const state = await browserState();
    if (state.checkout?.state === checkout) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const browserPost = (path: string, body: unknown) => realFetch(`${workerBase}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: workerBase }, body: JSON.stringify(body),
});

describe('install in GUI mode (interactive TTY, no --provider)', () => {
  it('lets the browser restore native auto-memory without removing other Claude settings', async () => {
    const { claudeSettingsPath } = cliPaths;
    mkdirSync(join(fixture, 'claude'), { recursive: true });
    writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', OTHER_SETTING: 'keep' } }));
    const installing = runInstallCommand({});
    const waiting = await waitForInstall('waiting');
    expect(waiting.install.catalog.defaults.disableAutoMemory).toBe(true);
    expect(offeredTasks).not.toContain('Claude Code: registering plugin');
    expect((await browserPost('/api/setup/install', { ...waiting.install.catalog.defaults, agents: ['claude-code'], disableAutoMemory: false })).status).toBe(200);
    await waitForInstall('ready');
    expect(JSON.parse(readFileSync(claudeSettingsPath(), 'utf8')).env).toEqual({ OTHER_SETTING: 'keep' });
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await installing;
    expect(questions).toEqual([]);
  });

  it('offers the default model when the saved one is not allowed outside the gateway, and At Home still finishes', async () => {
    writeFileSync(settingsPath, JSON.stringify({ ...baseSettings, CLAUDE_MEM_MODEL: 'my-gateway-model', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' }, null, 2));
    const installing = runInstallCommand({});
    const waiting = await waitForInstall('waiting');
    expect(waiting.install.catalog.defaults.claudeModel).toBe('haiku');
    expect((await browserPost('/api/setup/install', { ...waiting.install.catalog.defaults, agents: ['claude-code'] })).status).toBe(200);
    await waitForInstall('ready');
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await installing;
    // The untouched default changes nothing: the saved value stays as it was, and nothing threw.
    expect(readSettings().CLAUDE_MEM_MODEL).toBe('my-gateway-model');
  });

  it('saves the browser email signup that the worker never serves back', async () => {
    const installing = runInstallCommand({});
    const waiting = await waitForInstall('waiting');
    expect(waiting.install.catalog.defaults.email).toBeUndefined();
    const email = 'person@example.com';
    expect((await browserPost('/api/setup/install', { ...waiting.install.catalog.defaults, agents: ['claude-code'], email, note: 'hello' })).status).toBe(200);
    const ready = await waitForInstall('ready');
    expect(JSON.stringify(ready)).not.toContain(email);
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: email, CLAUDE_MEM_ONLINE_SIGNUP_NOTE: 'hello' });
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await installing;
  });

  it('leaves all choices pending when deferred, then resumes without stopping or copying the worker', async () => {
    await runInstallCommand({ setup: 'defer' });
    const deferred = await browserState();
    expect(deferred.status).toBe('pending');
    expect(deferred.install.status).toBe('waiting');
    expect(deferred.install.selection).toBeNull();
    expect(questions).toEqual([]);
    expect(offeredTasks).not.toContain('Claude Code: registering plugin');
    expect(opened).toEqual([]);
    expect(existsSync(sessionPath)).toBe(false);

    const selected = { ...deferred.install.catalog.defaults, agents: ['codex-cli'], claudeModel: 'sonnet' };
    writeFileSync(statePath, JSON.stringify({ ...deferred, install: { ...deferred.install, status: 'installing', selection: selected } }));
    offeredTasks.length = 0;
    const resume = runInstallCommand({ setup: 'resume' });
    await waitForStage('waiting-for-choice');
    expect(offeredTasks).not.toContain('Caching plugin version');
    expect(offeredTasks).not.toContain('Starting worker daemon');
    expect(workerStarts).toBe(1);
    expect(opened).toEqual([]);
    expect(questions).toEqual([]);
    const ready = await browserState();
    expect(ready.install.selection.agents).toEqual(['codex-cli']);
    expect(offeredTasks.some(task => task.startsWith('Codex CLI'))).toBe(true);
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await resume;
    expect(readSettings().CLAUDE_MEM_MODEL).toBe('sonnet');
  });

  it('At Home: starts the worker, opens the setup page, asks for no login, and finishes when the page does', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    // The worker is up before any login or provider question, and the page is open.
    expect(workerStarts).toBe(1);
    expect(workerStartStates).toEqual([{ status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null }]);
    expect(workerStartSessions).toMatchObject([{ pid: process.pid, already_pro: false }]);
    expect((workerStartSessions[0] as { setup_flow_id: string }).setup_flow_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
    expect(pairingStarts).toEqual([]);

    expect((await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' })).status).toBe(200);
    await waitForStage('home-ready');
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;

    // useSubscriptionAuth(): local, logged-in Claude SDK account; no claude-mem login at all.
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription', CLAUDE_MEM_CLOUD_SYNC_TOKEN: '' });
    expect(pairingStarts).toEqual([]);
    // Every choice is made in the browser, including email and telemetry.
    expect(questions).toEqual([]);
    expect(questions.filter(q => q.startsWith('Your work email'))).toHaveLength(0);
    expect(questions.some(q => q.includes('how can we help'))).toBe(false);
    // No provider multiselect and no model question: the browser made the choice, the model keeps its default.
    expect(questions.filter(q => !q.startsWith('Which agents') && !q.startsWith('Which runtime') && !q.startsWith('Disable Claude Code') && !q.startsWith('Install Claude Code') && !q.startsWith('Your work email'))).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'complete', choice: { branch: 'home' }, installer: { stage: 'home-ready' } });
    expect(lines.join('\n')).toContain('Not required (local provider)');
    expect(lines.join('\n')).toContain('claude-mem installed successfully!');
    expect(existsSync(sessionPath)).toBe(false);
    expect(ranTasks).toContain('Claude Code: registering plugin');
    expect(unexpected).toEqual([]);
  });

  it('clears an interrupted GUI hand-off before the worker starts', async () => {
    writeFileSync(statePath, JSON.stringify({ status: 'pending', choice: { branch: 'go', memoryBilling: 'hosted', chosenAt: 'earlier' },
      installer: { stage: 'go-awaiting-checkout', error: null, updatedAt: 'earlier' },
      checkout: { state: 'requested', requests: 1, error: null, updatedAt: 'earlier' }, tools: ['codex'], completedAt: null }));
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    expect(workerStartStates[0]).toEqual({ status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null });
    expect(pairingStarts).toEqual([]);
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await install;
  });

  it('Finish Setup: local tools picked in the browser that this run did not install are set up after the page finishes', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    expect(offeredTasks.filter(title => title.startsWith('Codex CLI'))).toEqual([]);
    expect((await browserPost('/api/setup/complete', { tools: ['claude-code', 'codex', 'chatgpt'] })).status).toBe(200);
    await install;
    // Claude Code was already installed by this run; Codex is new; ChatGPT is a cloud reader with nothing to install.
    expect(offeredTasks.filter(title => title.startsWith('Codex CLI'))).toHaveLength(1);
    expect(offeredTasks.filter(title => title === 'Claude Code: registering plugin')).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tools).toEqual(['claude-code', 'codex', 'chatgpt']);
    expect(lines.join('\n')).toMatch(/Agents: .*claude-code, codex-cli/);
  });

  it('On The Go: the pairing starts only after the choice, checkout runs when the page asks, and setup finishes once paid', async () => {
    writeFileSync(intentCredentialsPath, JSON.stringify(intentCredentials), { mode: 0o600 });
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    expect(pairingStarts).toEqual([]);
    expect((await browserPost('/api/setup/checkout', {})).status).toBe(409);
    expect((await browserPost('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' })).status).toBe(200);
    const handOff = await waitForStage('go-awaiting-checkout');
    expect(pairingStarts).toHaveLength(1);
    expect(pairingStartHeaders[0].get('X-Intent-Install-Id')).toBe(intentCredentials.install_id);
    expect(pairingStartHeaders[0].get('X-Intent-Token')).toBe(intentCredentials.intent_token);
    expect(handOff.choice).toMatchObject({ branch: 'go', memoryBilling: 'hosted' });
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
    // Not before checkout.
    expect((await browserPost('/api/setup/complete', {})).status).toBe(409);

    pollAnswers.push({ status: 200, body: READY_BODY });
    expect((await browserPost('/api/setup/checkout', {})).status).toBe(200);
    const paid = await waitForCheckout('paid');
    expect(paid.alreadyPro).toBe(true);
    // The existing path: the pairing's checkout URL (/api/pro/trial/claim), opened by the installer.
    expect(opened).toEqual([`${workerBase}/?setup=1`, `${startOrigin}/api/pro/trial/claim?pairing=${pairingId}&trial=1`]);
    // Paid checkout promotes the staged key to the active observer configuration.
    expect(readSettings()).toMatchObject({
      CLAUDE_MEM_PRO_TRIAL_STATE: 'active', CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'sync-token',
      CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'pro-memory-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: READY_BODY.memory_base_url,
      CLAUDE_MEM_OPENROUTER_MODEL: READY_BODY.memory_model, CLAUDE_MEM_PRO_MEMORY_KEY: '',
    });
    expect(JSON.parse(readFileSync(intentCredentialsPath, 'utf8'))).toEqual(intentCredentials);

    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;
    expect(lines.join('\n')).toMatch(/Account: .*CMEM Pro .*Free Trial active/);
    expect(lines.join('\n')).not.toContain('Open this URL');
    expect(unexpected).toEqual([]);
  });

  it('On The Go: a cancelled checkout returns to the checkout screen and the next Continue starts a fresh one', async () => {
    writeFileSync(intentCredentialsPath, JSON.stringify(intentCredentials), { mode: 0o600 });
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    await browserPost('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' });
    await waitForStage('go-awaiting-checkout');

    pollAnswers.push({ status: 410, body: {} });
    await browserPost('/api/setup/checkout', {});
    const failed = await waitForCheckout('failed');
    expect(failed.checkout.error).toMatch(/Continue to open it again/);
    expect(readSettings().CLAUDE_MEM_PRO_TRIAL_STATE).toBeUndefined();

    pollAnswers.push({ status: 200, body: READY_BODY });
    await browserPost('/api/setup/checkout', {});
    await waitForCheckout('paid');
    expect(pairingStarts).toHaveLength(2);
    for (const headers of pairingStartHeaders) {
      expect(headers.get('X-Intent-Install-Id')).toBe(intentCredentials.install_id);
      expect(headers.get('X-Intent-Token')).toBe(intentCredentials.intent_token);
    }
    await browserPost('/api/setup/complete', {});
    await install;
    expect(readSettings().CLAUDE_MEM_PRO_TRIAL_STATE).toBe('active');
  });

  it('At Home: Finish Setup while the extraction runs finishes the terminal without restarting the worker, so the run goes on', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    extraction.running = true;
    expect((await browserState()).backgroundWorkRunning).toEqual(['extraction']);
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;
    // The provider and auth method changed, but the worker reads them live: the one start is the funnel's own.
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    expect(workerStarts).toBe(1);
    expect(extraction.restartsWhileRunning).toBe(0);
    expect(extraction.running).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('complete');
    expect(lines.join('\n')).toContain('claude-mem installed successfully!');
  });

  it('On The Go: cloud sync needs a restart, which waits for the running extraction to finish', async () => {
    writeFileSync(intentCredentialsPath, JSON.stringify(intentCredentials), { mode: 0o600 });
    const install = runInstallCommand({});
    let installed = false;
    void install.then(() => { installed = true; });
    await waitForStage('waiting-for-choice');
    await browserPost('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' });
    await waitForStage('go-awaiting-checkout');
    pollAnswers.push({ status: 200, body: READY_BODY });
    await browserPost('/api/setup/checkout', {});
    await waitForCheckout('paid');
    extraction.running = true;
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    // The terminal holds the restart for as long as the run takes; the page already shows setup complete.
    for (let poll = 0; poll < 100 && !lines.some(line => line.includes('restarts to apply your settings once it finishes reading your goals, work and rules')); poll++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(lines.join('\n')).toContain('restarts to apply your settings once it finishes reading your goals, work and rules');
    for (let poll = 0; poll < 100 && backgroundPolls < 2; poll++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(backgroundPolls).toBeGreaterThanOrEqual(2);
    expect(installed).toBe(false);
    expect(workerStarts).toBe(1);
    expect((await browserState()).status).toBe('complete');

    extraction.running = false;
    await install;
    expect(workerStarts).toBe(2);
    expect(extraction.restartsWhileRunning).toBe(0);
    expect(lines.join('\n')).toMatch(/Account: .*CMEM Pro .*Free Trial active/);
  });

  it('a machine that already finished setup reopens the GUI without terminal questions', async () => {
    writeFileSync(statePath, JSON.stringify({ status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'x' }, installer: null, completedAt: 'x' }));
    const install = runInstallCommand({});
    const state = await waitForStage('waiting-for-choice');
    expect(state.install.status).toBe('ready');
    expect(questions).toEqual([]);
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await install;
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
  });

  it('a --provider host install says no account is needed', async () => {
    await runInstallCommand({ provider: 'host' });
    expect(pairingStarts).toEqual([]);
    expect(lines.join('\n')).toContain('Not required (host observer)');
  });

  it('a deferred install whose worker does not start fails instead of pointing at a dead setup page', async () => {
    fixtureWorkerResult = 'dead';
    const previousExitCode = process.exitCode;
    try {
      await runInstallCommand({ setup: 'defer' });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previousExitCode ?? 0; }
    expect(lines.join('\n')).toContain('the worker did not start');
    expect(lines.join('\n')).not.toContain('Setup is waiting at');
  });

  it('a deferred install with --no-auto-start leaves the worker to the caller and still succeeds', async () => {
    fixtureWorkerResult = 'dead';
    const previousExitCode = process.exitCode;
    try {
      await runInstallCommand({ setup: 'defer', noAutoStart: true });
      expect(process.exitCode ?? 0).toBe(0);
    } finally { process.exitCode = previousExitCode ?? 0; }
    expect(workerStarts).toBe(0);
    expect(lines.join('\n')).toContain('Setup is waiting at');
  });

  it('a reinstall whose worker does not start keeps a completed setup complete', async () => {
    const completed = { status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
      installer: { stage: 'home-ready', error: null, updatedAt: 'earlier' }, checkout: null, tools: null, completedAt: 'earlier' };
    writeFileSync(statePath, JSON.stringify(completed));
    fixtureWorkerResult = 'dead';
    await expect(runInstallCommand({})).rejects.toThrow('The setup page needs the worker');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'complete', completedAt: 'earlier' });
  });

  it('releases the GUI session when the worker fails while preserving saved setup state', async () => {
    fixtureWorkerResult = 'dead';
    await expect(runInstallCommand({})).rejects.toThrow('The setup page needs the worker');
    expect(workerStartStates[0]).toMatchObject({ status: 'pending' });
    expect(workerStartSessions[0]).toMatchObject({ pid: process.pid, already_pro: false });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('pending');
    expect(existsSync(sessionPath)).toBe(false);
    expect(opened).toEqual([]);
    expect(questions).toEqual([]);
  });

  it('releases the GUI session when the browser handoff fails and propagates the server error', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toMatchObject({ pid: process.pid, already_pro: false });
      return Response.json({ error: 'This setup session was refused by the worker.' }, { status: 403 });
    });
    await expect(runInstallCommand({})).rejects.toThrow('This setup session was refused by the worker.');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('pending');
    expect(existsSync(sessionPath)).toBe(false);
  });
});

describe('update keeps completed setup and asks only for missing requirements', () => {
  const complete = { status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
    installer: null, checkout: null, tools: ['claude-code'], completedAt: 'earlier' };
  const account = { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'keep-sync', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'keep-user',
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.example.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'keep-device' };
  const provision = (settings: Record<string, string>, state: unknown = complete) => {
    writeFileSync(settingsPath, JSON.stringify({ ...baseSettings, ...settings }));
    if (state) writeFileSync(statePath, JSON.stringify(state));
  };
  const expectPureUpdate = () => {
    expect(questions).toEqual([]);
    expect(opened).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(pairingStarts).toEqual([]);
    expect(offeredTasks).toContain('Caching plugin version');
    expect(offeredTasks).toContain('Copying plugin files to marketplace');
    expect(lines.join('\n')).toContain('claude-mem updated successfully!');
    expect(lines.join('\n')).not.toContain('Memory injection starts on your second session');
  };

  it('updates a completed Pro setup without login, checkout, preferences or onboarding', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'keep-memory-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/gateway/v1', CLAUDE_MEM_OPENROUTER_MODEL: 'keep-model',
      CLAUDE_MEM_SKILLS_DISABLED: 'review', CLAUDE_MEM_RUNTIME: 'worker' };
    provision(settings);
    const before = readFileSync(statePath, 'utf8');
    await runInstallCommand({ update: true });
    expectPureUpdate();
    expect(readSettings()).toMatchObject(settings);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(workerStarts).toBe(1);
  });

  it('keeps Claude auth, its custom model and cloud sync without rewriting local credentials', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'gateway',
      CLAUDE_MEM_MODEL: 'my-custom-model' };
    provision(settings);
    const envPath = process.env.CLAUDE_MEM_ENV_FILE!;
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=keep-key\nANTHROPIC_BASE_URL=https://gateway.example.test\n');
    try {
      const before = readFileSync(envPath, 'utf8');
      await runInstallCommand({ update: true });
      expectPureUpdate();
      expect(readSettings()).toMatchObject(settings);
      expect(readFileSync(envPath, 'utf8')).toBe(before);
    } finally { rmSync(envPath, { force: true }); }
  });

  it('updates a legacy default-Claude installation without an overwrite or onboarding prompt', async () => {
    const markerDir = join(cliPaths.marketplaceDirectory(), 'plugin', '.claude-plugin');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    provision(account, null);
    try {
      const before = readFileSync(settingsPath, 'utf8');
      const options: import('../../src/npx-cli/commands/install.js').InstallOptions = { update: true };
      await runInstallCommand(options);
      expectPureUpdate();
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(options.provider).toBe('claude');
    } finally { rmSync(join(markerDir, 'plugin.json'), { force: true }); }
  });

  for (const provider of ['codex', 'gemini', 'openai-compatible']) {
    it(`keeps a legacy ${provider} setup without a browser completion marker`, async () => {
      const settings = { ...account, CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_GEMINI_API_KEYS: 'one,two',
        CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'ollama', CLAUDE_MEM_CODEX_MODEL: 'keep-pin' };
      provision(settings, null);
      await runInstallCommand({ update: true });
      expectPureUpdate();
      expect(readSettings()).toMatchObject(settings);
      expect(existsSync(statePath)).toBe(false);
    });
  }

  for (const runtime of ['server', 'server-beta']) {
    it(`keeps the saved ${runtime} endpoint and credentials without bootstrap or a worker start`, async () => {
      const settings = { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_RUNTIME: runtime,
        CLAUDE_MEM_SERVER_URL: 'https://my-server.example.test', CLAUDE_MEM_SERVER_API_KEY: 'keep-server-key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'keep-project' };
      provision(settings);
      await runInstallCommand({ update: true });
      expectPureUpdate();
      expect(readSettings()).toMatchObject(settings);
      expect(workerStarts).toBe(0);
      expect(unexpected).toEqual([]);
    });
  }

  it('refreshes the saved agent selection and preserves unfinished browser progress', async () => {
    const state = { ...complete, status: 'pending', completedAt: null,
      install: { status: 'ready', selection: { agents: ['cursor'], dshProfile: 'saved-profile' } }, tools: ['codex'] };
    provision({ CLAUDE_MEM_PROVIDER: 'claude' }, state);
    await runInstallCommand({ update: true });
    expectPureUpdate();
    expect(offeredTasks).toContain('Cursor: installing hooks + MCP');
    expect(offeredTasks.some(title => title.startsWith('Codex'))).toBe(true);
    expect(questions).not.toContain('Which agents do you use?');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state);
  });

  it('asks only for the missing Gemini key and keeps the rest of the configuration', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_GEMINI_MODEL: 'keep-model' };
    provision(settings);
    await runInstallCommand({ update: true });
    expect(questions).toEqual(['Paste your Gemini API key:']);
    expect(readSettings()).toMatchObject({ ...settings, CLAUDE_MEM_GEMINI_API_KEY: 'new-provider-key' });
    expect(pairingStarts).toEqual([]);
    expect(opened).toEqual([]);
    // The repaired field counts as completed on the next update.
    questions.length = 0;
    await runInstallCommand({ update: true });
    expect(questions).toEqual([]);
  });

  it('keeps a personal endpoint and model when repairing its missing OpenRouter key', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://personal.example.test/v1', CLAUDE_MEM_OPENROUTER_MODEL: 'custom-model' };
    provision(settings);
    await runInstallCommand({ update: true });
    expect(questions).toEqual(['Paste your OpenRouter API key:']);
    expect(readSettings()).toMatchObject({ ...settings, CLAUDE_MEM_OPENROUTER_API_KEY: 'new-provider-key' });
    expect(pairingStarts).toEqual([]);
  });

  it('does not switch providers or erase sync when missing-key setup is cancelled', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'gemini' };
    provision(settings);
    passwordAnswer = prompts.CANCEL_SYMBOL;
    await expect(runInstallCommand({ update: true })).rejects.toThrow('Provider setup cancelled');
    expect(readSettings()).toMatchObject(settings);
    expect(lines.join('\n')).not.toContain('updated successfully');
  });

  it('restores a missing CMEM key through sign-in without replaying setup or checkout for an existing account', async () => {
    provision({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/gateway/v1' });
    writeFileSync(intentCredentialsPath, JSON.stringify(intentCredentials), { mode: 0o600 });
    pollAnswers.push({ status: 200, body: READY_BODY });
    // Simulate Return only when the login handoff has attached its input listener.
    const returnKey = setInterval(() => {
      if (process.stdin.listenerCount('data')) process.stdin.emit('data', Buffer.from('\r'));
    }, 10);
    try { await runInstallCommand({ update: true }); }
    finally { clearInterval(returnKey); }
    expect(questions).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(pairingStarts).toHaveLength(1);
    expect(opened).toEqual([`${startOrigin}/login?next=${encodeURIComponent(`/api/pro/trial/claim?pairing=${pairingId}&login_only=1`)}`]);
    expect(readSettings().CLAUDE_MEM_OPENROUTER_API_KEY).toBe('pro-memory-key');
    expect(lines.join('\n')).toContain('OAuth login complete');
  });

  it('asks for an unconfigured provider without replaying completed agent setup', async () => {
    provision({});
    providerAnswer = 'claude';
    await runInstallCommand({ update: true });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toStartWith('Select Provider');
    expect(questions[1]).toStartWith('Which Claude model');
    expect(setupRequests).toEqual([]);
    expect(opened).toEqual([]);
    expect(readSettings().CLAUDE_MEM_PROVIDER).toBe('claude');
  });
});

describe('install with --provider claude (interactive TTY)', () => {
  it('preserves interrupted browser progress and leaves local work unpaused', async () => {
    const saved = { status: 'pending', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
      installer: { stage: 'home-ready', error: null, updatedAt: 'earlier' }, checkout: null, tools: ['codex'], completedAt: null };
    writeFileSync(statePath, JSON.stringify(saved));
    writeFileSync(sessionPath, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    await runInstallCommand({ provider: 'claude', providerSource: 'flag' });
    expect(opened).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(saved);
    expect((worker!.routes as unknown as { setupIsActive: () => boolean }).setupIsActive()).toBe(false);
  });

  it('keeps the terminal flow: no setup page, no login, the model question in the terminal', async () => {
    await runInstallCommand({ provider: 'claude', providerSource: 'flag' });
    expect(opened).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(pairingStarts).toEqual([]);
    expect(questions.some(q => q.startsWith('Which Claude model'))).toBe(true);
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    expect(lines.join('\n')).toContain('--provider claude runs memory on your own Anthropic plan.');
    expect(existsSync(statePath)).toBe(false);
    expect(workerStartStates.every(state => state === null)).toBe(true);
    expect(workerStartSettings).not.toHaveLength(0);
    for (const settings of workerStartSettings) {
      expect(settings).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    }
  });
});

}

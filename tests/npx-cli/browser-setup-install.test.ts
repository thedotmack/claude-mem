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
const packageVersion = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')).version;
mock.module('../../src/npx-cli/utils/paths.js', () => ({ ...cliPaths, readPluginVersion: () => packageVersion }));

const lines: string[] = [];
const questions: string[] = [];
const ranTasks: string[] = [];
const offeredTasks: string[] = [];
let workerStarts = 0;
const workerStartStates: unknown[] = [];
const workerStartSessions: unknown[] = [];
let fixtureWorkerResult: 'ready' | 'dead' = 'ready';
mock.module('@clack/prompts', () => ({
  ...prompts,
  intro: () => {}, outro: (value: string) => lines.push(value), cancel: (value: string) => lines.push(value),
  note: (value: string, title?: string) => lines.push(`${title}\n${value}`),
  spinner: () => ({ start: (value: string) => lines.push(value), stop: (value: string) => lines.push(value), message: () => {} }),
  multiselect: async (options: { message: string }) => { questions.push(options.message); return ['claude-code']; },
  select: async (options: { message: string }) => {
    questions.push(options.message);
    if (options.message.startsWith('Which runtime')) return 'worker';
    if (options.message.startsWith('Disable Claude Code auto-memory')) return 'leave-enabled';
    return 'claude-haiku-4-5-20251001';
  },
  confirm: async (options: { message: string }) => { questions.push(options.message); return false; },
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
  fixtureWorkerResult = 'ready';
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
async function waitForStage(stage: string): Promise<any> {
  for (;;) {
    try { const state = await browserState(); if (state.installer?.stage === stage) return state; } catch { /* worker not up yet */ }
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
  it('At Home: starts the worker, opens the setup page, asks for no login, and finishes when the page does', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    // The worker is up before any login or provider question, and the page is open.
    expect(workerStarts).toBe(1);
    expect(workerStartStates).toEqual([{ status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null }]);
    expect(workerStartSessions).toEqual([{ pid: process.pid }]);
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
    expect(pairingStarts).toEqual([]);

    expect((await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' })).status).toBe(200);
    await waitForStage('home-ready');
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;

    // useSubscriptionAuth(): local, logged-in Claude SDK account; no claude-mem login at all.
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription', CLAUDE_MEM_CLOUD_SYNC_TOKEN: '' });
    expect(pairingStarts).toEqual([]);
    // No provider multiselect and no model question: the browser made the choice, the model keeps its default.
    expect(questions.filter(q => !q.startsWith('Which agents') && !q.startsWith('Which runtime') && !q.startsWith('Disable Claude Code') && !q.startsWith('Install Claude Code'))).toEqual([]);
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
    expect(lines.join('\n')).toMatch(/IDEs: .*claude-code, codex-cli/);
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
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(installed).toBe(false);
    expect(workerStarts).toBe(1);
    expect((await browserState()).status).toBe('complete');

    extraction.running = false;
    await install;
    expect(workerStarts).toBe(2);
    expect(extraction.restartsWhileRunning).toBe(0);
    expect(lines.join('\n')).toMatch(/Account: .*CMEM Pro .*Free Trial active/);
  });

  it('a machine that already finished setup keeps the terminal flow', async () => {
    const completed = { status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'x' }, installer: null, completedAt: 'x' };
    writeFileSync(statePath, JSON.stringify(completed));
    // The terminal flow's login step reaches cmem.ai, which this fixture refuses outside the pairing start.
    // Stopping at the login boundary is enough to show no browser hand-off ran.
    fetchSpy.mockImplementationOnce(async () => { throw new Error('OWNED_LOGIN_BOUNDARY'); });
    await expect(runInstallCommand({})).rejects.toThrow('EXIT_1');
    expect(opened).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(completed);
  });

  it('releases the GUI session when the worker fails while preserving saved setup state', async () => {
    fixtureWorkerResult = 'dead';
    fetchSpy.mockImplementationOnce(async () => { throw new Error('OWNED_LOGIN_BOUNDARY'); });
    await expect(runInstallCommand({})).rejects.toThrow('EXIT_1');
    expect(workerStartStates[0]).toMatchObject({ status: 'pending' });
    expect(workerStartSessions[0]).toEqual({ pid: process.pid });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('pending');
    expect(existsSync(sessionPath)).toBe(false);
    expect(opened).toEqual([]);
    expect(lines.join('\n')).toContain('Continuing setup here in the terminal.');
  });

  it('releases the GUI session when the browser handoff fails and propagates the server error', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toEqual({ pid: process.pid });
      return Response.json({ error: 'This setup session was refused by the worker.' }, { status: 403 });
    });
    await expect(runInstallCommand({})).rejects.toThrow('This setup session was refused by the worker.');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('pending');
    expect(existsSync(sessionPath)).toBe(false);
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
  });
});

}

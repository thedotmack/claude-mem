import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import-time TTY/settings constants and module mocks require a fresh process.
// The ordinary full-suite test spawns this same file once; the child retains
// every fixture case without leaking its mocks into sibling suites.
if (process.env.CLAUDE_MEM_INSTALLER_FIXTURE_CHILD !== import.meta.path) {
  describe('isolated installer fixture', () => {
    it('passes every case in a fresh Bun process', () => {
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'test', '--timeout', '10000', import.meta.path],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, CLAUDE_MEM_INSTALLER_FIXTURE_CHILD: import.meta.path },
        stdout: 'pipe', stderr: 'pipe', timeout: 45_000,
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      expect(child.exitCode).toBe(0);
      expect(child.success).toBe(true);
    }, 50_000);
  });
} else {
// Run this file as its own Bun invocation. Real packaged PTY coverage is
// separate: this suite drives the public command through controlled prompts.
const fixture = mkdtempSync(join(tmpdir(), 'cmem-combined-install-boundary-'));
const hostHome = join(fixture, 'host-home');
mkdirSync(hostHome, { recursive: true });
// Keep the real detector's command and directory checks; scope only its home root.
// Snapshot exports before mocking so afterAll restores both module spellings.
const realOs = { ...await import('node:os') };
const scopedOs = { ...realOs, homedir: () => hostHome };
const originalOsDefault = Object.getOwnPropertyDescriptor(realOs, 'default');
if (originalOsDefault) {
  Object.defineProperty(scopedOs, 'default', {
    ...originalOsDefault,
    value: { ...originalOsDefault.value, homedir: scopedOs.homedir },
  });
}
mock.module('os', () => scopedOs);
mock.module('node:os', () => scopedOs);
const keys = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'DSH_HOME', 'PATH', 'CLAUDE_MEM_SERVER_DATABASE_URL'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const priorTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
const data = join(fixture, 'data');
const piDir = join(fixture, 'pi');
const dshDir = join(fixture, 'dsh');
const bin = join(fixture, 'bin');
mkdirSync(data, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = data;
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'claude');
process.env.PI_CODING_AGENT_DIR = piDir;
process.env.DSH_HOME = dshDir;
process.env.PATH = bin + (process.platform === 'win32' ? ';' : ':') + (process.platform === 'win32' ? previous.PATH : '/usr/bin:/bin');
process.env.CLAUDE_MEM_SERVER_DATABASE_URL = 'postgresql://owned-test.invalid/never-contacted';

// Bun's child_process default environment retains the startup PATH. Delegate
// real command detection with this fixture's current environment instead.
const childProcess = await import('node:child_process');
const realExecFileSync = childProcess.execFileSync;
const commandEnvironment = spyOn(childProcess, 'execFileSync').mockImplementation(
  ((file: string, args: string[], options: any) => realExecFileSync(file, args, {
    ...options, env: { ...process.env, ...options?.env },
  })) as typeof childProcess.execFileSync,
);

const prompts = await import('@clack/prompts');
const banner = await import('../../src/npx-cli/banner.js');
const usage = await import('../../src/npx-cli/install/usage-summary.js');
const spawnGate = await import('../../src/shared/worker-spawn-gate.js');
const cliPaths = await import('../../src/npx-cli/utils/paths.js');
// This suite imports source modules; package-path resolution belongs to the built CLI.
const packageVersion = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')).version;
const readVersion = spyOn(cliPaths, 'readPluginVersion').mockReturnValue(packageVersion);
let selectedHosts = ['pi', 'dsh'];
let runtimeChoice: 'worker' | 'server' = 'server';
let hostOffers = 0;
let initialHosts: string[] = [];
let taskBatches = 0;
let bootstrapCalls = 0;
let httpCalls = 0;
let piCalls = 0;
let piResult = 0;
let dshResult = 0;
let profiles: Array<string | undefined> = [];
const lines: string[] = [];
const reachedTasks = new Error('OWNED_TASK_BOUNDARY');
mock.module('@clack/prompts', () => ({
  ...prompts,
  intro: () => {},
  multiselect: async (options: { initialValues: string[] }) => {
    initialHosts = [...options.initialValues];
    return selectedHosts;
  },
  select: async () => runtimeChoice,
  confirm: async (options: { message: string }) => {
    if (options.message === 'Install Claude Code now?') hostOffers++;
    return false;
  },
  tasks: async () => { taskBatches++; throw reachedTasks; },
  log: Object.fromEntries(['info', 'success', 'warn', 'error', 'message'].map(key => [key, (value: string) => lines.push(value)])),
}));
mock.module('../../src/npx-cli/banner.js', () => ({ ...banner, playBanner: async () => {} }));
mock.module('../../src/npx-cli/install/usage-summary.js', () => ({ ...usage, readUsageSummary: async () => null }));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({ ...spawnGate, holdSpawnLock: async () => () => {} }));
mock.module('../../src/services/hooks/server-bootstrap.js', () => ({
  bootstrapServerApiKey: async () => {
    bootstrapCalls++;
    return { rawKey: 'owned-test-key', projectId: 'owned-test-project', apiKeyId: 'owned-test-id' };
  },
  revokeServerApiKey: async () => { throw new Error('Unexpected server-key revocation'); },
  persistServerSettings: () => true,
}));
mock.module('../../src/services/integrations/PiInstaller.js', () => ({
  installPiExtension: () => { piCalls++; return piResult; },
}));
mock.module('../../src/services/integrations/DeepSeekHarnessInstaller.js', () => ({
  installDeepSeekHarness: async (profile?: string) => { profiles.push(profile); return dshResult; },
}));
const http = spyOn(globalThis, 'fetch').mockImplementation(async () => {
  httpCalls++;
  throw new Error('Unexpected HTTP from combined boundary test');
});
const exit = spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
  throw new Error('EXIT_' + code);
});
const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
const { runInstallCommand, makeIDETask } = await import('../../src/npx-cli/commands/install.js');
const { createInstallSummary, flushSummary } = await import('../../src/npx-cli/install/error-reporter.js');
const { detectInstalledIDEs, initialIDESelection } = await import('../../src/npx-cli/commands/ide-detection.js');
const loadSettings = spyOn(SettingsDefaultsManager, 'loadFromFile');
const settingsPath = join(data, 'settings.json');
let original: Buffer;
beforeEach(() => {
  for (const root of [piDir, dshDir]) { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); }
  rmSync(join(bin, 'claude'), { force: true });
  selectedHosts = ['pi', 'dsh']; runtimeChoice = 'server';
  hostOffers = 0; taskBatches = 0; bootstrapCalls = 0; httpCalls = 0;
  piCalls = 0; piResult = 0; dshResult = 0; profiles = []; initialHosts = [];
  lines.length = 0; loadSettings.mockClear(); exit.mockClear();
  original = Buffer.from(JSON.stringify({
    theme: 'keep-peer',
    env: {
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'owned-personal-provider-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://provider.example.invalid/api',
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:37878',
      CLAUDE_MEM_SERVER_API_KEY: 'keep-server-key',
      CLAUDE_MEM_SERVER_PROJECT_ID: 'keep-server-project',
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
    },
  }, null, 2) + '\n');
  writeFileSync(settingsPath, original, { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
});
afterAll(() => {
  commandEnvironment.mockRestore();
  readVersion.mockRestore();
  loadSettings.mockRestore(); exit.mockRestore(); http.mockRestore();
  mock.module('@clack/prompts', () => prompts);
  mock.module('../../src/npx-cli/banner.js', () => banner);
  mock.module('../../src/npx-cli/install/usage-summary.js', () => usage);
  mock.module('../../src/shared/worker-spawn-gate.js', () => spawnGate);
  mock.module('os', () => realOs);
  mock.module('node:os', () => realOs);
  if (priorTTY) Object.defineProperty(process.stdin, 'isTTY', priorTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(fixture, { recursive: true, force: true });
});
function expectUnchangedServerBoundary(): void {
  expect(readFileSync(settingsPath)).toEqual(original);
  expect(statSync(settingsPath).mode & 0o7777).toBe(0o600);
  expect(bootstrapCalls).toBe(0);
  expect(httpCalls).toBe(0);
  expect(taskBatches).toBe(0);
  expect(piCalls).toBe(0);
  expect(profiles).toEqual([]);
}
describe('combined public installer runtime boundary', () => {
  for (const ide of ['pi', 'pi-mono', 'dsh', 'deepseek-harness']) {
    for (const runtime of ['server', 'server-beta'] as const) {
      it('refuses explicit ' + ide + '/' + runtime + ' before provider loading and server mutation', async () => {
        await expect(runInstallCommand({ ide, runtime, provider: 'openrouter', serverUrl: 'https://never.example.invalid' }))
          .rejects.toThrow('EXIT_1');
        expect(loadSettings).not.toHaveBeenCalled();
        expectUnchangedServerBoundary();
        expect(lines.join('\n')).toContain('require --runtime worker');
      });
    }
  }
  for (const hosts of [['pi'], ['dsh'], ['pi', 'dsh'], ['claude-code', 'pi'], ['opencode', 'dsh']]) {
    it('refuses interactive server for ' + hosts.join('+') + ' before persistence/bootstrap', async () => {
      selectedHosts = hosts;
      await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('EXIT_1');
      expectUnchangedServerBoundary();
    });
  }
  it('preserves supported worker selection and the existing personal provider fields', async () => {
    runtimeChoice = 'worker';
    await expect(runInstallCommand({ provider: 'claude', dshProfile: 'review' })).rejects.toThrow('OWNED_TASK_BOUNDARY');
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(saved.theme).toBe('keep-peer');
    expect(saved.env.CLAUDE_MEM_RUNTIME).toBe('worker');
    expect(saved.env.CLAUDE_MEM_PROVIDER).toBe('openrouter');
    expect(saved.env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('owned-personal-provider-key');
    expect(saved.env.CLAUDE_MEM_SERVER_API_KEY).toBe('keep-server-key');
    expect(bootstrapCalls).toBe(0); expect(httpCalls).toBe(0); expect(taskBatches).toBe(1);
  });
  it('retains server setup for a supported host', async () => {
    await expect(runInstallCommand({ ide: 'opencode', runtime: 'server-beta', provider: 'claude', serverUrl: 'http://127.0.0.1:37879' }))
      .rejects.toThrow('OWNED_TASK_BOUNDARY');
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(saved.env.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(saved.env.CLAUDE_MEM_SERVER_URL).toBe('http://127.0.0.1:37879');
    expect(saved.env.CLAUDE_MEM_PROVIDER).toBe('openrouter');
    expect(bootstrapCalls).toBe(1); expect(httpCalls).toBe(0);
  });
});
describe.skipIf(process.platform === 'win32')('real Pi+DSH detection and public selection', () => {
  it('detects both configured harness roots in detector order without Claude', async () => {
    const detected = detectInstalledIDEs();
    expect(detected.find(ide => ide.id === 'pi')?.detected).toBe(true);
    expect(detected.find(ide => ide.id === 'dsh')?.detected).toBe(true);
    expect(detected.find(ide => ide.id === 'claude-code')?.detected).toBe(false);
    expect(initialIDESelection(detected).filter(id => id === 'pi' || id === 'dsh')).toEqual(['pi', 'dsh']);
    await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('EXIT_1');
    expect(initialHosts).toContain('pi'); expect(initialHosts).toContain('dsh');
    expect(initialHosts).not.toContain('claude-code');
    expect(hostOffers).toBe(0); expectUnchangedServerBoundary();
  });
  for (const only of ['pi', 'dsh']) {
    it('preselects the actual ' + only + '-only installation without offering Claude', async () => {
      rmSync(only === 'pi' ? dshDir : piDir, { recursive: true, force: true });
      selectedHosts = [only];
      await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('EXIT_1');
      expect(initialHosts.filter(id => id === 'pi' || id === 'dsh')).toEqual([only]);
      expect(initialHosts).not.toContain('claude-code');
      expect(hostOffers).toBe(0); expectUnchangedServerBoundary();
    });
  }
  it('keeps the no-agent Claude fallback and asks before installing the missing host', async () => {
    rmSync(piDir, { recursive: true, force: true });
    rmSync(dshDir, { recursive: true, force: true });
    selectedHosts = ['claude-code']; runtimeChoice = 'worker';
    await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('OWNED_TASK_BOUNDARY');
    expect(initialHosts).toEqual(['claude-code']);
    expect(hostOffers).toBe(1); expect(httpCalls).toBe(0);
  });
  it('does not offer missing Claude when it was not selected', async () => {
    selectedHosts = ['pi'];
    await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('EXIT_1');
    expect(hostOffers).toBe(0);
  });
  it('offers missing Claude only when selected, without silently downloading it', async () => {
    selectedHosts = ['claude-code', 'dsh'];
    await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('EXIT_1');
    expect(hostOffers).toBe(1); expectUnchangedServerBoundary();
  });
  it('does not offer a Claude host already detected in the owned command PATH', async () => {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    selectedHosts = ['claude-code', 'pi'];
    await expect(runInstallCommand({ provider: 'claude' })).rejects.toThrow('EXIT_1');
    expect(hostOffers).toBe(0); expect(initialHosts).toContain('claude-code');
  });
});
describe('combined public integration dispatch and partial summaries', () => {
  it('dispatches Pi and the requested DSH profile without changing provider choices', async () => {
    const summary = createInstallSummary();
    await makeIDETask('pi', summary)!.task(() => {});
    await makeIDETask('dsh', summary, 'review')!.task(() => {});
    expect(piCalls).toBe(1); expect(profiles).toEqual(['review']);
    expect(summary.failedIDEs).toEqual([]); expect(summary.warnings).toEqual([]);
    expect(readFileSync(settingsPath)).toEqual(original);
  });
  it('keeps DSH transcript-incomplete result2 warning-only with profile remediation', async () => {
    dshResult = 2;
    const summary = createInstallSummary();
    const line = await makeIDETask('dsh', summary, 'review')!.task(() => {});
    const output: string[] = [];
    flushSummary(summary, value => output.push(value));
    expect(summary.failedIDEs).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(line).toContain('transcript setup incomplete');
    expect(output.join('\n')).toContain('--dsh-profile review');
  });
  it('retains Pi failure with DSH success as a visible per-host partial outcome', async () => {
    piResult = 1;
    const summary = createInstallSummary();
    const piLine = await makeIDETask('pi', summary)!.task(() => {});
    const dshLine = await makeIDETask('dsh', summary, 'review')!.task(() => {});
    const output: string[] = [];
    flushSummary(summary, value => output.push(value));
    expect(summary.failedIDEs).toEqual(['pi']);
    expect(piLine).toContain('failed'); expect(dshLine).toContain('installed');
    expect(output.join('\n')).toContain('Pi');
    expect(profiles).toEqual(['review']);
  });
});

}

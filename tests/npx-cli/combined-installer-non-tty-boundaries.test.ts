import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// Run this file alone in a fresh Bun process, separate from the TTY suite.
// install.ts caches isInteractive at import: set false before every public import.
const fixture = mkdtempSync(join(tmpdir(), 'cmem-combined-install-non-tty-'));
const keys = [
  'CLAUDE_MEM_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_ENV_FILE',
  'PI_CODING_AGENT_DIR', 'DSH_HOME', 'PATH', 'CLAUDE_MEM_SERVER_DATABASE_URL',
  'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEYS',
  'CLAUDE_MEM_OPENROUTER_BASE_URL', 'CLAUDE_MEM_GEMINI_API_KEY', 'CLAUDE_MEM_GEMINI_API_KEYS',
];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const priorTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
const data = join(fixture, 'data');
const bin = join(fixture, 'bin');
mkdirSync(data, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = data;
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'claude');
process.env.CLAUDE_MEM_ENV_FILE = join(data, '.env');
process.env.PI_CODING_AGENT_DIR = join(fixture, 'pi');
process.env.DSH_HOME = join(fixture, 'dsh');
process.env.PATH = bin + (process.platform === 'win32' ? ';' : ':')
  + (process.platform === 'win32' ? previous.PATH : '/usr/bin:/bin');
process.env.CLAUDE_MEM_SERVER_DATABASE_URL = 'postgresql://owned-test.invalid/never-contacted';
for (const key of keys.slice(7)) delete process.env[key];
const settingsPath = join(data, 'settings.json');
const personalSettings = {
  CLAUDE_MEM_PROVIDER: 'openrouter',
  CLAUDE_MEM_OPENROUTER_API_KEY: 'owned-personal-openrouter-key',
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://provider.example.invalid/api',
  CLAUDE_MEM_GEMINI_API_KEY: 'owned-personal-gemini-key',
  CLAUDE_MEM_RUNTIME: 'worker',
  CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:37878',
  CLAUDE_MEM_SERVER_API_KEY: 'keep-server-key',
  CLAUDE_MEM_SERVER_PROJECT_ID: 'keep-server-project',
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'keep-account-token',
  CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'keep-account-user',
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.example.invalid',
  CLAUDE_MEM_WORKER_AUTOSTART: 'false',
};
// Provision valid personal credentials before imports; imports may seed/migrate
// owned settings or write markers. Command assertions begin after those imports.
writeFileSync(settingsPath, JSON.stringify({ theme: 'keep-peer', env: personalSettings }) + '\n', { mode: 0o600 });
let bootstrapCalls = 0;
let keyPersistenceCalls = 0;
let taskBoundaryCalls = 0;
let runtimeTaskCalls = 0;
let integrationCalls = 0;
let httpCalls = 0;
const lines: string[] = [];
// Keep source-vs-bundle version lookup from masking the provider getter path.
const installPaths = { ...await import('../../src/npx-cli/utils/paths.js') };
mock.module('../../src/npx-cli/utils/paths.js', () => ({ ...installPaths, readPluginVersion: () => '0.0.0-test' }));
const prompts = { ...await import('@clack/prompts') };
const banner = { ...await import('../../src/npx-cli/banner.js') };
const usage = { ...await import('../../src/npx-cli/install/usage-summary.js') };
const spawnGate = { ...await import('../../src/shared/worker-spawn-gate.js') };
const runtime = { ...await import('../../src/npx-cli/install/setup-runtime.js') };
mock.module('@clack/prompts', () => ({
  ...prompts,
  tasks: async () => { taskBoundaryCalls++; throw new Error('Unexpected interactive tasks'); },
}));
mock.module('../../src/npx-cli/banner.js', () => ({ ...banner, playBanner: async () => {} }));
mock.module('../../src/npx-cli/install/usage-summary.js', () => ({ ...usage, readUsageSummary: async () => null }));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({
  ...spawnGate,
  holdSpawnLock: async () => { taskBoundaryCalls++; throw new Error('Unexpected installer task boundary'); },
}));
mock.module('../../src/npx-cli/install/setup-runtime.js', () => ({
  ...runtime,
  getBunPath: () => null,
  ensureBun: async () => { runtimeTaskCalls++; throw new Error('Unexpected runtime setup'); },
  ensureUv: async () => { runtimeTaskCalls++; throw new Error('Unexpected runtime setup'); },
}));
mock.module('../../src/services/hooks/server-bootstrap.js', () => ({
  bootstrapServerApiKey: async () => {
    bootstrapCalls++;
    return { rawKey: 'owned-test-key', projectId: 'owned-test-project', apiKeyId: 'owned-test-id' };
  },
  revokeServerApiKey: async () => { throw new Error('Unexpected server-key revocation'); },
  persistServerSettings: () => { keyPersistenceCalls++; return true; },
}));
mock.module('../../src/services/integrations/PiInstaller.js', () => ({
  installPiExtension: () => { integrationCalls++; throw new Error('Unexpected Pi install'); },
}));
mock.module('../../src/services/integrations/DeepSeekHarnessInstaller.js', () => ({
  installDeepSeekHarness: async () => { integrationCalls++; throw new Error('Unexpected DSH install'); },
}));
const http = spyOn(globalThis, 'fetch').mockImplementation(async () => {
  httpCalls++;
  throw new Error('Unexpected HTTP from non-TTY boundary test');
});
const exit = spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
  throw new Error('EXIT_' + code);
});
const stderr = spyOn(console, 'error').mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(' ')); });
const stdout = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(' ')); });
const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
const loadSettings = spyOn(SettingsDefaultsManager, 'loadFromFile');
const { runInstallCommand } = await import('../../src/npx-cli/commands/install.js');
let original: Buffer;
beforeEach(() => {
  original = Buffer.from(JSON.stringify({
    theme: 'keep-peer',
    permissions: { allow: ['keep-account-peer'] },
    env: { ...SettingsDefaultsManager.getAllDefaults(), ...personalSettings },
  }, null, 2) + '\n');
  writeFileSync(settingsPath, original, { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
  // Reset after import effects and fixture setup. Observe only the public call.
  loadSettings.mockClear(); exit.mockClear(); http.mockClear();
  stderr.mockClear(); stdout.mockClear(); lines.length = 0;
  bootstrapCalls = 0; keyPersistenceCalls = 0; taskBoundaryCalls = 0;
  runtimeTaskCalls = 0; integrationCalls = 0; httpCalls = 0;
});
afterAll(() => {
  loadSettings.mockRestore(); exit.mockRestore(); http.mockRestore();
  stderr.mockRestore(); stdout.mockRestore();
  mock.module('@clack/prompts', () => prompts);
  mock.module('../../src/npx-cli/banner.js', () => banner);
  mock.module('../../src/npx-cli/install/usage-summary.js', () => usage);
  mock.module('../../src/shared/worker-spawn-gate.js', () => spawnGate);
  mock.module('../../src/npx-cli/install/setup-runtime.js', () => runtime);
  mock.module('../../src/npx-cli/utils/paths.js', () => installPaths);
  if (priorTTY) Object.defineProperty(process.stdin, 'isTTY', priorTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(fixture, { recursive: true, force: true });
});

describe('non-TTY public installer refusal before personal provider getters', () => {
  for (const ide of ['pi', 'pi-mono', 'dsh', 'deepseek-harness']) {
    for (const requestedRuntime of ['server', 'server-beta'] as const) {
      for (const provider of ['openrouter', 'gemini'] as const) {
        it('refuses ' + ide + '/' + requestedRuntime + '/' + provider + ' before provider/settings loading', async () => {
          expect(process.stdin.isTTY).toBe(false);
          // An explicit personal provider reaches the real private getSetting ->
          // public loadFromFile path without the early host/runtime refusal.
          // A valid persisted provider with no explicit choice returns earlier;
          // claude/host bypass getters, so neither can prove this regression.
          await expect(runInstallCommand({
            ide, runtime: requestedRuntime, provider,
            serverUrl: 'https://never.example.invalid', noAutoStart: true,
          })).rejects.toThrow('EXIT_1');
          expect(exit).toHaveBeenCalledWith(1);
          expect(lines.join('\n')).toContain('require --runtime worker');
          expect(loadSettings).not.toHaveBeenCalled();
          expect(readFileSync(settingsPath)).toEqual(original);
          expect(statSync(settingsPath).mode & 0o7777).toBe(0o600);
          expect(bootstrapCalls).toBe(0); expect(keyPersistenceCalls).toBe(0);
          expect(taskBoundaryCalls).toBe(0); expect(runtimeTaskCalls).toBe(0);
          expect(integrationCalls).toBe(0); expect(httpCalls).toBe(0);
          expect(http).not.toHaveBeenCalled();
        });
      }
    }
  }
});

}

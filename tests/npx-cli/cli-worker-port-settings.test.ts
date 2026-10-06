import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realShutdownHelper from '../../src/services/install/shutdown-helper.js';

const realShutdownHelperSnapshot = { ...realShutdownHelper };

// The worker binds the port in ~/.claude-mem/settings.json (getWorkerPort loads
// the file; an env var of the same name overrides it). doctor, uninstall and the
// OpenClaw installer read the port through SettingsDefaultsManager.get(), which
// sees only the env var and the built-in default, so a port set in the file was
// probed, stopped and registered at the wrong address.

// Keep every home-relative path these commands touch inside a sandbox. This must
// happen before the modules below load: the OpenClaw installer resolves its
// marketplace root from CLAUDE_CONFIG_DIR at import time.
const sandbox = mkdtempSync(join(tmpdir(), 'claude-mem-cli-port-'));
const savedEnv: Record<string, string | undefined> = {};
for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST']) {
  savedEnv[key] = process.env[key];
}
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.CLAUDE_CONFIG_DIR = join(sandbox, '.claude');

const shutdownPorts: Array<number | string> = [];
let shutdownCalled: () => void = () => {};

// The uninstall test stops at this call: the promise never settles, so nothing
// after the worker shutdown (file removal) ever runs.
mock.module('../../src/services/install/shutdown-helper.js', () => ({
  shutdownWorkerAndWait: (port: number | string) => {
    shutdownPorts.push(port);
    shutdownCalled();
    return new Promise(() => {});
  },
}));

const { USER_SETTINGS_PATH } = await import('../../src/shared/paths.js');
const { clearPortCache } = await import('../../src/shared/worker-utils.js');

const FILE_PORT = '38888';
const ENV_PORT = '39999';

function writeSettings(settings: Record<string, string>): void {
  writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings));
}

let savedSettings: string | null = null;

beforeAll(() => {
  try {
    savedSettings = readFileSync(USER_SETTINGS_PATH, 'utf-8');
  } catch {
    savedSettings = null;
  }
});

beforeEach(() => {
  delete process.env.CLAUDE_MEM_WORKER_PORT;
  delete process.env.CLAUDE_MEM_WORKER_HOST;
  clearPortCache();
});

afterEach(() => {
  delete process.env.CLAUDE_MEM_WORKER_PORT;
  delete process.env.CLAUDE_MEM_WORKER_HOST;
  clearPortCache();
});

afterAll(() => {
  mock.module('../../src/services/install/shutdown-helper.js', () => realShutdownHelperSnapshot);
  if (savedSettings === null) rmSync(USER_SETTINGS_PATH, { force: true });
  else writeFileSync(USER_SETTINGS_PATH, savedSettings);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearPortCache();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('npx claude-mem doctor probes the worker port from settings.json', () => {
  const originalFetch = globalThis.fetch;
  let requested: string[] = [];

  beforeEach(() => {
    requested = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('{}', { status: 503 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function runDoctor(): Promise<void> {
    const { runDoctorCommand } = await import('../../src/npx-cli/commands/doctor.js');
    // Run from source, there is no npm package root to read a version from.
    const pathsModule = await import('../../src/npx-cli/utils/paths.js');
    const version = spyOn(pathsModule, 'readPluginVersion').mockReturnValue('0.0.0-test');
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('doctor exited');
    }) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runDoctorCommand().catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'doctor exited') throw error;
      });
    } finally {
      version.mockRestore();
      exit.mockRestore();
      log.mockRestore();
    }
  }

  it('uses the port written in settings.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });

    await runDoctor();

    expect(requested).toContain(`http://127.0.0.1:${FILE_PORT}/api/health`);
  }, 30_000);

  it('lets the environment variable override settings.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });
    process.env.CLAUDE_MEM_WORKER_PORT = ENV_PORT;

    await runDoctor();

    expect(requested).toContain(`http://127.0.0.1:${ENV_PORT}/api/health`);
  }, 30_000);
});

describe('npx claude-mem uninstall stops the worker on the port from settings.json', () => {
  beforeEach(() => {
    shutdownPorts.length = 0;
  });

  async function portUninstallStops(): Promise<string> {
    const pathsModule = await import('../../src/npx-cli/utils/paths.js');
    const installed = spyOn(pathsModule, 'isPluginInstalled').mockReturnValue(true);
    const called = new Promise<void>(resolve => { shutdownCalled = resolve; });
    try {
      const { runUninstallCommand } = await import('../../src/npx-cli/commands/uninstall.js');
      void runUninstallCommand();
      await called;
    } finally {
      installed.mockRestore();
    }
    return String(shutdownPorts[0]);
  }

  it('uses the port written in settings.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });

    expect(await portUninstallStops()).toBe(FILE_PORT);
  });

  it('lets the environment variable override settings.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });
    process.env.CLAUDE_MEM_WORKER_PORT = ENV_PORT;

    expect(await portUninstallStops()).toBe(ENV_PORT);
  });
});

describe('OpenClaw install registers the worker port from settings.json', () => {
  const openclawConfig = join(sandbox, '.openclaw', 'openclaw.json');

  beforeAll(() => {
    // A pre-built plugin bundle where the installer looks for one.
    const dist = join(sandbox, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'openclaw', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '');
  });

  beforeEach(() => {
    rmSync(join(sandbox, '.openclaw'), { recursive: true, force: true });
  });

  async function install(): Promise<{ workerPort?: number }> {
    const { installOpenClawPlugin } = await import('../../src/services/integrations/OpenClawInstaller.js');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(installOpenClawPlugin()).toBe(0);
    } finally {
      log.mockRestore();
    }
    return JSON.parse(readFileSync(openclawConfig, 'utf-8')).plugins.entries['claude-mem'].config;
  }

  it('uses the port written in settings.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });

    expect((await install()).workerPort).toBe(Number(FILE_PORT));
  });

  it('lets the environment variable override settings.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });
    process.env.CLAUDE_MEM_WORKER_PORT = ENV_PORT;

    expect((await install()).workerPort).toBe(Number(ENV_PORT));
  });

  it('keeps a workerPort the user already set in openclaw.json', async () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });
    mkdirSync(join(sandbox, '.openclaw'), { recursive: true });
    writeFileSync(openclawConfig, JSON.stringify({
      plugins: { entries: { 'claude-mem': { enabled: true, config: { workerPort: 40001 } } } },
    }));

    expect((await install()).workerPort).toBe(40001);
  });
});

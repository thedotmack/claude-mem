import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, sep } from 'path';
import { spawnSync } from 'child_process';

// The worker binds the port in ~/.claude-mem/settings.json (getWorkerPort loads
// the file; an env var of the same name overrides it). doctor, uninstall and the
// OpenClaw installer read the port through SettingsDefaultsManager.get(), which
// sees only the env var and the built-in default, so a port set in the file was
// probed, stopped and registered at the wrong address.

// Sandbox every path these commands touch BEFORE any src module loads:
// shared/paths.ts freezes the data dir on first import, and the OpenClaw
// installer resolves its marketplace root from CLAUDE_CONFIG_DIR at import time.
// So no src module is imported statically in this file. Bun on Linux reads the
// home dir once at startup, so HOME set here does not move os.homedir(): the
// OpenClaw install, which writes under it, runs in a child process (below).
const realSettingsPath = join(homedir(), '.claude-mem', 'settings.json');
const sandbox = mkdtempSync(join(tmpdir(), 'claude-mem-cli-port-'));
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST',
]) {
  savedEnv[key] = process.env[key];
}
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.CLAUDE_CONFIG_DIR = join(sandbox, '.claude');
process.env.CLAUDE_MEM_DATA_DIR = join(sandbox, 'data');
mkdirSync(process.env.CLAUDE_MEM_DATA_DIR, { recursive: true });

const realShutdownHelperSnapshot = { ...(await import('../../src/services/install/shutdown-helper.js')) };
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

const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
const { USER_SETTINGS_PATH } = await import('../../src/shared/paths.js');
const { clearPortCache } = await import('../../src/shared/worker-utils.js');

const FILE_PORT = '38888';
const ENV_PORT = '39999';

/**
 * The settings file getWorkerPort() reads (CLAUDE_MEM_DATA_DIR/settings.json,
 * resolved at call time), refused unless it is inside the sandbox.
 */
function sandboxSettingsPath(): string {
  const settingsPath = join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  if (!settingsPath.startsWith(sandbox + sep)) {
    throw new Error(`refusing to touch a settings file outside the test sandbox: ${settingsPath}`);
  }
  return settingsPath;
}

function writeSettings(settings: Record<string, string>): void {
  writeFileSync(sandboxSettingsPath(), JSON.stringify(settings));
}

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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearPortCache();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('test isolation', () => {
  it('writes its settings fixtures inside the sandbox', () => {
    expect(sandboxSettingsPath()).toBe(join(sandbox, 'data', 'settings.json'));
  });

  it('refuses a settings path outside the sandbox', () => {
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = join(tmpdir(), 'not-the-sandbox');
    try {
      expect(() => sandboxSettingsPath()).toThrow('outside the test sandbox');
    } finally {
      process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    }
  });

  it('never resolves the real ~/.claude-mem settings file', () => {
    // Frozen on first import: the sandbox when this file runs first, otherwise
    // the per-run temp dir tests/preload.ts pins. Never the real one.
    expect(USER_SETTINGS_PATH).not.toBe(realSettingsPath);
    expect(USER_SETTINGS_PATH.startsWith(tmpdir())).toBe(true);
  });
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
  const installerPath = join(import.meta.dir, '..', '..', 'src', 'services', 'integrations', 'OpenClawInstaller.ts');
  const childScript = join(sandbox, 'install-openclaw.mjs');

  beforeAll(() => {
    // A pre-built plugin bundle where the installer looks for one.
    const dist = join(sandbox, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'openclaw', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '');

    // The installer writes under os.homedir(), and Bun on Linux reads the home
    // dir once at startup, so changing HOME in this process does not move it.
    // Run the install in a child whose HOME is the sandbox from the start, and
    // have the child refuse to install anywhere else.
    writeFileSync(childScript, [
      "import { homedir } from 'node:os';",
      "import { pathToFileURL } from 'node:url';",
      'if (homedir() !== process.env.CLAUDE_MEM_TEST_SANDBOX_HOME) {',
      "  console.error(`refusing to install: home dir ${homedir()} is not the test sandbox`);",
      '  process.exit(3);',
      '}',
      'const { installOpenClawPlugin } = await import(pathToFileURL(process.env.CLAUDE_MEM_TEST_INSTALLER).href);',
      'process.exit(installOpenClawPlugin());',
    ].join('\n'));
  });

  beforeEach(() => {
    rmSync(join(sandbox, '.openclaw'), { recursive: true, force: true });
  });

  function install(): { workerPort?: number } {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, {
      HOME: sandbox,
      USERPROFILE: sandbox,
      CLAUDE_CONFIG_DIR: join(sandbox, '.claude'),
      CLAUDE_MEM_DATA_DIR: join(sandbox, 'data'),
      CLAUDE_MEM_TEST_SANDBOX_HOME: sandbox,
      CLAUDE_MEM_TEST_INSTALLER: installerPath,
      // The child has no tests/preload.ts mocks; nothing it might send leaves the machine.
      CLAUDE_MEM_TELEMETRY_HOST: 'http://127.0.0.1:9',
    });
    // cwd is one of the installer's marketplace roots; keep it in the sandbox too.
    const child = spawnSync(process.execPath, [childScript], { cwd: sandbox, env, encoding: 'utf-8' });
    expect({ status: child.status, stderr: child.status === 0 ? '' : child.stderr }).toEqual({ status: 0, stderr: '' });
    return JSON.parse(readFileSync(openclawConfig, 'utf-8')).plugins.entries['claude-mem'].config;
  }

  it('uses the port written in settings.json', () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });

    expect(install().workerPort).toBe(Number(FILE_PORT));
  });

  it('lets the environment variable override settings.json', () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });
    process.env.CLAUDE_MEM_WORKER_PORT = ENV_PORT;

    expect(install().workerPort).toBe(Number(ENV_PORT));
  });

  it('keeps a workerPort the user already set in openclaw.json', () => {
    writeSettings({ CLAUDE_MEM_WORKER_PORT: FILE_PORT });
    mkdirSync(join(sandbox, '.openclaw'), { recursive: true });
    writeFileSync(openclawConfig, JSON.stringify({
      plugins: { entries: { 'claude-mem': { enabled: true, config: { workerPort: 40001 } } } },
    }));

    expect(install().workerPort).toBe(40001);
  });
});

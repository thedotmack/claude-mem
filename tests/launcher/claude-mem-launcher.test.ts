import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Runs the BUILT bundle (plugin/scripts/claude-mem-launcher.cjs) under Bun, the
// same file the installer compiles onto PATH. Case shapes mirror the Rule A
// shell resolution matrix in tests/infrastructure/plugin-distribution.test.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const launcherBundlePath = path.join(projectRoot, 'plugin', 'scripts', 'claude-mem-launcher.cjs');
// Temp HOMEs live inside the worktree, never the system temp dir or the real HOME.
const scratchParentDirectory = path.join(projectRoot, '.scratch', 'launcher-tests');

// The stub worker echoes where it ran from, its argv and the exact stdin it
// received, then exits with STUB_WORKER_EXIT_CODE once stdout has flushed.
const STUB_WORKER_SOURCE = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    pluginRoot: require('path').dirname(__dirname),
    argv: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString('utf-8'),
  }), () => process.exit(Number(process.env.STUB_WORKER_EXIT_CODE || 0)));
});
`;

interface LauncherRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function makeTemporaryHome(): string {
  return mkdtempSync(path.join(scratchParentDirectory, 'home-'));
}

function makeStubPluginRoot(pluginRoot: string): string {
  mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
  writeFileSync(path.join(pluginRoot, 'scripts', 'worker-service.cjs'), STUB_WORKER_SOURCE);
  return pluginRoot;
}

function cacheVersionRoot(temporaryHome: string, version: string): string {
  return path.join(temporaryHome, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', version);
}

function runLauncher(
  launcherArguments: string[],
  { temporaryHome, stdinPayload = '{"hook_event_name":"PostToolUse"}', extraEnvironment = {} }: {
    temporaryHome: string;
    stdinPayload?: string;
    extraEnvironment?: Record<string, string>;
  },
): LauncherRunResult {
  // Built from scratch so a CLAUDE_PLUGIN_ROOT / CLAUDE_CONFIG_DIR inherited
  // from the session running the tests can never leak into resolution.
  const launcherEnvironment: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    CLAUDE_MEM_DATA_DIR: path.join(temporaryHome, '.claude-mem'),
    ...extraEnvironment,
  };
  const result = spawnSync(process.execPath, [launcherBundlePath, ...launcherArguments], {
    input: stdinPayload,
    env: launcherEnvironment,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runObservationHook(options: Parameters<typeof runLauncher>[1]): LauncherRunResult {
  return runLauncher(['hook', 'claude-code', 'observation'], options);
}

function parseStubWorkerOutput(stdout: string): { pluginRoot: string; argv: string[]; stdin: string } {
  return JSON.parse(stdout);
}

describe('claude-mem launcher', () => {
  beforeAll(() => {
    if (!existsSync(launcherBundlePath)) {
      throw new Error(`${launcherBundlePath} is missing; run npm run build first`);
    }
    mkdirSync(scratchParentDirectory, { recursive: true });
  });

  afterAll(() => {
    rmSync(scratchParentDirectory, { recursive: true, force: true });
  });

  it('prints the integer LAUNCHER_PROTOCOL for --version', () => {
    const result = runLauncher(['--version'], { temporaryHome: makeTemporaryHome() });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('prints usage on stderr and exits 0 with no arguments', () => {
    const result = runLauncher([], { temporaryHome: makeTemporaryHome() });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage: claude-mem hook <platform> <event>');
  });

  it('passes non-hook subcommands through to worker-service.cjs with stdin closed', () => {
    const temporaryHome = makeTemporaryHome();
    const environmentRoot = makeStubPluginRoot(path.join(temporaryHome, 'env-root'));

    const result = runLauncher(['start'], {
      temporaryHome,
      stdinPayload: '{"ignored":true}',
      extraEnvironment: { CLAUDE_PLUGIN_ROOT: environmentRoot },
    });

    expect(result.status).toBe(0);
    const stubWorkerOutput = parseStubWorkerOutput(result.stdout);
    expect(stubWorkerOutput.argv).toEqual(['start']);
    expect(stubWorkerOutput.stdin).toBe('');
    expect(existsSync(path.join(temporaryHome, '.claude-mem', 'CAPTURE_BROKEN'))).toBe(false);
  });

  it('accepts a root that has worker-service.cjs but no bun-runner.js', () => {
    const temporaryHome = makeTemporaryHome();
    const workerOnlyRoot = makeStubPluginRoot(path.join(temporaryHome, 'worker-only-root'));
    expect(existsSync(path.join(workerOnlyRoot, 'scripts', 'bun-runner.js'))).toBe(false);

    const result = runObservationHook({ temporaryHome, extraEnvironment: { CLAUDE_PLUGIN_ROOT: workerOnlyRoot } });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).pluginRoot).toBe(workerOnlyRoot);
  });

  it('resolves the plugin root from CLAUDE_PLUGIN_ROOT and passes hook argv through', () => {
    const temporaryHome = makeTemporaryHome();
    const environmentRoot = makeStubPluginRoot(path.join(temporaryHome, 'env-root'));
    // A valid cache version must lose to the host-injected root.
    makeStubPluginRoot(cacheVersionRoot(temporaryHome, '99.0.0'));

    const result = runObservationHook({
      temporaryHome,
      extraEnvironment: { CLAUDE_PLUGIN_ROOT: `${environmentRoot}${path.sep}` },
    });

    expect(result.status).toBe(0);
    const stubWorkerOutput = parseStubWorkerOutput(result.stdout);
    expect(stubWorkerOutput.pluginRoot).toBe(environmentRoot);
    expect(stubWorkerOutput.argv).toEqual(['hook', 'claude-code', 'observation']);
  });

  it('steps into plugin/ when CLAUDE_PLUGIN_ROOT points at a repo-shaped checkout', () => {
    const temporaryHome = makeTemporaryHome();
    const checkoutRoot = path.join(temporaryHome, 'checkout');
    const nestedPluginRoot = makeStubPluginRoot(path.join(checkoutRoot, 'plugin'));

    const result = runObservationHook({ temporaryHome, extraEnvironment: { CLAUDE_PLUGIN_ROOT: checkoutRoot } });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).pluginRoot).toBe(nestedPluginRoot);
  });

  it('falls back to PLUGIN_ROOT, then the cache, when CLAUDE_PLUGIN_ROOT is invalid', () => {
    const temporaryHome = makeTemporaryHome();
    const pluginRootFromSecondaryEnvironment = makeStubPluginRoot(path.join(temporaryHome, 'secondary-root'));

    const result = runObservationHook({
      temporaryHome,
      extraEnvironment: {
        CLAUDE_PLUGIN_ROOT: path.join(temporaryHome, 'not-a-plugin-root'),
        PLUGIN_ROOT: pluginRootFromSecondaryEnvironment,
      },
    });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).pluginRoot).toBe(pluginRootFromSecondaryEnvironment);
  });

  it('prefers the highest cache version over the newest mtime and skips .orphaned_at dirs (2026-07-22 restart storm)', () => {
    const temporaryHome = makeTemporaryHome();
    // 13.13.0 is the highest version but orphaned; 13.2.0 wins a lexical sort
    // but loses a numeric one; 13.11.0 is orphaned with the newest mtime.
    const orphanedHighestRoot = makeStubPluginRoot(cacheVersionRoot(temporaryHome, '13.13.0'));
    writeFileSync(path.join(orphanedHighestRoot, '.orphaned_at'), String(Date.now()));
    const orphanedNewestMtimeRoot = makeStubPluginRoot(cacheVersionRoot(temporaryHome, '13.11.0'));
    writeFileSync(path.join(orphanedNewestMtimeRoot, '.orphaned_at'), String(Date.now()));
    makeStubPluginRoot(cacheVersionRoot(temporaryHome, '13.2.0'));
    makeStubPluginRoot(cacheVersionRoot(temporaryHome, '13.12.0-beta.1'));
    const expectedRoot = makeStubPluginRoot(cacheVersionRoot(temporaryHome, '13.12.0'));
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    utimesSync(expectedRoot, tenMinutesAgo, tenMinutesAgo);
    // A marketplace install must lose to any valid cache version.
    makeStubPluginRoot(path.join(temporaryHome, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin'));

    const result = runObservationHook({ temporaryHome });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).pluginRoot).toBe(expectedRoot);
  });

  it('honors CLAUDE_CONFIG_DIR for the cache lookup', () => {
    const temporaryHome = makeTemporaryHome();
    const customConfigDirectory = path.join(temporaryHome, 'custom-config');
    const expectedRoot = makeStubPluginRoot(
      path.join(customConfigDirectory, 'plugins', 'cache', 'thedotmack', 'claude-mem', '13.12.0'),
    );

    const result = runObservationHook({ temporaryHome, extraEnvironment: { CLAUDE_CONFIG_DIR: customConfigDirectory } });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).pluginRoot).toBe(expectedRoot);
  });

  it('falls back to the marketplace install when no cache version is usable', () => {
    const temporaryHome = makeTemporaryHome();
    // A cache version missing worker-service.cjs is not a valid root.
    const incompleteCacheRoot = cacheVersionRoot(temporaryHome, '99.0.0');
    mkdirSync(path.join(incompleteCacheRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(incompleteCacheRoot, 'scripts', 'bun-runner.js'), '');
    const marketplaceRoot = makeStubPluginRoot(
      path.join(temporaryHome, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin'),
    );

    const result = runObservationHook({ temporaryHome });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).pluginRoot).toBe(marketplaceRoot);
  });

  it('fails open with one stderr line when no plugin root exists', () => {
    const result = runObservationHook({ temporaryHome: makeTemporaryHome() });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('claude-mem: plugin scripts not found, continuing without memory\n');
  });

  it('exits 0 silently without running the worker when the plugin is disabled', () => {
    const temporaryHome = makeTemporaryHome();
    makeStubPluginRoot(cacheVersionRoot(temporaryHome, '13.12.0'));
    writeFileSync(
      path.join(temporaryHome, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': false } }),
    );

    const result = runObservationHook({ temporaryHome });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('delivers stdin to worker-service.cjs byte for byte', () => {
    const temporaryHome = makeTemporaryHome();
    const environmentRoot = makeStubPluginRoot(path.join(temporaryHome, 'env-root'));
    const stdinPayload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      unicode: 'ü 🧠 "quoted" \\ backslash',
      large: 'a'.repeat(1_000_000),
    }) + '\n';

    const result = runObservationHook({
      temporaryHome,
      stdinPayload,
      extraEnvironment: { CLAUDE_PLUGIN_ROOT: environmentRoot },
    });

    expect(result.status).toBe(0);
    expect(parseStubWorkerOutput(result.stdout).stdin).toBe(stdinPayload);
  });

  it('fails open when the worker exits non-zero, including 2 (never blocks)', () => {
    const temporaryHome = makeTemporaryHome();
    const environmentRoot = makeStubPluginRoot(path.join(temporaryHome, 'env-root'));

    for (const workerExitCode of ['7', '2']) {
      const result = runObservationHook({
        temporaryHome,
        extraEnvironment: { CLAUDE_PLUGIN_ROOT: environmentRoot, STUB_WORKER_EXIT_CODE: workerExitCode },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe(`claude-mem: worker exited ${workerExitCode}, continuing without memory\n`);
    }
  });

  it('reports an empty stdin payload, drops CAPTURE_BROKEN and skips the worker (#2188)', () => {
    const temporaryHome = makeTemporaryHome();
    const environmentRoot = makeStubPluginRoot(path.join(temporaryHome, 'env-root'));

    const result = runObservationHook({
      temporaryHome,
      stdinPayload: '',
      extraEnvironment: { CLAUDE_PLUGIN_ROOT: environmentRoot },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('empty stdin payload received — issue #2188');
    expect(readFileSync(path.join(temporaryHome, '.claude-mem', 'CAPTURE_BROKEN'), 'utf-8')).toContain('issue #2188');
  });

  // findBun() checks PATH, $BUN/$BUN_PATH/$BUN_INSTALL, ~/.bun/bin/bun, then
  // these absolute system paths. The env/HOME candidates are controlled below;
  // the absolute ones cannot be, so the fallback is only provable without them.
  const systemBunPathsFindBunChecks = ['/usr/local/bin/bun', '/opt/homebrew/bin/bun', '/home/linuxbrew/.linuxbrew/bin/bun'];
  const systemBunPresent = process.platform === 'win32' || systemBunPathsFindBunChecks.some((candidate) => existsSync(candidate));
  it.skipIf(systemBunPresent)(
    'compiled binary falls back to BUN_BE_BUN when no bun is discoverable (skipped when a system bun exists at a findBun absolute path, or on Windows)',
    () => {
      const temporaryHome = makeTemporaryHome();
      const environmentRoot = makeStubPluginRoot(path.join(temporaryHome, 'env-root'));
      const compiledLauncherPath = path.join(temporaryHome, 'claude-mem');
      const compileResult = spawnSync(
        process.execPath,
        ['build', '--compile', '--no-compile-autoload-dotenv', launcherBundlePath, '--outfile', compiledLauncherPath],
        { encoding: 'utf-8', timeout: 120_000 },
      );
      expect(compileResult.status).toBe(0);

      const noBunPath = '/usr/bin:/bin';
      expect(spawnSync('which', ['bun'], { env: { PATH: noBunPath }, encoding: 'utf-8' }).status).not.toBe(0);

      const result = spawnSync(compiledLauncherPath, ['hook', 'claude-code', 'observation'], {
        input: '{"hook_event_name":"PostToolUse"}',
        // No BUN / BUN_PATH / BUN_INSTALL, and a HOME with no ~/.bun.
        env: {
          PATH: noBunPath,
          HOME: temporaryHome,
          CLAUDE_MEM_DATA_DIR: path.join(temporaryHome, '.claude-mem'),
          CLAUDE_PLUGIN_ROOT: environmentRoot,
        },
        encoding: 'utf-8',
        timeout: 20_000,
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const stubWorkerOutput = parseStubWorkerOutput(result.stdout);
      expect(stubWorkerOutput.pluginRoot).toBe(environmentRoot);
      expect(stubWorkerOutput.argv).toEqual(['hook', 'claude-code', 'observation']);
    },
    150_000,
  );
});

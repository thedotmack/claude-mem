import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const VERSION_CHECK_PATH = join(REPO_ROOT, 'plugin', 'scripts', 'version-check.js');
const SPAWN_TIMEOUT_MS = 15_000;
const INSTALL_DIAGNOSTIC = '[version-check] installing plugin dependencies';
const INSTALL_SUCCESS_DIAGNOSTIC = '[version-check] plugin dependencies installed successfully';
const INSTALL_FAILURE_DIAGNOSTIC = '[version-check] bun install failed';
const FAKE_INSTALLED_MARKER_REL = join('node_modules', 'zod', 'v3', 'index.js');
const SKIP_NON_UNIX = process.platform === 'win32';

let tmpRoot: string;

function runVersionCheck(pluginRoot: string, fakeBinDir: string): Promise<{ stderr: string; stdout: string; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [VERSION_CHECK_PATH], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_MEM_DATA_DIR: join(pluginRoot, '.claude-mem'),
        CLAUDE_CONFIG_DIR: join(pluginRoot, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

      child.stdin.end();

      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`version-check subprocess exceeded ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolveResult({ stderr, stdout, code });
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      reject(err);
    }
  });
}

type BunBehavior = 'success' | 'partial-then-fail' | 'slow-success';

function makeFreshPlugin(name: string, bunBehavior: BunBehavior = 'success'): { pluginRoot: string; fakeBinDir: string } {
  const pluginRoot = join(tmpRoot, name);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
    name: 'fake-plugin',
    version: '0.0.0',
    dependencies: { zod: '^3.0.0' },
  }));
  writeFileSync(join(pluginRoot, '.install-version'), JSON.stringify({ version: '0.0.0' }));

  const fakeBinDir = join(pluginRoot, '.bin');
  mkdirSync(fakeBinDir, { recursive: true });

  // Fake bun behaviors:
  //   - success: creates the install marker file and exits 0 (happy path).
  //   - partial-then-fail: creates the partial node_modules dir THEN exits
  //     non-zero. Mirrors real bun's behavior under network timeout / OOM /
  //     registry 5xx where node_modules already exists when the failure
  //     surfaces. Required to cover the gh #2650 review-fix path that
  //     cleans up the partial dir so the next Setup run can retry.
  const fakeBunPath = join(fakeBinDir, 'bun');
  const installBody = bunBehavior === 'success'
    ? [
        `  mkdir -p "${pluginRoot}/node_modules/zod/v3"`,
        `  : > "${pluginRoot}/node_modules/zod/v3/index.js"`,
        '  exit 0',
      ]
    : bunBehavior === 'slow-success'
    ? [
        // Widens the window between "node_modules exists" and "marker
        // written" so a concurrent second Setup run reliably lands inside
        // it — reproducing the gh #3793 review race deterministically
        // instead of relying on timing luck.
        `  mkdir -p "${pluginRoot}/node_modules/zod/v3"`,
        '  sleep 1',
        `  : > "${pluginRoot}/node_modules/zod/v3/index.js"`,
        '  exit 0',
      ]
    : [
        `  mkdir -p "${pluginRoot}/node_modules"`,
        '  echo "fake bun install failure mid-fetch" 1>&2',
        '  exit 42',
      ];
  const fakeBunScript = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "install" ]; then',
    ...installBody,
    'fi',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(fakeBunPath, fakeBunScript);
  chmodSync(fakeBunPath, 0o755);

  return { pluginRoot, fakeBinDir };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'version-check-deps-'));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe.skipIf(SKIP_NON_UNIX)('version-check Setup-phase ensurePluginDependencies (gh #2649)', () => {
  test('installs plugin dependencies when node_modules is missing on fresh extract', async () => {
    // This is the gh #2640 / #2637 scenario: marketplace extracts files but
    // never runs `bun install`. Setup MUST detect the missing node_modules and
    // invoke dependency installation, otherwise the next hook (SessionStart
    // worker spawn) crashes with `Cannot find module 'zod/v3'`.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-fresh');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
  });

  test('cleans up partial node_modules after a failed install so next Setup can retry (gh #2650 review)', async () => {
    // Reproduces the Greptile review concern: `bun install` often creates
    // the node_modules directory BEFORE it fails (mid-fetch network
    // timeout, registry 5xx, OOM kill). Without explicit cleanup, the
    // `existsSync(node_modules)` guard would permanently short-circuit
    // every subsequent Setup run and the user has no recovery path short
    // of a manual `rm -rf node_modules`. Verify that after a failed
    // install the partial dir is removed.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-partial-fail', 'partial-then-fail');

    // Sanity-check the failure path: node_modules MUST exist before our
    // cleanup runs (otherwise we are not exercising the gh #2650 scenario).
    // Run version-check once and confirm both the failure diagnostic and
    // the post-cleanup absence of node_modules.
    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_FAILURE_DIAGNOSTIC);
    expect(stderr).toContain('exit 42');
    expect(existsSync(join(pluginRoot, 'node_modules'))).toBe(false);
  });

  test('skips install when a completed install marker is already present', async () => {
    // Setup runs on every Claude Code launch. If a previous install finished,
    // the install MUST be skipped — otherwise we re-run a 100 MB+ install on
    // every cold start and burn the user's bandwidth.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-already-installed');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', '.claude-mem-install-complete'), '');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    // The fake bun would have created zod/v3/index.js if invoked — its
    // absence proves the install path was not taken.
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(false);
  });

  test('removes an interrupted node_modules and reinstalls when it fails validation (gh #3793)', async () => {
    // Reproduces gh #3793: a worker version-mismatch tree-kill SIGKILLs this
    // script's own process mid-install, so node_modules exists but is
    // partial (the declared zod dependency has no package.json) and no
    // cleanup code ever ran. A node_modules that fails validation and lacks
    // the marker must be treated as incomplete: removed, then reinstalled.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-interrupted-install');
    mkdirSync(join(pluginRoot, 'node_modules', 'zod'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
    expect(existsSync(join(pluginRoot, 'node_modules', '.claude-mem-install-complete'))).toBe(true);
  });

  test('migrates a valid legacy install in place instead of deleting and reinstalling it (gh #3799 review)', async () => {
    // A node_modules that predates this marker requirement (e.g. an
    // installer/repair path that skipped installPluginDependencies because
    // the install was already current, or a marketplace root this repo's
    // installer never touches at all — this script's own bootstrap is the
    // only thing that has ever populated it) is otherwise perfectly good.
    // Deleting and forcing a reinstall is an unnecessary risk: if that
    // reinstall then fails, the plugin goes from working to broken. A tree
    // whose declared dependency actually resolves must be marked complete
    // in place, not discarded.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-legacy-valid-install');
    mkdirSync(join(pluginRoot, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '3.0.0' }));

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, 'node_modules', '.claude-mem-install-complete'))).toBe(true);
    // The fake bun would have created zod/v3/index.js if invoked — its
    // absence proves no reinstall happened, only a marker write.
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(false);
  });

  test('a second Setup run racing the first skips instead of deleting the in-flight install (gh #3793 review)', async () => {
    // Reproduces the Greptile review finding: two Setup hooks can fire near-
    // simultaneously (several Claude Code sessions launched at once, the
    // exact scenario in the original report). Without a lock, the second
    // process sees node_modules exists without the completion marker yet
    // (the first is still mid-install) and deletes it out from under the
    // first, corrupting the install.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-concurrent-install', 'slow-success');

    const first = runVersionCheck(pluginRoot, fakeBinDir);
    // Give the first process time to win the lock and start its (1s) bun
    // install before the second process starts, so the second reliably
    // lands inside the vulnerable window instead of winning the race itself.
    await new Promise((r) => setTimeout(r, 200));
    const second = runVersionCheck(pluginRoot, fakeBinDir);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    const results = [firstResult, secondResult];

    const installed = results.filter((r) => r.stderr.includes(INSTALL_DIAGNOSTIC));
    const skipped = results.filter((r) => r.stderr.includes('another process is installing'));
    expect(installed.length).toBe(1);
    expect(skipped.length).toBe(1);

    // The install that did run must have completed cleanly — proof the
    // skipped process never touched the in-flight node_modules.
    expect(installed[0].stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
    expect(existsSync(join(pluginRoot, 'node_modules', '.claude-mem-install-complete'))).toBe(true);
  });

  test('reclaims a stale install lock left by a killed process instead of blocking forever (gh #3793 review)', async () => {
    // A worker version-mismatch tree-kill (the original gh #3793 bug) can
    // SIGKILL this script mid-install, leaving the lock directory itself
    // held forever with no process left to release it. Without staleness
    // recovery, that would trade the old "node_modules exists forever"
    // deadlock for an equivalent "lock exists forever" deadlock.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-stale-lock');
    const lockPath = join(pluginRoot, '.claude-mem-install.lock');
    mkdirSync(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes old
    utimesSync(lockPath, staleTime, staleTime);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
    // The lock is released after use, not left behind for the next run.
    expect(existsSync(lockPath)).toBe(false);
  });
});

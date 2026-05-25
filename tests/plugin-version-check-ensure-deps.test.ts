import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

type BunBehavior = 'success' | 'partial-then-fail';

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

  test('skips install when node_modules is already present', async () => {
    // Setup runs on every Claude Code launch. If node_modules already exists,
    // the install MUST be skipped — otherwise we re-run a 100 MB+ install on
    // every cold start and burn the user's bandwidth.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-already-installed');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    // The fake bun would have created zod/v3/index.js if invoked — its
    // absence proves the install path was not taken.
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(false);
  });
});

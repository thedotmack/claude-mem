import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const BUN_RUNNER_PATH = join(REPO_ROOT, 'plugin', 'scripts', 'bun-runner.js');
const FAKE_SCRIPT_ARG = 'fake-script.cjs';
const SPAWN_TIMEOUT_MS = 15_000;
const EXPECTED_DIAGNOSTIC = '[bun-runner] bun install failed';

let tmpRoot: string;

function runRunner(pluginRoot: string, fakeBinDir: string): Promise<{ stderr: string; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [BUN_RUNNER_PATH, FAKE_SCRIPT_ARG], {
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
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.stdin.end();

      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`bun-runner subprocess exceeded ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolveResult({ stderr, code });
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

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bun-runner-deps-'));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe('bun-runner ensurePluginDependencies failure diagnostics', () => {
  test('logs a stderr diagnostic when bun install exits non-zero', async () => {
    const pluginRoot = join(tmpRoot, 'plugin-fail');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'fake-plugin', version: '0.0.0' }));

    const fakeBinDir = join(pluginRoot, '.bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeBunPath = join(fakeBinDir, 'bun');
    writeFileSync(
      fakeBunPath,
      `#!/usr/bin/env bash\nif [ "$1" = "install" ]; then\n  echo "fake bun install failure" 1>&2\n  exit 42\nfi\nexit 0\n`,
    );
    chmodSync(fakeBunPath, 0o755);

    const { stderr } = await runRunner(pluginRoot, fakeBinDir);

    expect(stderr).toContain(EXPECTED_DIAGNOSTIC);
    expect(stderr).toContain('exit 42');
  });

  test('logs a stderr diagnostic when bun install is killed by signal (OOM / SIGKILL / SIGTERM)', async () => {
    // Reproduces gh#2644 greptile review: spawnSync sets status=null AND
    // leaves .error undefined when the child is killed by an external signal —
    // only .signal carries the cause. Without an explicit signal branch the
    // failure is swallowed silently. Fake bun raises SIGTERM against itself.
    const pluginRoot = join(tmpRoot, 'plugin-signal');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'fake-plugin', version: '0.0.0' }));

    const fakeBinDir = join(pluginRoot, '.bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeBunPath = join(fakeBinDir, 'bun');
    writeFileSync(
      fakeBunPath,
      `#!/usr/bin/env bash\nif [ "$1" = "install" ]; then\n  kill -TERM $$\n  sleep 5\nfi\nexit 0\n`,
    );
    chmodSync(fakeBunPath, 0o755);

    const { stderr } = await runRunner(pluginRoot, fakeBinDir);

    expect(stderr).toContain(EXPECTED_DIAGNOSTIC);
    expect(stderr).toContain('killed by SIGTERM');
  });

  test('does not log diagnostic when node_modules already present', async () => {
    const pluginRoot = join(tmpRoot, 'plugin-ok');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'fake-plugin', version: '0.0.0' }));

    const fakeBinDir = join(pluginRoot, '.bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeBunPath = join(fakeBinDir, 'bun');
    writeFileSync(
      fakeBunPath,
      `#!/usr/bin/env bash\nif [ "$1" = "install" ]; then\n  echo "should-not-be-called" 1>&2\n  exit 99\nfi\nexit 0\n`,
    );
    chmodSync(fakeBunPath, 0o755);

    const { stderr } = await runRunner(pluginRoot, fakeBinDir);

    expect(stderr).not.toContain(EXPECTED_DIAGNOSTIC);
    expect(stderr).not.toContain('should-not-be-called');
  });
});

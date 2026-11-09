import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { spawnVersionProbe } from '../../src/npx-cli/install/tool-path.js';

test('a responsive version command still reports its output', () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = spawnVersionProbe(process.execPath, ['--version']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\d+\.\d+/);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [], 'A probe that answered in time must not warn.');
});

test('a stuck version command cannot indefinitely block runtime discovery', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tool-version-timeout-'));
  const runner = join(directory, 'probe.cjs');
  const source = fileURLToPath(new URL('../../src/npx-cli/install/tool-path.ts', import.meta.url));
  let child: ReturnType<typeof spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let closed = false;
  const stopOwnedProcessGroup = () => {
    if (!closed && child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  try {
    await build({
      stdin: { contents: `
        import { spawnVersionProbe } from ${JSON.stringify(source)};
        const result = spawnVersionProbe(process.execPath, ['-e',
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);']);
        console.log(JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code }));
      `, resolveDir: directory, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile: runner,
    });
    child = spawn(process.execPath, [runner], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    watchdog = setTimeout(() => { watchdogFired = true; stopOwnedProcessGroup(); }, 8_000);
    const exit = await new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', code => { closed = true; resolve(code); });
    });
    assert.equal(watchdogFired, false, 'The version probe required an external watchdog to stop it.');
    assert.equal(exit, 0, errors);
    const result = JSON.parse(output);
    assert.equal(result.error, 'ETIMEDOUT');
    assert.equal(result.status, null);
    assert.equal(result.signal, 'SIGKILL');
    assert.match(errors, /claude-mem: .+ -e .+ did not answer within 5s; treating it as unavailable/);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    stopOwnedProcessGroup();
    rmSync(directory, { recursive: true, force: true });
  }
});

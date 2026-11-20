import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpmStrict } from '../src/npx-cli/install/npm-install-helper.js';

const INSTALL_TIMEOUT_SENTINEL_MS = 987_654;
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

function makeFixture(directory: string) {
  const parentPid = join(directory, 'parent.pid'), descendantPid = join(directory, 'descendant.pid');
  const stopFile = join(directory, 'stop'), heartbeat = join(directory, 'heartbeat');
  const descendant = join(directory, 'descendant.cjs');
  const parent = join(directory, 'parent.cjs');
  writeFileSync(descendant, `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    process.stdout.write('descendant inherited stdout\\n');
    fs.writeFileSync(${JSON.stringify(heartbeat)}, '0');
    fs.writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid));
    let ticks = 0;
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks));
    }, 20);
    setTimeout(() => process.exit(0), 12_000).unref();
  `);
  writeFileSync(parent, `
    process.on('SIGTERM', () => process.exit(0));
    require('node:fs').writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'inherit' });
    setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 20);
    setTimeout(() => process.exit(0), 12_000).unref();
  `);
  writeFileSync(join(directory, 'npm'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(parent)}\n`, { mode: 0o755 });
  // Fixture-only cleanup does not depend on signalling a released parent PID.
  return { descendantPid, heartbeat, stop: () => writeFileSync(stopFile, 'stop') };
}

async function waitForFixture(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!existsSync(path)) {
    assert.ok(performance.now() < deadline, 'The fixture descendant did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function assertHeartbeatStopped(heartbeat: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50));
  const stopped = readFileSync(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(readFileSync(heartbeat, 'utf8'), stopped, 'The descendant still runs after the operation returned.');
}

test('a timed-out npm tree cannot leave a descendant holding its output pipes', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-descendant-timeout-'));
  const { descendantPid, heartbeat, stop: stopFixture } = makeFixture(directory);
  const oldPath = process.env.PATH, oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  const nativeSetTimeout = globalThis.setTimeout;
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let triggerTimeout: (() => void) | undefined;
  let watchdogFired = false;
  let pending: ReturnType<typeof runNpmStrict> | undefined;
  try {
    process.env.PATH = `${directory}:${oldPath ?? ''}`;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = String(INSTALL_TIMEOUT_SENTINEL_MS);
    // Fire the install deadline only after both real processes have installed
    // their signal handlers. All grace and watchdog timers remain real timers.
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== INSTALL_TIMEOUT_SENTINEL_MS) return nativeSetTimeout(callback, ms, ...args);
      triggerTimeout = () => callback(...args);
      heldTimer = nativeSetTimeout(() => {}, 60_000);
      return heldTimer;
    }) as typeof setTimeout;
    pending = runNpmStrict(directory, ['fixture']);
    globalThis.setTimeout = nativeSetTimeout;
    await waitForFixture(descendantPid);
    assert.ok(triggerTimeout);
    watchdog = setTimeout(() => { watchdogFired = true; stopFixture(); }, 4_000);
    const started = performance.now();
    triggerTimeout();
    const result = await pending;
    assert.equal(watchdogFired, false, 'The direct npm process exited, but its descendant kept the captured pipes open.');
    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /descendant inherited stdout/);
    assert.ok(performance.now() - started < 3_000);
    await assertHeartbeatStopped(heartbeat);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    if (watchdog) clearTimeout(watchdog);
    if (heldTimer) clearTimeout(heldTimer);
    stopFixture();
    if (pending) await pending;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a successful npm process still returns normally', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-descendant-success-'));
  const oldPath = process.env.PATH, oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
  const listeners = signals.map(signal => process.listeners(signal));
  try {
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nprintf "install complete\\n"\n', { mode: 0o755 });
    process.env.PATH = `${directory}:${oldPath ?? ''}`;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '2000';
    assert.deepEqual(await runNpmStrict(directory, ['fixture']), { code: 0, timedOut: false, stdout: 'install complete\n', stderr: '' });
    assert.deepEqual(signals.map(signal => process.listeners(signal)), listeners);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`installer ${signal} preserves its owner and stops its npm descendants`, { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'npm-parent-signal-'));
    const fixture = makeFixture(directory);
    const handledPath = join(directory, 'handled');
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    try {
      const runner = join(directory, 'installer.cjs');
      const source = fileURLToPath(new URL('../src/npx-cli/install/npm-install-helper.ts', import.meta.url));
      await build({
        stdin: { contents: `
          import { runNpmStrict } from ${JSON.stringify(source)};
          import { writeFileSync } from 'node:fs';
          ${signal === 'SIGTERM' ? `process.once('SIGTERM', () => { writeFileSync(${JSON.stringify(handledPath)}, 'handled'); process.exit(42); });` : ''}
          runNpmStrict(${JSON.stringify(directory)}, ['fixture']).catch(error => { console.error(error); process.exitCode = 1; });
        `, resolveDir: directory, loader: 'ts' },
        bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: runner, logLevel: 'silent',
      });
      child = spawn(process.execPath, [runner], {
        detached: true,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, CLAUDE_MEM_INSTALL_TIMEOUT_MS: '30000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stdout!.resume();
      child.stderr!.on('data', chunk => { errors += String(chunk); });
      exited = new Promise((resolve, reject) => {
        child!.once('error', reject);
        child!.once('close', (code, signal) => resolve({ code, signal }));
      });
      await waitForFixture(fixture.descendantPid);
      watchdog = setTimeout(() => { watchdogFired = true; fixture.stop(); child!.kill('SIGKILL'); }, 2_000);
      // A terminal sends Ctrl-C to the foreground process group, not just the
      // installer's PID. The fixture owns this group.
      process.kill(-child.pid!, signal);
      const result = await exited;
      assert.equal(watchdogFired, false, errors);
      if (signal === 'SIGTERM') {
        assert.equal(result.code, 42, errors);
        assert.equal(readFileSync(handledPath, 'utf8'), 'handled');
      } else {
        assert.ok(result.signal === 'SIGINT' || result.code === 130, JSON.stringify(result));
      }
      await assertHeartbeatStopped(fixture.heartbeat);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      fixture.stop();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (exited) await exited.catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

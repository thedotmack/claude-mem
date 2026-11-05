import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runNpmStrict } from '../src/npx-cli/install/npm-install-helper.js';

// The install timeout is set to this sentinel and its timer is held until the
// fake installer has written its pid, which it does only after installing its
// SIGTERM disposition. A freshly written executable can take over a second to
// start on a loaded host (macOS scans it first), and a SIGTERM that lands
// before the trap would kill it outright instead of exercising the grace path.
const INSTALL_TIMEOUT_SENTINEL_MS = 987_654;

function holdInstallTimeoutUntilReady(pidFile: string): { triggeredAt: () => number; restore: () => void } {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const heldTimers = new Set<object>();
  let triggeredAt = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== INSTALL_TIMEOUT_SENTINEL_MS) return nativeSetTimeout(callback, ms, ...args);
    const heldTimer = {};
    heldTimers.add(heldTimer);
    const fireWhenReady = () => {
      if (!heldTimers.has(heldTimer)) return;
      if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()) {
        heldTimers.delete(heldTimer);
        triggeredAt = performance.now();
        callback(...args);
      } else nativeSetTimeout(fireWhenReady, 10);
    };
    nativeSetTimeout(fireWhenReady, 0);
    return heldTimer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    if (timer && heldTimers.delete(timer as object)) return;
    nativeClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  return {
    triggeredAt: () => triggeredAt,
    restore: () => { globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout; },
  };
}

it.skipIf(process.platform === 'win32')('terminates a timed-out installer that ignores SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-npm-timeout-'));
  const pidFile = join(root, 'child.pid');
  const oldPath = process.env.PATH;
  const oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const current = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 5000 });
      if (current.status === 0 && current.stdout.includes(root)) process.kill(pid, 'SIGKILL');
    } catch {}
  };
  // Independent cleanup guarantees the failing baseline never leaves an orphan.
  const watchdog = setTimeout(cleanup, 15000);
  try {
    // The installer ignores SIGTERM from its first shell instruction (an ignored
    // disposition survives exec), so a slow runtime start cannot let the timeout's
    // SIGTERM land before the handler exists.
    writeFileSync(join(root, 'hold.js'), 'setInterval(()=>{},100);\n');
    writeFileSync(join(root, 'npm'), `#!/bin/sh\ntrap '' TERM\necho $$ > ${JSON.stringify(pidFile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'hold.js'))}\n`, { mode: 0o755 });
    process.env.PATH = root + ':' + oldPath;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = String(INSTALL_TIMEOUT_SENTINEL_MS);
    const installTimeout = holdInstallTimeoutUntilReady(pidFile);
    let result: Awaited<ReturnType<typeof runNpmStrict>>;
    try { result = await runNpmStrict(root, ['fixture']); } finally { installTimeout.restore(); }
    settled = true;
    expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    // SIGTERM is ignored, so the SIGKILL after the grace period must end the wait.
    expect(performance.now() - installTimeout.triggeredAt()).toBeLessThan(4000);
  } finally {
    clearTimeout(watchdog); cleanup();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it.skipIf(process.platform === 'win32')('reports a timeout even if the child handles SIGTERM by exiting zero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-npm-timeout-zero-'));
  const pidFile = join(root, 'child.pid');
  const oldPath = process.env.PATH;
  const oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const current = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 5000 });
      if (current.status === 0 && current.stdout.includes(root)) process.kill(pid, 'SIGKILL');
    } catch {}
  };
  const watchdog = setTimeout(cleanup, 15000);
  try {
    // The SIGTERM handler is installed by the installer's first shell instruction,
    // so a slow runtime start cannot race the timeout's SIGTERM.
    writeFileSync(join(root, 'npm'), `#!/bin/sh\ntrap 'exit 0' TERM\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1 & wait $!; done\n`, { mode: 0o755 });
    process.env.PATH = root + ':' + oldPath;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = String(INSTALL_TIMEOUT_SENTINEL_MS);
    const installTimeout = holdInstallTimeoutUntilReady(pidFile);
    let result: Awaited<ReturnType<typeof runNpmStrict>>;
    try { result = await runNpmStrict(root, ['fixture']); } finally { installTimeout.restore(); }
    settled = true;
    expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(124);
  } finally {
    clearTimeout(watchdog); cleanup();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

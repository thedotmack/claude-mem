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

async function withFakeNpm(
  script: (root: string, pidFile: string) => string,
  run: (result: Awaited<ReturnType<typeof runNpmStrict>>, elapsedMs: number) => void,
): Promise<void> {
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
  let installTimeout: ReturnType<typeof holdInstallTimeoutUntilReady> | undefined;
  try {
    writeFileSync(join(root, 'hold.js'), 'setInterval(()=>{},100);\n');
    writeFileSync(join(root, 'npm'), script(root, pidFile), { mode: 0o755 });
    process.env.PATH = root + ':' + oldPath;
    process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = String(INSTALL_TIMEOUT_SENTINEL_MS);
    installTimeout = holdInstallTimeoutUntilReady(pidFile);
    const result = await runNpmStrict(root, ['fixture']);
    settled = true;
    expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
    run(result, performance.now() - installTimeout.triggeredAt());
  } finally {
    installTimeout?.restore();
    clearTimeout(watchdog); cleanup();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
    rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === 'win32')('terminates a timed-out installer that ignores SIGTERM', async () => {
  // An ignored disposition survives exec, so startup cannot race SIGTERM.
  await withFakeNpm(
    (root, pidFile) => `#!/bin/sh\ntrap '' TERM\necho $$ > ${JSON.stringify(pidFile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'hold.js'))}\n`,
    (result, elapsedMs) => {
      expect(result.code).not.toBe(0);
      // SIGTERM is ignored, so the SIGKILL after the grace period must end the wait.
      expect(elapsedMs).toBeLessThan(4000);
    },
  );
}, 20000);

it.skipIf(process.platform === 'win32')('reports a timeout even if the child handles SIGTERM by exiting zero', async () => {
  // Install the trap before publishing readiness to the test.
  await withFakeNpm(
    (_root, pidFile) => `#!/bin/sh\ntrap 'exit 0' TERM\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1 & wait $!; done\n`,
    result => { expect(result.code).toBe(124); },
  );
}, 20000);

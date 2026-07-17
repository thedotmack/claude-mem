import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isWorkerJobObjectAvailable,
  assignPidToWorkerJob,
  assignProcessTreeToWorkerJob,
  __resetWorkerJobObjectForTesting,
} from '../../src/services/infrastructure/WindowsJobObject.js';
import { isPidAlive } from '../../src/supervisor/process-registry.js';

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return predicate();
}

function killIfAlive(pid: number): void {
  try {
    if (isPidAlive(pid)) process.kill(pid, 'SIGKILL' as unknown as number);
  } catch {
    // already dead
  }
}

describe('WindowsJobObject', () => {
  describe('platform guard', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      __resetWorkerJobObjectForTesting();
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
        configurable: true,
      });
      __resetWorkerJobObjectForTesting();
    });

    // NOTE: the module's win32/Bun support check (`IS_SUPPORTED`) is a
    // load-time constant, not re-evaluated per call — so on a real win32 dev
    // machine (this one), simply stubbing `process.platform` after the module
    // has already been imported once (by the static import above) has no
    // effect: IS_SUPPORTED already latched `true` against the real platform.
    // To exercise the actual non-win32 guard path we import a cache-busted
    // fresh module instance *after* stubbing the platform, so IS_SUPPORTED
    // freezes as `false` for that instance — this reproduces exactly what
    // happens on a real non-Windows machine, without ever touching bun:ffi.
    test('is a no-op on non-win32 platforms without throwing', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true,
      });

      const fresh = await import(
        `../../src/services/infrastructure/WindowsJobObject.js?platform-guard-${Date.now()}-${Math.random()}`
      );

      try {
        expect(() => {
          expect(fresh.isWorkerJobObjectAvailable()).toBe(false);
          expect(fresh.assignPidToWorkerJob(1234, 'x')).toBe(false);
          expect(fresh.assignProcessTreeToWorkerJob(1234, 'x')).toBeNull();
        }).not.toThrow();
      } finally {
        fresh.__resetWorkerJobObjectForTesting();
      }
    });
  });

  describe.skipIf(process.platform !== 'win32')('win32 integration', () => {
    beforeEach(() => {
      __resetWorkerJobObjectForTesting();
    });

    afterEach(() => {
      __resetWorkerJobObjectForTesting();
    });

    test('kill-on-close terminates a single assigned child when the job handle closes', async () => {
      const child = Bun.spawn(['bun', '-e', 'setTimeout(()=>{},60000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      try {
        expect(assignPidToWorkerJob(child.pid, 'test')).toBe(true);

        __resetWorkerJobObjectForTesting();

        const died = await waitUntil(() => !isPidAlive(child.pid), 3000);
        expect(died).toBe(true);
      } finally {
        killIfAlive(child.pid);
      }
    }, 10000);

    test('tree sweep assigns and kills a spawned child and its grandchild', async () => {
      const child = Bun.spawn([
        'bun',
        '-e',
        "Bun.spawn(['bun','-e','setTimeout(()=>{},60000)']); setTimeout(()=>{},60000)",
      ], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      let grandchildPid: number | undefined;

      try {
        // Give the grandchild a moment to actually spawn before we sweep.
        await new Promise(r => setTimeout(r, 500));

        const result = assignProcessTreeToWorkerJob(child.pid, 'test');
        expect(result).not.toBeNull();
        expect(result!.assigned.length).toBeGreaterThanOrEqual(2);
        expect(result!.assigned).toContain(child.pid);

        grandchildPid = result!.assigned.find(pid => pid !== child.pid);
        expect(grandchildPid).toBeDefined();

        __resetWorkerJobObjectForTesting();

        const childDied = await waitUntil(() => !isPidAlive(child.pid), 3000);
        const grandchildDied = await waitUntil(() => !isPidAlive(grandchildPid as number), 3000);

        expect(childDied).toBe(true);
        expect(grandchildDied).toBe(true);
      } finally {
        killIfAlive(child.pid);
        if (grandchildPid !== undefined) killIfAlive(grandchildPid);
      }
    }, 10000);

    // Guards the root-first ordering in assignProcessTreeToWorkerJob: because
    // the root is assigned to the job BEFORE the descendant snapshot is taken,
    // a child the root spawns AFTER assignment must inherit membership and die
    // on handle close — even though it never appeared in any snapshot. This is
    // exactly the snapshot->root-join race the ordering closes (a `.cmd`
    // wrapper forking its real child after the sweep would otherwise orphan).
    test('a child spawned AFTER the root is assigned inherits membership and is killed', async () => {
      // Parent has NO children at spawn; it forks one 700ms later — after we
      // assign the parent. Spawned directly (no cmd), so inline-script
      // metacharacters are safe.
      const parent = Bun.spawn([
        'bun',
        '-e',
        "setTimeout(()=>{Bun.spawn(['bun','-e','setTimeout(()=>{},60000)']);},700); setTimeout(()=>{},60000)",
      ], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      let lateChildPid: number | undefined;

      try {
        // Assign the parent immediately, while it still has no children.
        const result = assignProcessTreeToWorkerJob(parent.pid, 'test-inherit');
        expect(result).not.toBeNull();
        expect(result!.assigned).toContain(parent.pid);
        // Nothing to sweep yet — the child does not exist at assignment time.
        expect(result!.assigned).toEqual([parent.pid]);

        // Let the parent fork its child; it must inherit the job.
        await new Promise(r => setTimeout(r, 1200));

        // Discover the inherited child via a fresh sweep (idempotent) purely to
        // learn its pid for the death assertion.
        const probe = assignProcessTreeToWorkerJob(parent.pid, 'test-inherit');
        lateChildPid = probe!.assigned.find(pid => pid !== parent.pid);
        expect(lateChildPid).toBeDefined();

        __resetWorkerJobObjectForTesting();

        const parentDied = await waitUntil(() => !isPidAlive(parent.pid), 3000);
        const lateChildDied = await waitUntil(() => !isPidAlive(lateChildPid as number), 3000);

        expect(parentDied).toBe(true);
        expect(lateChildDied).toBe(true);
      } finally {
        killIfAlive(parent.pid);
        if (lateChildPid !== undefined) killIfAlive(lateChildPid);
      }
    }, 10000);

    // Models the SDK spawn topology from process-registry.ts:spawnSdkProcess:
    // on Windows a `.cmd` command is launched through `cmd.exe /d /c <cmd>`, so
    // the real long-lived process is a GRANDCHILD of the pid we hold. This is
    // exactly why spawnSdkProcess uses the TREE sweep, not a single-PID assign:
    // the grandchild spawned by the cmd wrapper must be captured retroactively
    // or it survives an abnormal worker death and orphans.
    test('tree sweep captures a cmd.exe-wrapped grandchild (SDK topology) and kills it on close', async () => {
      // cmd.exe /d /c <long-lived program> — the program is the grandchild,
      // mirroring how the real Claude CLI sits under the cmd wrapper. Pipe
      // stdio (as spawnSdkProcess uses) keeps the cmd wrapper alive; `ping`
      // is a metacharacter-free long-runner so cmd waits on it and doesn't
      // abort at its own command parse.
      const child = Bun.spawn(
        ['cmd.exe', '/d', '/c', 'ping', '-n', '60', '127.0.0.1'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );

      let grandchildPid: number | undefined;

      try {
        // Let cmd.exe launch the ping grandchild before we sweep.
        await new Promise(r => setTimeout(r, 800));

        const result = assignProcessTreeToWorkerJob(child.pid, 'sdk:test');
        expect(result).not.toBeNull();
        // At minimum the cmd wrapper; on a healthy spawn the ping grandchild too.
        expect(result!.assigned).toContain(child.pid);
        expect(result!.assigned.length).toBeGreaterThanOrEqual(2);

        grandchildPid = result!.assigned.find(pid => pid !== child.pid);
        expect(grandchildPid).toBeDefined();

        // Close the job handle: the abnormal-death backstop. Both the cmd
        // wrapper and the ping grandchild must die.
        __resetWorkerJobObjectForTesting();

        const childDied = await waitUntil(() => !isPidAlive(child.pid), 3000);
        const grandchildDied = await waitUntil(() => !isPidAlive(grandchildPid as number), 3000);

        expect(childDied).toBe(true);
        expect(grandchildDied).toBe(true);
      } finally {
        killIfAlive(child.pid);
        if (grandchildPid !== undefined) killIfAlive(grandchildPid);
      }
    }, 10000);

    test('assigning the same PID twice is idempotent and does not throw', () => {
      const child = Bun.spawn(['bun', '-e', 'setTimeout(()=>{},60000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      try {
        expect(() => {
          expect(assignPidToWorkerJob(child.pid, 'test')).toBe(true);
          expect(assignPidToWorkerJob(child.pid, 'test')).toBe(true);
        }).not.toThrow();
      } finally {
        killIfAlive(child.pid);
      }
    });

    test('a nonexistent PID returns false without throwing', () => {
      expect(() => {
        expect(assignPidToWorkerJob(999999999, 'x')).toBe(false);
      }).not.toThrow();
    });
  });
});

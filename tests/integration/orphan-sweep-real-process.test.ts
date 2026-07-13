import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { paths } from '../../src/shared/paths.js';
import { createProcessRegistry, isPidAlive } from '../../src/supervisor/process-registry.js';
import { reapOrphanedChromaProcesses } from '../../src/supervisor/orphan-sweep.js';

// The DURABLE regression contract for the chroma-mcp orphan leak (#3216/#3218):
// a REAL process that re-parents to init / systemd --user (which the synthetic
// FakeChildProcess-based tests structurally cannot reproduce) must be found and
// tree-killed by the boot sweep. Hermetic — uses a throwaway node sleeper whose
// cmdline carries the chroma-mcp markers, so it needs no uvx/network and gates
// in CI on any POSIX runner.
const isPosix = process.platform !== 'win32';

function ppidOf(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

/** {1} ∪ live `systemd --user` pids — the set an orphaned grandchild re-parents to. */
function orphanParentSet(): Set<number> {
  const set = new Set<number>([1]);
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && m[2].startsWith('systemd --user')) set.add(Number(m[1]));
    }
  } catch { /* best effort */ }
  return set;
}

describe.skipIf(!isPosix)('orphan-sweep — real orphaned chroma-mcp tree (#3216)', () => {
  const spawned: number[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('finds and tree-kills a real chroma-mcp orphan re-parented to init/systemd --user', async () => {
    const chromaDir = paths.chroma();

    // A launcher that spawns a detached "chroma-mcp --data-dir <ours>" sleeper,
    // prints its pid, and exits — so the sleeper re-parents to init/systemd --user.
    const launcher =
      `const { spawn } = require('child_process');` +
      `const child = spawn(process.execPath, ['-e','setTimeout(()=>{},60000)','chroma-mcp','--client-type','persistent','--data-dir',${JSON.stringify(chromaDir)}], { detached: true, stdio: 'ignore' });` +
      `child.unref(); process.stdout.write(String(child.pid));`;

    const orphanPid = Number(execFileSync(process.execPath, ['-e', launcher], { encoding: 'utf8' }).trim());
    expect(Number.isInteger(orphanPid) && orphanPid > 0).toBe(true);
    spawned.push(orphanPid);

    // Wait for the kernel to re-parent it onto the subreaper set.
    const parents = orphanParentSet();
    let reparented = false;
    for (let i = 0; i < 40; i++) {
      const pp = ppidOf(orphanPid);
      if (pp !== null && parents.has(pp)) { reparented = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(reparented).toBe(true);          // precondition: it really orphaned
    expect(isPidAlive(orphanPid)).toBe(true); // still alive going into the sweep

    // Fresh registry: the orphan is NOT tracked (an already-leaked tree).
    const dir = mkdtempSync(path.join(tmpdir(), 'sweep-'));
    tempDirs.push(dir);
    const registry = createProcessRegistry(path.join(dir, 'supervisor.json'));

    const reaped = await reapOrphanedChromaProcesses(registry);
    expect(reaped).toBeGreaterThanOrEqual(1);

    // killProcessTree does SIGTERM → 500ms → SIGKILL; poll generously for death.
    for (let i = 0; i < 60 && isPidAlive(orphanPid); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(isPidAlive(orphanPid)).toBe(false);
  });
});

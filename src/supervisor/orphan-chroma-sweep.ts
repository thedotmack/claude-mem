/**
 * Boot-time sweep for chroma-mcp process trees that no worker owns.
 *
 * Why this exists (#3905, #3301, #3175). When a worker dies without running its shutdown
 * cascade — SIGKILL from a version-mismatch recycle, OOM, `kill -9`, a deadline that fires before
 * teardown — its `uvx -> uv -> python chroma-mcp` tree survives and reparents to PID 1. The
 * supervisor registry keeps Chroma under one fixed key, so the successor's first spawn overwrites
 * the only record of that tree. From then on nothing in the process can find it: the registry
 * reapers (#3178, #3302) operate on rows, and the row is gone. Machines have been measured with
 * 619 and 808 such pairs, tens of GB of swap, load averages in the hundreds.
 *
 * So this sweep does not read the registry to find orphans. It reads the process table, keeps the
 * rows whose command line carries the chroma-mcp launch signature, groups them into trees, and
 * treats a tree as orphaned when its root's parent is PID 1 or is no longer alive. Trees whose
 * root is a child of this worker are ours and are never touched. Each orphan root goes through the
 * shared `killProcessTree`, which self-captures the root's start token and revalidates it before
 * every signal, so a recycled PID is never signalled.
 *
 * This is complementary to the registry-based reapers, not a replacement: they stop new
 * accumulation once a row exists; this clears the debt of trees that never had one. It runs once
 * at supervisor start, best-effort, and never blocks boot — a failure here leaves the pre-sweep
 * state, which is exactly what every earlier version did.
 *
 * Windows is a no-op: no `ps`, no PID 1 reparenting, and `taskkill /T` semantics differ enough
 * that a separate implementation would be needed (#3302 made the same call).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { killProcessTree } from '../shared/kill-process-tree.js';
import { isPidAlive, type ManagedProcessRecord } from './process-registry.js';

const execFileAsync = promisify(execFile);

/** One process-table row, the three fields this sweep needs. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * The launch signature. ChromaMcpManager spawns `uvx ... chroma-mcp ...` directly, and every
 * process in the resulting tree carries `chroma-mcp` in its command line: `uvx`, then `uv tool
 * uvx`, then `.../python3.x .../bin/chroma-mcp`. Two constraints, each for a reason: the executable
 * must be uvx, uv or python, so an editor open on a file named `chroma-mcp-incident.md` under PID 1
 * is never a candidate; and `chroma-mcp` may appear anywhere after it, so the python grandchild,
 * the process that actually holds the memory, is matched too.
 */
export const CHROMA_LAUNCH_SIGNATURE = /(?:^|\/)(?:uvx|uv|python[\d.]*)(?:\s|$).*chroma-mcp/;

export interface SweepDeps {
  /** Process-table reader; the real one shells out to `ps`. */
  readTable?: () => Promise<ProcessRow[]>;
  /** Liveness probe for parent PIDs. */
  isAlive?: (pid: number) => boolean;
  /** Tree kill for an orphan root; the real one is the shared killProcessTree. */
  killTree?: (pid: number) => Promise<void>;
  /** This worker's PID. Trees parented to it are owned, never orphans. */
  selfPid?: number;
  platform?: NodeJS.Platform;
  /** Registry to drop a `chroma` row whose PID was just reaped. Optional. */
  registry?: {
    getAll(): ManagedProcessRecord[];
    unregister(id: string): void;
  };
}

export interface SweepResult {
  /** Rows in the table that matched the signature. */
  matched: number;
  /** Tree roots among them. */
  trees: number;
  /** Roots whose parent is PID 1 or dead, excluding our own children. */
  orphans: number;
  killed: number;
  failed: number;
  /** Registry rows dropped because their PID was one of the killed roots. */
  unregistered: number;
  skipped: 'windows' | 'unreadable' | null;
}

/** Parse `ps -eo pid=,ppid=,command=` output. Exported for tests. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      command: match[3]!.trim(),
    });
  }
  return rows;
}

/**
 * `ps -eo pid=,ppid=,command=`, one snapshot. No `env:` is passed, so the child inherits the
 * parent's environment untouched (spawn-env discipline applies to env blocks handed to children;
 * `ps` gets none). `command=` is locale-independent.
 */
export async function readProcessTablePosix(): Promise<ProcessRow[]> {
  const result = await execFileAsync('ps', ['-eo', 'pid=,ppid=,command='], {
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseProcessTable(result.stdout);
}

/**
 * Among the rows that carry the signature, the roots are the ones whose parent is NOT itself a
 * signature row. A root is orphaned when its parent is PID 1 (reparented to init/launchd) or is
 * dead, and it is never one of our own children. Pure; exported for tests.
 */
export function findOrphanedChromaRoots(
  rows: ProcessRow[],
  options: { isAlive: (pid: number) => boolean; selfPid: number }
): { matched: ProcessRow[]; roots: ProcessRow[]; orphans: ProcessRow[] } {
  const matched = rows.filter((r) => CHROMA_LAUNCH_SIGNATURE.test(r.command) && r.pid !== options.selfPid);
  const matchedPids = new Set(matched.map((r) => r.pid));
  const roots = matched.filter((r) => !matchedPids.has(r.ppid));
  const orphans = roots.filter((r) => {
    if (r.ppid === options.selfPid) return false;
    if (r.ppid === 1) return true;
    return !options.isAlive(r.ppid);
  });
  return { matched, roots, orphans };
}

/**
 * Run the sweep. Best-effort throughout: a table read failure returns `skipped: 'unreadable'`, a
 * kill failure is counted and the next root is attempted. Kills run with bounded concurrency so a
 * machine carrying hundreds of orphans (measured: 619) does not take minutes to boot, and each
 * root's tree-kill is graceful (SIGTERM, settle, SIGKILL) via the shared primitive.
 */
export async function sweepOrphanedChromaTrees(deps: SweepDeps = {}): Promise<SweepResult> {
  const platform = deps.platform ?? process.platform;
  const result: SweepResult = {
    matched: 0, trees: 0, orphans: 0, killed: 0, failed: 0, unregistered: 0, skipped: null,
  };
  if (platform === 'win32') {
    result.skipped = 'windows';
    return result;
  }

  const readTable = deps.readTable ?? readProcessTablePosix;
  const isAlive = deps.isAlive ?? isPidAlive;
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid, { signalMode: 'graceful' }));
  const selfPid = deps.selfPid ?? process.pid;

  let rows: ProcessRow[];
  try {
    rows = await readTable();
  } catch (error) {
    logger.warn('PROCESS', 'Orphaned chroma-mcp sweep skipped: cannot read the process table', {
      error: error instanceof Error ? error.message : String(error),
    });
    result.skipped = 'unreadable';
    return result;
  }

  const { matched, roots, orphans } = findOrphanedChromaRoots(rows, { isAlive, selfPid });
  result.matched = matched.length;
  result.trees = roots.length;
  result.orphans = orphans.length;
  if (orphans.length === 0) {
    logger.debug('PROCESS', 'No orphaned chroma-mcp trees found', { matched: result.matched, trees: result.trees });
    return result;
  }

  logger.warn('PROCESS', 'Reaping orphaned chroma-mcp trees left by dead workers', {
    orphans: orphans.length,
    roots: orphans.map((r) => r.pid),
  });

  const killedPids = new Set<number>();
  const CONCURRENCY = 8;
  for (let i = 0; i < orphans.length; i += CONCURRENCY) {
    const batch = orphans.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.allSettled(batch.map((r) => killTree(r.pid)));
    outcomes.forEach((o, idx) => {
      const root = batch[idx]!;
      if (o.status === 'fulfilled') {
        result.killed += 1;
        killedPids.add(root.pid);
      } else {
        result.failed += 1;
        logger.warn('PROCESS', 'Failed to reap an orphaned chroma-mcp tree', {
          pid: root.pid,
          ppid: root.ppid,
          error: o.reason instanceof Error ? o.reason.message : String(o.reason),
        });
      }
    });
  }

  // A killed root may still have a registry row (the predecessor's, if nothing overwrote it yet).
  // Drop it so the successor's own registration starts clean. Only rows whose PID we just killed.
  if (deps.registry) {
    for (const record of deps.registry.getAll()) {
      if (record.type === 'chroma' && killedPids.has(record.pid)) {
        deps.registry.unregister(record.id);
        result.unregistered += 1;
      }
    }
  }

  logger.info('PROCESS', 'Orphaned chroma-mcp sweep finished', {
    orphans: result.orphans, killed: result.killed, failed: result.failed, unregistered: result.unregistered,
  });
  return result;
}

/**
 * POSIX/Windows process-tree teardown, extracted from ChromaMcpManager so both
 * the live-subprocess manager and the boot-time orphan sweep
 * (src/supervisor/orphan-sweep.ts) share one implementation. Kept dependency-
 * light (child_process + logger only) so the sweep and its tests need not pull
 * in the MCP-SDK-heavy ChromaMcpManager module.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// Static upper bound on the descendant walk (user Power-of-10 rule 2): a process
// tree deeper than this is pathological; the walk terminates rather than recurse
// unbounded. claude-mem's real chroma tree (uvx -> uv -> python -> chroma-mcp) is
// ~4 deep.
const MAX_TREE_DEPTH = 50;

/**
 * Kill a process and all its descendants (tree-kill).
 *
 * POSIX: Sends SIGTERM to the process, then uses `pgrep -P` to signal
 * children recursively. Falls back to single-PID kill if pgrep is unavailable.
 *
 * Windows: Uses `taskkill /T /F /PID` for full subtree teardown (same
 * pattern as shutdown.ts).
 *
 * Best-effort — swallows ESRCH (already dead) and logs other errors.
 */
export async function killProcessTree(pid: number): Promise<void> {
  logger.debug('CHROMA_MCP', `Killing process tree rooted at PID ${pid}`);

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true
      });
    } catch (error) {
      // taskkill exits non-zero when the process is already dead — that's fine.
      logger.debug('CHROMA_MCP', `taskkill tree-kill finished (may already be dead)`, {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  // POSIX: walk descendants recursively (bottom-up) and signal each.
  // `pkill -P <pid>` only reaches direct children, so `python` /
  // `chroma-mcp` under `uv` (grandchildren) get re-parented to init and
  // survive. We collect the full descendant set via `pgrep -P` walks before
  // signaling, so the SIGTERM phase reaches every layer
  // (CodeRabbit review on PR #2282).
  try {
    const descendantsBeforeTerm = await collectDescendantPids(pid);
    // Signal leaves first, then the root.
    for (const child of descendantsBeforeTerm) {
      try {
        process.kill(child, 'SIGTERM');
      } catch {
        // Already gone — fine.
      }
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logger.debug('CHROMA_MCP', `Failed to SIGTERM PID ${pid}`, { code }, err);
      }
    }

    // Brief wait for SIGTERM to propagate, then SIGKILL stragglers.
    await new Promise(resolve => setTimeout(resolve, 500));

    // Re-collect descendants — some layers may have re-parented during the
    // SIGTERM grace window.
    //
    // SIGKILL targets the UNION of pre-TERM and post-wait descendant sets:
    // when the root exits between snapshots, children get re-parented to
    // init and drop out of `pgrep -P <root>`. Without the union, those
    // re-parented descendants would never receive SIGKILL even though they
    // were definitely children before SIGTERM (CodeRabbit review on PR
    // #2282). Dedupe via Set since `descendantsBeforeKill` typically
    // overlaps with `descendantsBeforeTerm`.
    const descendantsBeforeKill = await collectDescendantPids(pid);
    const killTargets = Array.from(new Set([...descendantsBeforeTerm, ...descendantsBeforeKill]));
    for (const child of killTargets) {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
        // Already dead — fine.
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead — fine.
    }
  } catch (error) {
    logger.debug('CHROMA_MCP', `Process tree kill completed (best-effort)`, {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Recursively collect all descendant PIDs of `rootPid` using `pgrep -P`.
 * Returned bottom-up (leaves first) so callers can signal leaves before
 * their ancestors. Depth-bounded at MAX_TREE_DEPTH so the walk is statically
 * terminating.
 *
 * If `pgrep` is not installed at all (some minimal Linux images ship `ps` but
 * not `pgrep`), the pgrep walk would collect nothing and the caller would kill
 * only the root — leaving the orphan's Python/Chroma descendants alive to
 * re-parent and keep leaking (greptile review, PR #3232). In that one case we
 * fall back to a single `ps -eo pid,ppid` snapshot and derive the tree from it.
 * A `pgrep` that merely exits 1 (a PID with no children — the common leaf case)
 * is NOT treated as missing.
 */
export async function collectDescendantPids(rootPid: number): Promise<number[]> {
  const seen = new Set<number>();
  const collected: number[] = [];
  let pgrepMissing = false;

  async function walk(pid: number, depth: number): Promise<void> {
    if (depth >= MAX_TREE_DEPTH || pgrepMissing) return;
    let stdout = '';
    try {
      const result = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 2_000 });
      stdout = result.stdout;
    } catch (error) {
      // ENOENT means the pgrep binary itself is absent — a host-wide condition,
      // not a childless node — so switch to the ps-table fallback. Any other
      // failure (exit 1 = no children) is the expected leaf case: treat as
      // childless.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') pgrepMissing = true;
      return;
    }
    const children = parsePidLines(stdout).filter(n => !seen.has(n));
    for (const child of children) {
      seen.add(child);
      await walk(child, depth + 1);
      // Bottom-up: push after recursion so leaves come first.
      collected.push(child);
    }
  }

  await walk(rootPid, 0);
  if (pgrepMissing) return collectDescendantPidsViaProcTable(rootPid);
  return collected;
}

/**
 * pgrep-less descendant collection: one `ps -eo pid,ppid` snapshot fed through
 * the pure {@link descendantsFromProcTable} walk. Used as the fallback when
 * `pgrep` is unavailable; exported so the fallback chain can be exercised end-
 * to-end against a real process tree. Best-effort: a missing/failed `ps`
 * yields [].
 */
export async function collectDescendantPidsViaProcTable(rootPid: number): Promise<number[]> {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid'], { timeout: 5_000 }));
  } catch {
    return [];
  }
  return descendantsFromProcTable(rootPid, parseParentMap(stdout));
}

/** Parse whitespace-separated pid lines (`pgrep -P` output) into positive ints. */
function parsePidLines(stdout: string): number[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => Number.parseInt(line, 10))
    .filter(n => Number.isFinite(n) && n > 0);
}

/** Parse `ps -eo pid,ppid` output into {pid, ppid} pairs; skips header/garbage. */
export function parseParentMap(stdout: string): Array<{ pid: number; ppid: number }> {
  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)/);
    if (!match) continue; // "PID PPID" header and blanks fall through here
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

/**
 * Pure: collect every descendant of `rootPid` from a full {pid, ppid} process
 * snapshot, bottom-up (leaves first). Depth-bounded at MAX_TREE_DEPTH and
 * cycle-safe (a `seen` set), so it always terminates even on a malformed table.
 */
export function descendantsFromProcTable(
  rootPid: number,
  rows: ReadonlyArray<{ pid: number; ppid: number }>,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const { pid, ppid } of rows) {
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }

  const seen = new Set<number>([rootPid]);
  const collected: number[] = [];

  function walk(pid: number, depth: number): void {
    if (depth >= MAX_TREE_DEPTH) return;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child, depth + 1);
      collected.push(child); // bottom-up: push after recursion so leaves come first
    }
  }

  walk(rootPid, 0);
  return collected;
}

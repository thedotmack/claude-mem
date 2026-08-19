/**
 * Shared process-tree teardown.
 *
 * Extracted verbatim from ChromaMcpManager.killProcessTree /
 * .collectDescendantPids so every teardown path gets the same behavior. The
 * algorithm is unchanged from the Chroma implementation (PR #2282) — only the
 * log category moved from 'CHROMA_MCP' to 'PROCESS' now that the module is
 * shared.
 *
 * Why this matters beyond Chroma: Windows has no process groups, and Node's
 * `process.kill(pid, signal)` force-terminates exactly one PID. Any spawn
 * chain deeper than one level (uvx -> uv -> python -> chroma-mcp, or a `.cmd`
 * shim wrapping a real binary) leaves descendants running — they inherit
 * listening sockets and wedge the worker port.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * `taskkill` exits 128 when the target PID does not exist. That is the ONLY
 * non-zero status that means "already dead" — everything else (access denied,
 * timeout, a wedged /T walk) is a real failure the caller must hear about.
 */
const TASKKILL_NOT_FOUND_EXIT = 128;

/**
 * Phrasings that specifically mean "the target does not exist".
 *
 * Deliberately does NOT include the bare "could not be terminated" prefix:
 * taskkill emits that for BOTH outcomes —
 *   ERROR: ... could not be terminated. Reason: There is no running instance of the task.
 *   ERROR: ... could not be terminated. Reason: Access is denied.
 * — so matching the prefix would swallow access-denied as success, which is
 * the exact failure this classification exists to surface. Match the REASON.
 */
const TASKKILL_NOT_FOUND_PATTERN = /not found|no running instance|no tasks/i;

/** Raised when a tree-kill genuinely failed and the process may still be alive. */
export class ProcessTreeKillError extends Error {
  readonly pid: number;
  constructor(pid: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProcessTreeKillError';
    this.pid = pid;
  }
}

export interface KillProcessTreeOptions {
  /**
   * 'graceful' (default) — POSIX gets SIGTERM, a 500ms settle, then SIGKILL.
   *
   * 'immediate' — POSIX goes straight to SIGKILL with no SIGTERM and no
   * settle. Required by the stale-worker recycle (#3378): that path must run
   * ZERO stale-version shutdown code, and SIGTERM is catchable — a stale
   * worker handling it would execute the dying install's shutdown/handoff
   * logic, which is the exact restart storm the invariant exists to prevent.
   * SIGKILL is uncatchable, so tree-SIGKILL reaps descendants without ever
   * letting stale code run.
   *
   * No effect on Windows: `taskkill /T /F` is unconditionally immediate there.
   */
  signalMode?: 'graceful' | 'immediate';
}

/**
 * Kill a process and all its descendants (tree-kill).
 *
 * POSIX: collects the descendant set with `pgrep -P` walks and signals leaves
 * before their ancestors. In 'graceful' mode that is SIGTERM, a 500ms settle,
 * then SIGKILL of the union of the pre- and post-settle descendant sets; in
 * 'immediate' mode it is SIGKILL throughout.
 *
 * Windows: `taskkill /T /F /PID` for full subtree teardown.
 *
 * Throws ProcessTreeKillError when the kill genuinely failed (the tree may
 * still be alive). A target that was already gone is NOT an error.
 */
export async function killProcessTree(
  pid: number,
  options: KillProcessTreeOptions = {}
): Promise<void> {
  const immediate = options.signalMode === 'immediate';
  logger.debug('PROCESS', `Killing process tree rooted at PID ${pid}`, { immediate });

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true
      });
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      const message = error instanceof Error ? error.message : String(error);

      // Already gone is the expected, tolerated case.
      if (code === TASKKILL_NOT_FOUND_EXIT || TASKKILL_NOT_FOUND_PATTERN.test(`${stderr} ${message}`)) {
        logger.debug('PROCESS', 'taskkill reported the process was already gone', { pid });
        return;
      }

      // Anything else — access denied, a timeout, a wedged /T walk — means the
      // tree may still be running. Surfacing it is the whole point: callers
      // like `server stop` must not report success over a failed kill.
      throw new ProcessTreeKillError(
        pid,
        `taskkill failed for PID ${pid} (exit ${String(code)}): ${stderr.trim() || message}`,
        { cause: error }
      );
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
    const firstSignal: NodeJS.Signals = immediate ? 'SIGKILL' : 'SIGTERM';
    const descendantsBeforeTerm = await collectDescendantPids(pid);
    // Signal leaves first, then the root.
    for (const child of descendantsBeforeTerm) {
      try {
        process.kill(child, firstSignal);
      } catch {
        // Already gone — fine.
      }
    }
    try {
      process.kill(pid, firstSignal);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logger.debug('PROCESS', `Failed to ${firstSignal} PID ${pid}`, { code }, err);
      }
    }

    // Graceful mode waits for SIGTERM to propagate before escalating. Immediate
    // mode already sent SIGKILL, so there is nothing to wait for — but it still
    // re-collects below, to catch descendants that re-parented as the tree died.
    if (!immediate) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

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
    // In immediate mode the root already received SIGKILL in the pass above,
    // and SIGKILL is not survivable — re-sending it would be pure noise (and
    // would misrepresent the signal sequence to anything observing it).
    if (!immediate) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead — fine.
      }
    }
  } catch (error) {
    // The individual signal calls above already tolerate ESRCH themselves, so
    // anything surfacing here is a genuine failure of the teardown. Swallowing
    // it would contradict this function's documented contract (and let
    // `server stop` claim success over a kill that did not happen).
    throw new ProcessTreeKillError(
      pid,
      `tree-kill failed for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Every transitive descendant of `rootPid`, bottom-up (leaves first) so callers
 * can signal leaves before their ancestors.
 *
 * Works on Windows as well as POSIX. That is load-bearing, not a nicety: the
 * chroma teardown snapshots descendants BEFORE closing the transport, because
 * once the root exits its children re-parent and become unreachable from it.
 * A POSIX-only walk returned [] on Windows and left the uvx -> uv -> python
 * chain with nothing tracking it — the #3482 shape, on the target platform.
 *
 * Returns [] when the tree genuinely has no descendants. When the process
 * table cannot be ENUMERATED at all (no pgrep in a slim container, PowerShell
 * timeout) it also returns [], but logs a warning first — that case silently
 * degrades tree-kill to a single-PID kill, and an operator debugging a
 * #3482-shaped loop needs to see why.
 */
export async function collectDescendantPids(rootPid: number): Promise<number[]> {
  return process.platform === 'win32'
    ? collectDescendantPidsWindows(rootPid)
    : collectDescendantPidsPosix(rootPid);
}

async function collectDescendantPidsPosix(rootPid: number): Promise<number[]> {
  const seen = new Set<number>();
  const collected: number[] = [];

  async function walk(pid: number): Promise<void> {
    let stdout = '';
    try {
      const result = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 2_000 });
      stdout = result.stdout;
    } catch (error) {
      // pgrep exits 1 whenever a PID has no children — the expected leaf case
      // on every recursive walk. ANY other failure means we could not look,
      // which is materially different from having looked and found nothing.
      const code = (error as { code?: number | string }).code;
      if (code !== 1) {
        logger.warn('PROCESS', 'Cannot enumerate child processes — tree-kill degrades to a single-PID kill', {
          pid,
          code: typeof code === 'number' ? String(code) : code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    const children = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => Number.parseInt(line, 10))
      .filter(n => Number.isFinite(n) && n > 0 && !seen.has(n));

    for (const child of children) {
      seen.add(child);
      await walk(child);
      // Bottom-up: push after recursion so leaves come first.
      collected.push(child);
    }
  }

  await walk(rootPid);
  return collected;
}

/**
 * Windows has no pgrep and no process groups, so the whole parent/child table
 * is read once via CIM and walked in memory — one PowerShell spawn instead of
 * one per node. Same source `captureProcessStartToken` uses, so identities
 * stay consistent between enumeration and verification.
 */
async function collectDescendantPidsWindows(rootPid: number): Promise<number[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
      ],
      { timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (error) {
    logger.warn('PROCESS', 'Cannot enumerate Windows process table — tree-kill degrades to a single-PID kill', {
      rootPid,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const match = line.match(/^"(\d+)","(\d+)"/);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }

  const seen = new Set<number>([rootPid]);
  const collected: number[] = [];

  // Depth-first, pushing after recursion so the result stays leaves-first like
  // the POSIX walk — callers rely on that ordering.
  const walk = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      collected.push(child);
    }
  };
  walk(rootPid);

  return collected;
}

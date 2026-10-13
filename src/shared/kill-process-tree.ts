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
import { readdirSync, readFileSync } from 'fs';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { captureProcessStartToken, isSameProcess } from './process-identity.js';

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

  /**
   * The root's start token, captured when the caller first learned the PID.
   *
   * OPTIONAL, and omitting it is safe: when it is absent this function
   * captures the root's token itself at entry and revalidates before every
   * signal it sends. Root-identity checking is therefore the DEFAULT, not
   * something a call site can lose by forgetting an argument.
   *
   * Supplying it buys a strictly stronger guarantee, and only callers who
   * captured the PID before their OWN await can offer it:
   *
   *   - self-captured (default): detects reuse happening DURING this
   *     function's awaits — descendant enumeration and the graceful settle.
   *   - caller-supplied: additionally detects reuse that happened BEFORE
   *     entry, which self-capture cannot see because by then it would be
   *     reading the replacement's token. ChromaMcpManager needs this: its PID
   *     is captured before `await transport.close()`.
   *
   * On mismatch this function does nothing at all — it does not signal the
   * root, and it does not enumerate descendants from it either (they would be
   * the replacement's children, and on Windows `taskkill /T` would take that
   * whole subtree down).
   *
   * Callers holding their own pre-captured descendant snapshot should reap it
   * themselves after this returns — that snapshot is still valid even when the
   * root's identity is not.
   */
  expectedStartToken?: string | null;
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

  // Root identity, self-captured when the caller did not supply one. Making
  // this the default is deliberate: when it was opt-in, every call site that
  // omitted the option silently reopened the reuse hole, and each review round
  // found another one. Safe by construction now — a call site can only weaken
  // this by passing an explicitly wrong token, not by forgetting an argument.
  const rootStartToken = options.expectedStartToken !== undefined
    ? options.expectedStartToken
    : captureProcessStartToken(pid);

  /** Re-read before every signal: each await below reopens the reuse window. */
  const rootIsIntact = (): boolean => isSameProcess(pid, rootStartToken);

  if (!rootIsIntact()) {
    logger.warn('PROCESS', 'Skipping tree-kill: root PID was reused since it was captured', { pid });
    return;
  }

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
    const descendantsBeforeTerm = await collectDescendantIdentities(pid);
    // Signal leaves first, then the root.
    //
    // Revalidated even though the tokens were captured moments ago: capturing
    // them is not free (a `ps` spawn per PID on macOS, a PowerShell CIM query
    // on Windows), so with a multi-level chain there is real elapsed time
    // between enumerating the first descendant and signalling it. Long enough
    // for that PID to exit and be reissued — after which this loop would
    // SIGTERM, or in immediate mode SIGKILL, an unrelated process.
    for (const child of descendantsBeforeTerm) {
      if (!isSameProcess(child.pid, child.startToken)) {
        logger.debug('PROCESS', `Skipping ${firstSignal}: descendant PID was reused since enumeration`, {
          pid: child.pid,
          rootPid: pid,
        });
        continue;
      }
      try {
        process.kill(child.pid, firstSignal);
      } catch {
        // Already gone — fine.
      }
    }
    // Descendant enumeration above is an await, so the root may have exited
    // and had its PID reissued while it ran. Its descendants stay valid
    // targets (they were the real root's children and must still be reaped),
    // but the root itself must not be signalled if the number now names
    // something else — so this SKIPS the root signal without returning.
    if (rootIsIntact()) {
      try {
        process.kill(pid, firstSignal);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          logger.debug('PROCESS', `Failed to ${firstSignal} PID ${pid}`, { code }, err);
        }
      }
    } else {
      logger.warn('PROCESS', 'Skipping root signal: PID was reused during descendant enumeration', {
        pid,
        signal: firstSignal,
      });
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
    // #2282). Dedupe via Map since `descendantsBeforeKill` typically
    // overlaps with `descendantsBeforeTerm`.
    //
    // The union is also the ONLY place a stale PID can be signalled, which is
    // why identity is revalidated below. Members of the post-wait scan were
    // enumerated microseconds ago; members present ONLY in the pre-TERM scan
    // are absent from it for one of two reasons — they re-parented after the
    // root died (still alive, and exactly what the union exists to reap), or
    // they exited during the grace window (in which case the OS may have
    // reissued the number to an unrelated process). A start token separates
    // those two cases; without it the second one gets SIGKILLed.
    // Never walk a reused root: those children belong to the replacement.
    const descendantsBeforeKill = rootIsIntact() ? await collectDescendantIdentities(pid) : [];
    const killTargets = new Map<number, string | null>();
    // Pre-TERM first, then let the fresher post-wait token win on collision.
    for (const child of descendantsBeforeTerm) killTargets.set(child.pid, child.startToken);
    for (const child of descendantsBeforeKill) killTargets.set(child.pid, child.startToken);

    for (const [childPid, startToken] of killTargets) {
      if (!isSameProcess(childPid, startToken)) {
        logger.debug('PROCESS', 'Skipping SIGKILL: descendant PID was reused since the scan', {
          pid: childPid,
          rootPid: pid,
        });
        continue;
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already dead — fine.
      }
    }
    // In immediate mode the root already received SIGKILL in the pass above,
    // and SIGKILL is not survivable — re-sending it would be pure noise (and
    // would misrepresent the signal sequence to anything observing it).
    if (!immediate && rootIsIntact()) {
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

/** Descendant PID paired with the start token that proves its identity. */
export interface DescendantIdentity {
  pid: number;
  startToken: string | null;
}

/** One process-table row: discovery and identity from a SINGLE observation. */
interface ProcessTableRow {
  pid: number;
  ppid: number;
  startToken: string | null;
}

/**
 * Read the whole process table once, with each row's identity taken from the
 * SAME observation that discovered it.
 *
 * This atomicity is the point, not an optimisation. Enumerating PIDs first and
 * probing each one for its token afterwards is worse than having no check at
 * all: if a discovered PID exits and the number is reissued in between, the
 * probe captures the REPLACEMENT's token, and the later isSameProcess() call
 * then compares that replacement against itself, matches, and certifies an
 * unrelated process as a legitimate kill target.
 *
 * Token formats deliberately match captureProcessStartToken() on every
 * platform, because that is what the later revalidation re-reads. A mismatch
 * would make every comparison fail and silently skip every descendant —
 * resurrecting the orphan bug (#2313) instead of fixing it. That agreement is
 * asserted by test rather than assumed.
 */
async function readProcessTable(): Promise<ProcessTableRow[]> {
  if (process.platform === 'win32') return readProcessTableWindows();
  if (process.platform === 'linux') return readProcessTableLinux();
  return readProcessTablePosix();
}

/**
 * Linux: one read of /proc/<pid>/stat yields ppid (field 4) and starttime
 * (field 22) together — genuinely atomic per process, and starttime is exactly
 * what captureProcessStartToken() returns on this platform.
 */
function readProcessTableLinux(): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch (error) {
    logger.warn('PROCESS', 'Cannot read /proc — tree-kill degrades to a single-PID kill', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rows;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf-8');
    } catch {
      // Exited between readdir and read. Safe: a row we never observed simply
      // is not a target.
      continue;
    }
    // comm (field 2) is parenthesised and may contain spaces, so split after it.
    const tailStart = raw.lastIndexOf(') ');
    if (tailStart < 0) continue;
    const fields = raw.slice(tailStart + 2).split(' ');
    const ppid = Number.parseInt(fields[1] ?? '', 10);
    const starttime = fields[19];
    if (!Number.isFinite(ppid)) continue;
    rows.push({
      pid: Number.parseInt(entry, 10),
      ppid,
      startToken: starttime && /^\d+$/.test(starttime) ? starttime : null,
    });
  }
  return rows;
}

/**
 * macOS/BSD: `ps -eo pid=,ppid=,lstart=` is one snapshot carrying all three.
 * Its lstart is byte-identical to `ps -p <pid> -o lstart=`, which is what
 * captureProcessStartToken() uses here. LC_ALL/LANG are pinned for the same
 * reason they are pinned there — a locale-formatted date would not compare
 * equal on the revalidation.
 */
async function readProcessTablePosix(): Promise<ProcessTableRow[]> {
  let stdout: string;
  try {
    const result = await execFileAsync('ps', ['-eo', 'pid=,ppid=,lstart='], {
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    stdout = result.stdout;
  } catch (error) {
    logger.warn('PROCESS', 'Cannot enumerate the process table — tree-kill degrades to a single-PID kill', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const startToken = match[3]!.trim();
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      startToken: startToken.length > 0 ? startToken : null,
    });
  }
  return rows;
}

/**
 * Windows: the CIM query already returned the parent link, so asking for
 * CreationDate in the same row makes identity part of that one observation
 * instead of N follow-up PowerShell probes — which were both the race above
 * and, at ~100-300ms each, the dominant cost of enumeration.
 *
 * The ToString format matches captureProcessStartToken()'s exactly.
 */
async function readProcessTableWindows(): Promise<ProcessTableRow[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='StartToken';Expression={$_.CreationDate.ToString('yyyyMMddHHmmss.ffffff')}} | ConvertTo-Csv -NoTypeInformation",
      ],
      { timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (error) {
    logger.warn('PROCESS', 'Cannot enumerate the Windows process table — tree-kill degrades to a single-PID kill', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const match = line.match(/^"(\d+)","(\d+)","(.*)"$/);
    if (!match) continue;
    const startToken = match[3]!.trim();
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      startToken: startToken.length > 0 ? startToken : null,
    });
  }
  return rows;
}

/**
 * Every transitive descendant of `rootPid`, each carrying the identity it had
 * in the same table read that discovered it. Bottom-up (leaves first) so
 * callers can signal leaves before their ancestors.
 *
 * Works on Windows as well as POSIX. That is load-bearing, not a nicety: the
 * chroma teardown snapshots descendants BEFORE closing the transport, because
 * once the root exits its children re-parent and become unreachable from it.
 *
 * Returns [] both when the tree genuinely has no descendants and when the
 * table could not be read; the latter logs a warning first, because it
 * silently degrades tree-kill to a single-PID kill.
 */
export async function collectDescendantIdentities(rootPid: number): Promise<DescendantIdentity[]> {
  const rows = await readProcessTable();

  const childrenByParent = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const seen = new Set<number>([rootPid]);
  const collected: DescendantIdentity[] = [];

  const walk = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      walk(child.pid);
      // Push after recursion so leaves come first.
      collected.push({ pid: child.pid, startToken: child.startToken });
    }
  };
  walk(rootPid);

  return collected;
}

/** PID-only view, for callers that do not signal what they enumerate. */
export async function collectDescendantPids(rootPid: number): Promise<number[]> {
  return (await collectDescendantIdentities(rootPid)).map(entry => entry.pid);
}

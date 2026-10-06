/**
 * Cross-platform descendant enumeration + identity for the Windows Chroma
 * lifecycle gates.
 *
 * Kept independent of the production descendant collector so the lifecycle
 * gates can assert what the worker actually left behind, including image names
 * for failure messages.
 *
 * Identity, not just PID: every recorded descendant carries its start token
 * (Win32_Process CreationDate / /proc starttime) from the SAME row that
 * established its parent link. Probing tokens after finding PIDs could record
 * a replacement's token and later authorize killing that replacement. Asserting
 * "pid is gone" alone is also unsound: the OS can reuse that number. A fresh
 * mismatching token proves reuse; an unreadable token leaves the result
 * uncertain and is reported as a survivor rather than a false pass.
 */

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { captureProcessStartToken, isPidAlive } from '../../../src/supervisor/process-registry.js';
import { hasMatchingProcessStartToken } from '../../../src/shared/process-identity.js';
import { sanitizeEnv } from '../../../src/supervisor/env-sanitizer.js';

export interface ProcessIdentity {
  pid: number;
  /** Start token at snapshot time; null when the OS would not report one. */
  startToken: string | null;
  /** Best-effort image name, for failure messages only — never for matching. */
  name: string;
}

/** One row carrying ancestry, image name, and identity together. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  startToken: string | null;
}

function readProcessTableWindows(): ProcessRow[] {
  // CSV keeps parsing trivial and locale-independent; Get-CimInstance is the
  // same source captureProcessStartToken() uses, so identities stay consistent.
  const stdout = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name='StartToken';Expression={$_.CreationDate.ToString('yyyyMMddHHmmss.ffffff')}} | ConvertTo-Csv -NoTypeInformation",
    ],
    { encoding: 'utf-8', timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  );

  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const match = line.match(/^"(\d+)","(\d+)","(.*)","(.*)"$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      name: match[3]!,
      startToken: match[4]!.trim() || null,
    });
  }
  return rows;
}

function readProcessTableLinux(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf-8');
    } catch {
      continue; // Exited before its row could be observed.
    }
    const tailStart = raw.lastIndexOf(') ');
    const nameStart = raw.indexOf('(');
    if (tailStart < 0 || nameStart < 0) continue;
    const fields = raw.slice(tailStart + 2).split(' ');
    const ppid = Number.parseInt(fields[1] ?? '', 10);
    if (!Number.isInteger(ppid)) continue;
    const starttime = fields[19];
    rows.push({
      pid: Number.parseInt(entry, 10),
      ppid,
      name: raw.slice(nameStart + 1, tailStart),
      startToken: starttime && /^\d+$/.test(starttime) ? starttime : null,
    });
  }
  return rows;
}

function readProcessTablePosix(): ProcessRow[] {
  const stdout = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,comm='], {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    // The production token reader forces this locale. lstart must have the
    // same 24-byte shape in both reads or a valid owner looks unrelated.
    env: { ...sanitizeEnv(process.env), LC_ALL: 'C', LANG: 'C' },
  });

  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      name: match[4]!.trim(),
      startToken: match[3]!.trim() || null,
    });
  }
  return rows;
}

function readProcessTable(): ProcessRow[] {
  if (process.platform === 'win32') return readProcessTableWindows();
  if (process.platform === 'linux') return readProcessTableLinux();
  return readProcessTablePosix();
}

/**
 * Windows GitHub runners inject Visual Studio telemetry (`vctip.exe`) under
 * almost any spawned tree. That is not a chroma-mcp descendant and must not
 * fail the #3482 recycle gate.
 */
const WINDOWS_RUNNER_NOISE = new Set(['vctip.exe']);

function isWindowsRunnerNoise(name: string): boolean {
  return WINDOWS_RUNNER_NOISE.has(name.toLowerCase());
}

/**
 * A parent-child link is credible only when both process creation times are
 * readable and the child was created no earlier than its alleged parent.
 * Windows can retain a dead parent's PID in a child's PPID after that PID has
 * been reused. A fresh token on the child alone does not prove ownership.
 */
function childStartedAfterParent(parentToken: string | null, childToken: string | null): boolean {
  if (!parentToken || !childToken) return false;
  // Get-CimInstance CreationDate.ToString('yyyyMMddHHmmss.ffffff') has a
  // literal dot between seconds and microseconds. Fixed width makes lexical
  // order identical to creation-time order without losing precision.
  const cimToken = /^\d{14}\.\d{6}$/;
  if (cimToken.test(parentToken) && cimToken.test(childToken)) {
    return childToken >= parentToken;
  }
  if (/^\d+$/.test(parentToken) && /^\d+$/.test(childToken)) {
    // Linux /proc starttime ticks.
    return BigInt(childToken) >= BigInt(parentToken);
  }
  // macOS/BSD ps lstart is forced to the C locale in readProcessTablePosix.
  const parentTime = Date.parse(parentToken);
  const childTime = Date.parse(childToken);
  return Number.isFinite(parentTime) && Number.isFinite(childTime) && childTime >= parentTime;
}

/**
 * Every transitive descendant of `rootPid`, with identity captured.
 *
 * MUST be called while the root is still alive: once it exits, its children
 * re-parent (to init on POSIX, to nothing traceable on Windows) and drop out
 * of the parent-child table entirely, so a post-mortem walk finds nothing and
 * would report a false PASS.
 */
export function snapshotDescendants(
  rootPid: number,
  expectedRootToken?: string,
  rows: ProcessRow[] = readProcessTable()
): ProcessIdentity[] {
  const rowPids = new Set<number>();
  for (const row of rows) {
    if (rowPids.has(row.pid)) throw new Error(`process table repeated pid ${row.pid} during descendant snapshot`);
    rowPids.add(row.pid);
  }
  if (expectedRootToken !== undefined) {
    const root = rows.find(row => row.pid === rootPid);
    if (!root || root.startToken !== expectedRootToken) {
      throw new Error(`fixture root identity changed before descendant snapshot (pid=${rootPid})`);
    }
  }
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const found: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const rootRow = rows.find(row => row.pid === rootPid);
  const queue = [{ pid: rootPid, trustedToken: rootRow?.startToken ?? null }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      // Keep an unproven edge visible as a null-token survivor, but do not
      // authorize killing it or any grandchild below that edge. Validate each
      // edge, not merely each descendant against the fixture's root time.
      const trustedToken = childStartedAfterParent(current.trustedToken, child.startToken)
        ? child.startToken
        : null;
      queue.push({ pid: child.pid, trustedToken });
      if (isWindowsRunnerNoise(child.name)) continue;
      found.push({
        pid: child.pid,
        startToken: trustedToken,
        name: child.name,
      });
    }
  }

  return found;
}

/**
 * Of a snapshot, the entries that are STILL the same running process.
 *
 * A pid whose start token changed is a different process that inherited the
 * number — not a survivor. When no token was captured (the OS declined), fall
 * back to liveness alone and let the caller see it in the failure message.
 */
export function survivingProcesses(
  snapshot: ProcessIdentity[],
  isAlive = isPidAlive,
  readStartToken = captureProcessStartToken
): ProcessIdentity[] {
  return snapshot.filter(entry => {
    if (!isAlive(entry.pid)) return false;
    if (entry.startToken === null) return true;

    // Bias toward "still alive" when the token cannot be re-read.
    //
    // captureProcessStartToken can transiently return null (a PowerShell CIM
    // spawn that times out, a /proc read that races). Treating that as
    // "identity differs, so it is gone" would drop a LIVE survivor from the
    // list — and because waitForOrphansToClear() stops the moment the list is
    // empty, a single transient null anywhere in the polling loop would end
    // the primary gate GREEN over real orphans. Only a token that was read
    // successfully AND differs proves the PID was recycled.
    const currentToken = readStartToken(entry.pid);
    if (currentToken === null) return true;
    return currentToken === entry.startToken;
  });
}

export function describeProcesses(entries: ProcessIdentity[]): string {
  if (entries.length === 0) return '(none)';
  return entries.map(e => `${e.name}(pid=${e.pid})`).join(', ');
}

/** Authorize a root cleanup only with a recorded, freshly matching identity. */
export async function runForMatchingProcess(
  pid: number,
  startToken: string | null | undefined,
  action: (pid: number, startToken: string) => void | Promise<void>,
  matchesStartToken = hasMatchingProcessStartToken
): Promise<boolean> {
  if (!startToken || !matchesStartToken(pid, startToken)) return false;
  await action(pid, startToken);
  return true;
}

/**
 * Reap only descendants captured while the fixture was alive. A free listener
 * does not imply its sidecars exited: Bun 1.4 releases the socket while the
 * detached chroma/Python chain can remain alive. Never walk a dead root or use
 * taskkill /T here: either could select processes outside this snapshot.
 *
 * Missing or unreadable start tokens are not permission to kill. The caller
 * checks for survivors afterwards and reports an incomplete cleanup.
 */
export function reapSnapshottedDescendants(
  snapshot: ProcessIdentity[],
  matchesStartToken = hasMatchingProcessStartToken,
  killOne = (pid: number): void => {
    try {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 30_000,
      });
    } catch (error) {
      // The child may exit between the final identity read and taskkill.
      if ((error as { status?: number }).status !== 128) throw error;
    }
  }
): void {
  // snapshotDescendants is breadth-first. Kill leaves before their parents,
  // without trusting a post-exit parent PID or a possibly recycled child PID.
  const failures: string[] = [];
  for (const entry of [...snapshot].reverse()) {
    if (entry.startToken === null) continue;
    if (!matchesStartToken(entry.pid, entry.startToken)) continue;
    try {
      killOne(entry.pid);
    } catch (error) {
      failures.push(`${entry.name}(pid=${entry.pid}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`snapshot descendant cleanup failed: ${failures.join('; ')}`);
}

/**
 * Cleanup for a still-live fixture or replacement worker. The root must carry
 * a token recorded by that process before teardown; its descendants are then
 * discovered with ancestry and tokens from the same process-table rows.
 */
export function reapOwnedLiveTree(
  pid: number,
  startToken: string | null | undefined,
  killOne: (pid: number) => void,
  matchesStartToken = hasMatchingProcessStartToken,
  rows?: ProcessRow[],
  onSnapshot?: (children: ProcessIdentity[]) => void
): ProcessIdentity[] | null {
  if (!startToken || !matchesStartToken(pid, startToken)) return null;
  const children = snapshotDescendants(pid, startToken, rows ?? readProcessTable());
  // Hand the evidence to the caller BEFORE any kill can throw or orphan a
  // child. The caller must verify this snapshot after teardown; an unverified
  // child is never silently treated as cleaned up.
  onSnapshot?.(children);
  const failures: string[] = [];
  try {
    reapSnapshottedDescendants(children, matchesStartToken, killOne);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  // Child cleanup can take time. Revalidate before killing the root itself.
  if (matchesStartToken(pid, startToken)) {
    try {
      killOne(pid);
    } catch (error) {
      failures.push(`root pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return children;
}

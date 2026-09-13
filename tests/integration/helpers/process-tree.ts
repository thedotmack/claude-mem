/**
 * Cross-platform descendant enumeration + identity for the Windows Chroma
 * lifecycle gates.
 *
 * Why this is not `collectDescendantPids` from src/shared/kill-process-tree.ts:
 * that helper walks with `pgrep`, which is POSIX-only and returns [] on
 * Windows by construction. The whole point of these tests is to observe the
 * Windows process tree, so the enumeration has to work there.
 *
 * Identity, not just PID: every recorded descendant carries its start token
 * (Win32_Process CreationDate / /proc starttime) via the PRODUCTION
 * captureProcessStartToken(). Asserting "pid is gone" alone is unsound — the
 * OS can hand that number to something else between snapshot and assertion and
 * produce a false PASS. A survivor only counts as alive when the pid is alive
 * AND its start token still matches.
 */

import { execFileSync } from 'child_process';
import { captureProcessStartToken, isPidAlive } from '../../../src/supervisor/process-registry.js';

export interface ProcessIdentity {
  pid: number;
  /** Start token at snapshot time; null when the OS would not report one. */
  startToken: string | null;
  /** Best-effort image name, for failure messages only — never for matching. */
  name: string;
}

/** One row per process: pid, parent pid, image name. */
interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
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
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation',
    ],
    { encoding: 'utf-8', timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  );

  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const match = line.match(/^"(\d+)","(\d+)","(.*)"$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      name: match[3]!,
    });
  }
  return rows;
}

function readProcessTablePosix(): ProcessRow[] {
  const stdout = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      name: match[3]!.trim(),
    });
  }
  return rows;
}

function readProcessTable(): ProcessRow[] {
  return process.platform === 'win32' ? readProcessTableWindows() : readProcessTablePosix();
}

/**
 * Every transitive descendant of `rootPid`, with identity captured.
 *
 * MUST be called while the root is still alive: once it exits, its children
 * re-parent (to init on POSIX, to nothing traceable on Windows) and drop out
 * of the parent-child table entirely, so a post-mortem walk finds nothing and
 * would report a false PASS.
 */
export function snapshotDescendants(rootPid: number): ProcessIdentity[] {
  const rows = readProcessTable();
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const found: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      found.push({
        pid: child.pid,
        startToken: captureProcessStartToken(child.pid),
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
export function survivingProcesses(snapshot: ProcessIdentity[]): ProcessIdentity[] {
  return snapshot.filter(entry => {
    if (!isPidAlive(entry.pid)) return false;
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
    const currentToken = captureProcessStartToken(entry.pid);
    if (currentToken === null) return true;
    return currentToken === entry.startToken;
  });
}

export function describeProcesses(entries: ProcessIdentity[]): string {
  if (entries.length === 0) return '(none)';
  return entries.map(e => `${e.name}(pid=${e.pid})`).join(', ');
}

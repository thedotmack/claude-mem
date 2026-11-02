/**
 * Port reclaim for the two spawn launchers.
 *
 * TWO distinct failure modes reclaim the worker port here:
 *
 *   1. A WEDGED worker we own (all platforms) — reclaimWedgedOwnedWorker. Our
 *      PID file names a LIVE process that holds the port, but it has stopped
 *      answering /health (e.g. a worker spinning at 100% CPU during a provider
 *      quota cooldown, #4127). It ignores SIGTERM and never yields the port, so
 *      every launcher gives up and the machine hard-blocks. This case is not
 *      Windows-specific and the owner is alive, so the ghost-listener logic
 *      below never sees it — it is handled first, before the Windows gate.
 *      It kills only on evidence: the worker is past its boot grace, fails two
 *      spaced health re-probes, owns the LISTEN socket, still carries the start
 *      token our PID file recorded, and its command line is a claude-mem worker.
 *      This is a backstop; an in-process wedge watchdog is the root fix.
 *
 *   2. A GHOST listener (Windows only) — the rest of this module. Detailed
 *      below.
 *
 * Ghost-listener reclaim on Windows.
 *
 * WHY THIS EXISTS — the 2026-09-07 reproduction (and #3482 / #3300 / plan-15
 * #3603): the worker daemon's listening socket is inherited by the chroma-mcp
 * sidecar tree (uvx -> uv -> python) it spawns. When the worker is killed
 * OUT-OF-BAND — crash, `taskkill /F` without `/T`, a kill that runs no
 * shutdown code — nothing tree-kills the sidecar, so the descendants stay
 * alive holding the inherited socket handle. Windows keeps the port LISTENING
 * under the DEAD worker's PID (netstat shows an owner that no longer exists),
 * and every launcher treats "port in use" as proof of a live worker:
 *
 *   - the daemon duplicate gate logs "Port already in use, refusing to start
 *     duplicate" and exit(0)s;
 *   - ensureWorkerStarted() logs "Port in use but worker not responding to
 *     health checks" and returns 'dead'.
 *
 * Neither ever reclaims, so the port stays bound until a human tree-kills the
 * chroma chain by hand (the recovery manual). This module automates that
 * recovery with the same evidence the manual uses:
 *
 *   1. netstat finds the LISTENING owner PID(s) for the port;
 *   2. if EVERY owner is dead, the surviving sidecar is located two ways:
 *      a. walking down the process table's parent chain from the dead PID
 *         (Windows preserves the parent link after the parent exits);
 *      b. a full-table scan for processes whose command line points at THIS
 *         install's chroma store (`--data-dir <DATA_DIR>`), which catches the
 *         broken-chain case: when the worker dies, its uvx/uv stdio parents
 *         read EOF and exit, leaving the chroma-mcp/python sidecar orphaned
 *         one or two links BELOW a dead PID — unreachable by walk (a), but
 *         still carrying our data-dir argument;
 *   3. only processes that are chroma sidecars by executable name (walk a)
 *      or by data-dir fingerprint (scan b) are killed, so a reused PID whose
 *      new owner happens to have children cannot pull unrelated processes
 *      into the kill;
 *   4. every kill goes through killProcessTree with the start token from the
 *      SAME table read that discovered the target, so a PID that exits and is
 *      reissued between discovery and kill is never signalled.
 *
 * A live owner the ghost path finds — a foreign service, another install, or
 * a worker the wedged path above declined — is never touched: those keep the
 * current "in use" behavior, not get killed by a launcher.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, statSync, promises as fsPromises } from 'node:fs';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';
import { killProcessTree } from './kill-process-tree.js';
import { isPidAlive, type PidInfo } from '../supervisor/process-registry.js';
import { readOwnedWorkerPidInfo } from '../supervisor/index.js';
import { waitForHealth } from '../services/infrastructure/HealthMonitor.js';
import { captureProcessStartToken, isSameProcess, normalizeProcessName } from './process-identity.js';
import { readWedgedWorkerUptimeSeconds } from './hook-constants.js';
import { DATA_DIR, USER_SETTINGS_PATH, paths } from './paths.js';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';

const execFileAsync = promisify(execFile);

/**
 * Executable names of the chroma-mcp sidecar chain the worker spawns
 * (uvx -> uv -> python -> chroma-mcp). Only descendants matching these are
 * reclaim targets: they are the only processes in the tree that can hold the
 * inherited listening socket, and the whitelist is what makes the kill safe
 * against PID reuse.
 */
const CHROMA_SIDECAR_NAME_PATTERN = /^(uv|uvx|python|chroma-mcp)(\.exe)?$/i;

/** Whitelist check for a process-table Name column value. */
export function isChromaSidecarName(name: string): boolean {
  return CHROMA_SIDECAR_NAME_PATTERN.test(name.trim());
}

/**
 * The chroma-mcp entry point anywhere in a command line, in either spelling
 * (`chroma-mcp` console script, `chroma_mcp` module form).
 *
 * Needed alongside isChromaSidecarName because the chain's LEAF is an
 * interpreter: on POSIX the python running the chroma-mcp console script
 * reports comm `python3.13` — 15-char kernel truncation and version suffix
 * keep it off the name whitelist — while its argv still names chroma-mcp and
 * carries the data-dir fingerprint.
 */
const CHROMA_MCP_CMDLINE_PATTERN = /chroma[-_]mcp/i;

/**
 * A process-table row names a chroma-mcp sidecar chain member: by executable
 * name (the uvx/uv/uvx.exe/... launchers) or by the chroma-mcp entry point in
 * its command line (the python leaf). Only ever combined with a data-dir
 * fingerprint match — the name alone never justifies a kill.
 */
function isChromaSidecarCandidate(row: WindowsProcessRow): boolean {
  return isChromaSidecarName(row.name) || (row.cmdline !== null && CHROMA_MCP_CMDLINE_PATTERN.test(row.cmdline));
}

export interface WindowsProcessRow {
  pid: number;
  ppid: number;
  name: string;
  startToken: string | null;
  /** Full command line; null when the OS did not expose it. */
  cmdline: string | null;
  /** Owning uid (POSIX readers only; Windows rows leave it undefined). */
  uid?: number | null;
}

/**
 * Does a command line point at THIS install's chroma store?
 *
 * chroma-mcp is always spawned with `--data-dir <DATA_DIR>/chroma`, so the
 * argument is a reliable ownership fingerprint. Matching it matters for the
 * broken-chain case (see reclaimGhostListeningPort): when the uvx/uv layers
 * exit after the worker dies, the surviving chroma-mcp/python sidecar is no
 * longer reachable by walking down from the dead owner's PID — but its
 * command line still names our data dir, which is how we know it is ours.
 */
export function chromaCmdlineMatchesDataDir(cmdline: string | null, dataDir: string): boolean {
  if (!cmdline) return false;
  const normalizedCmdline = cmdline.toLowerCase().replace(/\\/g, '/');
  const flagIndex = normalizedCmdline.indexOf('--data-dir');
  if (flagIndex < 0) return false;
  let value = normalizedCmdline.slice(flagIndex + '--data-dir'.length).trim();
  // A value containing spaces is double-quoted by the spawner.
  if (value.startsWith('"')) {
    const endQuote = value.indexOf('"', 1);
    value = endQuote < 0 ? value.slice(1) : value.slice(1, endQuote);
  }
  const normalizedDir = dataDir.toLowerCase().replace(/\\/g, '/');
  return (
    value === normalizedDir ||
    (value.startsWith(normalizedDir) && value[normalizedDir.length] === '/')
  );
}

/** A read's own timeout, cut to `capMs` (what is left of a caller's deadline) when there is one. */
function cappedTimeoutMs(ownTimeoutMs: number, capMs: number | undefined): number {
  return capMs === undefined ? ownTimeoutMs : Math.max(1, Math.min(ownTimeoutMs, capMs));
}

/**
 * One CIM query returning pid, parent pid, executable name, command line and
 * creation token per row. Identity and ancestry come from the SAME
 * observation, so the discovery-to-kill gap never revalidates a target
 * against a different read (same atomicity rule as readProcessTable in
 * kill-process-tree.ts). Command lines may contain commas and quotes, so the
 * rows are transported as JSON rather than CSV.
 */
async function readWindowsProcessTableWithNames(capMs?: number): Promise<WindowsProcessRow[] | null> {
  try {
    const result = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='StartToken';Expression={$_.CreationDate.ToString('yyyyMMddHHmmss.ffffff')}} | ConvertTo-Json -Compress",
      ],
      { timeout: cappedTimeoutMs(30_000, capMs), windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );
    const parsed = JSON.parse(result.stdout) as unknown;
    const rawRows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
    const rows: WindowsProcessRow[] = [];
    for (const row of rawRows as Array<Record<string, unknown>>) {
      const name = typeof row.Name === 'string' ? row.Name.trim() : '';
      if (!name) continue;
      const pid = typeof row.ProcessId === 'number' ? row.ProcessId : Number.parseInt(String(row.ProcessId), 10);
      const ppid = typeof row.ParentProcessId === 'number' ? row.ParentProcessId : Number.parseInt(String(row.ParentProcessId), 10);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      rows.push({
        pid,
        ppid,
        name,
        cmdline: typeof row.CommandLine === 'string' ? row.CommandLine : null,
        startToken: typeof row.StartToken === 'string' && row.StartToken.length > 0 ? row.StartToken : null,
      });
    }
    return rows;
  } catch (error) {
    logger.warn(
      'PROCESS',
      'Cannot enumerate the Windows process table with names — ghost-port reclaim disabled',
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }
}

/**
 * Linux counterpart of readWindowsProcessTableWithNames: one readdir plus up
 * to three small reads per pid. Identity comes from /proc/<pid>/stat, which
 * yields ppid and starttime (the token format captureProcessStartToken()
 * revalidates against on this platform) from the SAME read — the atomicity
 * rule that keeps a discovered PID from being certified with a replacement's
 * token (see readProcessTable in kill-process-tree.ts).
 */
function readLinuxProcessTableWithNames(): WindowsProcessRow[] {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch (error) {
    logger.warn(
      'PROCESS',
      'Cannot read /proc — orphan chroma-mcp sweep disabled for this attempt',
      { error: error instanceof Error ? error.message : String(error) }
    );
    return [];
  }

  const rows: WindowsProcessRow[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf-8');
    } catch {
      // Exited between readdir and read. Safe: a row we never observed simply
      // is not a target.
      continue;
    }
    const stat = parseLinuxProcStat(raw);
    if (!stat) continue;
    let name = '';
    let cmdline: string | null = null;
    let uid: number | null = null;
    try {
      uid = statSync(`/proc/${entry}`).uid;
    } catch { /* exited — an unknown owner is never a target */ }
    try {
      name = readFileSync(`/proc/${entry}/comm`, 'utf-8').trim();
    } catch { /* name is supplementary evidence; the cmdline marker still applies */ }
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ') || null;
    } catch { /* kernel thread or exited — nothing to fingerprint */ }
    rows.push({ pid, ppid: stat.ppid, name, cmdline, uid, startToken: stat.startToken });
  }
  return rows;
}

/**
 * ppid and starttime from one /proc/<pid>/stat line. comm (field 2) is
 * parenthesised and may itself contain spaces or `) `, so fields are read
 * after its LAST closing paren. Pure and exported for tests.
 */
export function parseLinuxProcStat(raw: string): { ppid: number; startToken: string | null } | null {
  const tailStart = raw.lastIndexOf(') ');
  if (tailStart < 0) return null;
  const fields = raw.slice(tailStart + 2).split(' ');
  const ppid = Number.parseInt(fields[1] ?? '', 10);
  if (!Number.isFinite(ppid)) return null;
  const starttime = fields[19];
  return { ppid, startToken: starttime && /^\d+$/.test(starttime) ? starttime : null };
}

/**
 * macOS/BSD counterpart: `ps -eo pid=,ppid=,uid=,lstart=,command=` is one snapshot
 * carrying discovery and identity. Its lstart is byte-identical to
 * `ps -p <pid> -o lstart=`, which is what captureProcessStartToken() uses on
 * this platform — the same agreement readProcessTablePosix() in
 * kill-process-tree.ts relies on (and asserts by test). LC_ALL/LANG are
 * pinned so a locale-formatted date would not compare unequal on the
 * revalidation.
 */
async function readMacProcessTableWithNames(capMs?: number): Promise<WindowsProcessRow[]> {
  let stdout: string;
  try {
    const result = await execFileAsync('ps', ['-eo', 'pid=,ppid=,uid=,lstart=,command='], {
      timeout: cappedTimeoutMs(10_000, capMs),
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    stdout = result.stdout;
  } catch (error) {
    logger.warn(
      'PROCESS',
      'Cannot enumerate the process table with names — orphan chroma-mcp sweep disabled for this attempt',
      { error: error instanceof Error ? error.message : String(error) }
    );
    return [];
  }
  return parseMacProcessTable(stdout);
}

/** Rows from `ps -eo pid=,ppid=,uid=,lstart=,command=` output. Pure and exported for tests. */
export function parseMacProcessTable(stdout: string): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    // lstart is `EEE MMM d HH:mm:ss yyyy` — five fields with whatever internal
    // padding ps printed, preserved verbatim so the token byte-matches the
    // later revalidation read. The command line follows it.
    const match = line.trim().match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
    );
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      uid: Number.parseInt(match[3]!, 10),
      name: normalizeProcessName(match[5]!.split(' ')[0] ?? ''),
      cmdline: match[5]!.trim().length > 0 ? match[5]! : null,
      startToken: match[4]!.trim(),
    });
  }
  return rows;
}

/**
 * Cross-platform process table with names and command lines.
 *
 * Null means "cannot enumerate" — only the Windows reader signals that (it is
 * shared with the ghost-listener path); the POSIX readers degrade to an empty
 * table and log. Callers must refuse to kill on null, never guess.
 */
function readProcessTableWithNames(capMs?: number): Promise<WindowsProcessRow[] | null> {
  if (process.platform === 'win32') return readWindowsProcessTableWithNames(capMs);
  if (process.platform === 'linux') return Promise.resolve(readLinuxProcessTableWithNames());
  return readMacProcessTableWithNames(capMs);
}

/** Owner PIDs currently LISTENING on `port`, or null when netstat failed. */
async function listListeningOwnerPids(port: number, capMs?: number): Promise<number[] | null> {
  try {
    const result = await execFileAsync('netstat', ['-ano'], {
      timeout: cappedTimeoutMs(15_000, capMs),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNetstatListeningPids(result.stdout, port);
  } catch (error) {
    logger.warn(
      'PROCESS',
      'netstat failed — ghost-port reclaim disabled for this attempt',
      { port, error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }
}

/**
 * POSIX counterpart of listListeningOwnerPids: `lsof -t` prints one PID per
 * LISTEN socket owner. lsof exits 1 with no output when nothing matches, which
 * is an answer ("no listener"), not a failure. Null when lsof is unavailable or
 * failed — callers must then refuse to kill, never guess.
 */
async function listListeningOwnerPidsPosix(port: number, capMs?: number): Promise<number[] | null> {
  try {
    const result = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: cappedTimeoutMs(10_000, capMs),
      maxBuffer: 1024 * 1024,
    });
    return parsePidLines(result.stdout);
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code === 1 && typeof failure.stdout === 'string' && failure.stdout.trim() === '') {
      return [];
    }
    logger.warn('PROCESS', 'lsof failed — cannot verify the worker port owner', {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Parse one-PID-per-line output (lsof -t). Pure and exported for tests. */
export function parsePidLines(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Linux counterpart of listListeningOwnerPidsPosix, read from /proc like this
 * module's other Linux reads: the LISTEN sockets on `port` from
 * /proc/net/tcp{,6}, then the processes holding one of those inodes. BusyBox
 * `lsof` ignores `-iTCP -sTCP:LISTEN -t` and lists every open file of every
 * process, so every PID it printed looked like an owner (#5098). As with `lsof`
 * run as the user, only the user's own processes' fds are readable. Null when
 * /proc/net/tcp cannot be read. Exported for tests.
 */
export function listListeningOwnerPidsLinux(port: number): number[] | null {
  const inodes = new Set<string>();
  let readAnyTable = false;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf-8');
    } catch {
      continue; // tcp6 is absent on a kernel without IPv6
    }
    readAnyTable = true;
    for (const inode of parseProcNetTcpListenInodes(text, port)) inodes.add(inode);
  }
  if (!readAnyTable) {
    logger.warn('PROCESS', 'Cannot read /proc/net/tcp, so the worker port owner cannot be verified', { port });
    return null;
  }
  if (inodes.size === 0) return [];
  const owners = new Set<number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // another user's process, or exited
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const socket = /^socket:\[(\d+)\]$/.exec(target);
      if (socket && inodes.has(socket[1])) {
        owners.add(Number.parseInt(entry, 10));
        break;
      }
    }
  }
  return [...owners];
}

/** Inodes of the LISTEN (state 0A) sockets on `port` in a /proc/net/tcp or tcp6 table. Pure and exported for tests. */
export function parseProcNetTcpListenInodes(table: string, port: number): string[] {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes: string[] = [];
  // Columns: sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
  for (const line of table.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const localPort = fields[1].split(':').pop()?.toUpperCase();
    if (localPort === portHex && fields[3] === '0A' && fields[9] !== '0') inodes.push(fields[9]);
  }
  return inodes;
}

/**
 * Full command line of a POSIX process, or null when it cannot be read. Linux
 * reads /proc/<pid>/cmdline, joined as readLinuxProcessTableWithNames does:
 * BusyBox `ps` has no `-p` and no `command` field, so the `ps` read always
 * failed there and no wedged worker was ever reclaimed (#5098). Exported for tests.
 */
export async function readPosixCommandLine(pid: number, capMs?: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ') || null;
    } catch {
      return null;
    }
  }
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: cappedTimeoutMs(5_000, capMs) });
    const cmdline = result.stdout.trim();
    return cmdline.length > 0 ? cmdline : null;
  } catch {
    return null;
  }
}

/**
 * Parse `netstat -ano` output for every process LISTENING on `port`.
 *
 * Pure and exported for tests: feed it a captured netstat transcript and
 * assert on the parsed owners without touching the real process table.
 */
export function parseNetstatListeningPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  const addressSuffix = `:${port}`;
  for (const rawLine of netstatOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Proto LocalAddress ForeignAddress State PID
    if (!/^TCP\b/i.test(line)) continue;
    const fields = line.split(/\s+/);
    const localAddress = fields[1];
    if (!localAddress?.endsWith(addressSuffix)) continue;
    if (fields[3] !== 'LISTENING') continue;
    const pid = Number.parseInt(fields[4] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export type GhostPortReclaimResult =
  | { reclaimed: true; killedPids: number[] }
  | {
      reclaimed: false;
      reason:
        | 'not-supported' // non-Windows — no inheritable-handle ghost mechanism
        | 'netstat-unreadable'
        | 'no-listener' // port is not bound by anything
        | 'owner-alive' // a live process owns the port — never touch it
        | 'table-unreadable' // could not enumerate processes — refuse to guess
        | 'no-chroma-descendants' // owner dead but nothing reclaimable found
        | 'kill-failed' // a tree-kill genuinely failed
        | 'still-bound' // everything reclaimable was killed, port stayed bound
        // Wedged-worker path refusals — our worker is alive but not provably wedged:
        | 'owner-booting' // inside its boot/migration grace (pid-file age)
        | 'owner-responding' // answered a health re-probe
        | 'owner-progressing' // silent, but its heartbeat is fresh: slow, not dead
        | 'owner-identity-mismatch' // start token or command line is not our worker
        | 'out-of-budget'; // a caller's hook deadline leaves too little to finish (RECLAIM_MIN_BUDGET_MS)
      killedPids?: number[];
    };

interface KillTreeOptions {
  expectedStartToken?: string | null;
  signalMode: 'immediate' | 'graceful';
}

/** Start token and command line of one live PID, read as a single observation. */
export interface ProcessIdentity {
  startToken: string | null;
  cmdline: string | null;
}

/** A claude-mem worker daemon's command line names its bundle. */
const WORKER_CMDLINE_PATTERN = /worker-service/i;

/** Health re-probes before a wedged verdict: two probes, spaced apart. */
const WEDGED_HEALTH_PROBE_TIMEOUT_MS = 1_500;
const WEDGED_HEALTH_PROBE_SPACING_MS = 1_000;

/**
 * A caller spending a hook deadline (the UserPromptSubmit session-init, whose
 * host kills it at 15 s) gets a reclaim only when one can finish in time:
 * - before anything runs, RECLAIM_MIN_BUDGET_MS must be left: the two spaced
 *   health probes at full length (a probe cut short would read a slow but
 *   healthy worker as wedged) plus a tree-kill;
 * - before any kill, RECLAIM_KILL_BUDGET_MS must still be left (taskkill /T /F
 *   allows itself 5 s; a POSIX graceful kill settles 500 ms);
 * - every process read is cut to what is left, and a read cut short refuses
 *   to kill, like any unreadable owner list or process table.
 * Otherwise the reclaim declines with 'out-of-budget' and the next launcher
 * without a deadline (the MCP server, SessionStart, the daemon gate) does it.
 */
const RECLAIM_KILL_BUDGET_MS = 5_500;
const RECLAIM_MIN_BUDGET_MS = 2 * WEDGED_HEALTH_PROBE_TIMEOUT_MS + WEDGED_HEALTH_PROBE_SPACING_MS + RECLAIM_KILL_BUDGET_MS;

/**
 * Injectable seams for tests. Defaults are the real Windows implementations;
 * the suite injects fakes to exercise every decision branch on every CI
 * platform (the real netstat/CIM/taskkill path is covered by the Windows
 * integration gate). `capMs` on a read is what is left of the caller's
 * deadline (see RECLAIM_MIN_BUDGET_MS), or undefined without one.
 */
export interface GhostPortReclaimDeps {
  isWin32?: () => boolean;
  listOwners?: (port: number, capMs?: number) => Promise<number[] | null>;
  readTable?: (capMs?: number) => Promise<WindowsProcessRow[] | null>;
  killTree?: (pid: number, options: KillTreeOptions) => Promise<void>;
  dataDir?: () => string | null;
  /** The live worker our PID file claims (start-token verified), or null. */
  readOwnedWorker?: () => PidInfo | null;
  /** One bounded /api/health probe; true when the worker answered. */
  probeHealth?: (port: number) => Promise<boolean>;
  /** Start token + command line of `pid`, read together. */
  readIdentity?: (pid: number, capMs?: number) => Promise<ProcessIdentity>;
  /** Minimum worker age (seconds) before a silent worker may count as wedged. */
  minOwnerAgeSeconds?: number;
  /** The worker's own liveness heartbeat, or null when it has written none (or it is unreadable). */
  readHeartbeat?: () => WorkerHeartbeat | null;
  /** A heartbeat younger than this (ms) means the worker's event loop still turns. */
  heartbeatStaleMs?: number;
  /** A fresh heartbeat spares the worker only if it finished an HTTP response within this long (ms). */
  maxSilentProtectionMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Deadline (read with `now`) of a caller spending a hook budget; absent or null for none. */
  deadlineAt?: number | null;
}

interface WedgedReclaimDeps {
  listOwners: (port: number) => Promise<number[] | null>;
  killTree: (pid: number, options: KillTreeOptions) => Promise<void>;
  readOwnedWorker: () => PidInfo | null;
  probeHealth: (port: number) => Promise<boolean>;
  readIdentity: (pid: number) => Promise<ProcessIdentity>;
  minOwnerAgeSeconds: number;
  readHeartbeat: () => WorkerHeartbeat | null;
  heartbeatStaleMs: number;
  maxSilentProtectionMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** False when a kill could no longer finish inside the caller's deadline. */
  hasKillBudget: () => boolean;
}

/**
 * Reclaim a worker of OURS that has wedged: the PID file names a live process
 * meant to own `port`, but /health has been unreachable for the caller's whole
 * wait (both launchers reach reclaim only after waitForHealth timed out). A
 * worker spinning at 100% CPU — e.g. stuck in a provider quota cooldown
 * (#4127) — stops answering /health while it still holds the port and its PID
 * file, and ignores SIGTERM. The owner is ALIVE and the mechanism is not
 * Windows-specific, so the netstat / sidecar path never reaches it.
 *
 * Returns null when this mechanism does not apply — no live worker we own, or
 * it records a different port — so the caller falls through to the
 * ghost-listener logic. A live FOREIGN owner (a process our PID file does not
 * claim) is never matched here, so it stays protected.
 *
 * Killing a live process from a spawn path needs evidence, all of it gathered
 * before anything is signalled:
 *   1. Age: the PID file's startedAt is older than the wedged-uptime grace
 *      (CLAUDE_MEM_WEDGED_WORKER_UPTIME_S). A booting or migrating worker can
 *      block its event loop for seconds; the daemon duplicate gate waits only
 *      ~3s, so without this a slow boot would be killed, and killed again.
 *   2. Silence: two /api/health re-probes, spaced apart, both fail. The
 *      verdict never rests on a single timeout or on how long a caller waited.
 *   3. Identity: the PID is a LISTEN owner of this port, it still carries the
 *      start token our PID file recorded, and its command line is a
 *      claude-mem worker (the command-line check comes from quinnmacro's
 *      #3408). That token is handed to killProcessTree, which revalidates it
 *      before every signal, so a PID reissued mid-reclaim is never signalled.
 */
async function reclaimWedgedOwnedWorker(
  port: number,
  deps: WedgedReclaimDeps,
): Promise<GhostPortReclaimResult | null> {
  const owned = deps.readOwnedWorker();
  if (owned === null || owned.port !== port) return null;
  const refuse = (
    reason: 'owner-booting' | 'owner-responding' | 'owner-progressing' | 'owner-identity-mismatch' | 'netstat-unreadable' | 'out-of-budget',
    details: Record<string, unknown> = {},
  ): GhostPortReclaimResult => {
    logger.info('PROCESS', 'Wedged-worker reclaim declined', { port, pid: owned.pid, reason, ...details });
    return { reclaimed: false, reason, killedPids: [] };
  };

  const ageSeconds = (deps.now() - Date.parse(owned.startedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < deps.minOwnerAgeSeconds) {
    return refuse('owner-booting', { ageSeconds, minOwnerAgeSeconds: deps.minOwnerAgeSeconds });
  }

  for (let probe = 0; probe < 2; probe++) {
    if (probe > 0) await deps.sleep(WEDGED_HEALTH_PROBE_SPACING_MS);
    if (await deps.probeHealth(port)) return refuse('owner-responding');
  }

  const listeners = await deps.listOwners(port);
  if (listeners === null) return refuse('netstat-unreadable');
  if (!listeners.includes(owned.pid)) {
    // Our worker is alive but something else holds the port. Not a wedged
    // worker of ours: let the ghost-listener logic judge the actual owner
    // (a dead owner's sidecar is reclaimable, a live foreign one never is).
    logger.info('PROCESS', 'Wedged-worker reclaim: our worker does not own the port — deferring to the ghost-listener check', {
      port,
      pid: owned.pid,
      listeners,
    });
    return null;
  }

  // Silence is not death. Under on-access antivirus a worker's event loop can
  // be held in slow synchronous file opens (traced up to 2 s each), and a held
  // loop misses health probes. After one such reclaim the restart re-ran the
  // backfill, and health came back about 9 minutes after the kill. The worker
  // publishes its own heartbeat: a timer (which runs only when the loop turns)
  // stamps beatAtMs, and lastResponseAtMs is when it last finished any HTTP
  // response. A fresh beat alone cannot tell a slow worker from one whose loop
  // turns while every request hangs, so it spares the worker only while that
  // worker has finished a response within maxSilentProtectionMs. The worker
  // writes both fields, so a recovery resets the window by itself and no hook
  // keeps state of its own. A heartbeat from another pid (an earlier run), or
  // none at all (an older worker), keeps the previous verdict.
  const heartbeat = deps.readHeartbeat();
  if (heartbeat !== null && heartbeat.pid === owned.pid) {
    const nowMs = deps.now();
    const heartbeatAgeMs = Math.max(0, nowMs - heartbeat.beatAtMs);
    const sinceLastResponseMs = Math.max(0, nowMs - heartbeat.lastResponseAtMs);
    if (heartbeatAgeMs < deps.heartbeatStaleMs) {
      if (sinceLastResponseMs < deps.maxSilentProtectionMs) {
        return refuse('owner-progressing', {
          heartbeatAgeMs: Math.round(heartbeatAgeMs),
          sinceLastResponseMs: Math.round(sinceLastResponseMs),
        });
      }
      logger.warn('PROCESS', 'Worker finished no response within the protection window despite a fresh liveness heartbeat', {
        port,
        pid: owned.pid,
        sinceLastResponseMs: Math.round(sinceLastResponseMs),
        maxSilentProtectionMs: deps.maxSilentProtectionMs,
      });
    }
  }

  const identity = await deps.readIdentity(owned.pid);
  const tokenMismatch = owned.startToken !== undefined
    && identity.startToken !== null
    && identity.startToken !== owned.startToken;
  if (tokenMismatch || identity.cmdline === null || !WORKER_CMDLINE_PATTERN.test(identity.cmdline)) {
    return refuse('owner-identity-mismatch', { tokenMismatch, hasCmdline: identity.cmdline !== null });
  }
  if (!deps.hasKillBudget()) return refuse('out-of-budget');

  logger.warn('PROCESS', 'Reclaiming wedged worker: past its boot grace, silent on two health probes, and still holding the port', {
    port,
    pid: owned.pid,
    ageSeconds: Math.round(ageSeconds),
  });

  try {
    // Graceful: SIGTERM, a settle, then SIGKILL. A worker that ignores SIGTERM
    // (the 100% CPU wedge) still dies on the uncatchable SIGKILL, and the
    // tree-kill reaps its chroma sidecar chain so the inherited socket frees.
    // A signal shutdown never spawns a successor (worker-shutdown.ts), so this
    // runs no restart handoff.
    await deps.killTree(owned.pid, {
      // No token at all → undefined, so killProcessTree self-captures at entry
      // and still revalidates across its own awaits.
      expectedStartToken: identity.startToken ?? owned.startToken ?? undefined,
      signalMode: 'graceful',
    });
  } catch (error) {
    logger.error(
      'PROCESS',
      'Wedged-worker reclaim tree-kill failed',
      { port, pid: owned.pid },
      error instanceof Error ? error : new Error(String(error))
    );
    return { reclaimed: false, reason: 'kill-failed', killedPids: [] };
  }

  const after = await deps.listOwners(port);
  if (after !== null && after.length === 0) {
    logger.info('PROCESS', 'Wedged worker reclaimed — port is free again', { port, killedPids: [owned.pid] });
    return { reclaimed: true, killedPids: [owned.pid] };
  }
  logger.warn('PROCESS', 'Wedged-worker reclaim killed the worker but the port is still bound', {
    port,
    pid: owned.pid,
    stillOwnedBy: after,
  });
  return { reclaimed: false, reason: 'still-bound', killedPids: [owned.pid] };
}

/**
 * Default identity read: the start token, then the command line, then the
 * token again. If the PID was reissued while the command line was being read,
 * that command line belongs to another process and must not vouch for this
 * one, so both fields come back null.
 */
async function readProcessIdentity(
  pid: number,
  isWin32: boolean,
  readTable: (capMs?: number) => Promise<WindowsProcessRow[] | null>,
  capMs?: number,
): Promise<ProcessIdentity> {
  const startToken = captureProcessStartToken(pid);
  const cmdline = isWin32
    ? (await readTable(capMs))?.find(row => row.pid === pid)?.cmdline ?? null
    : await readPosixCommandLine(pid, capMs);
  if (!isSameProcess(pid, startToken)) return { startToken: null, cmdline: null };
  return { startToken, cmdline };
}

/**
 * Reclaim the worker port. First handles a WEDGED worker we own on every
 * platform (reclaimWedgedOwnedWorker), then a ghost listener — one whose
 * owning PID is dead but whose socket stays bound because the dead owner's
 * surviving descendants inherited the handle (Windows). Returns reclaimed:true
 * only when the port is verified free again after the kill.
 *
 * Safety rules (all must hold before anything is signalled):
 *   - The wedged-worker path fires only for a live PID our OWN PID file claims
 *     for this exact port; a live FOREIGN owner is never matched there.
 *   - The ghost-listener path is Windows only; POSIX sockets die with their
 *     owner, so once the wedged path declines there is nothing left to reclaim
 *     and it resolves to not-supported.
 *   - A LIVE FOREIGN owner means "leave it alone": a process our PID file does
 *     not claim is not ours to kill from a spawn path.
 *   - Every ghost kill target is (a) a chroma sidecar reachable down the dead
 *     owner's parent chain, or (b) a chroma sidecar whose command line names
 *     THIS install's data dir — PID reuse cannot pull in strangers, and a
 *     chain that broke between the dead owner and the survivor is still
 *     identified by its data-dir argument.
 *   - Each kill goes through killProcessTree() with the start token captured
 *     in the same table read that discovered the target.
 */
export async function reclaimGhostListeningPort(
  port: number,
  deps: GhostPortReclaimDeps = {}
): Promise<GhostPortReclaimResult> {
  const isWin32 = deps.isWin32 ?? (() => process.platform === 'win32');
  const now = deps.now ?? Date.now;
  const deadlineAt = deps.deadlineAt ?? null;
  const lacksBudget = (needMs: number): boolean => deadlineAt !== null && deadlineAt - now() < needMs;
  // What is left of the caller's deadline caps every process read (see RECLAIM_MIN_BUDGET_MS).
  const readCapMs = (): number | undefined => (deadlineAt === null ? undefined : Math.max(1, deadlineAt - now()));
  if (lacksBudget(RECLAIM_MIN_BUDGET_MS)) {
    logger.info('PROCESS', 'Port reclaim skipped: not enough of the hook budget is left to finish one', {
      port,
      remainingMs: readCapMs(),
      neededMs: RECLAIM_MIN_BUDGET_MS,
    });
    return { reclaimed: false, reason: 'out-of-budget', killedPids: [] };
  }

  const readOwners = deps.listOwners
    ?? ((p: number, capMs?: number) => (isWin32()
      ? listListeningOwnerPids(p, capMs)
      : process.platform === 'linux'
        ? Promise.resolve(listListeningOwnerPidsLinux(p))
        : listListeningOwnerPidsPosix(p, capMs)));
  const listOwners = (p: number) => readOwners(p, readCapMs());
  const readProcessTable = deps.readTable ?? readWindowsProcessTableWithNames;
  const readTable = () => readProcessTable(readCapMs());
  const killTree = deps.killTree ?? ((pid, options) => killProcessTree(pid, options));
  const dataDir = deps.dataDir ?? (() => DATA_DIR);
  const readIdentity = deps.readIdentity
    ?? ((pid: number, capMs?: number) => readProcessIdentity(pid, isWin32(), readProcessTable, capMs));

  // Wedged-worker reclaim runs on every platform, before the Windows-only
  // ghost-listener path: a live worker we own that has stopped answering
  // /health (#4127) is invisible to the dead-owner netstat/sidecar logic.
  const wedged = await reclaimWedgedOwnedWorker(port, {
    listOwners,
    killTree,
    readOwnedWorker: deps.readOwnedWorker ?? readOwnedWorkerPidInfo,
    probeHealth: deps.probeHealth ?? ((p: number) => waitForHealth(p, WEDGED_HEALTH_PROBE_TIMEOUT_MS)),
    readIdentity: (pid: number) => readIdentity(pid, readCapMs()),
    minOwnerAgeSeconds: deps.minOwnerAgeSeconds ?? readWedgedWorkerUptimeSeconds(),
    readHeartbeat: deps.readHeartbeat ?? (() => readWorkerHeartbeat()),
    heartbeatStaleMs: deps.heartbeatStaleMs ?? readWorkerHeartbeatStaleMs(),
    maxSilentProtectionMs: deps.maxSilentProtectionMs ?? MAX_SILENT_PROTECTION_MS,
    now,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
    hasKillBudget: () => !lacksBudget(RECLAIM_KILL_BUDGET_MS),
  });
  if (wedged !== null) return wedged;

  if (!isWin32()) {
    return { reclaimed: false, reason: 'not-supported', killedPids: [] };
  }

  const owners = await listOwners(port);
  if (owners === null) return { reclaimed: false, reason: 'netstat-unreadable', killedPids: [] };
  if (owners.length === 0) return { reclaimed: false, reason: 'no-listener', killedPids: [] };

  const table = await readTable();
  if (table === null) return { reclaimed: false, reason: 'table-unreadable', killedPids: [] };

  // A live owner is authoritative: something real owns the port. Killing or
  // reclaiming here could take down a wedged-but-alive worker that still
  // owns its socket — the launcher must keep reporting it as in use.
  const aliveOwners = owners.filter(owner => isPidAlive(owner));
  if (aliveOwners.length > 0) {
    return { reclaimed: false, reason: 'owner-alive', killedPids: [] };
  }

  const childrenByParent = new Map<number, WindowsProcessRow[]>();
  for (const row of table) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const killTargets = new Map<number, WindowsProcessRow>();

  // (a) Walk every dead owner's surviving descendants. Windows keeps the
  // parent link after the parent exits, so the chain the dead worker spawned
  // is still reachable from its PID — when no intermediate link died.
  const seen = new Set<number>();
  const walk = (parentPid: number): void => {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      walk(child.pid);
      if (isChromaSidecarName(child.name)) killTargets.set(child.pid, child);
    }
  };
  for (const owner of owners) walk(owner);

  // (b) Broken-chain scan: the worker's uvx/uv layers read EOF on the MCP
  // stdio pipes and exit when the worker dies, so the surviving
  // chroma-mcp/python sidecar can sit one or two links BELOW a dead PID —
  // invisible to the walk above. Its `--data-dir <DATA_DIR>` argument still
  // proves it belongs to this install, so match every sidecar-named process
  // against our data dir anywhere in the table. (Walk targets already carry
  // their own evidence; a data-dir match is not required of them.)
  const ownDataDir = dataDir();
  if (ownDataDir) {
    for (const row of table) {
      if (killTargets.has(row.pid)) continue;
      if (!isChromaSidecarName(row.name)) continue;
      if (chromaCmdlineMatchesDataDir(row.cmdline, ownDataDir)) {
        killTargets.set(row.pid, row);
      }
    }
  }

  if (killTargets.size === 0) {
    logger.info('PROCESS', 'Ghost listener owner is dead but no chroma-sidecar descendants found', {
      port,
      deadOwners: owners,
      processTableRows: table.length,
      dataDir: ownDataDir ?? '(unresolved)',
    });
    return { reclaimed: false, reason: 'no-chroma-descendants', killedPids: [] };
  }
  logger.warn('PROCESS', 'Reclaiming ghost listener: killing dead worker\'s surviving chroma sidecar chain', {
    port,
    deadOwners: owners,
    targets: [...killTargets.values()].map(target => ({ pid: target.pid, name: target.name })),
  });

  const killedPids: number[] = [];
  for (const target of killTargets.values()) {
    // Each tree-kill can take its full taskkill timeout, so a caller's
    // deadline is checked before every one, not once for the whole chain.
    if (lacksBudget(RECLAIM_KILL_BUDGET_MS)) {
      logger.info('PROCESS', 'Ghost-listener reclaim stopped before a kill: the hook budget is spent', { port, killedPids });
      return { reclaimed: false, reason: 'out-of-budget', killedPids };
    }
    try {
      await killTree(target.pid, {
        // Identity from the discovery read — never re-probed against a
        // different observation, and never self-captured after an await.
        expectedStartToken: target.startToken,
        signalMode: 'immediate',
      });
      killedPids.push(target.pid);
    } catch (error) {
      logger.error(
        'PROCESS',
        'Ghost-port reclaim tree-kill failed',
        { port, pid: target.pid },
        error instanceof Error ? error : new Error(String(error))
      );
      return { reclaimed: false, reason: 'kill-failed', killedPids };
    }
  }

  const after = await listOwners(port);
  if (after !== null && after.length === 0) {
    logger.info('PROCESS', 'Ghost listener reclaimed — port is free again', { port, killedPids });
    return { reclaimed: true, killedPids };
  }
  logger.warn('PROCESS', 'Ghost-port reclaim killed the sidecar chain but the port is still bound', {
    port,
    killedPids,
    stillOwnedBy: after,
  });
  return { reclaimed: false, reason: 'still-bound', killedPids };
}

/**
 * Injectable seams for the orphan sweep, mirroring GhostPortReclaimDeps: the
 * suite injects a fake table and kill so every decision branch runs on every
 * CI platform without touching real processes.
 */
export interface OrphanSweepDeps {
  /** The exact chroma store this worker holds the writer lock for. Required: no root default. */
  dataDir: () => string | null;
  /**
   * Re-checked after the (possibly slow) table read and before every kill:
   * false once this connection was cancelled or lost its writer lock, so a
   * sweep overtaken by stop() can never kill a replacement worker's sidecar.
   */
  stillOwnsStore?: () => boolean;
  readTable?: (capMs?: number) => Promise<WindowsProcessRow[] | null>;
  killTree?: (pid: number, options: KillTreeOptions) => Promise<void>;
  /** Our uid on POSIX, null on Windows (rows there carry no owner). */
  ownUid?: () => number | null;
  platform?: NodeJS.Platform;
}

/**
 * Does a command line's --data-dir name EXACTLY this store?
 *
 * Stricter than chromaCmdlineMatchesDataDir (which the ghost-port path calls
 * with the DATA_DIR root and so must accept children): a machine-wide kill
 * may only target the store whose writer lock we hold. A child directory, or
 * a path differing only in case on a case-sensitive filesystem (Linux), is a
 * different store with its own lock.
 */
export function chromaCmdlineNamesExactDataDir(
  cmdline: string | null,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!cmdline) return false;
  const flagIndex = cmdline.indexOf('--data-dir');
  if (flagIndex < 0) return false;
  let value = cmdline.slice(flagIndex + '--data-dir'.length).trim();
  if (value.startsWith('=')) value = value.slice(1);
  // A value containing spaces is double-quoted by the spawner.
  if (value.startsWith('"')) {
    const endQuote = value.indexOf('"', 1);
    value = endQuote < 0 ? value.slice(1) : value.slice(1, endQuote);
  }
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const normalize = (dir: string): string => {
    const slashed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  return normalize(value) === normalize(dataDir);
}

/**
 * Kill every chroma-mcp sidecar still holding THIS install's chroma data dir
 * (#4608).
 *
 * When a worker dies out of band — crash, SIGKILL without tree teardown, a
 * package upgrade replacing it — its chroma-mcp sidecar chain survives
 * re-parented to init (PPID=1). It holds no port (POSIX sockets died with the
 * worker), so the Windows ghost-listener path above never sees it, and the
 * chroma writer lock cannot help either: the lock only governs lock-file
 * lifetime, while the orphan keeps the DATA DIR open and accepts nothing that
 * would tell it to stop. The next worker then spawns its own chroma-mcp on
 * the same store — two concurrent writers, which is what the reporter logged
 * for 16 days (110 failed batch adds, 84 transport errors, a store once
 * judged corrupt).
 *
 * Call it while holding the chroma writer lock: the lock proves no LIVE
 * worker owns this store, so any process still carrying our --data-dir
 * fingerprint is by definition an orphan of a dead generation. Every kill
 * target is evidence-matched four ways — chroma sidecar by name or by the
 * chroma-mcp entry point in its command line, PLUS exactly our data dir
 * in its command line, PLUS our uid on POSIX, PLUS not our own pid — and goes through killProcessTree with
 * the start token from the SAME table read that discovered it, so PID reuse
 * between discovery and kill is never signalled.
 *
 * Fail-soft by design: an unreadable table or a failed tree-kill is logged
 * and skipped, never thrown — the sweep is a pre-spawn cleanup, and turning
 * a ps hiccup into a chroma outage would trade one degradation for another.
 * Graceful teardown (SIGTERM first) leaves uv its builds-scratch cleanup.
 */
export async function reclaimOrphanChromaDataDirWriters(deps: OrphanSweepDeps): Promise<{ killedPids: number[] }> {
  const dataDir = deps.dataDir;
  const stillOwnsStore = deps.stillOwnsStore ?? (() => true);
  const platform = deps.platform ?? process.platform;
  const ownUid = (deps.ownUid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : null)))();
  const readTable = deps.readTable ?? readProcessTableWithNames;
  const killTree = deps.killTree ?? ((pid: number, options: KillTreeOptions) => killProcessTree(pid, options));

  const ownDataDir = dataDir();
  if (!ownDataDir) return { killedPids: [] };

  const table = await readTable();
  if (table === null) {
    logger.warn('PROCESS', 'Cannot enumerate the process table — refusing to guess at chroma orphans');
    return { killedPids: [] };
  }
  if (!stillOwnsStore()) {
    logger.debug('PROCESS', 'Chroma connection cancelled during the orphan sweep table read; killing nothing');
    return { killedPids: [] };
  }

  const targets = table.filter(
    row =>
      row.pid !== process.pid &&
      // POSIX: only our own uid's processes. A row with an unknown owner is
      // never a target. Windows rows carry no owner; the exact data-dir match
      // below binds them to this profile's store.
      (ownUid === null || row.uid === ownUid) &&
      isChromaSidecarCandidate(row) &&
      chromaCmdlineNamesExactDataDir(row.cmdline, ownDataDir, platform)
  );
  if (targets.length === 0) return { killedPids: [] };

  logger.warn('PROCESS', 'Killing orphaned chroma-mcp sidecar(s) still holding this install\'s chroma data dir', {
    dataDir: ownDataDir,
    targets: targets.map(target => ({ pid: target.pid, ppid: target.ppid, name: target.name })),
  });

  const killedPids: number[] = [];
  for (const target of targets) {
    if (!stillOwnsStore()) {
      logger.debug('PROCESS', 'Chroma connection cancelled mid-sweep; leaving the remaining targets alone');
      break;
    }
    try {
      await killTree(target.pid, {
        // Identity from the discovery read — never re-probed against a
        // different observation, and never self-captured after an await.
        expectedStartToken: target.startToken,
        signalMode: 'graceful',
      });
      killedPids.push(target.pid);
    } catch (error) {
      logger.error(
        'PROCESS',
        'Orphan chroma-mcp tree-kill failed; leaving the rest of the sweep to proceed',
        { pid: target.pid },
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
  return { killedPids };
}

/** How often the worker refreshes its liveness heartbeat file. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_STALE_DEFAULT_MS = 120_000;
const WORKER_HEARTBEAT_STALE_BOUNDS_MS = { min: 10_000, max: 3_600_000 } as const;

/**
 * CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS from the environment, else settings.json,
 * else the default. Hooks are short processes, so each reclaim reads it afresh.
 */
export function readWorkerHeartbeatStaleMs(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = USER_SETTINGS_PATH,
): number {
  const raw = env.CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS
    ?? SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true }).CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value)
    && value >= WORKER_HEARTBEAT_STALE_BOUNDS_MS.min
    && value <= WORKER_HEARTBEAT_STALE_BOUNDS_MS.max
    ? value
    : WORKER_HEARTBEAT_STALE_DEFAULT_MS;
}

/**
 * A fresh liveness heartbeat spares a silent worker only while it has finished
 * an HTTP response within this long: a worker with no completed response for
 * 10 minutes is judged as before, whatever its heartbeat says.
 */
export const MAX_SILENT_PROTECTION_MS = 600_000;

/** What the worker publishes about itself. Only the worker ever writes it. */
export interface WorkerHeartbeat {
  /** The worker process that wrote it; a heartbeat from any other pid is ignored. */
  pid: number;
  /** When the heartbeat timer last ran (ms epoch). Fresh means the event loop turns. */
  beatAtMs: number;
  /** When the worker last finished an HTTP response (ms epoch), or when it started if it has finished none. */
  lastResponseAtMs: number;
}

/** The worker's heartbeat, or null when there is none or it does not parse as one. */
export function readWorkerHeartbeat(heartbeatPath: string = paths.workerHeartbeat()): WorkerHeartbeat | null {
  try {
    const parsed = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as Partial<WorkerHeartbeat> | null;
    if (parsed
      && Number.isSafeInteger(parsed.pid)
      && Number.isFinite(parsed.beatAtMs)
      && Number.isFinite(parsed.lastResponseAtMs)) {
      return { pid: parsed.pid!, beatAtMs: parsed.beatAtMs!, lastResponseAtMs: parsed.lastResponseAtMs! };
    }
  } catch {
    // No heartbeat yet (an older worker, or before the first beat).
  }
  return null;
}

export interface WorkerHeartbeatOptions {
  /** When the worker last finished an HTTP response (ms epoch), or null if it has finished none. */
  readLastResponseAtMs: () => number | null;
  heartbeatPath?: string;
  intervalMs?: number;
  pid?: number;
  now?: () => number;
}

/**
 * Publish the heartbeat from an unref'd timer. The timer fires only when the
 * event loop turns, so beatAtMs measures progress. Each beat writes a temp
 * file and renames it over the heartbeat, so a hook never reads a torn one.
 * The write is async (a thread-pool thread waits on a slow filesystem, not
 * the loop), and a failed write is ignored: a missing or stale heartbeat only
 * restores the old verdict.
 */
export function startWorkerHeartbeat(options: WorkerHeartbeatOptions): () => void {
  const heartbeatPath = options.heartbeatPath ?? paths.workerHeartbeat();
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const tmpPath = `${heartbeatPath}.${pid}.tmp`;
  // One write at a time: on a slow filesystem a second beat truncating the
  // temp file while the first renames it could publish a torn heartbeat.
  let writing = false;
  const beat = () => {
    if (writing) return;
    writing = true;
    const heartbeat: WorkerHeartbeat = {
      pid,
      beatAtMs: now(),
      lastResponseAtMs: options.readLastResponseAtMs() ?? startedAtMs,
    };
    void fsPromises.writeFile(tmpPath, JSON.stringify(heartbeat))
      .then(() => fsPromises.rename(tmpPath, heartbeatPath))
      .catch(() => {})
      .finally(() => { writing = false; });
  };
  beat();
  const timer = setInterval(beat, options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

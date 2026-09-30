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
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';
import { killProcessTree } from './kill-process-tree.js';
import { isPidAlive, type PidInfo } from '../supervisor/process-registry.js';
import { readOwnedWorkerPidInfo } from '../supervisor/index.js';
import { waitForHealth } from '../services/infrastructure/HealthMonitor.js';
import { captureProcessStartToken, isSameProcess } from './process-identity.js';
import { readWedgedWorkerUptimeSeconds } from './hook-constants.js';
import { DATA_DIR } from './paths.js';

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

export interface WindowsProcessRow {
  pid: number;
  ppid: number;
  name: string;
  startToken: string | null;
  /** Full command line; null when the OS did not expose it. */
  cmdline: string | null;
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

/**
 * One CIM query returning pid, parent pid, executable name, command line and
 * creation token per row. Identity and ancestry come from the SAME
 * observation, so the discovery-to-kill gap never revalidates a target
 * against a different read (same atomicity rule as readProcessTable in
 * kill-process-tree.ts). Command lines may contain commas and quotes, so the
 * rows are transported as JSON rather than CSV.
 */
async function readWindowsProcessTableWithNames(): Promise<WindowsProcessRow[] | null> {
  try {
    const result = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='StartToken';Expression={$_.CreationDate.ToString('yyyyMMddHHmmss.ffffff')}} | ConvertTo-Json -Compress",
      ],
      { timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
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

/** Owner PIDs currently LISTENING on `port`, or null when netstat failed. */
async function listListeningOwnerPids(port: number): Promise<number[] | null> {
  try {
    const result = await execFileAsync('netstat', ['-ano'], {
      timeout: 15_000,
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
async function listListeningOwnerPidsPosix(port: number): Promise<number[] | null> {
  try {
    const result = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: 10_000,
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

/** Full command line of a POSIX process, or null when it cannot be read. */
async function readPosixCommandLine(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 });
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
        | 'owner-identity-mismatch'; // start token or command line is not our worker
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
 * Injectable seams for tests. Defaults are the real Windows implementations;
 * the suite injects fakes to exercise every decision branch on every CI
 * platform (the real netstat/CIM/taskkill path is covered by the Windows
 * integration gate).
 */
export interface GhostPortReclaimDeps {
  isWin32?: () => boolean;
  listOwners?: (port: number) => Promise<number[] | null>;
  readTable?: () => Promise<WindowsProcessRow[] | null>;
  killTree?: (pid: number, options: KillTreeOptions) => Promise<void>;
  dataDir?: () => string | null;
  /** The live worker our PID file claims (start-token verified), or null. */
  readOwnedWorker?: () => PidInfo | null;
  /** One bounded /api/health probe; true when the worker answered. */
  probeHealth?: (port: number) => Promise<boolean>;
  /** Start token + command line of `pid`, read together. */
  readIdentity?: (pid: number) => Promise<ProcessIdentity>;
  /** Minimum worker age (seconds) before a silent worker may count as wedged. */
  minOwnerAgeSeconds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface WedgedReclaimDeps {
  listOwners: (port: number) => Promise<number[] | null>;
  killTree: (pid: number, options: KillTreeOptions) => Promise<void>;
  readOwnedWorker: () => PidInfo | null;
  probeHealth: (port: number) => Promise<boolean>;
  readIdentity: (pid: number) => Promise<ProcessIdentity>;
  minOwnerAgeSeconds: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
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
    reason: 'owner-booting' | 'owner-responding' | 'owner-identity-mismatch' | 'netstat-unreadable',
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

  const identity = await deps.readIdentity(owned.pid);
  const tokenMismatch = owned.startToken !== undefined
    && identity.startToken !== null
    && identity.startToken !== owned.startToken;
  if (tokenMismatch || identity.cmdline === null || !WORKER_CMDLINE_PATTERN.test(identity.cmdline)) {
    return refuse('owner-identity-mismatch', { tokenMismatch, hasCmdline: identity.cmdline !== null });
  }

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
  readTable: () => Promise<WindowsProcessRow[] | null>,
): Promise<ProcessIdentity> {
  const startToken = captureProcessStartToken(pid);
  const cmdline = isWin32
    ? (await readTable())?.find(row => row.pid === pid)?.cmdline ?? null
    : await readPosixCommandLine(pid);
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
  const listOwners = deps.listOwners
    ?? ((p: number) => (isWin32() ? listListeningOwnerPids(p) : listListeningOwnerPidsPosix(p)));
  const readTable = deps.readTable ?? readWindowsProcessTableWithNames;
  const killTree = deps.killTree ?? ((pid, options) => killProcessTree(pid, options));
  const dataDir = deps.dataDir ?? (() => DATA_DIR);

  // Wedged-worker reclaim runs on every platform, before the Windows-only
  // ghost-listener path: a live worker we own that has stopped answering
  // /health (#4127) is invisible to the dead-owner netstat/sidecar logic.
  const wedged = await reclaimWedgedOwnedWorker(port, {
    listOwners,
    killTree,
    readOwnedWorker: deps.readOwnedWorker ?? readOwnedWorkerPidInfo,
    probeHealth: deps.probeHealth ?? ((p: number) => waitForHealth(p, WEDGED_HEALTH_PROBE_TIMEOUT_MS)),
    readIdentity: deps.readIdentity ?? ((pid: number) => readProcessIdentity(pid, isWin32(), readTable)),
    minOwnerAgeSeconds: deps.minOwnerAgeSeconds ?? readWedgedWorkerUptimeSeconds(),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
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

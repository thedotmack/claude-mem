import { ChildProcess, spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';
import { sanitizeEnv } from './env-sanitizer.js';

const REAP_SESSION_SIGTERM_TIMEOUT_MS = 5_000;
const REAP_SESSION_SIGKILL_TIMEOUT_MS = 1_000;

const DATA_DIR = path.join(homedir(), '.claude-mem');
const DEFAULT_REGISTRY_PATH = path.join(DATA_DIR, 'supervisor.json');

export interface ManagedProcessInfo {
  pid: number;
  type: string;
  sessionId?: string | number;
  startedAt: string;
  // POSIX process group leader PID for group-scoped teardown.
  // On Unix, when a child is spawned with `detached: true`, the kernel calls
  // setpgid() and the child becomes the leader of its own group — its pgid
  // equals its pid. Stored so `process.kill(-pgid, signal)` can tear down
  // the child AND every descendant it spawned in one syscall (Principle 5).
  // Undefined on Windows (no POSIX groups) and for processes that were not
  // spawned with detached: true (e.g. the worker itself, MCP stdio clients).
  pgid?: number;
}

export interface ManagedProcessRecord extends ManagedProcessInfo {
  id: string;
}

interface PersistedRegistry {
  processes: Record<string, ManagedProcessInfo>;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 0) return false;
  if (pid === 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return true;
      logger.debug('SYSTEM', 'PID check failed', { pid, code });
      return false;
    }
    logger.warn('SYSTEM', 'PID check threw non-Error', { pid, error: String(error) });
    return false;
  }
}

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
  // Opaque process-start token used to distinguish a worker incarnation from
  // another process that happens to reuse the same PID. Captured via
  // captureProcessStartToken() at write time, checked via
  // verifyPidFileOwnership() at read time. Optional for backwards
  // compatibility with PID files written by older versions.
  startToken?: string;
}

/**
 * Capture an opaque "identity" token for a running PID — something stable
 * across time for that exact process incarnation, but different if the PID
 * gets reused by a later process.
 *
 * Fixes a class of false-positive "worker already running" errors where the
 * PID file survives (bind-mounted volume, persistent home dir, etc.) while
 * the PID namespace resets (docker stop / docker start), and the new worker
 * incarnation happens to get the same PID as the old one. A plain kill(0)
 * liveness check then says "yes, PID is alive" — but it's actually *us*
 * checking against our own PID file and refusing to boot.
 *
 * Sources by platform (`process.platform`):
 * - `linux`: field 22 of /proc/<pid>/stat (starttime, jiffies since boot).
 *   Cheap, no exec. Same approach pgrep/systemd use.
 * - `darwin` and any other POSIX (*BSD, SunOS) that falls through the Linux
 *   check: `ps -p <pid> -o lstart=` (wall-clock start time). A one-shot exec
 *   at worker startup — fine. If `ps` is missing the ENOENT is caught and
 *   null is returned; callers then fall back to liveness-only.
 * - `win32`: null (caller falls back to liveness-only behavior). The PID-
 *   reuse scenario doesn't affect Windows deployments the way containers do.
 *
 * Returns null when we can't read a token (permission denied, process gone,
 * unsupported platform). Callers should treat null as "can't verify" and
 * fall back to the liveness-only code path to preserve existing behavior.
 */
export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') {
    try {
      // /proc/<pid>/stat format:
      //   <pid> (comm) <state> <ppid> ... <starttime@field-22> ...
      // `comm` can contain spaces and parens, so we key off the LAST ')' and
      // split the tail — avoids being confused by weird process names.
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const tailStart = raw.lastIndexOf(') ');
      if (tailStart < 0) return null;
      const fields = raw.slice(tailStart + 2).split(' ');
      // After ') ' we're at field 3 (state). starttime is field 22.
      // Offset into `fields`: 22 - 3 = 19.
      const starttime = fields[19];
      return starttime && /^\d+$/.test(starttime) ? starttime : null;
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'captureProcessStartToken: /proc read failed', {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  if (process.platform === 'win32') {
    return null;
  }

  try {
    // Pin LC_ALL=C so `ps lstart=` emits a locale-independent timestamp
    // (e.g. `Mon Apr 21 09:00:00 2026`). Without this, a bind-mounted PID
    // file written under one locale and read under another would hash to
    // different tokens and the new worker would incorrectly treat itself
    // as a stale prior incarnation — reintroducing the bug this helper
    // exists to prevent. Flagged by Greptile on PR #2082.
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    });
    if (result.status !== 0) return null;
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'captureProcessStartToken: ps exec failed', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Verify that the process named by `info` is the same worker incarnation
 * that wrote the PID file. Returns true only when:
 *   - the PID is currently alive, AND
 *   - either the stored start token matches the current token for that PID,
 *     OR no token is stored (PID file written by an older version — fall
 *     back to liveness-only for backwards compatibility).
 *
 * Returns false for null input, dead PIDs, and token mismatches. A token
 * mismatch means the PID has been reused by an unrelated process — the PID
 * file is stale even though kill(0) succeeds.
 */
export function verifyPidFileOwnership(info: PidInfo | null): info is PidInfo {
  if (!info) return false;
  if (!isPidAlive(info.pid)) return false;

  if (!info.startToken) return true;

  const currentToken = captureProcessStartToken(info.pid);
  if (currentToken === null) return true;

  const match = currentToken === info.startToken;
  if (!match) {
    // Emit a debug signal when liveness passes but identity fails — the
    // exact container-restart scenario this helper exists to catch. Without
    // this log the callers just say "stale" and can't distinguish
    // "process dead" from "PID reused by a different process".
    logger.debug('SYSTEM', 'verifyPidFileOwnership: start-token mismatch (PID reused)', {
      pid: info.pid,
      stored: info.startToken,
      current: currentToken
    });
  }
  return match;
}

export class ProcessRegistry {
  private readonly registryPath: string;
  private readonly entries = new Map<string, ManagedProcessInfo>();
  private readonly runtimeProcesses = new Map<string, ChildProcess>();
  private initialized = false;

  constructor(registryPath: string = DEFAULT_REGISTRY_PATH) {
    this.registryPath = registryPath;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    mkdirSync(path.dirname(this.registryPath), { recursive: true });

    if (!existsSync(this.registryPath)) {
      this.persist();
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as PersistedRegistry;
      const processes = raw.processes ?? {};
      for (const [id, info] of Object.entries(processes)) {
        this.entries.set(id, info);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.warn('SYSTEM', 'Failed to parse supervisor registry, rebuilding', {
          path: this.registryPath
        }, error);
      } else {
        logger.warn('SYSTEM', 'Failed to parse supervisor registry, rebuilding', {
          path: this.registryPath,
          error: String(error)
        });
      }
      this.entries.clear();
    }

    const removed = this.pruneDeadEntries();
    if (removed > 0) {
      logger.info('SYSTEM', 'Removed dead processes from supervisor registry', { removed });
    }
    this.persist();
  }

  register(id: string, processInfo: ManagedProcessInfo, processRef?: ChildProcess): void {
    this.initialize();
    this.entries.set(id, processInfo);
    if (processRef) {
      this.runtimeProcesses.set(id, processRef);
    }
    this.persist();
  }

  unregister(id: string): void {
    this.initialize();
    this.entries.delete(id);
    this.runtimeProcesses.delete(id);
    this.persist();
  }

  clear(): void {
    this.entries.clear();
    this.runtimeProcesses.clear();
    this.persist();
  }

  getAll(): ManagedProcessRecord[] {
    this.initialize();
    return Array.from(this.entries.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => {
        const left = Date.parse(a.startedAt);
        const right = Date.parse(b.startedAt);
        return (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right);
      });
  }

  getBySession(sessionId: string | number): ManagedProcessRecord[] {
    const normalized = String(sessionId);
    return this.getAll().filter(record => record.sessionId !== undefined && String(record.sessionId) === normalized);
  }

  getRuntimeProcess(id: string): ChildProcess | undefined {
    return this.runtimeProcesses.get(id);
  }

  getByPid(pid: number): ManagedProcessRecord[] {
    return this.getAll().filter(record => record.pid === pid);
  }

  pruneDeadEntries(): number {
    this.initialize();

    let removed = 0;
    for (const [id, info] of this.entries) {
      if (isPidAlive(info.pid)) continue;
      this.entries.delete(id);
      this.runtimeProcesses.delete(id);
      removed += 1;
    }

    if (removed > 0) {
      this.persist();
    }

    return removed;
  }

  /**
   * Kill and unregister all processes tagged with the given sessionId.
   * Sends SIGTERM first, waits up to 5s, then SIGKILL for survivors.
   * Called when a session is deleted to prevent leaked child processes (#1351).
   */
  async reapSession(sessionId: string | number): Promise<number> {
    this.initialize();

    const sessionRecords = this.getBySession(sessionId);
    if (sessionRecords.length === 0) {
      return 0;
    }

    const sessionIdNum = typeof sessionId === 'number' ? sessionId : Number(sessionId) || undefined;
    logger.info('SYSTEM', `Reaping ${sessionRecords.length} process(es) for session ${sessionId}`, {
      sessionId: sessionIdNum,
      pids: sessionRecords.map(r => r.pid)
    });

    // Phase 1: SIGTERM all alive processes — use process-group teardown for
    // records that carry pgid so any descendants the SDK spawned are killed
    // too (Principle 5).
    const aliveRecords = sessionRecords.filter(r => isPidAlive(r.pid));
    for (const record of aliveRecords) {
      try {
        if (typeof record.pgid === 'number' && process.platform !== 'win32') {
          process.kill(-record.pgid, 'SIGTERM');
        } else {
          process.kill(record.pid, 'SIGTERM');
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            logger.debug('SYSTEM', `Failed to SIGTERM session process PID ${record.pid}`, {
              pid: record.pid,
              pgid: record.pgid
            }, error);
          }
        } else {
          logger.warn('SYSTEM', `Failed to SIGTERM session process PID ${record.pid} (non-Error)`, {
            pid: record.pid,
            pgid: record.pgid,
            error: String(error)
          });
        }
      }
    }

    // Phase 2: Wait for processes to exit
    const deadline = Date.now() + REAP_SESSION_SIGTERM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const survivors = aliveRecords.filter(r => isPidAlive(r.pid));
      if (survivors.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Phase 3: SIGKILL any survivors — process-group teardown when pgid is
    // recorded so descendants are killed too.
    const survivors = aliveRecords.filter(r => isPidAlive(r.pid));
    for (const record of survivors) {
      logger.warn('SYSTEM', `Session process PID ${record.pid} did not exit after SIGTERM, sending SIGKILL`, {
        pid: record.pid,
        pgid: record.pgid,
        sessionId: sessionIdNum
      });
      try {
        if (typeof record.pgid === 'number' && process.platform !== 'win32') {
          process.kill(-record.pgid, 'SIGKILL');
        } else {
          process.kill(record.pid, 'SIGKILL');
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            logger.debug('SYSTEM', `Failed to SIGKILL session process PID ${record.pid}`, {
              pid: record.pid,
              pgid: record.pgid
            }, error);
          }
        } else {
          logger.warn('SYSTEM', `Failed to SIGKILL session process PID ${record.pid} (non-Error)`, {
            pid: record.pid,
            pgid: record.pgid,
            error: String(error)
          });
        }
      }
    }

    // Brief wait for SIGKILL to take effect
    if (survivors.length > 0) {
      const sigkillDeadline = Date.now() + REAP_SESSION_SIGKILL_TIMEOUT_MS;
      while (Date.now() < sigkillDeadline) {
        const remaining = survivors.filter(r => isPidAlive(r.pid));
        if (remaining.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Phase 4: Unregister all session records
    for (const record of sessionRecords) {
      this.entries.delete(record.id);
      this.runtimeProcesses.delete(record.id);
    }
    this.persist();

    logger.info('SYSTEM', `Reaped ${sessionRecords.length} process(es) for session ${sessionId}`, {
      sessionId: sessionIdNum,
      reaped: sessionRecords.length
    });

    return sessionRecords.length;
  }

  private persist(): void {
    const payload: PersistedRegistry = {
      processes: Object.fromEntries(this.entries.entries())
    };

    mkdirSync(path.dirname(this.registryPath), { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(payload, null, 2));
  }
}

let registrySingleton: ProcessRegistry | null = null;

export function getProcessRegistry(): ProcessRegistry {
  if (!registrySingleton) {
    registrySingleton = new ProcessRegistry();
  }
  return registrySingleton;
}

export function createProcessRegistry(registryPath: string): ProcessRegistry {
  return new ProcessRegistry(registryPath);
}

// ---------------------------------------------------------------------------
// SDK session lookup + exit verification
// ---------------------------------------------------------------------------

export interface TrackedSdkProcess {
  pid: number;
  pgid: number | undefined;
  sessionDbId: number;
  process: ChildProcess;
}

/**
 * Look up the live SDK subprocess for a given session, if any.
 *
 * Returns undefined when no SDK record is registered for the session, or
 * when the ChildProcess reference has been dropped (process exited and was
 * unregistered). Warns on duplicates — multiple SDK records per session
 * indicate a race in createSdkSpawnFactory's pre-spawn cleanup.
 */
export function getSdkProcessForSession(sessionDbId: number): TrackedSdkProcess | undefined {
  const registry = getProcessRegistry();
  const matches = registry.getBySession(sessionDbId).filter(r => r.type === 'sdk');

  if (matches.length > 1) {
    logger.warn('PROCESS', `Multiple SDK processes found for session ${sessionDbId}`, {
      count: matches.length,
      pids: matches.map(m => m.pid),
    });
  }

  const record = matches[0];
  if (!record) return undefined;

  const processRef = registry.getRuntimeProcess(record.id);
  if (!processRef) return undefined;

  return {
    pid: record.pid,
    pgid: record.pgid,
    sessionDbId,
    process: processRef,
  };
}

/**
 * Wait for an SDK subprocess to exit, escalating to SIGKILL on the process
 * group if it overstays `timeoutMs`. Fully event-driven — no polling.
 *
 * This is primary-path cleanup invoked from session-level finally() blocks
 * when a session ends; it is NOT a reaper. It runs at most once per session
 * deletion. Process-group teardown (`kill(-pgid, SIGKILL)`) ensures any
 * descendants the SDK spawned are also killed.
 */
export async function ensureSdkProcessExit(
  tracked: TrackedSdkProcess,
  timeoutMs: number = 5000
): Promise<void> {
  const { pid, pgid, process: proc } = tracked;

  // Already exited? Trust exitCode, not proc.killed — proc.killed only means
  // Node sent a signal; the process may still be running.
  if (proc.exitCode !== null) return;

  const exitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  if (proc.exitCode !== null) return;

  // Timeout: escalate to SIGKILL on the whole process group so any
  // descendants the SDK spawned are killed too (Principle 5).
  logger.warn('PROCESS', `PID ${pid} did not exit after ${timeoutMs}ms, sending SIGKILL to process group`, {
    pid, pgid, timeoutMs,
  });
  try {
    if (typeof pgid === 'number' && process.platform !== 'win32') {
      process.kill(-pgid, 'SIGKILL');
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    // Already dead — fine.
  }

  // Wait up to 1s for SIGKILL to take effect (event-driven, not blind sleep).
  const sigkillExit = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });
  const sigkillTimeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
  });
  await Promise.race([sigkillExit, sigkillTimeout]);
}

// ---------------------------------------------------------------------------
// Pool slot waiters — backpressure without eviction
// ---------------------------------------------------------------------------
//
// waitForSlot is used by SDKAgent to avoid starting more concurrent SDK
// subprocesses than configured. It is event-driven: when a process exits and
// is unregistered, notifySlotAvailable() wakes exactly one waiter. There is
// no polling. There is no idle-session eviction (Principle 1 — do not kick
// live sessions to make room; a full pool must apply backpressure upstream).

const TOTAL_PROCESS_HARD_CAP = 10;
const slotWaiters: Array<() => void> = [];

function getActiveSdkCount(): number {
  return getProcessRegistry().getAll().filter(record => record.type === 'sdk').length;
}

function notifySlotAvailable(): void {
  const waiter = slotWaiters.shift();
  if (waiter) waiter();
}

/**
 * Wait until a pool slot is available to spawn another SDK subprocess.
 *
 * Resolves immediately when active SDK process count is below `maxConcurrent`.
 * Otherwise enqueues a waiter that is woken by a subsequent exit handler.
 * Rejects with a timeout error if no slot opens within `timeoutMs`.
 * Rejects immediately if the registry is already at the hard cap.
 */
export async function waitForSlot(maxConcurrent: number, timeoutMs: number = 60_000): Promise<void> {
  const activeCount = getActiveSdkCount();
  if (activeCount >= TOTAL_PROCESS_HARD_CAP) {
    throw new Error(`Hard cap exceeded: ${activeCount} processes in registry (cap=${TOTAL_PROCESS_HARD_CAP}). Refusing to spawn more.`);
  }

  if (activeCount < maxConcurrent) return;

  logger.info('PROCESS', `Pool limit reached (${activeCount}/${maxConcurrent}), waiting for slot...`);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = slotWaiters.indexOf(onSlot);
      if (idx >= 0) slotWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for agent pool slot after ${timeoutMs}ms`));
    }, timeoutMs);

    const onSlot = () => {
      clearTimeout(timeout);
      if (getActiveSdkCount() < maxConcurrent) {
        resolve();
      } else {
        slotWaiters.push(onSlot);
      }
    };

    slotWaiters.push(onSlot);
  });
}

// ---------------------------------------------------------------------------
// SDK subprocess spawn
// ---------------------------------------------------------------------------

export interface SpawnedSdkProcess {
  stdin: NonNullable<ChildProcess['stdin']>;
  stdout: NonNullable<ChildProcess['stdout']>;
  stderr: NonNullable<ChildProcess['stderr']>;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill: ChildProcess['kill'];
  on: ChildProcess['on'];
  once: ChildProcess['once'];
  off: ChildProcess['off'];
}

export interface SpawnSdkOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Spawn a Claude SDK subprocess in its own POSIX process group.
 *
 * The spawn uses `detached: true` so the child becomes the leader of a new
 * process group (setpgid). The leader's PID equals its pgid on Unix, so we
 * store `child.pid` as both pid and pgid on the managed process record.
 * Shutdown then signals the group via `process.kill(-pgid, signal)`, tearing
 * down the SDK child AND every descendant in one syscall (Principle 5).
 *
 * Windows caveat: `detached: true` does not create a POSIX group. The
 * recorded pgid is still the child PID so Windows teardown at least kills
 * the direct child; full subtree teardown on Windows requires Job Objects
 * or `taskkill /T /F` (see shutdown.ts).
 *
 * Node's child_process.spawn is used intentionally — Bun.spawn does NOT
 * support `detached: true` (see PATHFINDER-2026-04-22/_reference.md Part 2
 * row 3), and this module must work under Bun as well as Node.
 */
export function spawnSdkProcess(
  sessionDbId: number,
  options: SpawnSdkOptions
): { process: SpawnedSdkProcess; pid: number; pgid: number } | null {
  const registry = getProcessRegistry();

  // On Windows, use cmd.exe wrapper for .cmd files to properly handle paths with spaces.
  const useCmdWrapper = process.platform === 'win32' && options.command.endsWith('.cmd');
  const env = sanitizeEnv(options.env ?? process.env);

  // Filter empty string args AND their preceding flag (Issue #2049).
  // The Agent SDK emits ["--setting-sources", ""] when settingSources defaults to [].
  // Simply dropping "" leaves an orphan --setting-sources that consumes the next
  // flag as its value, crashing Claude Code 2.1.109+ with
  // "Invalid setting source: --permission-mode". Drop the flag too so the SDK
  // default (no setting sources) is preserved by omission.
  const filteredArgs: string[] = [];
  for (const arg of options.args) {
    if (arg === '') {
      if (filteredArgs.length > 0 && filteredArgs[filteredArgs.length - 1].startsWith('--')) {
        filteredArgs.pop();
      }
      continue;
    }
    filteredArgs.push(arg);
  }

  // Unix: detached:true causes the kernel to setpgid() on the child so the
  // child becomes leader of a new process group whose pgid equals its pid.
  // Windows: detached:true would let claude.exe outlive the worker AND
  // documents windowsHide as "undefined behavior" when combined — visible
  // GUI windows pop per assistant turn (#2190, #2198). On Windows we want
  // claude.exe to die with the parent and stay hidden, so detached:false.
  //
  // stdin must be 'pipe' (not 'ignore') because SpawnedSdkProcess.stdin is
  // typed NonNullable<...> and the Claude Agent SDK consumes that pipe to
  // stream prompts in. With 'ignore', child.stdin would be null and the
  // null-check below (line ~737) would tear the child down immediately.
  const isWin = process.platform === 'win32';
  const child = useCmdWrapper
    ? spawn('cmd.exe', ['/d', '/c', options.command, ...filteredArgs], {
        cwd: options.cwd,
        env,
        detached: !isWin,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
        windowsHide: true,
      })
    : spawn(options.command, filteredArgs, {
        cwd: options.cwd,
        env,
        detached: !isWin,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
        windowsHide: true,
      });

  // ALWAYS attach an 'error' listener BEFORE any other code runs, regardless of
  // whether the child has a PID. child_process.spawn emits 'error' asynchronously
  // for ENOENT, EACCES, AbortSignal-driven aborts, etc. Without a listener these
  // become uncaughtException — the cause of "The operation was aborted." escaping
  // to the daemon during crash-recovery loops.
  child.on('error', (err: Error) => {
    logger.warn('SDK_SPAWN', `[session-${sessionDbId}] child emitted error event`, {
      sessionDbId,
      pid: child.pid,
      errorName: err.name,
      errorCode: (err as NodeJS.ErrnoException).code,
    }, err);
  });

  if (!child.pid) {
    logger.error('PROCESS', 'Spawn succeeded but produced no PID', { sessionDbId });
    return null;
  }

  const pid = child.pid;
  const pgid = pid; // On Unix with detached:true, pgid === pid. On Windows, this is an alias.

  // Capture stderr for debugging spawn failures.
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      logger.debug('SDK_SPAWN', `[session-${sessionDbId}] stderr: ${data.toString().trim()}`);
    });
  }

  // Register the process in the supervisor registry with pgid recorded so
  // the shutdown cascade can signal the whole group.
  const recordId = `sdk:${sessionDbId}:${pid}`;
  registry.register(recordId, {
    pid,
    type: 'sdk',
    sessionId: sessionDbId,
    startedAt: new Date().toISOString(),
    pgid,
  }, child);

  // Auto-unregister on exit. child.on('exit') is the authoritative event-driven
  // signal that a process has left — no polling, no sweeper needed (Principle 4).
  child.on('exit', (code: number | null, signal: string | null) => {
    if (code !== 0) {
      logger.warn('SDK_SPAWN', `[session-${sessionDbId}] Claude process exited`, { code, signal, pid });
    }
    registry.unregister(recordId);
    // Wake one pool-slot waiter since a slot just freed up.
    notifySlotAvailable();
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    logger.error('PROCESS', 'Spawned SDK child missing required stdio streams', {
      sessionDbId,
      pid,
      hasStdin: Boolean(child.stdin),
      hasStdout: Boolean(child.stdout),
      hasStderr: Boolean(child.stderr),
    });
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    return null;
  }

  const spawned: SpawnedSdkProcess = {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };

  return { process: spawned, pid, pgid };
}

/**
 * SDK-compatible spawn factory.
 *
 * The Claude Agent SDK's `spawnClaudeCodeProcess` option calls our factory
 * with its own spawn arguments; we forward them into `spawnSdkProcess` which
 * creates the child in its own process group and records it in the supervisor
 * registry. The returned shape is the minimal subset of ChildProcess that the
 * SDK consumes — stdin/stdout/stderr pipes, killed/exitCode getters, and
 * kill/on/once/off.
 *
 * Pre-spawn cleanup: if a previous process for this session is still alive
 * (e.g. a crash-recovery attempt that collided with a still-running SDK),
 * SIGTERM it. Multiple processes sharing the same --resume UUID waste API
 * credits and can conflict with each other (Issue #1590).
 */
export function createSdkSpawnFactory(sessionDbId: number) {
  return (spawnOptions: SpawnSdkOptions): SpawnedSdkProcess => {
    const registry = getProcessRegistry();

    // Kill any existing process for this session before spawning a new one.
    const existing = registry.getBySession(sessionDbId).filter(r => r.type === 'sdk');
    for (const record of existing) {
      if (!isPidAlive(record.pid)) continue;
      try {
        if (typeof record.pgid === 'number') {
          // Signal the whole group — kill the SDK child and any descendants.
          if (process.platform !== 'win32') {
            process.kill(-record.pgid, 'SIGTERM');
          } else {
            process.kill(record.pid, 'SIGTERM');
          }
        } else {
          process.kill(record.pid, 'SIGTERM');
        }
        logger.warn('PROCESS', `Killing duplicate SDK process PID ${record.pid} before spawning new one for session ${sessionDbId}`, {
          existingPid: record.pid,
          sessionDbId,
        });
      } catch (error: unknown) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'ESRCH') {
          if (error instanceof Error) {
            logger.warn('PROCESS', `Failed to SIGTERM duplicate SDK process PID ${record.pid}`, { sessionDbId }, error);
          } else {
            logger.warn('PROCESS', `Failed to SIGTERM duplicate SDK process PID ${record.pid} (non-Error)`, {
              sessionDbId, error: String(error),
            });
          }
        }
      }
    }

    const result = spawnSdkProcess(sessionDbId, spawnOptions);
    if (!result) {
      // Match the legacy failure mode: the SDK needs a process-like object
      // even on spawn failure; throwing here surfaces via exit code 2 to the
      // hook layer (Principle 2 — fail-fast).
      throw new Error(`Failed to spawn SDK subprocess for session ${sessionDbId}`);
    }

    return result.process;
  };
}

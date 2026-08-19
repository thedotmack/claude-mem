import { ChildProcess, spawnSync } from 'child_process';
import { spawnHidden } from '../shared/spawn.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { sanitizeEnv } from './env-sanitizer.js';
import { paths } from '../shared/paths.js';
// Moved to shared/ so kill-process-tree.ts can use it without closing an
// import cycle (process-registry already imports kill-process-tree). Re-exported
// here so every existing caller keeps its import path.
import { captureProcessStartToken, isSameProcess } from '../shared/process-identity.js';
export { captureProcessStartToken, isSameProcess };
import { killProcessTree } from '../shared/kill-process-tree.js';

const REAP_SESSION_SIGTERM_TIMEOUT_MS = 5_000;
const REAP_SESSION_SIGKILL_TIMEOUT_MS = 1_000;

const DEFAULT_REGISTRY_PATH = paths.supervisorRegistry();

export interface ManagedProcessInfo {
  pid: number;
  type: string;
  sessionId?: string | number;
  startedAt: string;
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

// Poll until every record's pid is gone or the timeout elapses. Shared by the
// reapSession wait phase and shutdown.ts's SIGTERM grace period.
export async function waitForExit(records: ManagedProcessRecord[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (records.every(record => !isPidAlive(record.pid))) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
  startToken?: string;
}

export function verifyPidFileOwnership(info: PidInfo | null): info is PidInfo {
  if (!info) return false;
  if (!isPidAlive(info.pid)) return false;

  if (!info.startToken) return true;

  const currentToken = captureProcessStartToken(info.pid);
  if (currentToken === null) return true;

  const match = currentToken === info.startToken;
  if (!match) {
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
    const existing = this.entries.get(id);
    this.entries.delete(id);
    this.runtimeProcesses.delete(id);
    this.persist();
    if (existing?.type === 'sdk') notifySlotAvailable();
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

  pruneDeadEntries(): number {
    this.initialize();

    let removed = 0;
    let removedSdk = 0;
    for (const [id, info] of this.entries) {
      if (isPidAlive(info.pid)) continue;
      this.entries.delete(id);
      this.runtimeProcesses.delete(id);
      removed += 1;
      if (info.type === 'sdk') removedSdk += 1;
    }

    if (removed > 0) {
      this.persist();
    }
    for (let i = 0; i < removedSdk; i += 1) notifySlotAvailable();

    return removed;
  }

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

    const aliveRecords = sessionRecords.filter(r => isPidAlive(r.pid));
    // Identities captured up front. The SIGKILL phase below runs after a 5s
    // waitForExit, and a record whose process exits during that window can
    // have its PID reissued — force-killing it would hit a stranger, and the
    // tree-kill form would take that stranger's children too.
    const startTokens = new Map<number, string | null>(
      aliveRecords.map(r => [r.pid, captureProcessStartToken(r.pid)])
    );
    for (const record of aliveRecords) {
      try {
        if (process.platform === 'win32') {
          // Windows has no process groups, and process.kill() force-terminates
          // exactly one PID — a `.cmd` shim dies while the real child it wraps
          // survives. taskkill /T is the only teardown that reaches descendants.
          await killProcessTree(record.pid);
        } else if (typeof record.pgid === 'number') {
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

    await waitForExit(aliveRecords, REAP_SESSION_SIGTERM_TIMEOUT_MS);

    const survivors = aliveRecords.filter(r => isPidAlive(r.pid));
    for (const record of survivors) {
      logger.warn('SYSTEM', `Session process PID ${record.pid} did not exit after SIGTERM, sending SIGKILL`, {
        pid: record.pid,
        pgid: record.pgid,
        sessionId: sessionIdNum
      });
      const expectedStartToken = startTokens.get(record.pid) ?? null;
      if (!isSameProcess(record.pid, expectedStartToken)) {
        logger.warn('SYSTEM', 'Skipping SIGKILL: session process PID was reused during the grace window', {
          pid: record.pid,
          sessionId: sessionIdNum,
        });
        continue;
      }

      try {
        if (process.platform === 'win32') {
          await killProcessTree(record.pid, { expectedStartToken });
        } else if (typeof record.pgid === 'number') {
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

    if (survivors.length > 0) {
      const sigkillDeadline = Date.now() + REAP_SESSION_SIGKILL_TIMEOUT_MS;
      while (Date.now() < sigkillDeadline) {
        const remaining = survivors.filter(r => isPidAlive(r.pid));
        if (remaining.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    for (const record of sessionRecords) {
      this.entries.delete(record.id);
      this.runtimeProcesses.delete(record.id);
    }
    this.persist();
    for (const record of sessionRecords) {
      if (record.type === 'sdk') notifySlotAvailable();
    }

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

export interface TrackedSdkProcess {
  pid: number;
  pgid: number | undefined;
  sessionDbId: number;
  process: ChildProcess;
}

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

export async function ensureSdkProcessExit(
  tracked: TrackedSdkProcess,
  timeoutMs: number = 5000
): Promise<void> {
  const { pid, pgid, process: proc } = tracked;

  if (proc.exitCode !== null) return;

  // Captured BEFORE the exit race below. That race waits up to timeoutMs, and
  // a PID that exits inside it can be reissued before the force-kill runs.
  const expectedStartToken = captureProcessStartToken(pid);

  const exitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  if (proc.exitCode !== null) return;

  logger.warn('PROCESS', `PID ${pid} did not exit after ${timeoutMs}ms, sending SIGKILL to process group`, {
    pid, pgid, timeoutMs,
  });
  if (!isSameProcess(pid, expectedStartToken)) {
    logger.warn('PROCESS', 'Skipping force-kill: SDK process PID was reused while awaiting exit', {
      pid,
      pgid,
    });
    return;
  }

  try {
    if (process.platform === 'win32') {
      // proc.kill() only reaches the direct child — on Windows that is often a
      // `.cmd`/`.exe` shim whose real payload keeps running (and keeps the
      // inherited socket open). Tree-kill the whole chain instead.
      await killProcessTree(pid, { expectedStartToken });
    } else if (typeof pgid === 'number') {
      process.kill(-pgid, 'SIGKILL');
    } else {
      proc.kill('SIGKILL');
    }
  } catch (error: unknown) {
    // A bare swallow here used to be accurate — process.kill()/proc.kill()
    // only ever raised ESRCH ("already dead — fine"). killProcessTree() also
    // raises ProcessTreeKillError for a genuine failure (Windows taskkill
    // access-denied), and silently discarding that would hide a live SDK tree
    // behind a clean-looking teardown. ESRCH stays tolerated; anything else is
    // surfaced.
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno !== 'ESRCH') {
      logger.warn('PROCESS', `Force-kill of SDK process PID ${pid} failed`, {
        pid,
        pgid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sigkillExit = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });
  const sigkillTimeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
  });
  await Promise.race([sigkillExit, sigkillTimeout]);
}

const TOTAL_PROCESS_HARD_CAP = 10;
const SLOT_RECHECK_INTERVAL_MS = 5_000;
const slotWaiters: Array<() => void> = [];

/**
 * Slots granted by waitForSlot() that are not yet visible as registry
 * records. Registration only happens after spawn() returns a PID, and the
 * caller has a wide await gap (OAuth refresh) between the grant and the
 * spawn. Without a reservation, every concurrent caller observes the same
 * stale count and all of them spawn (#3287: 9 agents against a max of 2).
 */
let reservedSlots = 0;

export interface SlotReservation {
  /** Frees the reserved slot. Idempotent: calls after the first are no-ops. */
  release(): void;
}

function takeSlotReservation(): SlotReservation {
  reservedSlots += 1;
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      reservedSlots -= 1;
      notifySlotAvailable();
    },
  };
}

function getActiveSdkCount(): number {
  return getProcessRegistry().getAll().filter(record => record.type === 'sdk').length + reservedSlots;
}

function notifySlotAvailable(): void {
  const waiter = slotWaiters.shift();
  if (waiter) waiter();
}

/**
 * Waits until an SDK agent slot is free, then reserves it. The count check
 * and the reservation happen in the same synchronous block, so no concurrent
 * caller can be granted the same slot. The caller must release the returned
 * reservation once the spawned process is registered (the registry record
 * takes over the accounting) or when the spawn fails or never happens:
 * a leaked reservation would occupy the slot until the worker restarts.
 */
export async function waitForSlot(maxConcurrent: number, signal?: AbortSignal): Promise<SlotReservation> {
  getProcessRegistry().pruneDeadEntries();
  const activeCount = getActiveSdkCount();
  if (activeCount >= TOTAL_PROCESS_HARD_CAP) {
    throw new Error(`Hard cap exceeded: ${activeCount} processes in registry (cap=${TOTAL_PROCESS_HARD_CAP}). Refusing to spawn more.`);
  }

  if (activeCount < maxConcurrent) return takeSlotReservation();

  if (signal?.aborted) {
    throw new Error('waitForSlot aborted before queuing');
  }

  logger.info('PROCESS', `Pool limit reached (${activeCount}/${maxConcurrent}), waiting for slot...`);

  return new Promise<SlotReservation>((resolve, reject) => {
    let recheckTimer: ReturnType<typeof setInterval> | null = null;
    let abortHandler: (() => void) | null = null;
    const cleanup = () => {
      if (recheckTimer) clearInterval(recheckTimer);
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
      const idx = slotWaiters.indexOf(onSlot);
      if (idx >= 0) slotWaiters.splice(idx, 1);
    };
    const onSlot = () => {
      const count = getActiveSdkCount();
      if (count >= TOTAL_PROCESS_HARD_CAP) {
        cleanup();
        reject(new Error(`Hard cap exceeded: ${count} processes in registry (cap=${TOTAL_PROCESS_HARD_CAP}). Refusing to spawn more.`));
        return;
      }

      if (count < maxConcurrent) {
        cleanup();
        resolve(takeSlotReservation());
      } else {
        slotWaiters.push(onSlot);
      }
    };

    if (signal) {
      abortHandler = () => {
        cleanup();
        reject(new Error('waitForSlot aborted'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    slotWaiters.push(onSlot);
    recheckTimer = setInterval(() => {
      const removed = getProcessRegistry().pruneDeadEntries();
      if (removed > 0) {
        logger.info('PROCESS', 'Pruned stale process registry entries while waiting for agent slot', { removed });
        return;
      }
      notifySlotAvailable();
    }, SLOT_RECHECK_INTERVAL_MS);
    recheckTimer.unref?.();
  });
}

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
  extraArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export function normalizeSpawnSdkArgs(args: string[], extraArgs: string[] = []): string[] {
  const filteredArgs: string[] = [];
  for (const arg of args) {
    if (arg === '') {
      // The SDK encodes optional flag/value pairs as `--flag ''` when the
      // value is absent. Strip the whole pair, but only when the preceding
      // token is a long option so positional args are left untouched.
      if (filteredArgs.length > 0 && filteredArgs[filteredArgs.length - 1].startsWith('--')) {
        filteredArgs.pop();
      }
      continue;
    }
    filteredArgs.push(arg);
  }

  for (const extraArg of extraArgs) {
    if (extraArg !== '') {
      filteredArgs.push(extraArg);
    }
  }

  return filteredArgs;
}

export function spawnSdkProcess(
  sessionDbId: number,
  options: SpawnSdkOptions
): { process: SpawnedSdkProcess; pid: number; pgid: number } | null {
  const registry = getProcessRegistry();

  const useCmdWrapper = process.platform === 'win32' && options.command.endsWith('.cmd');
  const env = sanitizeEnv(options.env ?? process.env);
  const filteredArgs = normalizeSpawnSdkArgs(options.args, options.extraArgs);

  const isWin = process.platform === 'win32';
  const child = useCmdWrapper
    ? spawnHidden('cmd.exe', ['/d', '/c', options.command, ...filteredArgs], {
        cwd: options.cwd,
        env,
        detached: !isWin,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
        windowsHide: true,
      })
    : spawnHidden(options.command, filteredArgs, {
        cwd: options.cwd,
        env,
        detached: !isWin,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
        windowsHide: true,
      });

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
  const pgid = pid; 

  // Keep the tail of stderr so a non-zero exit can say WHY at WARN level.
  // Without this, a CLI that dies at flag parsing ("error: unknown option…")
  // logs only an opaque {code=1} and the real cause is invisible unless the
  // worker happens to run at DEBUG.
  const STDERR_TAIL_MAX_CHARS = 2048;
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
      logger.debug('SDK_SPAWN', `[session-${sessionDbId}] stderr: ${text.trim()}`);
    });
  }

  const recordId = `sdk:${sessionDbId}:${pid}`;
  registry.register(recordId, {
    pid,
    type: 'sdk',
    sessionId: sessionDbId,
    startedAt: new Date().toISOString(),
    pgid,
  }, child);

  child.on('exit', () => {
    registry.unregister(recordId);
  });

  // 'close', not 'exit': 'exit' can fire while piped stderr still holds
  // buffered data, truncating the tail. 'close' waits for all stdio to drain.
  child.on('close', (code: number | null, signal: string | null) => {
    if (code !== 0) {
      const tail = stderrTail.trim();
      logger.warn('SDK_SPAWN', `[session-${sessionDbId}] Claude process exited`, {
        code,
        signal,
        pid,
        ...(tail ? { stderrTail: tail } : {}),
      });
    }
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

function sigtermDuplicateSdkProcess(record: ManagedProcessRecord, sessionDbId: number): void {
  if (process.platform === 'win32') {
    // The SDK spawn factory is synchronous (it must return SpawnedSdkProcess
    // to its caller), so the tree-kill cannot be awaited here. That matches
    // the pre-existing contract: this function only *starts* the teardown —
    // process.kill() never waited for the duplicate to exit either. taskkill
    // /T is what makes the teardown reach the duplicate's descendants instead
    // of orphaning them.
    //
    // killProcessTree now REJECTS on a genuine kill failure, so this
    // fire-and-forget call must terminate its own promise chain — an
    // unhandled rejection here would take the worker down on a duplicate that
    // merely failed to die.
    killProcessTree(record.pid).catch((error: unknown) => {
      logger.warn('PROCESS', `Tree-kill of duplicate SDK process PID ${record.pid} failed`, {
        sessionDbId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else if (typeof record.pgid === 'number') {
    process.kill(-record.pgid, 'SIGTERM');
  } else {
    process.kill(record.pid, 'SIGTERM');
  }
  logger.warn('PROCESS', `Killing duplicate SDK process PID ${record.pid} before spawning new one for session ${sessionDbId}`, {
    existingPid: record.pid,
    sessionDbId,
  });
}

export function createSdkSpawnFactory(sessionDbId: number, slotReservation?: SlotReservation, extraArgs: string[] = []) {
  return (spawnOptions: SpawnSdkOptions): SpawnedSdkProcess => {
    const registry = getProcessRegistry();

    const existing = registry.getBySession(sessionDbId).filter(r => r.type === 'sdk');
    for (const record of existing) {
      if (!isPidAlive(record.pid)) continue;
      try {
        sigtermDuplicateSdkProcess(record, sessionDbId);
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

    let result: ReturnType<typeof spawnSdkProcess>;
    try {
      result = spawnSdkProcess(sessionDbId, {
        ...spawnOptions,
        extraArgs: [...(spawnOptions.extraArgs ?? []), ...extraArgs],
      });
    } finally {
      // The waitForSlot() reservation is consumed here: on success the
      // process is now a registry record (registered inside spawnSdkProcess)
      // and takes over the slot accounting; on failure the slot goes back to
      // the pool. Both statements above are synchronous, so no other caller
      // can observe the reservation and the record at the same time.
      slotReservation?.release();
    }
    if (!result) {
      throw new Error(`Failed to spawn SDK subprocess for session ${sessionDbId}`);
    }

    return result.process;
  };
}

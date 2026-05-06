import { ChildProcess, spawnSync } from 'child_process';
import { spawnHidden } from '../shared/spawn.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { sanitizeEnv } from './env-sanitizer.js';
import { paths } from '../shared/paths.js';

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

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
  startToken?: string;
}

export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const tailStart = raw.lastIndexOf(') ');
      if (tailStart < 0) return null;
      const fields = raw.slice(tailStart + 2).split(' ');
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

  getByPid(pid: number): ManagedProcessRecord[] {
    return this.getAll().filter(record => record.pid === pid);
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

    const deadline = Date.now() + REAP_SESSION_SIGTERM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const survivors = aliveRecords.filter(r => isPidAlive(r.pid));
      if (survivors.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

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
  try {
    if (typeof pgid === 'number' && process.platform !== 'win32') {
      process.kill(-pgid, 'SIGKILL');
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    // Already dead — fine.
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

function getActiveSdkCount(): number {
  return getProcessRegistry().getAll().filter(record => record.type === 'sdk').length;
}

function notifySlotAvailable(): void {
  const waiter = slotWaiters.shift();
  if (waiter) waiter();
}

export async function waitForSlot(maxConcurrent: number, signal?: AbortSignal): Promise<void> {
  getProcessRegistry().pruneDeadEntries();
  const activeCount = getActiveSdkCount();
  if (activeCount >= TOTAL_PROCESS_HARD_CAP) {
    throw new Error(`Hard cap exceeded: ${activeCount} processes in registry (cap=${TOTAL_PROCESS_HARD_CAP}). Refusing to spawn more.`);
  }

  if (activeCount < maxConcurrent) return;

  if (signal?.aborted) {
    throw new Error('waitForSlot aborted before queuing');
  }

  logger.info('PROCESS', `Pool limit reached (${activeCount}/${maxConcurrent}), waiting for slot...`);

  return new Promise<void>((resolve, reject) => {
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
        resolve();
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
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export function spawnSdkProcess(
  sessionDbId: number,
  options: SpawnSdkOptions
): { process: SpawnedSdkProcess; pid: number; pgid: number } | null {
  const registry = getProcessRegistry();

  const useCmdWrapper = process.platform === 'win32' && options.command.endsWith('.cmd');
  const env = sanitizeEnv(options.env ?? process.env);

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

  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      logger.debug('SDK_SPAWN', `[session-${sessionDbId}] stderr: ${data.toString().trim()}`);
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

  child.on('exit', (code: number | null, signal: string | null) => {
    if (code !== 0) {
      logger.warn('SDK_SPAWN', `[session-${sessionDbId}] Claude process exited`, { code, signal, pid });
    }
    registry.unregister(recordId);
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

export function createSdkSpawnFactory(sessionDbId: number) {
  return (spawnOptions: SpawnSdkOptions): SpawnedSdkProcess => {
    const registry = getProcessRegistry();

    const existing = registry.getBySession(sessionDbId).filter(r => r.type === 'sdk');
    for (const record of existing) {
      if (!isPidAlive(record.pid)) continue;
      try {
        if (typeof record.pgid === 'number') {
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
      throw new Error(`Failed to spawn SDK subprocess for session ${sessionDbId}`);
    }

    return result.process;
  };
}

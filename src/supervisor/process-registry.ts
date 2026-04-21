import { ChildProcess, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';

const REAP_SESSION_SIGTERM_TIMEOUT_MS = 5_000;
const REAP_SESSION_SIGKILL_TIMEOUT_MS = 1_000;

const DATA_DIR = path.join(homedir(), '.claude-mem');
const DEFAULT_REGISTRY_PATH = path.join(DATA_DIR, 'supervisor.json');

export interface ManagedProcessInfo {
  pid: number;
  type: string;
  sessionId?: string | number;
  startedAt: string;
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

    // Phase 1: SIGTERM all alive processes
    const aliveRecords = sessionRecords.filter(r => isPidAlive(r.pid));
    for (const record of aliveRecords) {
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch (error: unknown) {
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            logger.debug('SYSTEM', `Failed to SIGTERM session process PID ${record.pid}`, {
              pid: record.pid
            }, error);
          }
        } else {
          logger.warn('SYSTEM', `Failed to SIGTERM session process PID ${record.pid} (non-Error)`, {
            pid: record.pid,
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

    // Phase 3: SIGKILL any survivors
    const survivors = aliveRecords.filter(r => isPidAlive(r.pid));
    for (const record of survivors) {
      logger.warn('SYSTEM', `Session process PID ${record.pid} did not exit after SIGTERM, sending SIGKILL`, {
        pid: record.pid,
        sessionId: sessionIdNum
      });
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch (error: unknown) {
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            logger.debug('SYSTEM', `Failed to SIGKILL session process PID ${record.pid}`, {
              pid: record.pid
            }, error);
          }
        } else {
          logger.warn('SYSTEM', `Failed to SIGKILL session process PID ${record.pid} (non-Error)`, {
            pid: record.pid,
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

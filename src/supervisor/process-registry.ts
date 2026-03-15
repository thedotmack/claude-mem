import { ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const DEFAULT_REGISTRY_PATH = path.join(DATA_DIR, 'supervisor.json');

export interface ManagedProcessInfo {
  pid: number;
  type: string;
  sessionId?: string | number;
  startedAt: string;
  socketPath?: string;
}

export interface ManagedProcessRecord extends ManagedProcessInfo {
  id: string;
}

interface PersistedRegistry {
  processes: Record<string, ManagedProcessInfo>;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 0) return false;
  if (pid === 0) return true;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
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
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to parse supervisor registry, rebuilding', {
        path: this.registryPath
      }, error as Error);
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

import { execFile } from 'child_process';
import { existsSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { isPidAlive, type ManagedProcessRecord, type ProcessRegistry } from './process-registry.js';

const execFileAsync = promisify(execFile);
const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

type TreeKillFn = (pid: number, signal?: string, callback?: (error?: Error | null) => void) => void;

export interface ShutdownCascadeOptions {
  registry: ProcessRegistry;
  currentPid?: number;
  dataDir?: string;
  pidFilePath?: string;
}

export function cleanupSocketFiles(
  socketPaths: Array<string | undefined> = [],
  dataDir: string = DATA_DIR
): void {
  const knownSockets = new Set<string>();

  for (const socketPath of socketPaths) {
    if (socketPath) {
      knownSockets.add(socketPath);
    }
  }

  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir)) {
      if (entry.endsWith('.sock')) {
        knownSockets.add(path.join(dataDir, entry));
      }
    }
  }

  for (const socketPath of knownSockets) {
    try {
      rmSync(socketPath, { force: true });
    } catch (error) {
      logger.debug('SYSTEM', 'Failed to remove stale socket file', { socketPath }, error as Error);
    }
  }
}

export async function runShutdownCascade(options: ShutdownCascadeOptions): Promise<void> {
  const currentPid = options.currentPid ?? process.pid;
  const dataDir = options.dataDir ?? DATA_DIR;
  const pidFilePath = options.pidFilePath ?? PID_FILE;
  const allRecords = options.registry.getAll();
  const childRecords = [...allRecords]
    .filter(record => record.pid !== currentPid)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  for (const record of childRecords) {
    if (!isPidAlive(record.pid)) {
      options.registry.unregister(record.id);
      continue;
    }

    try {
      await signalProcess(record.pid, 'SIGTERM');
    } catch (error) {
      logger.debug('SYSTEM', 'Failed to send SIGTERM to child process', {
        pid: record.pid,
        type: record.type
      }, error as Error);
    }
  }

  await waitForExit(childRecords, 5000);

  const survivors = childRecords.filter(record => isPidAlive(record.pid));
  for (const record of survivors) {
    try {
      await signalProcess(record.pid, 'SIGKILL');
    } catch (error) {
      logger.debug('SYSTEM', 'Failed to force kill child process', {
        pid: record.pid,
        type: record.type
      }, error as Error);
    }
  }

  await waitForExit(survivors, 1000);

  for (const record of childRecords) {
    options.registry.unregister(record.id);
  }
  for (const record of allRecords.filter(record => record.pid === currentPid)) {
    options.registry.unregister(record.id);
  }

  cleanupSocketFiles(allRecords.map(record => record.socketPath), dataDir);

  try {
    rmSync(pidFilePath, { force: true });
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to remove PID file during shutdown', { pidFilePath }, error as Error);
  }

  options.registry.pruneDeadEntries();
}

async function waitForExit(records: ManagedProcessRecord[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const survivors = records.filter(record => isPidAlive(record.pid));
    if (survivors.length === 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (signal === 'SIGTERM') {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ESRCH') {
        return;
      }
      throw error;
    }
    return;
  }

  if (process.platform === 'win32') {
    const treeKill = await loadTreeKill();
    if (treeKill) {
      await new Promise<void>((resolve, reject) => {
        treeKill(pid, signal, (error) => {
          if (!error) {
            resolve();
            return;
          }

          const errno = (error as NodeJS.ErrnoException).code;
          if (errno === 'ESRCH') {
            resolve();
            return;
          }
          reject(error);
        });
      });
      return;
    }

    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') {
      args.push('/F');
    }

    await execFileAsync('taskkill', args, {
      timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
      windowsHide: true
    });
    return;
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') {
      return;
    }
    throw error;
  }
}

async function loadTreeKill(): Promise<TreeKillFn | null> {
  const moduleName = 'tree-kill';

  try {
    const treeKillModule = await import(moduleName);
    return (treeKillModule.default ?? treeKillModule) as TreeKillFn;
  } catch {
    return null;
  }
}

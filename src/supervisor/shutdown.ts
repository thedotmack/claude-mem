import { execFile } from 'child_process';
import { rmSync } from 'fs';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { isPidAlive, type ManagedProcessRecord, type ProcessRegistry } from './process-registry.js';
import { paths } from '../shared/paths.js';

const execFileAsync = promisify(execFile);
const PID_FILE = paths.workerPid();

type TreeKillFn = (pid: number, signal?: string, callback?: (error?: Error | null) => void) => void;

export interface ShutdownCascadeOptions {
  registry: ProcessRegistry;
  currentPid?: number;
  pidFilePath?: string;
}

export async function runShutdownCascade(options: ShutdownCascadeOptions): Promise<void> {
  const currentPid = options.currentPid ?? process.pid;
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
      await signalProcess(record, 'SIGTERM');
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Failed to send SIGTERM to child process', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type
        }, error);
      } else {
        logger.warn('SYSTEM', 'Failed to send SIGTERM to child process (non-Error)', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type,
          error: String(error)
        });
      }
    }
  }

  await waitForExit(childRecords, 5000);

  const survivors = childRecords.filter(record => isPidAlive(record.pid));
  for (const record of survivors) {
    try {
      await signalProcess(record, 'SIGKILL');
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Failed to force kill child process', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type
        }, error);
      } else {
        logger.warn('SYSTEM', 'Failed to force kill child process (non-Error)', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type,
          error: String(error)
        });
      }
    }
  }

  await waitForExit(survivors, 1000);

  for (const record of childRecords) {
    options.registry.unregister(record.id);
  }
  for (const record of allRecords.filter(record => record.pid === currentPid)) {
    options.registry.unregister(record.id);
  }

  try {
    rmSync(pidFilePath, { force: true });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Failed to remove PID file during shutdown', { pidFilePath }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to remove PID file during shutdown (non-Error)', {
        pidFilePath,
        error: String(error)
      });
    }
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

async function signalProcess(record: ManagedProcessRecord, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const { pid, pgid } = record;

  if (process.platform !== 'win32') {
    // Try the process group first when we have one — it reaches grandchildren
    // re-parented to init. If the group is already gone (ESRCH) the actual
    // root pid may still be alive (e.g. it survived its own group teardown);
    // fall through to the per-pid signal so shutdown isn't a no-op
    // (CodeRabbit review on PR #2282).
    if (typeof pgid === 'number') {
      try {
        process.kill(-pgid, signal);
        return;
      } catch (error: unknown) {
        const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (errno !== 'ESRCH') {
          throw error;
        }
        // ESRCH on the group — fall through and try the bare pid below.
      }
    }

    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (errno !== 'ESRCH') {
        throw error;
      }
    }
    return;
  }

  if (signal === 'SIGTERM') {
    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      if (error instanceof Error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === 'ESRCH') {
          return;
        }
      }
      throw error;
    }
    return;
  }

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
}

async function loadTreeKill(): Promise<TreeKillFn | null> {
  const moduleName = 'tree-kill';

  try {
    const treeKillModule = await import(moduleName);
    return (treeKillModule.default ?? treeKillModule) as TreeKillFn;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'tree-kill module not available, using fallback', {}, error instanceof Error ? error : undefined);
    return null;
  }
}

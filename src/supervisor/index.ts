import { existsSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';
import {
  getProcessRegistry,
  verifyPidFileOwnership,
  type ManagedProcessInfo,
  type PidInfo,
  type ProcessRegistry
} from './process-registry.js';
import { runShutdownCascade } from './shutdown.js';
import { startHealthChecker, stopHealthChecker } from './health-checker.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

interface ValidateWorkerPidOptions {
  logAlive?: boolean;
  pidFilePath?: string;
}

export type ValidateWorkerPidStatus = 'missing' | 'alive' | 'stale' | 'invalid';

class Supervisor {
  private readonly registry: ProcessRegistry;
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private signalHandlersRegistered = false;
  private shutdownInitiated = false;
  private shutdownHandler: (() => Promise<void>) | null = null;

  constructor(registry: ProcessRegistry) {
    this.registry = registry;
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.registry.initialize();
    const pidStatus = validateWorkerPidFile({ logAlive: false });
    if (pidStatus === 'alive') {
      throw new Error('Worker already running');
    }

    this.started = true;

    startHealthChecker();
  }

  configureSignalHandlers(shutdownHandler: () => Promise<void>): void {
    this.shutdownHandler = shutdownHandler;

    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;

    const handleSignal = async (signal: string): Promise<void> => {
      if (this.shutdownInitiated) {
        logger.warn('SYSTEM', `Received ${signal} but shutdown already in progress`);
        return;
      }
      this.shutdownInitiated = true;

      logger.info('SYSTEM', `Received ${signal}, shutting down...`);

      try {
        if (this.shutdownHandler) {
          await this.shutdownHandler();
        } else {
          await this.stop();
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          logger.error('SYSTEM', 'Error during shutdown', {}, error);
        } else {
          logger.error('SYSTEM', 'Error during shutdown (non-Error)', { error: String(error) });
        }
        try {
          await this.stop();
        } catch (stopError: unknown) {
          if (stopError instanceof Error) {
            logger.debug('SYSTEM', 'Supervisor shutdown fallback failed', {}, stopError);
          } else {
            logger.debug('SYSTEM', 'Supervisor shutdown fallback failed', { error: String(stopError) });
          }
        }
      }

      process.exit(0);
    };

    process.on('SIGTERM', () => void handleSignal('SIGTERM'));
    process.on('SIGINT', () => void handleSignal('SIGINT'));

    if (process.platform !== 'win32') {
      if (process.argv.includes('--daemon')) {
        process.on('SIGHUP', () => {
          logger.debug('SYSTEM', 'Ignoring SIGHUP in daemon mode');
        });
      } else {
        process.on('SIGHUP', () => void handleSignal('SIGHUP'));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    stopHealthChecker();
    this.stopPromise = runShutdownCascade({
      registry: this.registry,
      currentPid: process.pid
    }).finally(() => {
      this.started = false;
      this.stopPromise = null;
    });

    await this.stopPromise;
  }

  assertCanSpawn(type: string): void {
    if (this.stopPromise !== null) {
      throw new Error(`Supervisor is shutting down, refusing to spawn ${type}`);
    }
  }

  registerProcess(id: string, processInfo: ManagedProcessInfo, processRef?: Parameters<ProcessRegistry['register']>[2]): void {
    this.registry.register(id, processInfo, processRef);
  }

  unregisterProcess(id: string): void {
    this.registry.unregister(id);
  }

  getRegistry(): ProcessRegistry {
    return this.registry;
  }
}

const supervisorSingleton = new Supervisor(getProcessRegistry());

export async function startSupervisor(): Promise<void> {
  await supervisorSingleton.start();
}

export async function stopSupervisor(): Promise<void> {
  await supervisorSingleton.stop();
}

export function getSupervisor(): Supervisor {
  return supervisorSingleton;
}

export function configureSupervisorSignalHandlers(shutdownHandler: () => Promise<void>): void {
  supervisorSingleton.configureSignalHandlers(shutdownHandler);
}

export function validateWorkerPidFile(options: ValidateWorkerPidOptions = {}): ValidateWorkerPidStatus {
  const pidFilePath = options.pidFilePath ?? PID_FILE;

  if (!existsSync(pidFilePath)) {
    return 'missing';
  }

  let pidInfo: PidInfo | null = null;

  try {
    pidInfo = JSON.parse(readFileSync(pidFilePath, 'utf-8')) as PidInfo;
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.warn('SYSTEM', 'Failed to parse worker PID file, removing it', { path: pidFilePath }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to parse worker PID file, removing it', {
        path: pidFilePath,
        error: String(error)
      });
    }
    rmSync(pidFilePath, { force: true });
    return 'invalid';
  }

  if (verifyPidFileOwnership(pidInfo)) {
    if (options.logAlive ?? true) {
      logger.info('SYSTEM', 'Worker already running (PID alive)', {
        existingPid: pidInfo.pid,
        existingPort: pidInfo.port,
        startedAt: pidInfo.startedAt
      });
    }
    return 'alive';
  }

  logger.info('SYSTEM', 'Removing stale PID file (worker process is dead or PID has been reused)', {
    pid: pidInfo.pid,
    port: pidInfo.port,
    startedAt: pidInfo.startedAt
  });
  rmSync(pidFilePath, { force: true });
  return 'stale';
}

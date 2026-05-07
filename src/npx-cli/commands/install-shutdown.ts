import { shutdownWorkerAndWait, type ShutdownResult } from '../../services/install/shutdown-helper.js';
import {
  formatWorkerUpgradeSafetyError,
  shutdownIncompatibleWorkerIfRunning,
  WorkerUpgradeSafetyError,
  type WorkerUpgradeSafetyOptions,
  type WorkerUpgradeSafetyResult,
} from '../../services/worker-upgrade-safety.js';

export interface InstallShutdownDependencies {
  shutdownIncompatibleWorkerIfRunning: (
    port: number | string,
    timeoutMs: number,
    options: WorkerUpgradeSafetyOptions,
  ) => Promise<WorkerUpgradeSafetyResult>;
  formatWorkerUpgradeSafetyError: typeof formatWorkerUpgradeSafetyError;
  shutdownWorkerAndWait: typeof shutdownWorkerAndWait;
}

const defaultDependencies: InstallShutdownDependencies = {
  shutdownIncompatibleWorkerIfRunning,
  formatWorkerUpgradeSafetyError,
  shutdownWorkerAndWait,
};

export async function shutdownWorkerBeforeInstallOverwrite(
  port: number | string,
  expectedVersion: string,
  timeoutMs: number = 10000,
  dependencies: Partial<InstallShutdownDependencies> = {},
): Promise<ShutdownResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const safety = await deps.shutdownIncompatibleWorkerIfRunning(port, timeoutMs, { expectedVersion });
  if (safety.action === 'shutdown-failed') {
    throw new WorkerUpgradeSafetyError(deps.formatWorkerUpgradeSafetyError(port, safety));
  }

  if (safety.action === 'shutdown-confirmed') {
    return {
      workerWasRunning: true,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    };
  }

  if (safety.action === 'not-running') {
    return {
      workerWasRunning: false,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    };
  }

  if (!safety.ownershipVerified) {
    throw new WorkerUpgradeSafetyError(
      `Refusing to stop unknown service on port ${port}; claude-mem worker ownership could not be verified`,
    );
  }

  const result = await deps.shutdownWorkerAndWait(port, timeoutMs, {
    workerWasObserved: safety.workerObserved,
  });
  const normalizedResult = {
    ...result,
    workerWasRunning: result.workerWasRunning || safety.workerObserved || safety.shutdownRequested,
  };
  if (normalizedResult.workerWasRunning && !normalizedResult.shutdownConfirmed) {
    throw new WorkerUpgradeSafetyError(
      `Running claude-mem worker on port ${port} did not confirm shutdown before install overwrite`,
    );
  }
  return normalizedResult;
}

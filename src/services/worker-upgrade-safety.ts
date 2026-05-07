import {
  checkVersionMatch,
  getRunningWorkerHealth,
  waitForHealth,
  type VersionCheckResult,
  type WorkerHealthStatus,
} from './infrastructure/HealthMonitor.js';
import { shutdownWorkerAndWait } from './install/shutdown-helper.js';
import { readPidFile, verifyPidFileOwnership } from './infrastructure/ProcessManager.js';
import { logger } from '../utils/logger.js';

export type WorkerUpgradeSafetyAction =
  | 'compatible'
  | 'not-running'
  | 'shutdown-confirmed'
  | 'shutdown-failed';

export type WorkerUpgradeSafetyReason =
  | 'version-mismatch'
  | 'version-unavailable'
  | 'unknown-owner';

export interface WorkerUpgradeSafetyResult {
  action: WorkerUpgradeSafetyAction;
  reason?: WorkerUpgradeSafetyReason;
  shutdownRequested: boolean;
  shutdownConfirmed: boolean;
  before: VersionCheckResult;
  after?: VersionCheckResult;
  workerObserved: boolean;
  ownershipVerified: boolean;
}

export class WorkerUpgradeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUpgradeSafetyError';
  }
}

export interface WorkerUpgradeSafetyDependencies {
  checkVersionMatch: typeof checkVersionMatch;
  getRunningWorkerHealth: typeof getRunningWorkerHealth;
  waitForHealth: typeof waitForHealth;
  shutdownWorkerAndWait: typeof shutdownWorkerAndWait;
  readPidFile: typeof readPidFile;
  verifyPidFileOwnership: typeof verifyPidFileOwnership;
}

export interface WorkerUpgradeSafetyOptions {
  expectedVersion: string;
  assumeWorkerHealthy?: boolean;
  healthProbeTimeoutMs?: number;
  dependencies?: Partial<WorkerUpgradeSafetyDependencies>;
}

const defaultDependencies: WorkerUpgradeSafetyDependencies = {
  checkVersionMatch,
  getRunningWorkerHealth,
  waitForHealth,
  shutdownWorkerAndWait,
  readPidFile,
  verifyPidFileOwnership,
};

function resolveDependencies(options: WorkerUpgradeSafetyOptions): WorkerUpgradeSafetyDependencies {
  return { ...defaultDependencies, ...options.dependencies };
}

function hasKnownMismatch(result: VersionCheckResult): boolean {
  return (
    result.pluginVersion !== 'unknown' &&
    result.workerVersion !== null &&
    result.pluginVersion !== result.workerVersion
  );
}

function describeVersion(result: VersionCheckResult): Record<string, string | null> {
  return {
    pluginVersion: result.pluginVersion,
    workerVersion: result.workerVersion,
  };
}

function getHealthVersion(health: WorkerHealthStatus | null): string | null {
  return typeof health?.version === 'string' && health.version.length > 0 ? health.version : null;
}

function mergeHealthVersion(result: VersionCheckResult, health: WorkerHealthStatus | null): VersionCheckResult {
  if (result.workerVersion !== null) return result;

  const healthVersion = getHealthVersion(health);
  if (!healthVersion || result.pluginVersion === 'unknown') return result;

  return {
    matches: result.pluginVersion === healthVersion,
    pluginVersion: result.pluginVersion,
    workerVersion: healthVersion,
  };
}

function hasClaudeMemWorkerPath(health: WorkerHealthStatus | null): boolean {
  if (typeof health?.workerPath !== 'string' || health.workerPath.length === 0) {
    return false;
  }

  const normalizedPath = health.workerPath.replaceAll('\\', '/').toLowerCase();
  const filename = normalizedPath.split('/').pop() ?? '';
  const hasWorkerEntrypoint =
    filename === 'claude-mem' ||
    filename === 'claude-mem.exe' ||
    /^worker-service\.(cjs|js|mjs|ts)$/.test(filename);
  const tiedToClaudeMemInstall =
    normalizedPath.includes('/plugins/cache/thedotmack/claude-mem/') ||
    normalizedPath.includes('/plugins/marketplaces/thedotmack/') ||
    normalizedPath.includes('/claude-mem/src/services/') ||
    normalizedPath.includes('/claude-mem/dist/');

  return hasWorkerEntrypoint && tiedToClaudeMemInstall;
}

function hasClaudeMemHealthIdentity(health: WorkerHealthStatus | null): boolean {
  return (
    health?.status === 'ok' &&
    typeof health.version === 'string' &&
    Number.isInteger(health.pid) &&
    typeof health.managed === 'boolean' &&
    typeof health.hasIpc === 'boolean' &&
    hasClaudeMemWorkerPath(health)
  );
}

function hasValidatedPidOwnership(
  port: number,
  health: WorkerHealthStatus | null,
  dependencies: WorkerUpgradeSafetyDependencies,
): boolean {
  const pidInfo = dependencies.readPidFile();
  if (!dependencies.verifyPidFileOwnership(pidInfo)) return false;
  if (pidInfo.port !== port) return false;
  const healthPid = health?.pid;
  if (Number.isInteger(healthPid) && healthPid !== pidInfo.pid) return false;
  return true;
}

export function hasClaudeMemWorkerOwnershipProof(
  port: number,
  health: WorkerHealthStatus | null,
  dependencies: Partial<WorkerUpgradeSafetyDependencies> = {},
): boolean {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  if (hasValidatedPidOwnership(port, health, resolvedDependencies)) return true;
  return hasClaudeMemHealthIdentity(health);
}

async function isHealthyWorkerPresent(
  port: number,
  options: WorkerUpgradeSafetyOptions,
  dependencies: WorkerUpgradeSafetyDependencies,
): Promise<boolean> {
  if (options.assumeWorkerHealthy === true) return true;
  return dependencies.waitForHealth(port, options.healthProbeTimeoutMs ?? 250);
}

function wasWorkerObserved(
  before: VersionCheckResult,
  health: WorkerHealthStatus | null,
  assumeWorkerHealthy?: boolean,
): boolean {
  return before.workerVersion !== null || health !== null || assumeWorkerHealthy === true;
}

export async function shutdownIncompatibleWorkerIfRunning(
  port: number | string,
  timeoutMs: number = 10000,
  options: WorkerUpgradeSafetyOptions,
): Promise<WorkerUpgradeSafetyResult> {
  const dependencies = resolveDependencies(options);
  const numericPort = Number(port);
  const initialBefore = await dependencies.checkVersionMatch(numericPort, options.expectedVersion);
  const beforeHealth = await dependencies.getRunningWorkerHealth(numericPort);
  const before = mergeHealthVersion(initialBefore, beforeHealth);
  const workerObserved = wasWorkerObserved(before, beforeHealth, options.assumeWorkerHealthy);
  const ownershipVerified = hasClaudeMemWorkerOwnershipProof(numericPort, beforeHealth, dependencies);

  let reason: WorkerUpgradeSafetyReason | undefined;
  if (hasKnownMismatch(before)) {
    reason = 'version-mismatch';
  } else if (before.pluginVersion !== 'unknown' && before.workerVersion === null) {
    const healthy = await isHealthyWorkerPresent(numericPort, options, dependencies);
    if (!healthy) {
      return {
        action: 'not-running',
        shutdownRequested: false,
        shutdownConfirmed: true,
        before,
        workerObserved: false,
        ownershipVerified: false,
      };
    }
    reason = 'version-unavailable';
  }

  if (!reason) {
    return {
      action: 'compatible',
      shutdownRequested: false,
      shutdownConfirmed: true,
      before,
      workerObserved,
      ownershipVerified,
    };
  }

  if (!ownershipVerified) {
    logger.error('SYSTEM', 'Refusing to send admin shutdown to service without claude-mem ownership proof', {
      port,
      reason,
      ...describeVersion(before),
    });
    return {
      action: 'shutdown-failed',
      reason: 'unknown-owner',
      shutdownRequested: false,
      shutdownConfirmed: false,
      before,
      workerObserved,
      ownershipVerified,
    };
  }

  logger.warn('SYSTEM', 'Running worker is not safe for upgrade; requesting shutdown before continuing', {
    port,
    reason,
    ...describeVersion(before),
  });

  const shutdown = await dependencies.shutdownWorkerAndWait(port, timeoutMs, { workerWasObserved: true });
  if (!shutdown.shutdownConfirmed) {
    logger.error('SYSTEM', 'Incompatible worker shutdown request did not free the worker port', {
      port,
      reason,
      before: describeVersion(before),
      shutdown,
    });
    return {
      action: 'shutdown-failed',
      reason,
      shutdownRequested: true,
      shutdownConfirmed: false,
      before,
      workerObserved,
      ownershipVerified,
    };
  }

  const afterHealth = await dependencies.getRunningWorkerHealth(numericPort);
  const after = mergeHealthVersion(await dependencies.checkVersionMatch(numericPort, options.expectedVersion), afterHealth);
  let stillUnsafe = hasKnownMismatch(after);
  if (!stillUnsafe && after.workerVersion === null) {
    stillUnsafe = await dependencies.waitForHealth(numericPort, options.healthProbeTimeoutMs ?? 250);
  }

  if (stillUnsafe) {
    logger.error('SYSTEM', 'Incompatible worker still responding after shutdown request', {
      port,
      reason,
      before: describeVersion(before),
      after: describeVersion(after),
    });
    return {
      action: 'shutdown-failed',
      reason,
      shutdownRequested: true,
      shutdownConfirmed: false,
      before,
      after,
      workerObserved,
      ownershipVerified,
    };
  }

  logger.info('SYSTEM', 'Incompatible worker stopped before upgrade-sensitive work continued', {
    port,
    reason,
    before: describeVersion(before),
    after: describeVersion(after),
  });

  return {
    action: 'shutdown-confirmed',
    reason,
    shutdownRequested: true,
    shutdownConfirmed: true,
    before,
    after,
    workerObserved,
    ownershipVerified,
  };
}

export function formatWorkerUpgradeSafetyError(
  port: number | string,
  result: WorkerUpgradeSafetyResult,
): string {
  if (result.reason === 'unknown-owner') {
    return `Refusing to stop unknown service on port ${port}; claude-mem worker ownership could not be verified`;
  }

  const workerVersion = result.after?.workerVersion ?? result.before.workerVersion ?? 'unknown';
  const pluginVersion = result.after?.pluginVersion ?? result.before.pluginVersion;
  return `Incompatible claude-mem worker is still running on port ${port}: worker=${workerVersion}, plugin=${pluginVersion}`;
}

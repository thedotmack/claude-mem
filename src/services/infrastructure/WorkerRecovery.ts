import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { paths } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import {
  captureProcessStartToken,
  getProcessRegistry,
  isPidAlive,
  type ManagedProcessRecord,
  type PidInfo,
} from '../../supervisor/process-registry.js';
import { readPidFile, removePidFileIfOwner } from './ProcessManager.js';
import { waitForPortFree } from './HealthMonitor.js';

const execFileAsync = promisify(execFile);
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 10_000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 10_000;
const RECOVERY_PORT_FREE_TIMEOUT_MS = 10_000;

export interface WindowsProcessSnapshot {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

export interface WorkerRecoveryDependencies {
  platform: NodeJS.Platform;
  chromaDataDir: string;
  readWorkerPid: () => PidInfo | null;
  listWindowsProcesses: () => Promise<WindowsProcessSnapshot[]>;
  getManagedProcesses: () => ManagedProcessRecord[];
  unregisterManagedProcess: (id: string) => void;
  killProcessTree: (pid: number) => Promise<void>;
  removeWorkerPidFile: (expectedOwnerPid: number | null) => void;
  isPidAlive: (pid: number) => boolean;
  captureProcessStartToken: (pid: number) => string | null;
  waitForPortFree: (port: number, timeoutMs: number) => Promise<boolean>;
}

function normalizeForCommandLineMatch(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function asFiniteInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseWindowsProcessSnapshots(raw: string): WindowsProcessSnapshot[] {
  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const snapshots: WindowsProcessSnapshot[] = [];

    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const pid = asFiniteInteger(record.ProcessId ?? record.pid);
      if (pid === null) continue;
      const parentPid = asFiniteInteger(record.ParentProcessId ?? record.parentPid) ?? 0;
      snapshots.push({
        pid,
        parentPid,
        name: String(record.Name ?? record.name ?? ''),
        commandLine: String(record.CommandLine ?? record.commandLine ?? ''),
      });
    }

    return snapshots;
  } catch (error: unknown) {
    logger.warn('SYSTEM', 'Could not parse Windows process inventory during worker recovery', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function listWindowsProcesses(): Promise<WindowsProcessSnapshot[]> {
  const script = [
    'Get-CimInstance Win32_Process',
    "Where-Object { $_.CommandLine -and ($_.CommandLine -match 'chroma-mcp|worker-service\\.cjs') }",
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf-8',
      timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
      windowsHide: true,
      env: sanitizeEnv(process.env),
    },
  );

  if (result.status !== 0) {
    logger.warn('SYSTEM', 'Windows process inventory failed during worker recovery', {
      status: result.status,
      error: result.error?.message,
    });
    return [];
  }
  return parseWindowsProcessSnapshots(result.stdout);
}

function isOwnedChromaProcess(processInfo: WindowsProcessSnapshot, chromaDataDir: string): boolean {
  const commandLine = normalizeForCommandLineMatch(processInfo.commandLine);
  if (!commandLine.includes('chroma-mcp')) return false;

  const normalizedDataDir = normalizeForCommandLineMatch(chromaDataDir);
  if (normalizedDataDir && commandLine.includes(normalizedDataDir)) {
    return true;
  }

  // Remote Chroma has no local --data-dir. Restrict that fallback to the
  // exact uv tool launcher owned by claude-mem rather than matching arbitrary
  // chroma-mcp installations on the machine.
  return commandLine.includes('tool uvx') && commandLine.includes('--from chroma-mcp==');
}

export function selectOwnedChromaRoots(
  processes: WindowsProcessSnapshot[],
  chromaDataDir: string,
): WindowsProcessSnapshot[] {
  const owned = processes.filter(processInfo => isOwnedChromaProcess(processInfo, chromaDataDir));
  const ownedPids = new Set(owned.map(processInfo => processInfo.pid));
  return owned.filter(processInfo => !ownedPids.has(processInfo.parentPid));
}

function commandLineOwnsWorker(
  processInfo: WindowsProcessSnapshot | undefined,
  workerScriptPath: string,
): boolean {
  if (!processInfo) return false;
  const commandLine = normalizeForCommandLineMatch(processInfo.commandLine);
  const scriptPath = normalizeForCommandLineMatch(workerScriptPath);
  if (!commandLine.includes('--daemon')) return false;
  if (scriptPath && commandLine.includes(scriptPath)) return true;
  return commandLine.includes('worker-service.cjs') && (
    commandLine.includes('/thedotmack/') || commandLine.includes('/claude-mem/')
  );
}

function hasWorkerOwnership(
  pid: number,
  storedToken: string | undefined,
  processInfo: WindowsProcessSnapshot | undefined,
  workerScriptPath: string,
  dependencies: WorkerRecoveryDependencies,
): boolean {
  if (!dependencies.isPidAlive(pid)) return false;

  if (storedToken) {
    const currentToken = dependencies.captureProcessStartToken(pid);
    if (currentToken !== null) {
      return currentToken === storedToken;
    }
  }

  // CIM creation-time queries can fail transiently while Windows is under
  // load. An exact worker command line remains a safe fallback, but never
  // overrides a positively observed token mismatch (PID reuse).
  return commandLineOwnsWorker(processInfo, workerScriptPath);
}

function hasStrictStartTokenOwnership(
  pid: number,
  storedToken: string | undefined,
  dependencies: WorkerRecoveryDependencies,
): boolean {
  if (!storedToken || !dependencies.isPidAlive(pid)) return false;
  const currentToken = dependencies.captureProcessStartToken(pid);
  return currentToken !== null && currentToken === storedToken;
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error: unknown) {
    // taskkill returns a failure when the target exited between inventory and
    // termination. Treat that race as success; the port-free proof below is
    // the authoritative recovery result.
    logger.debug('SYSTEM', 'Windows recovery tree-kill finished (target may already be gone)', {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function defaultDependencies(): WorkerRecoveryDependencies {
  const registry = getProcessRegistry();
  return {
    platform: process.platform,
    chromaDataDir: paths.chroma(),
    readWorkerPid: readPidFile,
    listWindowsProcesses,
    getManagedProcesses: () => registry.getAll(),
    unregisterManagedProcess: id => registry.unregister(id),
    killProcessTree: killWindowsProcessTree,
    removeWorkerPidFile: removePidFileIfOwner,
    isPidAlive,
    captureProcessStartToken,
    waitForPortFree,
  };
}

/**
 * Reclaim a Windows worker port after the worker stops answering health
 * checks. Destructive actions are limited to a creation-token-verified worker
 * PID and Chroma processes whose command line points at claude-mem's own data
 * directory (or its exact remote-mode uv launcher).
 */
export async function recoverUnhealthyWorker(
  port: number,
  workerScriptPath: string,
  overrides: Partial<WorkerRecoveryDependencies> = {},
): Promise<boolean> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  if (dependencies.platform !== 'win32') {
    return false;
  }

  logger.warn('SYSTEM', 'Worker port is occupied but health is unresponsive — starting automatic recovery', { port });

  const workerPidInfo = dependencies.readWorkerPid();
  const processes = await dependencies.listWindowsProcesses();
  const byPid = new Map(processes.map(processInfo => [processInfo.pid, processInfo]));
  const killedPids = new Set<number>();

  if (workerPidInfo && hasWorkerOwnership(
    workerPidInfo.pid,
    workerPidInfo.startToken,
    byPid.get(workerPidInfo.pid),
    workerScriptPath,
    dependencies,
  )) {
    logger.warn('SYSTEM', 'Terminating unresponsive claude-mem worker process tree', {
      pid: workerPidInfo.pid,
      port,
    });
    await dependencies.killProcessTree(workerPidInfo.pid);
    killedPids.add(workerPidInfo.pid);
  }

  const chromaRoots = selectOwnedChromaRoots(processes, dependencies.chromaDataDir);
  for (const root of chromaRoots) {
    if (killedPids.has(root.pid)) continue;
    logger.warn('SYSTEM', 'Terminating orphaned claude-mem Chroma process tree', { pid: root.pid });
    await dependencies.killProcessTree(root.pid);
    killedPids.add(root.pid);
  }

  for (const record of dependencies.getManagedProcesses()) {
    if (record.type !== 'chroma') continue;
    const snapshot = byPid.get(record.pid);
    const ownedByCommand = snapshot ? isOwnedChromaProcess(snapshot, dependencies.chromaDataDir) : false;
    const ownedByToken = hasStrictStartTokenOwnership(record.pid, record.startToken, dependencies);
    if (!ownedByCommand && !ownedByToken) continue;

    if (!killedPids.has(record.pid)) {
      await dependencies.killProcessTree(record.pid);
      killedPids.add(record.pid);
    }
    dependencies.unregisterManagedProcess(record.id);
  }

  dependencies.removeWorkerPidFile(workerPidInfo?.pid ?? null);
  const portFreed = await dependencies.waitForPortFree(port, RECOVERY_PORT_FREE_TIMEOUT_MS);
  if (!portFreed) {
    logger.error('SYSTEM', 'Automatic worker recovery could not release the listening port', {
      port,
      killedPids: [...killedPids],
    });
    return false;
  }

  logger.info('SYSTEM', 'Automatic worker recovery released the port', {
    port,
    killedPids: [...killedPids],
  });
  return true;
}

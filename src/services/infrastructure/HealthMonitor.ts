
import path from 'path';
import net from 'net';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

const execFileAsync = promisify(execFile);

async function httpRequestToWorker(
  port: number,
  endpointPath: string,
  method: string = 'GET',
  timeoutMs: number = HOOK_TIMEOUTS.HEALTH_CHECK
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
      method,
      signal: controller.signal,
    });
    let body = '';
    try {
      body = await response.text();
    } catch {
      // Body unavailable — health/readiness checks only need .ok
    }
    return { ok: response.ok, statusCode: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

interface WindowsProcessInfo {
  pid: number;
  commandLine: string;
  executablePath: string;
}

function parsePidLines(stdout: string): number[] {
  return Array.from(new Set(
    stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\d+$/.test(line))
      .map(line => parseInt(line, 10))
      .filter(pid => pid > 0)
  ));
}

async function runPowerShell(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf-8',
      timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
      windowsHide: true,
    }
  );
  return String(stdout ?? '');
}

async function getWindowsPortOwnerPidsViaNetstat(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      'netstat',
      ['-ano', '-p', 'tcp'],
      {
        encoding: 'utf-8',
        timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
        windowsHide: true,
      }
    );
    const pids = new Set<number>();
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
      const localAddress = parts[1];
      const state = parts[3].toUpperCase();
      const pid = parseInt(parts[4], 10);
      if (state === 'LISTENING' && localAddress.endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    return [...pids];
  } catch (error: unknown) {
    logger.debug(
      'SYSTEM',
      'Failed to enumerate Windows port owners via netstat',
      { port },
      error instanceof Error ? error : new Error(String(error))
    );
    return [];
  }
}

export async function getWindowsPortOwnerPids(port: number): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];

  try {
    const stdout = await runPowerShell(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
    );
    const pids = parsePidLines(stdout);
    if (pids.length > 0) return pids;
  } catch (error: unknown) {
    logger.debug(
      'SYSTEM',
      'Failed to enumerate Windows port owners via Get-NetTCPConnection',
      { port },
      error instanceof Error ? error : new Error(String(error))
    );
  }

  return getWindowsPortOwnerPidsViaNetstat(port);
}

export async function isWindowsPortHeldByMissingProcess(port: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  const ownerPids = await getWindowsPortOwnerPids(port);
  if (ownerPids.length === 0) return false;

  for (const pid of ownerPids) {
    if (pid === process.pid) return false;
    const info = await getWindowsProcessInfo(pid);
    if (info !== null) return false;
  }

  return true;
}

async function getWindowsProcessInfo(pid: number): Promise<WindowsProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    const stdout = await runPowerShell(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
      `if ($p) { [pscustomobject]@{ ProcessId=$p.ProcessId; ExecutablePath=$p.ExecutablePath; CommandLine=$p.CommandLine } | ConvertTo-Json -Compress }`
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as {
      ProcessId?: unknown;
      ExecutablePath?: unknown;
      CommandLine?: unknown;
    };
    return {
      pid: typeof parsed.ProcessId === 'number' ? parsed.ProcessId : pid,
      executablePath: typeof parsed.ExecutablePath === 'string' ? parsed.ExecutablePath : '',
      commandLine: typeof parsed.CommandLine === 'string' ? parsed.CommandLine : '',
    };
  } catch (error: unknown) {
    logger.debug(
      'SYSTEM',
      'Failed to read Windows process info',
      { pid },
      error instanceof Error ? error : new Error(String(error))
    );
    return null;
  }
}

export function isLikelyClaudeMemWorkerCommand(commandLine: string, executablePath: string = ''): boolean {
  const text = `${commandLine} ${executablePath}`.replace(/\\/g, '/').toLowerCase();
  if (!text.includes('claude-mem')) return false;

  return text.includes('worker-service.cjs') ||
    text.includes('/worker-service') ||
    text.includes('/plugin/scripts/claude-mem') ||
    text.includes('claude-mem.exe');
}

async function taskkillProcessTree(pid: number): Promise<boolean> {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
      windowsHide: true,
    });
    return true;
  } catch (error: unknown) {
    logger.debug(
      'SYSTEM',
      'taskkill finished with non-zero exit (process may already be gone)',
      { pid },
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}

export async function forceKillStaleWorkerPortOwners(
  port: number,
  expectedWorkerPid: number | null = null
): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  const ownerPids = await getWindowsPortOwnerPids(port);
  if (ownerPids.length === 0) return false;

  let killedAny = false;
  for (const pid of ownerPids) {
    if (pid === process.pid) {
      logger.warn('SYSTEM', 'Refusing to taskkill current process while cleaning worker port', { port, pid });
      continue;
    }

    const info = await getWindowsProcessInfo(pid);
    const matchesExpectedPid = expectedWorkerPid !== null && pid === expectedWorkerPid;
    const matchesClaudeMemWorker = info
      ? isLikelyClaudeMemWorkerCommand(info.commandLine, info.executablePath)
      : false;

    if (!matchesExpectedPid && !matchesClaudeMemWorker) {
      logger.warn('SYSTEM', 'Port owner does not look like claude-mem worker; leaving it alone', {
        port,
        pid,
        commandLine: info?.commandLine ?? '(unknown)',
        executablePath: info?.executablePath ?? '(unknown)',
      });
      continue;
    }

    logger.warn('SYSTEM', 'Force-killing stale claude-mem worker port owner on Windows', {
      port,
      pid,
      matchedBy: matchesExpectedPid ? 'expected-pid' : 'command-line',
    });
    const killed = await taskkillProcessTree(pid);
    killedAny = killedAny || killed;
  }

  return killedAny;
}

async function pollEndpointUntilOk(
  port: number,
  endpointPath: string,
  timeoutMs: number,
  retryLogMessage: string
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await httpRequestToWorker(port, endpointPath, 'GET', HOOK_TIMEOUTS.HEALTH_CHECK);
      if (result.ok) return true;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', retryLogMessage, {}, error);
      } else {
        logger.debug('SYSTEM', retryLogMessage, { error: String(error) });
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/health', timeoutMs, 'Service not ready yet, will retry');
}

export function waitForReadiness(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/readiness', timeoutMs, 'Worker not ready yet, will retry');
}

export async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function httpShutdown(port: number, reason: 'stop' | 'restart' = 'stop'): Promise<boolean> {
  try {
    // The CLI restart path stops the worker through this same endpoint; the
    // reason tag lets the worker report shutdown_reason: 'restart' on its
    // worker_stopped telemetry instead of a generic 'stop'.
    const endpointPath = reason === 'restart' ? '/api/admin/shutdown?reason=restart' : '/api/admin/shutdown';
    const result = await httpRequestToWorker(port, endpointPath, 'POST', HOOK_TIMEOUTS.HEALTH_CHECK);
    if (!result.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', { status: result.statusCode });
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message?.includes('ECONNREFUSED')) {
      logger.debug('SYSTEM', 'Worker already stopped', {}, error);
      return false;
    }
    logger.error('SYSTEM', 'Shutdown request failed unexpectedly', {}, error as Error);
    return false;
  }
}

export function getInstalledPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EBUSY') {
        logger.debug('SYSTEM', 'Could not read plugin version (shutdown race)', { code });
        return 'unknown';
      }
      throw error;
    }
    throw error;
  }
}

export async function getRunningWorkerVersion(port: number): Promise<string | null> {
  try {
    const result = await httpRequestToWorker(port, '/api/version', 'GET', HOOK_TIMEOUTS.HEALTH_CHECK);
    if (!result.ok) return null;
    const data = JSON.parse(result.body) as { version: string };
    return data.version;
  } catch {
    logger.debug('SYSTEM', 'Could not fetch worker version', {});
    return null;
  }
}

export interface VersionCheckResult {
  matches: boolean;
  pluginVersion: string;
  workerVersion: string | null;
}

export async function checkVersionMatch(port: number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}


import path from 'path';
import { homedir } from 'os';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmSync, statSync, utimesSync, copyFileSync } from 'fs';
import { exec, execSync, spawnSync } from 'child_process';
import { spawnHidden } from '../../shared/spawn.js';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor, validateWorkerPidFile, type ValidateWorkerPidStatus } from '../../supervisor/index.js';
import { paths } from '../../shared/paths.js';

const execAsync = promisify(exec);

const DATA_DIR = paths.dataDir();
const PID_FILE = paths.workerPid();

interface RuntimeResolverOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  pathExists?: (candidatePath: string) => boolean;
  lookupInPath?: (binaryName: string, platform: NodeJS.Platform) => string | null;
}

function isBunExecutablePath(executablePath: string | undefined | null): boolean {
  if (!executablePath) return false;

  return /(^|[\\/])bun(\.exe)?$/i.test(executablePath.trim());
}

function lookupBinaryInPath(binaryName: string, platform: NodeJS.Platform): string | null {
  const command = platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;

  let output: string;
  try {
    output = execSync(command, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', `Binary lookup failed for ${binaryName}`, { command }, error);
    } else {
      logger.debug('SYSTEM', `Binary lookup failed for ${binaryName}`, { command }, new Error(String(error)));
    }
    return null;
  }

  const firstMatch = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);

  return firstMatch || null;
}

let cachedWorkerRuntimePath: string | undefined = undefined;

export function resolveWorkerRuntimePath(options: RuntimeResolverOptions = {}): string | null {
  const isMemoizable = Object.keys(options).length === 0;
  if (isMemoizable && cachedWorkerRuntimePath !== undefined) {
    return cachedWorkerRuntimePath;
  }

  const result = resolveWorkerRuntimePathUncached(options);

  if (isMemoizable && result !== null) {
    cachedWorkerRuntimePath = result;
  }
  return result;
}

function resolveWorkerRuntimePathUncached(options: RuntimeResolverOptions): string | null {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;

  if (isBunExecutablePath(execPath)) {
    return execPath;
  }

  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const lookupInPath = options.lookupInPath ?? lookupBinaryInPath;

  const candidatePaths: (string | undefined)[] = platform === 'win32'
    ? [
        env.BUN,
        env.BUN_PATH,
        path.join(homeDirectory, '.bun', 'bin', 'bun.exe'),
        path.join(homeDirectory, '.bun', 'bin', 'bun'),
        env.USERPROFILE ? path.join(env.USERPROFILE, '.bun', 'bin', 'bun.exe') : undefined,
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'bun', 'bun.exe') : undefined,
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'bun', 'bin', 'bun.exe') : undefined,
      ]
    : [
        env.BUN,
        env.BUN_PATH,
        path.join(homeDirectory, '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun',
        '/usr/bin/bun', // Debian/Ubuntu apt install path
        '/snap/bin/bun', // Ubuntu Snap install path
      ];

  for (const candidate of candidatePaths) {
    const normalized = candidate?.trim();
    if (!normalized) continue;

    if (isBunExecutablePath(normalized) && pathExists(normalized)) {
      return normalized;
    }

    if (normalized.toLowerCase() === 'bun') {
      return normalized;
    }
  }

  return lookupInPath('bun', platform);
}

import {
  captureProcessStartToken,
  verifyPidFileOwnership,
  type PidInfo
} from '../../supervisor/process-registry.js';
export { captureProcessStartToken, verifyPidFileOwnership, type PidInfo };

export function writePidFile(info: PidInfo): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const resolvedToken = info.startToken ?? captureProcessStartToken(info.pid);
  const payload: PidInfo = resolvedToken ? { ...info, startToken: resolvedToken } : info;
  writeFileSync(PID_FILE, JSON.stringify(payload, null, 2));
}

export function readPidFile(): PidInfo | null {
  if (!existsSync(PID_FILE)) return null;

  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, new Error(String(error)));
    }
    return null;
  }
}

export function removePidFile(): void {
  if (!existsSync(PID_FILE)) return;

  try {
    unlinkSync(PID_FILE);
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, new Error(String(error)));
    }
  }
}

export function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}

export async function getChildProcesses(parentPid: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    logger.warn('SYSTEM', 'Invalid parent PID for child process enumeration', { parentPid });
    return [];
  }

  try {
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId"`;
    const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, windowsHide: true });
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && /^\d+$/.test(line))
      .map(line => parseInt(line, 10))
      .filter(pid => pid > 0);
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, error);
    } else {
      logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, new Error(String(error)));
    }
    return [];
  }
}

export function parseElapsedTime(etime: string): number {
  if (!etime || etime.trim() === '') return -1;

  const cleaned = etime.trim();
  let totalMinutes = 0;

  const dayMatch = cleaned.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    totalMinutes = parseInt(dayMatch[1], 10) * 24 * 60 +
                   parseInt(dayMatch[2], 10) * 60 +
                   parseInt(dayMatch[3], 10);
    return totalMinutes;
  }

  const hourMatch = cleaned.match(/^(\d+):(\d+):(\d+)$/);
  if (hourMatch) {
    totalMinutes = parseInt(hourMatch[1], 10) * 60 + parseInt(hourMatch[2], 10);
    return totalMinutes;
  }

  const minMatch = cleaned.match(/^(\d+):(\d+)$/);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  return -1;
}

const CHROMA_MIGRATION_MARKER_FILENAME = '.chroma-cleaned-v10.3';

export function runOneTimeChromaMigration(dataDirectory?: string): void {
  const effectiveDataDir = dataDirectory ?? DATA_DIR;
  const markerPath = path.join(effectiveDataDir, CHROMA_MIGRATION_MARKER_FILENAME);
  const chromaDir = path.join(effectiveDataDir, 'chroma');

  if (existsSync(markerPath)) {
    logger.debug('SYSTEM', 'Chroma migration marker exists, skipping wipe');
    return;
  }

  logger.warn('SYSTEM', 'Running one-time chroma data wipe (upgrade from pre-v10.3)', { chromaDir });

  if (existsSync(chromaDir)) {
    rmSync(chromaDir, { recursive: true, force: true });
    logger.info('SYSTEM', 'Chroma data directory removed', { chromaDir });
  }

  mkdirSync(effectiveDataDir, { recursive: true });
  writeFileSync(markerPath, new Date().toISOString());
  logger.info('SYSTEM', 'Chroma migration marker written', { markerPath });
}

const CWD_REMAP_MARKER_FILENAME = '.cwd-remap-applied-v1';

type CwdClassification =
  | { kind: 'main'; project: string }
  | { kind: 'worktree'; project: string }
  | { kind: 'skip' };

function gitQuery(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? '').trim();
}

function classifyCwdForRemap(cwd: string): CwdClassification {
  if (!existsSync(cwd)) return { kind: 'skip' };

  const gitDir = gitQuery(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return { kind: 'skip' };

  const commonDir = gitQuery(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return { kind: 'skip' };

  const toplevel = gitQuery(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return { kind: 'skip' };
  const leaf = path.basename(toplevel);

  if (gitDir === commonDir) {
    return { kind: 'main', project: leaf };
  }

  const parentRepoDir = commonDir.endsWith('/.git')
    ? path.dirname(commonDir)
    : commonDir.replace(/\.git$/, '');
  const parent = path.basename(parentRepoDir);
  return { kind: 'worktree', project: `${parent}/${leaf}` };
}

export function runOneTimeCwdRemap(dataDirectory?: string): void {
  const effectiveDataDir = dataDirectory ?? DATA_DIR;
  const markerPath = path.join(effectiveDataDir, CWD_REMAP_MARKER_FILENAME);
  const dbPath = path.join(effectiveDataDir, 'claude-mem.db');

  if (existsSync(markerPath)) {
    logger.debug('SYSTEM', 'cwd-remap marker exists, skipping');
    return;
  }

  if (!existsSync(dbPath)) {
    mkdirSync(effectiveDataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
    logger.debug('SYSTEM', 'No DB present, cwd-remap marker written without work', { dbPath });
    return;
  }

  logger.warn('SYSTEM', 'Running one-time cwd-based project remap', { dbPath });

  try {
    executeCwdRemap(dbPath, effectiveDataDir, markerPath);
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error('SYSTEM', 'cwd-remap failed, marker not written (will retry on next startup)', {}, err);
    } else {
      logger.error('SYSTEM', 'cwd-remap failed, marker not written (will retry on next startup)', {}, new Error(String(err)));
    }
  }
}

function executeCwdRemap(dbPath: string, effectiveDataDir: string, markerPath: string): void {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');

  const probe = new Database(dbPath, { readonly: true });
  const hasPending = probe.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
  ).get() as { name: string } | undefined;
  probe.close();

  if (!hasPending) {
    mkdirSync(effectiveDataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
    logger.info('SYSTEM', 'pending_messages table not present, cwd-remap skipped');
    return;
  }

  const backup = `${dbPath}.bak-cwd-remap-${Date.now()}`;
  copyFileSync(dbPath, backup);
  logger.info('SYSTEM', 'DB backed up before cwd-remap', { backup });

  const db = new Database(dbPath);
  try {
    const cwdRows = db.prepare(`
      SELECT cwd FROM pending_messages
      WHERE cwd IS NOT NULL AND cwd != ''
      GROUP BY cwd
    `).all() as Array<{ cwd: string }>;

    const byCwd = new Map<string, CwdClassification>();
    for (const { cwd } of cwdRows) byCwd.set(cwd, classifyCwdForRemap(cwd));

    const sessionRows = db.prepare(`
      SELECT s.id AS session_id, s.memory_session_id, s.project AS old_project, p.cwd
      FROM sdk_sessions s
      JOIN pending_messages p ON p.content_session_id = s.content_session_id
      WHERE p.cwd IS NOT NULL AND p.cwd != ''
        AND p.id = (
          SELECT MIN(p2.id) FROM pending_messages p2
          WHERE p2.content_session_id = s.content_session_id
            AND p2.cwd IS NOT NULL AND p2.cwd != ''
        )
    `).all() as Array<{ session_id: number; memory_session_id: string | null; old_project: string; cwd: string }>;

    type Target = { sessionId: number; memorySessionId: string | null; newProject: string };
    const targets: Target[] = [];
    for (const r of sessionRows) {
      const c = byCwd.get(r.cwd);
      if (!c || c.kind === 'skip') continue;
      if (r.old_project === c.project) continue;
      targets.push({ sessionId: r.session_id, memorySessionId: r.memory_session_id, newProject: c.project });
    }

    if (targets.length === 0) {
      logger.info('SYSTEM', 'cwd-remap: no sessions need updating');
    } else {
      const updSession = db.prepare('UPDATE sdk_sessions      SET project = ? WHERE id = ?');
      const updObs     = db.prepare('UPDATE observations      SET project = ? WHERE memory_session_id = ?');
      const updSum     = db.prepare('UPDATE session_summaries SET project = ? WHERE memory_session_id = ?');

      let sessionN = 0, obsN = 0, sumN = 0;
      const tx = db.transaction(() => {
        for (const t of targets) {
          sessionN += updSession.run(t.newProject, t.sessionId).changes;
          if (t.memorySessionId) {
            obsN += updObs.run(t.newProject, t.memorySessionId).changes;
            sumN += updSum.run(t.newProject, t.memorySessionId).changes;
          }
        }
      });
      tx();

      logger.info('SYSTEM', 'cwd-remap applied', { sessions: sessionN, observations: obsN, summaries: sumN, backup });
    }

    mkdirSync(effectiveDataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
    logger.info('SYSTEM', 'cwd-remap marker written', { markerPath });
  } finally {
    db.close();
  }
}

export function spawnDaemon(
  scriptPath: string,
  port: number,
  extraEnv: Record<string, string> = {}
): number | undefined {
  getSupervisor().assertCanSpawn('worker daemon');

  const env = sanitizeEnv({
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
    ...extraEnv
  });

  const runtimePath = resolveWorkerRuntimePath();
  if (!runtimePath) {
    logger.error(
      'SYSTEM',
      'Bun runtime not found — install from https://bun.sh and ensure it is on PATH or set BUN env var. The worker daemon requires Bun because it uses bun:sqlite.'
    );
    return undefined;
  }

  if (process.platform === 'win32') {
    const psScript = `Start-Process -FilePath '${runtimePath.replace(/'/g, "''")}' -ArgumentList @('${scriptPath.replace(/'/g, "''")}','--daemon') -WindowStyle Hidden`;
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    try {
      execSync(`powershell -NoProfile -EncodedCommand ${encodedCommand}`, {
        stdio: 'ignore',
        windowsHide: true,
        env
      });
      return 0;
    } catch (error: unknown) {
      logger.error(
        'SYSTEM',
        'Failed to spawn worker daemon on Windows',
        { runtimePath },
        error instanceof Error ? error : new Error(String(error))
      );
      return undefined;
    }
  }

  const setsidPath = '/usr/bin/setsid';
  const useSetsid = existsSync(setsidPath);

  const execPath = useSetsid ? setsidPath : runtimePath;
  const args = useSetsid
    ? [runtimePath, scriptPath, '--daemon']
    : [scriptPath, '--daemon'];

  const child = spawnHidden(execPath, args, {
    detached: true,
    stdio: 'ignore',
    env
  });

  if (child.pid === undefined) {
    return undefined;
  }

  child.unref();
  return child.pid;
}

export function isProcessAlive(pid: number): boolean {
  if (pid === 0) return true;

  if (!Number.isInteger(pid) || pid < 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return true;
      logger.debug('SYSTEM', 'Process not alive', { pid, code });
    } else {
      logger.debug('SYSTEM', 'Process not alive (non-Error thrown)', { pid }, new Error(String(error)));
    }
    return false;
  }
}

export function isPidFileRecent(thresholdMs: number = 15000): boolean {
  try {
    const stats = statSync(PID_FILE);
    return (Date.now() - stats.mtimeMs) < thresholdMs;
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'PID file not accessible for recency check', { path: PID_FILE }, error);
    } else {
      logger.debug('SYSTEM', 'PID file not accessible for recency check', { path: PID_FILE }, new Error(String(error)));
    }
    return false;
  }
}

export function touchPidFile(): void {
  try {
    if (!existsSync(PID_FILE)) return;
    const now = new Date();
    utimesSync(PID_FILE, now, now);
  } catch {
    // Best-effort — failure to touch doesn't affect correctness
  }
}

export function cleanStalePidFile(): ValidateWorkerPidStatus {
  return validateWorkerPidFile({ logAlive: false });
}


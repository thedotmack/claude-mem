import path from 'path';
import os from 'os';
import fs from 'fs';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { findClaudeExecutable as defaultFindClaudeExecutable } from '../../shared/find-claude-executable.js';
import { logger } from '../../utils/logger.js';
import {
  clearDependencyStatus,
  recordClaudeCliSetupRequired,
  recordUvxVectorSearchUnavailable,
  snapshotDependencyHealth,
  type DependencyHealthSnapshot,
} from '../../shared/dependency-health.js';

interface DependencyPreflightSettings {
  CLAUDE_MEM_PROVIDER?: string;
  CLAUDE_MEM_CHROMA_ENABLED?: string;
}

interface ClassifiedClaudeSetupError {
  kind: string;
  message: string;
}

export interface WorkerDependencyPreflightOptions {
  settings: DependencyPreflightSettings;
  classifyClaudeError: (error: unknown) => ClassifiedClaudeSetupError;
  findClaudeExecutable?: () => string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  pathExists?: (filePath: string) => boolean;
  isFile?: (filePath: string) => boolean;
}

function defaultPathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function defaultIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function pathKeyFor(env: Record<string, string>): string {
  return Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
}

function pathSeparatorFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function uvxBinDirs(options: Required<Pick<WorkerDependencyPreflightOptions, 'homedir' | 'isFile'>>, env: Record<string, string>): string[] {
  const override = env.CLAUDE_MEM_CHROMA_UVX_PATH;
  const dirs = [
    override,
    path.join(options.homedir(), '.local', 'bin'),
    path.join(options.homedir(), '.cargo', 'bin'),
  ].filter((dir): dir is string => Boolean(dir));

  return dirs.map(dir => options.isFile(dir) ? path.dirname(dir) : dir);
}

function effectiveUvxEnv(options: WorkerDependencyPreflightOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? defaultPathExists;
  const isFile = options.isFile ?? defaultIsFile;
  const homedir = options.homedir ?? os.homedir;
  const env = stringEnv(options.env ?? sanitizeEnv(process.env));
  const pathKey = pathKeyFor(env);
  const separator = pathSeparatorFor(platform);
  const currentPathEntries = (env[pathKey] ?? '').split(separator).filter(Boolean);
  const have = new Set(currentPathEntries.map(entry => platform === 'win32' ? entry.toLowerCase() : entry));
  const additions = uvxBinDirs({ homedir, isFile }, env).filter(dir => {
    if (!pathExists(dir)) return false;
    const key = platform === 'win32' ? dir.toLowerCase() : dir;
    return !have.has(key);
  });

  if (additions.length > 0) {
    env[pathKey] = [...additions, ...currentPathEntries].join(separator);
  }

  return env;
}

function hasExecutableOnPath(command: string, options: WorkerDependencyPreflightOptions): boolean {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const env = effectiveUvxEnv(options);
  const pathKey = pathKeyFor(env);
  const separator = pathSeparatorFor(platform);
  const names = platform === 'win32' && !command.toLowerCase().endsWith('.exe')
    ? [command, `${command}.exe`]
    : [command];

  if (command.includes('/') || command.includes('\\')) {
    return names.some(name => isFile(name));
  }

  const dirs = (env[pathKey] ?? '').split(separator).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      if (isFile(path.join(dir, name))) {
        return true;
      }
    }
  }
  return false;
}

function resolveUvxCommand(options: WorkerDependencyPreflightOptions): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return 'uvx';
  }

  const isFile = options.isFile ?? defaultIsFile;
  const env = effectiveUvxEnv(options);
  const override = env.CLAUDE_MEM_CHROMA_UVX_PATH;
  if (override && isFile(override)) {
    return override;
  }

  const pathKey = pathKeyFor(env);
  const dirs = (env[pathKey] ?? '').split(pathSeparatorFor(platform)).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'uvx.exe');
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return 'uvx.exe';
}

export function runWorkerDependencyPreflight(options: WorkerDependencyPreflightOptions): DependencyHealthSnapshot {
  const provider = options.settings.CLAUDE_MEM_PROVIDER || 'claude';
  const chromaEnabled = options.settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';

  if (provider === 'claude') {
    const findClaudeExecutable = options.findClaudeExecutable ?? (() => defaultFindClaudeExecutable('WORKER'));
    try {
      findClaudeExecutable();
      clearDependencyStatus('claude_cli');
    } catch (error) {
      const classified = options.classifyClaudeError(error);
      const message = classified.kind === 'setup_required'
        ? classified.message
        : `Claude CLI preflight failed: ${error instanceof Error ? error.message : String(error)}`;
      recordClaudeCliSetupRequired(message);
    }
  } else {
    clearDependencyStatus('claude_cli');
  }

  if (chromaEnabled) {
    const uvxCommand = resolveUvxCommand(options);
    if (hasExecutableOnPath(uvxCommand, options)) {
      clearDependencyStatus('uvx');
    } else {
      logger.warn('WORKER', 'uvx executable not found during worker dependency preflight', {
        command: uvxCommand,
      });
      recordUvxVectorSearchUnavailable(
        `uvx executable not found on effective PATH for vector search (${uvxCommand})`,
      );
    }
  } else {
    clearDependencyStatus('uvx');
  }

  return snapshotDependencyHealth();
}

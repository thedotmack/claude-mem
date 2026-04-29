
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, basename } from 'path';
import { logger } from './logger.js';

export interface CursorProjectRegistry {
  [projectName: string]: {
    workspacePath: string;
    installedAt: string;
  };
}

export interface CursorMcpConfig {
  mcpServers: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

export function readCursorRegistry(registryFile: string): CursorProjectRegistry {
  try {
    if (!existsSync(registryFile)) return {};
    return JSON.parse(readFileSync(registryFile, 'utf-8'));
  } catch (error) {
    logger.error('CONFIG', 'Failed to read Cursor registry, using empty registry', {
      file: registryFile,
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

export function writeCursorRegistry(registryFile: string, registry: CursorProjectRegistry): void {
  const dir = join(registryFile, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryFile, JSON.stringify(registry, null, 2));
}

export function registerCursorProject(
  registryFile: string,
  projectName: string,
  workspacePath: string
): void {
  const registry = readCursorRegistry(registryFile);
  registry[projectName] = {
    workspacePath,
    installedAt: new Date().toISOString()
  };
  writeCursorRegistry(registryFile, registry);
}

export function unregisterCursorProject(registryFile: string, projectName: string): void {
  const registry = readCursorRegistry(registryFile);
  if (registry[projectName]) {
    delete registry[projectName];
    writeCursorRegistry(registryFile, registry);
  }
}

export function writeContextFile(workspacePath: string, context: string): void {
  const rulesDir = join(workspacePath, '.cursor', 'rules');
  const rulesFile = join(rulesDir, 'claude-mem-context.mdc');
  const tempFile = `${rulesFile}.tmp`;

  mkdirSync(rulesDir, { recursive: true });

  const content = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

${context}

---
*Updated after last session. Use claude-mem's MCP search tools for more detailed queries.*
`;

  writeFileSync(tempFile, content);
  renameSync(tempFile, rulesFile);
}

export function readContextFile(workspacePath: string): string | null {
  const rulesFile = join(workspacePath, '.cursor', 'rules', 'claude-mem-context.mdc');
  if (!existsSync(rulesFile)) return null;
  return readFileSync(rulesFile, 'utf-8');
}

export function configureCursorMcp(mcpJsonPath: string, mcpServerScriptPath: string): void {
  const dir = join(mcpJsonPath, '..');
  mkdirSync(dir, { recursive: true });

  let config: CursorMcpConfig = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
    } catch (error) {
      logger.error('CONFIG', 'Failed to read MCP config, starting fresh', {
        file: mcpJsonPath,
        error: error instanceof Error ? error.message : String(error)
      });
      config = { mcpServers: {} };
    }
  }

  config.mcpServers['claude-mem'] = {
    command: 'node',
    args: [mcpServerScriptPath]
  };

  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
}

export function removeMcpConfig(mcpJsonPath: string): void {
  if (!existsSync(mcpJsonPath)) return;

  try {
    const config: CursorMcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    if (config.mcpServers && config.mcpServers['claude-mem']) {
      delete config.mcpServers['claude-mem'];
      writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
    }
  } catch (e) {
    logger.warn('CURSOR', 'Failed to remove MCP config during cleanup', {
      mcpJsonPath,
      error: e instanceof Error ? e.message : String(e)
    });
  }
}

export function parseArrayField(field: string): { field: string; index: number } | null {
  const match = field.match(/^(.+)\[(\d+)\]$/);
  if (!match) return null;
  return {
    field: match[1],
    index: parseInt(match[2], 10)
  };
}

export function jsonGet(json: Record<string, unknown>, field: string, fallback: string = ''): string {
  const arrayAccess = parseArrayField(field);

  if (arrayAccess) {
    const arr = json[arrayAccess.field];
    if (!Array.isArray(arr)) return fallback;
    const value = arr[arrayAccess.index];
    if (value === undefined || value === null) return fallback;
    return String(value);
  }

  const value = json[field];
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function getProjectName(workspacePath: string): string {
  if (!workspacePath) return 'unknown-project';

  const driveMatch = workspacePath.match(/^([A-Za-z]):[\\\/]?$/);
  if (driveMatch) {
    return `drive-${driveMatch[1].toUpperCase()}`;
  }

  const normalized = workspacePath.replace(/\\/g, '/');
  const name = basename(normalized);

  if (!name) {
    return 'unknown-project';
  }

  return name;
}

export function isEmpty(str: string | null | undefined): boolean {
  if (str === null || str === undefined) return true;
  if (str === '') return true;
  if (str === 'null') return true;
  if (str === 'empty') return true;
  return false;
}

export function urlEncode(str: string): string {
  return encodeURIComponent(str);
}

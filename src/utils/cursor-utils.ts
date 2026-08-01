
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { toBmpSafe } from './bmp-safe.js';
import { parseJsonWithBom } from '../shared/atomic-json.js';
import { readJsonSafe } from './json-utils.js';

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
  if (!existsSync(registryFile)) return {};
  try {
    const parsed = parseJsonWithBom<unknown>(readFileSync(registryFile, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cursor project registry is not a JSON object');
    }
    return parsed as CursorProjectRegistry;
  } catch (error) {
    logger.error('CONFIG', 'Failed to read Cursor registry, using empty registry', {
      file: registryFile,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
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

${toBmpSafe(context)}

---
*Updated after last session. Use claude-mem's MCP search tools for more detailed queries.*
`;

  writeFileSync(tempFile, content);
  renameSync(tempFile, rulesFile);
}

export function configureCursorMcp(mcpJsonPath: string, mcpServerScriptPath: string): void {
  const dir = join(mcpJsonPath, '..');
  mkdirSync(dir, { recursive: true });

  let config: CursorMcpConfig;
  try {
    const parsed = readJsonSafe<unknown>(mcpJsonPath, { mcpServers: {} });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cursor MCP config is not a JSON object');
    }
    config = parsed as CursorMcpConfig;
  } catch (error) {
    logger.error('CONFIG', 'Failed to read Cursor MCP config; repair or remove mcp.json before retrying', {
      file: mcpJsonPath,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
  if (config.mcpServers === undefined) {
    config.mcpServers = {};
  } else if (config.mcpServers === null || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    throw new Error('Cursor MCP config has a non-object mcpServers value');
  }

  config.mcpServers['claude-mem'] = {
    command: 'node',
    args: [mcpServerScriptPath]
  };

  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
}

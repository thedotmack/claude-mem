/**
 * Cursor Integration Utilities
 *
 * Pure functions for Cursor project registry, context files, and MCP configuration.
 * Designed for testability - all file paths are passed as parameters.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, basename } from 'path';
import { logger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Project Registry Functions
// ============================================================================

/**
 * Read the Cursor project registry from a file
 */
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

/**
 * Write the Cursor project registry to a file
 */
export function writeCursorRegistry(registryFile: string, registry: CursorProjectRegistry): void {
  const dir = join(registryFile, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryFile, JSON.stringify(registry, null, 2));
}

/**
 * Register a project in the Cursor registry
 */
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

/**
 * Unregister a project from the Cursor registry
 */
export function unregisterCursorProject(registryFile: string, projectName: string): void {
  const registry = readCursorRegistry(registryFile);
  if (registry[projectName]) {
    delete registry[projectName];
    writeCursorRegistry(registryFile, registry);
  }
}

// ============================================================================
// Context File Functions
// ============================================================================

/**
 * Write context file to a Cursor project's .cursor/rules directory
 * Uses atomic write (temp file + rename) to prevent corruption
 */
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

  // Atomic write: temp file + rename
  writeFileSync(tempFile, content);
  renameSync(tempFile, rulesFile);
}

/**
 * Read context file from a Cursor project's .cursor/rules directory
 */
export function readContextFile(workspacePath: string): string | null {
  const rulesFile = join(workspacePath, '.cursor', 'rules', 'claude-mem-context.mdc');
  if (!existsSync(rulesFile)) return null;
  return readFileSync(rulesFile, 'utf-8');
}

// ============================================================================
// MCP Configuration Functions
// ============================================================================

/**
 * Configure claude-mem MCP server in Cursor's mcp.json
 * Preserves existing MCP servers
 */
export function configureCursorMcp(mcpJsonPath: string, mcpServerScriptPath: string): void {
  const dir = join(mcpJsonPath, '..');
  mkdirSync(dir, { recursive: true });

  // Load existing config or create new
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

  // Add claude-mem MCP server
  config.mcpServers['claude-mem'] = {
    command: 'node',
    args: [mcpServerScriptPath]
  };

  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
}

/**
 * Remove claude-mem MCP server from Cursor's mcp.json
 * Preserves other MCP servers
 */
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

// ============================================================================
// JSON Utility Functions (mirrors common.sh logic)
// ============================================================================

/**
 * Parse array field syntax like "workspace_roots[0]"
 * Returns null for simple fields
 */
export function parseArrayField(field: string): { field: string; index: number } | null {
  const match = field.match(/^(.+)\[(\d+)\]$/);
  if (!match) return null;
  return {
    field: match[1],
    index: parseInt(match[2], 10)
  };
}

/**
 * Extract JSON field with fallback (mirrors common.sh json_get)
 * Supports array access like "field[0]"
 */
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

/**
 * Get project name from workspace path (mirrors common.sh get_project_name)
 */
export function getProjectName(workspacePath: string): string {
  if (!workspacePath) return 'unknown-project';

  // Handle Windows drive root (C:\ or C:)
  const driveMatch = workspacePath.match(/^([A-Za-z]):[\\\/]?$/);
  if (driveMatch) {
    return `drive-${driveMatch[1].toUpperCase()}`;
  }

  // Normalize to forward slashes for cross-platform support
  const normalized = workspacePath.replace(/\\/g, '/');
  const name = basename(normalized);

  if (!name) {
    return 'unknown-project';
  }

  return name;
}

/**
 * Check if string is empty/null (mirrors common.sh is_empty)
 * Also treats jq's literal "null" string as empty
 */
export function isEmpty(str: string | null | undefined): boolean {
  if (str === null || str === undefined) return true;
  if (str === '') return true;
  if (str === 'null') return true;
  if (str === 'empty') return true;
  return false;
}

/**
 * URL encode a string (mirrors common.sh url_encode)
 */
export function urlEncode(str: string): string {
  return encodeURIComponent(str);
}

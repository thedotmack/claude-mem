/**
 * Project-level configuration support via .claude-mem.json
 *
 * Supports disabling memory capture at the project level for:
 * - Projects with sensitive data
 * - Temporary experiments
 * - Any project where memory capture should be disabled
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

/**
 * Project-level configuration schema
 */
export interface ProjectConfig {
  enabled: boolean;
  reason?: string;
  captureObservations?: boolean;
  captureSessions?: boolean;
  capturePrompts?: boolean;
}

/**
 * Default configuration when .claude-mem.json doesn't exist
 */
const DEFAULT_CONFIG: ProjectConfig = {
  enabled: true,
  captureObservations: true,
  captureSessions: true,
  capturePrompts: true
};

/**
 * Cache for project configurations to avoid repeated file reads
 */
const configCache = new Map<string, ProjectConfig>();

/**
 * Load project configuration from .claude-mem.json in project root
 *
 * @param cwd - Current working directory (project root)
 * @returns Project configuration with defaults
 */
export function loadProjectConfig(cwd: string): ProjectConfig {
  // Check cache first
  if (configCache.has(cwd)) {
    return configCache.get(cwd)!;
  }

  const configPath = join(cwd, '.claude-mem.json');

  // If no config file, use defaults
  if (!existsSync(configPath)) {
    configCache.set(cwd, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const configData = readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(configData);

    // Validate and merge with defaults
    const config: ProjectConfig = {
      enabled: rawConfig.enabled !== undefined ? Boolean(rawConfig.enabled) : true,
      reason: rawConfig.reason,
      captureObservations: rawConfig.captureObservations !== undefined
        ? Boolean(rawConfig.captureObservations)
        : (rawConfig.enabled !== false),
      captureSessions: rawConfig.captureSessions !== undefined
        ? Boolean(rawConfig.captureSessions)
        : (rawConfig.enabled !== false),
      capturePrompts: rawConfig.capturePrompts !== undefined
        ? Boolean(rawConfig.capturePrompts)
        : (rawConfig.enabled !== false)
    };

    // If enabled is false, override all capture settings
    if (!config.enabled) {
      config.captureObservations = false;
      config.captureSessions = false;
      config.capturePrompts = false;
    }

    configCache.set(cwd, config);

    logger.debug('PROJECT', 'Loaded project configuration', {
      cwd,
      config: JSON.stringify(config)
    });

    return config;
  } catch (error) {
    logger.warn('PROJECT', 'Failed to parse .claude-mem.json, using defaults', { cwd }, error);
    configCache.set(cwd, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

/**
 * Check if memory capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if memory capture is enabled
 */
export function isMemoryEnabled(cwd: string): boolean {
  const config = loadProjectConfig(cwd);
  return config.enabled;
}

/**
 * Check if observation capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if observation capture is enabled
 */
export function canCaptureObservations(cwd: string): boolean {
  const config = loadProjectConfig(cwd);
  return config.enabled && config.captureObservations !== false;
}

/**
 * Check if session capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if session capture is enabled
 */
export function canCaptureSessions(cwd: string): boolean {
  const config = loadProjectConfig(cwd);
  return config.enabled && config.captureSessions !== false;
}

/**
 * Check if prompt capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if prompt capture is enabled
 */
export function canCapturePrompts(cwd: string): boolean {
  const config = loadProjectConfig(cwd);
  return config.enabled && config.capturePrompts !== false;
}

/**
 * Clear the configuration cache (useful for testing)
 */
export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * EndlessModeConfig: Configuration loader for Endless Mode feature
 *
 * Loads settings from settings.json or environment variables with priority:
 * settings.json > environment > defaults
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../../utils/logger.js';

export interface EndlessModeConfigType {
  enabled: boolean;
  fallbackToOriginal: boolean;
  maxLookupTime: number;
  keepRecentToolUses: number;
  maxToolHistoryMB: number;
  enableSynchronousMode: boolean;
}

function getBooleanSetting(settingsValue: any, envValue: string | undefined, defaultValue: boolean): boolean {
  if (settingsValue !== undefined) {
    if (typeof settingsValue === 'boolean') return settingsValue;
    if (typeof settingsValue === 'string') return settingsValue.toLowerCase() === 'true';
  }
  if (envValue !== undefined) return envValue.toLowerCase() === 'true';
  return defaultValue;
}

function getNumberSetting(settingsValue: any, envValue: string | undefined, defaultValue: number): number {
  if (settingsValue !== undefined) {
    if (typeof settingsValue === 'number') return settingsValue;
    if (typeof settingsValue === 'string') {
      const parsed = parseInt(settingsValue, 10);
      if (!isNaN(parsed)) return parsed;
    }
  }
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return defaultValue;
}

/**
 * Get Endless Mode configuration from settings or environment
 */
export function getConfig(): EndlessModeConfigType {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  let settings: any = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (error) {
      logger.warn('CONFIG', 'Failed to parse settings.json, using environment/defaults', {}, error as Error);
    }
  }

  const enabled = getBooleanSetting(
    settings.env?.CLAUDE_MEM_ENDLESS_MODE,
    process.env.CLAUDE_MEM_ENDLESS_MODE,
    false
  );

  const fallbackToOriginal = getBooleanSetting(
    settings.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,
    process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,
    true
  );

  const maxLookupTime = getNumberSetting(
    settings.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,
    process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,
    500
  );

  const keepRecentToolUses = getNumberSetting(
    settings.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,
    process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,
    0
  );

  const maxToolHistoryMB = getNumberSetting(
    settings.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,
    process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,
    50
  );

  const enableSynchronousMode = getBooleanSetting(
    settings.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,
    process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,
    enabled  // Default to same as Endless Mode enabled state
  );

  const config = {
    enabled,
    fallbackToOriginal,
    maxLookupTime,
    keepRecentToolUses,
    maxToolHistoryMB,
    enableSynchronousMode
  };

  if (enabled) {
    logger.info('CONFIG', 'Endless Mode enabled', {
      fallback: fallbackToOriginal,
      maxLookupTime: `${maxLookupTime}ms`,
      keepRecent: keepRecentToolUses,
      maxToolHistoryMB: `${maxToolHistoryMB}MB`,
      syncMode: enableSynchronousMode
    });
  } else {
    logger.debug('CONFIG', 'Endless Mode disabled');
  }

  return config;
}

// Legacy class-based API for backwards compatibility
export class EndlessModeConfig {
  static getConfig = getConfig;
  static clearCache(): void {
    // No-op: caching removed as settings don't change at runtime
  }
}

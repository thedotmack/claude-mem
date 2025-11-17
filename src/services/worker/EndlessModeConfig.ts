/**
 * EndlessModeConfig: Configuration loader for Endless Mode feature
 *
 * Responsibility:
 * - Load Endless Mode settings from settings.json or environment variables
 * - Provide type-safe configuration for TransformLayer
 * - Handle defaults and validation
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { TransformLayerConfig } from './TransformLayer.js';
import { logger } from '../../utils/logger.js';

export class EndlessModeConfig {
  private static config: TransformLayerConfig | null = null;

  /**
   * Get Endless Mode configuration from settings or environment
   */
  static getConfig(): TransformLayerConfig {
    // Return cached config if available
    if (this.config) {
      return this.config;
    }

    // Try loading from settings.json first
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    let settings: any = {};

    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch (error) {
        logger.warn('CONFIG', 'Failed to parse settings.json, using environment/defaults', {}, error as Error);
      }
    }

    // Read configuration with priority: settings.json > environment > defaults
    const enabled = this.getBooleanSetting(
      settings.env?.CLAUDE_MEM_ENDLESS_MODE,
      process.env.CLAUDE_MEM_ENDLESS_MODE,
      false
    );

    const fallbackToOriginal = this.getBooleanSetting(
      settings.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,
      process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,
      true
    );

    const maxLookupTime = this.getNumberSetting(
      settings.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,
      process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,
      500
    );

    const keepRecentToolUses = this.getNumberSetting(
      settings.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,
      process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,
      0
    );

    this.config = {
      enabled,
      fallbackToOriginal,
      maxLookupTime,
      keepRecentToolUses
    };

    if (enabled) {
      logger.info('CONFIG', 'Endless Mode enabled', {
        fallback: fallbackToOriginal,
        maxLookupTime: `${maxLookupTime}ms`,
        keepRecent: keepRecentToolUses
      });
    } else {
      logger.debug('CONFIG', 'Endless Mode disabled');
    }

    return this.config;
  }

  /**
   * Clear cached config (useful for testing or reload)
   */
  static clearCache(): void {
    this.config = null;
  }

  /**
   * Parse boolean setting with defaults
   */
  private static getBooleanSetting(
    settingsValue: any,
    envValue: string | undefined,
    defaultValue: boolean
  ): boolean {
    // Priority 1: settings.json
    if (settingsValue !== undefined) {
      if (typeof settingsValue === 'boolean') return settingsValue;
      if (typeof settingsValue === 'string') {
        return settingsValue.toLowerCase() === 'true';
      }
    }

    // Priority 2: environment variable
    if (envValue !== undefined) {
      return envValue.toLowerCase() === 'true';
    }

    // Priority 3: default
    return defaultValue;
  }

  /**
   * Parse number setting with defaults
   */
  private static getNumberSetting(
    settingsValue: any,
    envValue: string | undefined,
    defaultValue: number
  ): number {
    // Priority 1: settings.json
    if (settingsValue !== undefined) {
      if (typeof settingsValue === 'number') return settingsValue;
      if (typeof settingsValue === 'string') {
        const parsed = parseInt(settingsValue, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }

    // Priority 2: environment variable
    if (envValue !== undefined) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed)) return parsed;
    }

    // Priority 3: default
    return defaultValue;
  }
}

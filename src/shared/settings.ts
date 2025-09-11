import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PathResolver } from './paths.js';
import type { Settings } from './types.js';

/**
 * Settings utilities for managing ~/.claude-mem/settings.json
 */
export class SettingsManager {
  private static settingsPath: string;
  private static cachedSettings: Settings | null = null;

  static {
    const pathResolver = new PathResolver();
    this.settingsPath = join(pathResolver.getConfigDir(), 'settings.json');
  }

  /**
   * Safely read settings.json with error handling
   * Returns empty object if file doesn't exist or is malformed
   */
  static readSettings(): Settings {
    // Return cached settings if available
    if (this.cachedSettings !== null) {
      return this.cachedSettings;
    }

    try {
      if (existsSync(this.settingsPath)) {
        const content = readFileSync(this.settingsPath, 'utf-8');
        const settings = JSON.parse(content) as Settings;
        this.cachedSettings = settings;
        return settings;
      }
    } catch {
      // File is malformed or unreadable - return empty settings
    }

    // File doesn't exist or failed to read
    const emptySettings: Settings = {};
    this.cachedSettings = emptySettings;
    return emptySettings;
  }

  /**
   * Get a specific setting value with optional fallback
   */
  static getSetting<K extends keyof Settings>(
    key: K,
    fallback?: Settings[K]
  ): Settings[K] | undefined {
    const settings = this.readSettings();
    return settings[key] ?? fallback;
  }

  /**
   * Get the Claude binary path from settings
   * Falls back to 'claude' if not found or settings don't exist
   */
  static getClaudePath(): string {
    const claudePath = this.getSetting('claudePath', 'claude');
    return claudePath as string;
  }

  /**
   * Clear cached settings (useful for testing or after settings changes)
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }
}

/**
 * Convenience function to get Claude binary path
 * Can be imported directly for simple use cases
 */
export function getClaudePath(): string {
  return SettingsManager.getClaudePath();
}

/**
 * Convenience function to read all settings
 * Can be imported directly for simple use cases
 */
export function readSettings(): Settings {
  return SettingsManager.readSettings();
}

/**
 * Convenience function to get a specific setting
 * Can be imported directly for simple use cases
 */
export function getSetting<K extends keyof Settings>(
  key: K,
  fallback?: Settings[K]
): Settings[K] | undefined {
  return SettingsManager.getSetting(key, fallback);
}
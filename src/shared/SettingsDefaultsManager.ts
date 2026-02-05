/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { DEFAULT_OBSERVATION_TYPES_STRING, DEFAULT_OBSERVATION_CONCEPTS_STRING } from '../constants/observation-metadata.js';

export interface SettingsDefaults {
  // memU Configuration
  CLAUDE_MEMU_API_KEY: string;
  CLAUDE_MEMU_API_URL: string;
  CLAUDE_MEMU_NAMESPACE: string;
  // Worker Configuration
  CLAUDE_MEMU_WORKER_PORT: string;
  CLAUDE_MEMU_WORKER_HOST: string;
  // System Configuration
  CLAUDE_MEMU_DATA_DIR: string;
  CLAUDE_MEMU_LOG_LEVEL: string;
  // Context Configuration
  CLAUDE_MEMU_CONTEXT_LIMIT: string;
  CLAUDE_MEMU_CONTEXT_TYPES: string;
  CLAUDE_MEMU_CONTEXT_CONCEPTS: string;
  // Feature Toggles
  CLAUDE_MEMU_PROACTIVE_CONTEXT: string;
  CLAUDE_MEMU_SHOW_SUMMARIES: string;
}

export class SettingsDefaultsManager {
  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    // memU Configuration
    CLAUDE_MEMU_API_KEY: '',
    CLAUDE_MEMU_API_URL: 'https://api.memu.so',
    CLAUDE_MEMU_NAMESPACE: 'default',
    // Worker Configuration
    CLAUDE_MEMU_WORKER_PORT: '37777',
    CLAUDE_MEMU_WORKER_HOST: '127.0.0.1',
    // System Configuration
    CLAUDE_MEMU_DATA_DIR: join(homedir(), '.claude-memu'),
    CLAUDE_MEMU_LOG_LEVEL: 'INFO',
    // Context Configuration
    CLAUDE_MEMU_CONTEXT_LIMIT: '20',
    CLAUDE_MEMU_CONTEXT_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    CLAUDE_MEMU_CONTEXT_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Feature Toggles
    CLAUDE_MEMU_PROACTIVE_CONTEXT: 'true',
    CLAUDE_MEMU_SHOW_SUMMARIES: 'true',
  };

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key: keyof SettingsDefaults): string {
    return this.DEFAULTS[key];
  }

  /**
   * Get a setting value with environment variable override
   */
  static getWithEnv(key: keyof SettingsDefaults): string {
    return process.env[key] || this.DEFAULTS[key];
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.getWithEnv(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.getWithEnv(key);
    return value === 'true';
  }

  /**
   * Get the data directory path
   */
  static getDataDir(): string {
    return this.getWithEnv('CLAUDE_MEMU_DATA_DIR');
  }

  /**
   * Get the worker port
   */
  static getWorkerPort(): number {
    return this.getInt('CLAUDE_MEMU_WORKER_PORT');
  }

  /**
   * Get the worker host
   */
  static getWorkerHost(): string {
    return this.getWithEnv('CLAUDE_MEMU_WORKER_HOST');
  }

  /**
   * Get the worker URL
   */
  static getWorkerUrl(): string {
    return `http://${this.getWorkerHost()}:${this.getWorkerPort()}`;
  }

  /**
   * Load settings from file with fallback to defaults
   */
  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          console.log('[SETTINGS] Created settings file:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to create settings file:', error);
        }
        return defaults;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      // Merge file settings with defaults
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (settings[key] !== undefined) {
          result[key] = settings[key];
        }
      }

      return result;
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', error);
      return this.getAllDefaults();
    }
  }

  /**
   * Save settings to file
   */
  static saveToFile(settingsPath: string, settings: Partial<SettingsDefaults>): void {
    try {
      const dir = dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const current = this.loadFromFile(settingsPath);
      const updated = { ...current, ...settings };
      writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf-8');
    } catch (error) {
      console.error('[SETTINGS] Failed to save settings:', error);
    }
  }
}

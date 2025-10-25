/**
 * Settings Service - Centralized configuration management for claude-mem
 *
 * Priority order:
 * 1. Settings file (~/.claude-mem/settings.json)
 * 2. Default values (lowest priority)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export type ModelOption = 'claude-haiku-4-5' | 'claude-sonnet-4-5' | 'claude-opus-4' | 'claude-3-7-sonnet';

export interface Settings {
  /** AI model to use for processing observations */
  model: ModelOption;

  /** Port for worker service HTTP API */
  workerPort: number;

  /** Enable/disable saving observations to database */
  enableMemoryStorage: boolean;

  /** Enable/disable context injection at session start */
  enableContextInjection: boolean;

  /** Number of recent sessions to load in context (was hardcoded to 3) */
  contextDepth: number;
}

export interface SettingsWithDescriptions {
  model: {
    value: ModelOption;
    description: string;
    options: ModelOption[];
  };
  workerPort: {
    value: number;
    description: string;
  };
  enableMemoryStorage: {
    value: boolean;
    description: string;
  };
  enableContextInjection: {
    value: boolean;
    description: string;
  };
  contextDepth: {
    value: number;
    description: string;
  };
}

const DEFAULT_SETTINGS: Settings = {
  model: 'claude-sonnet-4-5',
  workerPort: 37777,
  enableMemoryStorage: true,
  enableContextInjection: true,
  contextDepth: 5,
};

const SETTINGS_DESCRIPTIONS = {
  model: 'AI model to use for processing observations and generating summaries',
  workerPort: 'Port for the background worker service HTTP API',
  enableMemoryStorage: 'Enable/disable saving tool observations to the database',
  enableContextInjection: 'Enable/disable context injection at session start',
  contextDepth: 'Number of recent sessions to load when injecting context (higher = more history, more tokens)',
};

const MODEL_OPTIONS: ModelOption[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-opus-4',
  'claude-3-7-sonnet',
];

export class SettingsService {
  private settingsPath: string;
  private cachedSettings: Settings | null = null;

  constructor(settingsPath?: string) {
    this.settingsPath = settingsPath || join(homedir(), '.claude-mem', 'settings.json');
  }

  /**
   * Load settings from file, merge with defaults
   */
  private loadSettings(): Settings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let fileSettings: Partial<Settings> = {};

    // Try to load from file
    if (existsSync(this.settingsPath)) {
      try {
        const content = readFileSync(this.settingsPath, 'utf-8');
        fileSettings = JSON.parse(content);
      } catch (error: any) {
        // Back up invalid settings file before falling back to defaults
        const backupPath = this.settingsPath + '.bak';
        try {
          renameSync(this.settingsPath, backupPath);
          console.error(`[claude-mem] Failed to parse settings file: ${error.message}`);
          console.error(`[claude-mem] Backed up invalid settings to: ${backupPath}`);
        } catch (backupError: any) {
          console.error(`[claude-mem] Failed to parse settings file: ${error.message}`);
          console.error(`[claude-mem] Could not backup invalid file: ${backupError.message}`);
        }
      }
    }

    // Merge: defaults < file
    const settings: Settings = {
      model: (fileSettings.model as ModelOption) ?? DEFAULT_SETTINGS.model,
      workerPort: fileSettings.workerPort ?? DEFAULT_SETTINGS.workerPort,
      enableMemoryStorage: fileSettings.enableMemoryStorage ?? DEFAULT_SETTINGS.enableMemoryStorage,
      enableContextInjection: fileSettings.enableContextInjection ?? DEFAULT_SETTINGS.enableContextInjection,
      contextDepth: fileSettings.contextDepth ?? DEFAULT_SETTINGS.contextDepth,
    };

    // Validate
    this.validateSettings(settings);

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Validate settings object
   */
  private validateSettings(settings: Settings): void {
    if (!MODEL_OPTIONS.includes(settings.model)) {
      throw new Error(`Invalid model: ${settings.model}. Must be one of: ${MODEL_OPTIONS.join(', ')}`);
    }

    if (typeof settings.workerPort !== 'number' || settings.workerPort < 1 || settings.workerPort > 65535) {
      throw new Error(`Invalid workerPort: ${settings.workerPort}. Must be between 1-65535`);
    }

    if (typeof settings.enableMemoryStorage !== 'boolean') {
      throw new Error(`Invalid enableMemoryStorage: ${settings.enableMemoryStorage}. Must be boolean`);
    }

    if (typeof settings.enableContextInjection !== 'boolean') {
      throw new Error(`Invalid enableContextInjection: ${settings.enableContextInjection}. Must be boolean`);
    }

    if (typeof settings.contextDepth !== 'number' || settings.contextDepth < 1 || settings.contextDepth > 50) {
      throw new Error(`Invalid contextDepth: ${settings.contextDepth}. Must be between 1-50`);
    }
  }

  /**
   * Get current settings
   */
  get(): Settings {
    return this.loadSettings();
  }

  /**
   * Get settings with descriptions (for display/help)
   */
  getWithDescriptions(): SettingsWithDescriptions {
    const settings = this.get();
    return {
      model: {
        value: settings.model,
        description: SETTINGS_DESCRIPTIONS.model,
        options: MODEL_OPTIONS,
      },
      workerPort: {
        value: settings.workerPort,
        description: SETTINGS_DESCRIPTIONS.workerPort,
      },
      enableMemoryStorage: {
        value: settings.enableMemoryStorage,
        description: SETTINGS_DESCRIPTIONS.enableMemoryStorage,
      },
      enableContextInjection: {
        value: settings.enableContextInjection,
        description: SETTINGS_DESCRIPTIONS.enableContextInjection,
      },
      contextDepth: {
        value: settings.contextDepth,
        description: SETTINGS_DESCRIPTIONS.contextDepth,
      },
    };
  }

  /**
   * Update settings (partial update)
   */
  set(updates: Partial<Settings>): void {
    const current = this.get();
    const updated = { ...current, ...updates };

    // Validate before saving
    this.validateSettings(updated);

    // Ensure parent directory exists
    const dir = dirname(this.settingsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write to file atomically
    try {
      const tempPath = this.settingsPath + '.tmp';
      writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8');
      // Atomic rename on POSIX systems
      renameSync(tempPath, this.settingsPath);
      this.cachedSettings = updated;
    } catch (error: any) {
      throw new Error(`Failed to save settings: ${error.message}`);
    }
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.set(DEFAULT_SETTINGS);
  }

  /**
   * Get default settings
   */
  getDefaults(): Settings {
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Get available model options
   */
  getModelOptions(): ModelOption[] {
    return [...MODEL_OPTIONS];
  }

  /**
   * Check if settings file exists
   */
  exists(): boolean {
    return existsSync(this.settingsPath);
  }

  /**
   * Get settings file path
   */
  getPath(): string {
    return this.settingsPath;
  }
}

/**
 * Singleton instance for global access
 */
let instance: SettingsService | null = null;

export function getSettings(): SettingsService {
  if (!instance) {
    instance = new SettingsService();
  }
  return instance;
}

/**
 * Config Service - Manage claude-mem settings
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths } from '../utils/paths';

export interface SettingDefinition {
  key: string;
  defaultValue: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
}

export const DEFAULT_SETTINGS: SettingDefinition[] = [
  { key: 'CLAUDE_MEM_WORKER_PORT', defaultValue: '37777', description: 'Worker service port', type: 'number' },
  { key: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS', defaultValue: '50', description: 'Number of observations in context', type: 'number' },
  { key: 'CLAUDE_MEM_LOG_LEVEL', defaultValue: 'INFO', description: 'Log level (DEBUG|INFO|WARN|ERROR)', type: 'string' },
  { key: 'CLAUDE_MEM_MODEL', defaultValue: 'claude-sonnet-4-5', description: 'AI model for processing', type: 'string' },
  { key: 'CLAUDE_MEM_PROVIDER', defaultValue: 'claude', description: 'AI provider (claude|gemini|openrouter)', type: 'string' },
  { key: 'CLAUDE_MEM_DATA_DIR', defaultValue: paths.claudeMemDir, description: 'Data directory path', type: 'string' },
];

export class ConfigService {
  private settingsPath = paths.claudeMemSettings;

  /**
   * Get all current settings
   */
  getSettings(): Record<string, string> {
    if (!existsSync(this.settingsPath)) {
      return this.getDefaultSettings();
    }

    try {
      return JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
    } catch {
      return this.getDefaultSettings();
    }
  }

  /**
   * Get a specific setting
   */
  get(key: string): string | undefined {
    const settings = this.getSettings();
    return settings[key];
  }

  /**
   * Set a setting
   */
  set(key: string, value: string): boolean {
    try {
      const settings = this.getSettings();
      settings[key] = value;
      this.saveSettings(settings);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.saveSettings(this.getDefaultSettings());
  }

  /**
   * Validate settings
   */
  validate(): { valid: boolean; errors: string[] } {
    const settings = this.getSettings();
    const errors: string[] = [];

    // Validate port
    const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      errors.push(`Invalid port: ${settings.CLAUDE_MEM_WORKER_PORT} (must be 1024-65535)`);
    }

    // Validate log level
    const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    if (!validLevels.includes(settings.CLAUDE_MEM_LOG_LEVEL)) {
      errors.push(`Invalid log level: ${settings.CLAUDE_MEM_LOG_LEVEL}`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get default settings
   */
  private getDefaultSettings(): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const def of DEFAULT_SETTINGS) {
      defaults[def.key] = def.defaultValue;
    }
    return defaults;
  }

  /**
   * Save settings to file
   */
  private saveSettings(settings: Record<string, string>): void {
    const { mkdirSync, dirname } = require('path');
    const dir = dirname(this.settingsPath);
    
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }
}

export const configService = new ConfigService();

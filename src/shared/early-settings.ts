import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';

const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');

interface EarlySettings {
  CLAUDE_MEM_DATA_DIR?: string;
  CLAUDE_MEM_LOG_LEVEL?: string;
  CLAUDE_MEM_PYTHON_VERSION?: string;
  CLAUDE_CODE_PATH?: string;
}

/**
 * Load settings for early-stage modules (paths, logger)
 * Falls back to env vars, then defaults
 */
export function loadEarlySetting(key: keyof EarlySettings, defaultValue: string): string {
  // Priority: settings.json > env var > default
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
      const fileValue = data.env?.[key];
      if (fileValue !== undefined) return fileValue;
    }
  } catch (error) {
    happy_path_error__with_fallback('Failed to load settings file', { error, settingsPath: SETTINGS_PATH, key });
  }

  return process.env[key] || defaultValue;
}

/**
 * Shared utility functions for agent implementations
 *
 * Extracted from SDKAgent to allow reuse across SDKAgent, EndlessRunner,
 * and other agent implementations that need Claude executable discovery
 * and model configuration.
 */

import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/**
 * Find Claude executable (checks settings, then PATH)
 */
export function findClaudeExecutable(): string {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  // 1. Check configured path
  if (settings.CLAUDE_CODE_PATH) {
    // Lazy load fs to keep startup fast
    const { existsSync } = require('fs');
    if (!existsSync(settings.CLAUDE_CODE_PATH)) {
      throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
    }
    return settings.CLAUDE_CODE_PATH;
  }

  // 2. On Windows, prefer "claude.cmd" via PATH to avoid spawn issues with spaces in paths
  if (process.platform === 'win32') {
    try {
      execSync('where claude.cmd', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return 'claude.cmd'; // Let Windows resolve via PATHEXT
    } catch {
      // Fall through to generic error
    }
  }

  // 3. Try auto-detection for non-Windows platforms
  try {
    const claudePath = execSync(
      process.platform === 'win32' ? 'where claude' : 'which claude',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n')[0].trim();

    if (claudePath) return claudePath;
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Fallback behavior - which/where failed, continue to throw clear error
    logger.debug('SDK', 'Claude executable auto-detection failed', {}, error as Error);
  }

  throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
}

/**
 * Get model ID from settings or environment
 */
export function getModelId(): string {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_MODEL;
}

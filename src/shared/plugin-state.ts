
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { parseJsonWithBom } from './atomic-json.js';

const PLUGIN_SETTINGS_KEY = 'claude-mem@thedotmack';

/**
 * Claude Code's plugin toggle. It is host-local: a Qoder hook (marked by
 * qoder-hook-launcher.cjs) runs even when the Claude Code plugin is disabled.
 */
export function isPluginDisabledInClaudeSettings(): boolean {
  if (process.env.CLAUDE_MEM_QODER_HOOK === '1') return false;
  try {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(claudeConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = parseJsonWithBom<Record<string, any>>(raw);
    return settings?.enabledPlugins?.[PLUGIN_SETTINGS_KEY] === false;
  } catch (error: unknown) {
    logger.error('CONFIG', 'Failed to read Claude settings', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

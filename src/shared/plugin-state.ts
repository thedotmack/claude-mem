
import { existsSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { parseJsonWithBom } from './atomic-json.js';

const PLUGIN_SETTINGS_KEY = 'claude-mem@thedotmack';

function resolvePluginSettingsKey(claudeConfigDir: string): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return PLUGIN_SETTINGS_KEY;

  const cacheRoot = join(claudeConfigDir, 'plugins', 'cache');
  const cachePath = relative(cacheRoot, pluginRoot).split(sep);
  const [marketplace, pluginName, version] = cachePath;

  if (
    cachePath.length === 3 &&
    marketplace &&
    pluginName === 'claude-mem' &&
    version &&
    !cachePath.some((part) => part === '..')
  ) {
    return `claude-mem@${marketplace}`;
  }

  return PLUGIN_SETTINGS_KEY;
}

export function isPluginDisabledInClaudeSettings(): boolean {
  try {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(claudeConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = parseJsonWithBom<Record<string, any>>(raw);
    return settings?.enabledPlugins?.[resolvePluginSettingsKey(claudeConfigDir)] === false;
  } catch (error: unknown) {
    logger.error('CONFIG', 'Failed to read Claude settings', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

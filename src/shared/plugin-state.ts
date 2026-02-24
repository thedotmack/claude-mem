/**
 * Plugin state utilities for checking Claude Code's plugin settings.
 * Kept minimal — no heavy dependencies — so hooks can check quickly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PLUGIN_SETTINGS_KEY = 'claude-mem@thedotmack';

/**
 * Check if claude-mem is disabled in Claude Code's settings (#781).
 * Sync read + JSON parse for speed — called before any async work.
 * Returns true only if the plugin is explicitly disabled (enabledPlugins[key] === false).
 */
export function isPluginDisabledInClaudeSettings(): boolean {
  try {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(claudeConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    return settings?.enabledPlugins?.[PLUGIN_SETTINGS_KEY] === false;
  } catch {
    // If settings can't be read/parsed, assume not disabled
    return false;
  }
}

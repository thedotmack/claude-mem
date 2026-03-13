/**
 * Plugin state utilities for checking Claude Code and Droid CLI plugin settings.
 * Kept minimal — no heavy dependencies — so hooks can check quickly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_PLUGIN_SETTINGS_KEY = 'claude-mem@thedotmack';
const FACTORY_PLUGIN_SETTINGS_KEY = 'claude-mem@thedotmack';

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
    return settings?.enabledPlugins?.[CLAUDE_PLUGIN_SETTINGS_KEY] === false;
  } catch {
    return false;
  }
}

/**
 * Check if claude-mem is disabled in Droid CLI (Factory) settings.
 * Checks ~/.factory/settings.json for the plugin's enabled state.
 */
export function isPluginDisabledInFactorySettings(): boolean {
  try {
    const factoryConfigDir = process.env.FACTORY_CONFIG_DIR || join(homedir(), '.factory');
    const settingsPath = join(factoryConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    return settings?.enabledPlugins?.[FACTORY_PLUGIN_SETTINGS_KEY] === false;
  } catch {
    return false;
  }
}

/**
 * Check if claude-mem is disabled in either Claude Code or Droid CLI settings.
 * Returns true if disabled in either platform.
 */
export function isPluginDisabledInAnySettings(): boolean {
  return isPluginDisabledInClaudeSettings() || isPluginDisabledInFactorySettings();
}

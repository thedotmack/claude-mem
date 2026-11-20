
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { parseJsonWithBom } from './atomic-json.js';
import { readTomlBooleanInTable } from './codex-toml.js';

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

/** claude-mem's plugin id in Codex's config.toml (CodexCliInstaller writes it). */
export const CODEX_PLUGIN_CONFIG_TABLE = '[plugins."claude-mem@claude-mem-local"]';

/**
 * Codex's plugin toggle. claude-mem's Codex hooks live in the user's own
 * hooks.json, which Codex runs whether or not the plugin is switched on, so
 * the hook itself has to honour `enabled = false`: someone who turned the
 * plugin off must not keep having prompts and tool activity saved. Only an
 * explicit `false` counts; a missing file or entry is not a choice. Reads the
 * home Codex is running from (CODEX_HOME, which a hook inherits).
 */
export function isPluginDisabledInCodexConfig(): boolean {
  try {
    const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    if (!existsSync(configPath)) return false;
    return readTomlBooleanInTable(readFileSync(configPath, 'utf-8'), CODEX_PLUGIN_CONFIG_TABLE, 'enabled') === false;
  } catch (error: unknown) {
    logger.error('CONFIG', 'Failed to read Codex config', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

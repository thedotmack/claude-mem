/**
 * Node Identity Module
 *
 * Single source of truth for machine identification in multi-machine networking.
 * Priority: env var > settings file > fallback (os.hostname() or default)
 */

import { hostname } from 'os';
import path from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';

let cachedNodeName: string | null = null;

/**
 * Get the node name for this machine.
 * Priority: CLAUDE_MEM_NODE_NAME env var > settings file > os.hostname()
 * Result is cached after first call (same pattern as getWorkerPort()).
 */
export function getNodeName(): string {
  if (cachedNodeName !== null) return cachedNodeName;

  if (process.env.CLAUDE_MEM_NODE_NAME) {
    cachedNodeName = process.env.CLAUDE_MEM_NODE_NAME;
    return cachedNodeName;
  }

  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const settingsPath = path.join(dataDir, 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const nodeName = settings.CLAUDE_MEM_NODE_NAME;
    if (typeof nodeName === 'string' && nodeName.length > 0) {
      cachedNodeName = nodeName;
      return cachedNodeName!;
    }
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to load node name from settings', { error: error instanceof Error ? error.message : String(error) });
  }

  cachedNodeName = hostname();
  return cachedNodeName;
}

/** Clear the cached node name. Call this when settings are updated. */
export function clearNodeNameCache(): void {
  cachedNodeName = null;
}

/**
 * Get the instance name for this deployment (e.g., 'openclaw-legal').
 * Priority: CLAUDE_MEM_INSTANCE_NAME env var > settings file > '' (empty string)
 */
export function getInstanceName(): string {
  if (process.env.CLAUDE_MEM_INSTANCE_NAME) return process.env.CLAUDE_MEM_INSTANCE_NAME;

  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const settingsPath = path.join(dataDir, 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const inst = settings.CLAUDE_MEM_INSTANCE_NAME;
    return (typeof inst === 'string' && inst.length > 0) ? inst : '';
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to load instance name from settings', { error: error instanceof Error ? error.message : String(error) });
  }

  return '';
}

/**
 * Get the network mode for this instance.
 * Priority: CLAUDE_MEM_NETWORK_MODE env var > settings file > 'standalone'
 */
export function getNetworkMode(): 'standalone' | 'server' | 'client' {
  if (process.env.CLAUDE_MEM_NETWORK_MODE) {
    const envMode = process.env.CLAUDE_MEM_NETWORK_MODE;
    if (envMode === 'standalone' || envMode === 'server' || envMode === 'client') return envMode;
  }

  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const settingsPath = path.join(dataDir, 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const mode = settings.CLAUDE_MEM_NETWORK_MODE;
    if (mode === 'server' || mode === 'client') return mode;
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to load network mode from settings', { error: error instanceof Error ? error.message : String(error) });
  }

  return 'standalone';
}

/**
 * Detect the upstream AI provider from environment or request context.
 * Returns: 'claude', 'codex', 'gemini', or the raw value if set explicitly.
 *
 * This is separate from `platform` (which tracks the development tool like
 * claude-code, openclaw, opencode) — llm_source tracks which AI model provider
 * is actually generating responses.
 */
export function getLlmSource(): string {
  // Explicit override via env var
  if (process.env.CLAUDE_MEM_LLM_SOURCE) {
    return process.env.CLAUDE_MEM_LLM_SOURCE;
  }

  // Check settings file (single read for both LLM_SOURCE and PROVIDER)
  let settings: Record<string, any> | null = null;
  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const settingsPath = path.join(dataDir, 'settings.json');
    settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    if (settings.CLAUDE_MEM_LLM_SOURCE) {
      return settings.CLAUDE_MEM_LLM_SOURCE;
    }
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to load LLM source from settings', { error: error instanceof Error ? error.message : String(error) });
  }

  // Detect from environment signals
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return 'codex';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY) return 'gemini';

  // Check CLAUDE_MEM_PROVIDER from the already-loaded settings as final signal
  if (settings?.CLAUDE_MEM_PROVIDER) {
    return settings.CLAUDE_MEM_PROVIDER;
  }

  return 'unknown';
}

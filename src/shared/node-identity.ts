/**
 * Node Identity Module
 *
 * Single source of truth for machine identification in multi-machine networking.
 * Priority: env var > settings file > fallback (os.hostname() or default)
 */

import { hostname } from 'os';
import path from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';

/**
 * Get the node name for this machine.
 * Priority: CLAUDE_MEM_NODE_NAME env var > settings file > os.hostname()
 */
export function getNodeName(): string {
  if (process.env.CLAUDE_MEM_NODE_NAME) return process.env.CLAUDE_MEM_NODE_NAME;

  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const settingsPath = path.join(dataDir, 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    if (settings.CLAUDE_MEM_NODE_NAME) return settings.CLAUDE_MEM_NODE_NAME;
  } catch {
    // settings file missing or corrupt — fall through
  }

  return hostname();
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
    return settings.CLAUDE_MEM_INSTANCE_NAME || '';
  } catch {
    // settings file missing or corrupt — fall through
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
    if (envMode === 'server' || envMode === 'client') return envMode;
  }

  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const settingsPath = path.join(dataDir, 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const mode = settings.CLAUDE_MEM_NETWORK_MODE;
    if (mode === 'server' || mode === 'client') return mode;
  } catch {
    // settings file missing or corrupt — fall through
  }

  return 'standalone';
}

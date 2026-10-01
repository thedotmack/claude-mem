import {
  existsSync,
  readFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
export { ensureDirectoryExists, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { resolvePluginRoot } from '../../shared/worker-utils.js';

export const IS_WINDOWS = process.platform === 'win32';

export function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function marketplaceDirectory(): string {
  return join(claudeConfigDirectory(), 'plugins', 'marketplaces', 'thedotmack');
}

export function pluginsDirectory(): string {
  return join(claudeConfigDirectory(), 'plugins');
}

export function knownMarketplacesPath(): string {
  return join(pluginsDirectory(), 'known_marketplaces.json');
}

export function installedPluginsPath(): string {
  return join(pluginsDirectory(), 'installed_plugins.json');
}

export function claudeSettingsPath(): string {
  return join(claudeConfigDirectory(), 'settings.json');
}

export function pluginCacheRootDirectory(): string {
  return join(pluginsDirectory(), 'cache', 'thedotmack', 'claude-mem');
}

export function pluginCacheDirectory(version: string): string {
  return join(pluginCacheRootDirectory(), version);
}

export function npmPackageRootDirectory(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const root = join(dirname(currentFilePath), '..', '..');
  if (!existsSync(join(root, 'package.json'))) {
    throw new Error(
      `npmPackageRootDirectory: expected package.json at ${root}. ` +
      `Bundle structure may have changed — update the path walk.`,
    );
  }
  return root;
}

export function npmPackagePluginDirectory(): string {
  return join(npmPackageRootDirectory(), 'plugin');
}

export function readPluginVersion(): string {
  const pluginJsonPath = join(npmPackagePluginDirectory(), '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    try {
      const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
      if (pluginJson.version) return pluginJson.version;
    } catch {
      // Fall through to package.json
    }
  }

  const packageJsonPath = join(npmPackageRootDirectory(), 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson.version) return packageJson.version;
    } catch {
      // Unable to read
    }
  }

  return '0.0.0';
}

/**
 * Installed = the shared worker-script oracle finds a plugin root (cache,
 * marketplace, or dev checkout) — the same answer the worker spawner uses, so a
 * working cache-only install is never reported as missing (#3534).
 */
export function isPluginInstalled(): boolean {
  return resolvePluginRoot() !== null;
}

export { readJsonSafe } from '../../utils/json-utils.js';

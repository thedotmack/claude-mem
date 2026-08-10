import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
export { ensureDirectoryExists, writeJsonFileAtomic } from '../../shared/atomic-json.js';

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

export function pluginCacheDirectory(version: string): string {
  return join(pluginsDirectory(), 'cache', 'thedotmack', 'claude-mem', version);
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

function pluginCacheRootDirectory(): string {
  return join(pluginsDirectory(), 'cache', 'thedotmack', 'claude-mem');
}

/**
 * A version directory name (e.g. `13.14.0` or `13.15.0-beta.1`) turned into a
 * key that sorts newest-first, with stable builds ahead of pre-releases at the
 * same version. This mirrors the ordering the runtime hooks use in
 * plugin/hooks/hooks.json so the CLI resolves the same plugin root the hooks do.
 */
function versionSortKey(name: string): string {
  const isStable = name.includes('-') ? '0' : '1';
  const [major = '0', minor = '0', patch = '0'] = name.split('-')[0].split('.');
  const pad = (part: string): string => (part.match(/^\d+/)?.[0] ?? '0').padStart(8, '0');
  return `${pad(major)}${pad(minor)}${pad(patch)}${isStable}`;
}

/**
 * Non-orphaned versioned cache directories, newest first. A cache directory is
 * orphaned when it holds a `.orphaned_at` marker (written when a newer version
 * supersedes it); the hooks skip those, so we do too.
 */
function versionedCacheDirectories(): string[] {
  const cacheRoot = pluginCacheRootDirectory();
  if (!existsSync(cacheRoot)) return [];

  let names: string[];
  try {
    names = readdirSync(cacheRoot);
  } catch {
    return [];
  }

  return names
    .filter((name) => /^\d/.test(name))
    .map((name) => join(cacheRoot, name))
    .filter((dir) => {
      if (existsSync(join(dir, '.orphaned_at'))) return false;
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => versionSortKey(basename(b)).localeCompare(versionSortKey(basename(a))));
}

/**
 * The directory that holds `.claude-plugin/plugin.json`, or null when the given
 * candidate is not an installed plugin root. A candidate may point either at the
 * root itself (cache directories) or at its parent (the marketplace copy nests
 * the plugin under `plugin/`), so both layouts are accepted.
 */
function normalizePluginRoot(candidate: string): string | null {
  const trimmed = candidate.replace(/[\\/]+$/, '');
  const nested = join(trimmed, 'plugin');
  if (existsSync(join(nested, '.claude-plugin', 'plugin.json'))) return nested;
  if (existsSync(join(trimmed, '.claude-plugin', 'plugin.json'))) return trimmed;
  return null;
}

/**
 * The plugin root the runtime actually loads, matching how the hooks in
 * plugin/hooks/hooks.json resolve it: `$CLAUDE_PLUGIN_ROOT` first, then the
 * newest non-orphaned versioned cache directory, then the marketplace copy.
 * Returns null when no installed plugin root is found.
 */
export function resolvePluginRoot(): string | null {
  const candidates: string[] = [];
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT;
  if (envRoot) candidates.push(envRoot);
  candidates.push(...versionedCacheDirectories());
  candidates.push(marketplaceDirectory());

  for (const candidate of candidates) {
    const root = normalizePluginRoot(candidate);
    if (root) return root;
  }
  return null;
}

export function isPluginInstalled(): boolean {
  return resolvePluginRoot() !== null;
}

export { readJsonSafe } from '../../utils/json-utils.js';

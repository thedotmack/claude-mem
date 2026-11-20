import { homedir } from 'os';
import { join } from 'path';
import { readJsonSafe } from '../utils/json-utils.js';

/**
 * Where Claude Code keeps claude-mem's install, and claude-mem's entries in
 * Claude Code's installed_plugins.json: the one rule. The CLI's
 * src/npx-cli/utils/paths.ts re-exports the paths, and
 * src/npx-cli/utils/prune-cache.ts reads the registrations through here.
 *
 * Its own module, with only node and the BOM-aware JSON reader beneath it, so
 * the SessionStart launcher (src/launcher/ensure-launcher.ts, plain node, a
 * small bundle) reads the same locations as the installer without importing
 * paths.ts, which loads the worker resolver (worker-utils.ts). The same reason
 * src/shared/data-dir.ts is its own module.
 */

export function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function pluginsDirectory(): string {
  return join(claudeConfigDirectory(), 'plugins');
}

/** The thedotmack marketplace copy (install.ts copyPluginToMarketplace writes it). */
export function marketplaceDirectory(): string {
  return join(pluginsDirectory(), 'marketplaces', 'thedotmack');
}

export function installedPluginsPath(): string {
  return join(pluginsDirectory(), 'installed_plugins.json');
}

/** claude-mem's key in installed_plugins.json (install.ts registerPlugin). */
const CLAUDE_MEM_PLUGIN_KEY = 'claude-mem@thedotmack';

/**
 * Every entry of claude-mem@thedotmack in installed_plugins.json, of any
 * scope; none for a missing file. Read with readJsonSafe, as install.ts
 * registerPlugin reads it, so a file that does not parse throws.
 */
export function readClaudeMemRegistrationEntries(registryPath: string = installedPluginsPath()): unknown[] {
  const registry = readJsonSafe<{ plugins?: Record<string, unknown> } | null>(registryPath, {});
  const entries = registry?.plugins?.[CLAUDE_MEM_PLUGIN_KEY];
  return Array.isArray(entries) ? entries : [];
}

/** The non-empty installPath of each entry: the folder Claude Code loads claude-mem from. */
export function registeredInstallPathsOf(entries: unknown[]): string[] {
  return entries
    .map(entry => (entry as { installPath?: unknown } | null)?.installPath)
    .filter((installPath): installPath is string => typeof installPath === 'string' && installPath.length > 0);
}

/**
 * Whether an entry of claude-mem@thedotmack is its user-scope one: the entry
 * install.ts registerPlugin writes on every install of every host, and the
 * only one it replaces. Claude Code writes the project- and local-scope ones
 * (`scope` 'project' or 'local', with a projectPath).
 */
export function isUserScopeRegistration(entry: unknown): boolean {
  return (entry as { scope?: unknown } | null)?.scope === 'user';
}

/**
 * The install paths of claude-mem's user-scope entries, the ones install.ts
 * registerPlugin writes on every install of every host. Entries of other
 * scopes (a project's own install) are left out.
 */
export function readUserScopeClaudeMemInstallPaths(registryPath: string = installedPluginsPath()): string[] {
  return registeredInstallPathsOf(readClaudeMemRegistrationEntries(registryPath).filter(isUserScopeRegistration));
}

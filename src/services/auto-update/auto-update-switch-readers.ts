/**
 * The production readers of the auto-update check's gates 1 and 2
 * (auto-update-check.ts readAutoUpdateSwitches): claude-mem's settings.json,
 * the env blocks of Claude Code's user and managed settings, Claude Code's
 * plugin records, and the install's plugin root, every Claude Code path under
 * CLAUDE_CONFIG_DIR (npx-cli/utils/paths.ts). The worker's tick
 * (worker-service.ts buildAutoUpdateCheckDeps) and doctor's Auto-update row
 * both take them from here, so they read the same files the same way.
 *
 * Its own module, not auto-update-check.ts: that one keeps every effect
 * injected, so `bun test` drives the gates with fixtures instead.
 */

import { claudeSettingsPath, installedPluginsPath, knownMarketplacesPath, marketplaceDirectory, pluginCacheRootDirectory } from '../../npx-cli/utils/paths.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { PluginRootResolution } from '../../shared/worker-utils.js';
import {
  claudeCodeManagedSettingsDirectory,
  readAutoUpdateSettings,
  readClaudeCodePluginState,
  readClaudeCodeSettingsEnvBlocks,
  type AutoUpdateSwitchReaders,
} from './auto-update-check.js';

/** The readers of gate 1's switches in settings and the environment (auto-update-check.ts readAutoUpdateSettingsSwitches). */
export type AutoUpdateSettingsReaders = Pick<AutoUpdateSwitchReaders, 'env' | 'readSettings' | 'readClaudeCodeSettingsEnv'>;

/**
 * `env` is where Claude Code's switches are read first: the worker passes its
 * own environment, doctor the one it runs in.
 */
export function productionAutoUpdateSettingsReaders(options: { env: NodeJS.ProcessEnv }): AutoUpdateSettingsReaders {
  return {
    env: options.env,
    readSettings: () => readAutoUpdateSettings(USER_SETTINGS_PATH),
    readClaudeCodeSettingsEnv: () => readClaudeCodeSettingsEnvBlocks({
      userSettingsPath: claudeSettingsPath(),
      managedSettingsDirectory: claudeCodeManagedSettingsDirectory(),
    }),
  };
}

/**
 * All of gates 1 and 2's readers. `resolvePluginRoot` is the install's plugin
 * root (worker-utils.ts resolvePluginRoot), which doctor has already resolved
 * for its other rows.
 */
export function productionAutoUpdateSwitchReaders(options: {
  env: NodeJS.ProcessEnv;
  resolvePluginRoot: () => PluginRootResolution | null;
}): AutoUpdateSwitchReaders {
  return {
    ...productionAutoUpdateSettingsReaders({ env: options.env }),
    // known_marketplaces.json is the file install.ts registerMarketplace
    // writes, read at the same path.
    readClaudeCodePluginState: () => readClaudeCodePluginState({
      userSettingsPath: claudeSettingsPath(),
      installedPluginsPath: installedPluginsPath(),
      knownMarketplacesPath: knownMarketplacesPath(),
    }),
    resolvePluginRoot: options.resolvePluginRoot,
    pluginCacheRootDirectory,
    marketplaceDirectory,
  };
}

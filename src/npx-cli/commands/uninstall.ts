import * as p from '@clack/prompts';
import pc from 'picocolors';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  claudeSettingsPath,
  installedPluginsPath,
  isPluginInstalled,
  knownMarketplacesPath,
  marketplaceDirectory,
  pluginsDirectory,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
import {
  normalizeRuntimeFlag,
  planServerRuntimeUninstall,
  type InstallRuntimeId,
} from './server-runtime-setup.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';

// #2568 — read the runtime the operator installed so uninstall can dispatch to
// the matching teardown. The worker path is the default and is unchanged: only
// when the recorded runtime is the server runtime do we run the extra teardown.
function readSelectedRuntime(): InstallRuntimeId {
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return normalizeRuntimeFlag(settings.CLAUDE_MEM_RUNTIME) ?? 'worker';
  } catch {
    return 'worker';
  }
}

function clearServerRuntimeSettings(keys: readonly string[]): void {
  if (!existsSync(USER_SETTINGS_PATH)) return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
  } catch (error: unknown) {
    console.warn('[uninstall] Could not read settings for server runtime cleanup:', error instanceof Error ? error.message : String(error));
    return;
  }
  const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
  let changed = false;
  for (const key of keys) {
    if (key in flat) {
      delete flat[key];
      changed = true;
    }
  }
  if (changed) {
    try {
      writeFileSync(USER_SETTINGS_PATH, JSON.stringify(flat, null, 2), 'utf-8');
    } catch (error: unknown) {
      console.warn('[uninstall] Could not write settings during server runtime cleanup:', error instanceof Error ? error.message : String(error));
    }
  }
}

function removeMarketplaceDirectory(): boolean {
  const marketplaceDir = marketplaceDirectory();
  if (existsSync(marketplaceDir)) {
    rmSync(marketplaceDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

function removeCacheDirectory(): boolean {
  const cacheDirectory = join(pluginsDirectory(), 'cache', 'thedotmack', 'claude-mem');
  if (existsSync(cacheDirectory)) {
    rmSync(cacheDirectory, { recursive: true, force: true });
    return true;
  }
  return false;
}

function removeFromKnownMarketplaces(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});
  if (knownMarketplaces['thedotmack']) {
    delete knownMarketplaces['thedotmack'];
    writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
  }
}

function removeFromInstalledPlugins(): void {
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});
  if (installedPlugins.plugins?.['claude-mem@thedotmack']) {
    delete installedPlugins.plugins['claude-mem@thedotmack'];
    writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
  }
}

function stripLegacyClaudeMemAlias(): void {
  const home = homedir();
  const candidateFiles = [
    join(home, '.bashrc'),
    join(home, '.zshrc'),
    join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ];

  const aliasLineRegex = /^\s*alias\s+claude-mem\s*=/;

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${filePath}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    const lines = content.split('\n');
    const filtered = lines.filter((line) => !aliasLineRegex.test(line));
    if (filtered.length === lines.length) continue; 
    try {
      writeFileSync(filePath, filtered.join('\n'));
      console.error(`Removed legacy claude-mem alias from ${filePath}`);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not rewrite ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

export function removeFromClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  let dirty = false;

  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    delete settings.enabledPlugins['claude-mem@thedotmack'];
    dirty = true;
  }

  // Symmetric counterpart to disableClaudeAutoMemory() in install.ts. The
  // installer sets env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1" to suppress
  // Claude Code's built-in auto-memory; on uninstall we restore the host
  // CLI's default behavior by removing that key. The value-equality guard
  // (=== '1') ensures we only strip the specific token the installer wrote
  // — if a user had pre-set this key to something else (e.g. '0' to force
  // auto-memory on), or to '1' themselves before installing claude-mem,
  // their intent is preserved. The installer's own no-op-when-already-'1'
  // path means the worst case is leaving behind a value claude-mem would
  // have written anyway. Any other env entries the user added themselves
  // (ANTHROPIC_AUTH_TOKEN, AWS_REGION, etc.) are preserved. If the env
  // block becomes empty as a result, the block itself is dropped to keep
  // settings.json tidy.
  if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
    if (
      Object.prototype.hasOwnProperty.call(settings.env, 'CLAUDE_CODE_DISABLE_AUTO_MEMORY') &&
      settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1'
    ) {
      delete settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      dirty = true;
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
    }
  }

  if (dirty) {
    writeJsonFileAtomic(claudeSettingsPath(), settings);
  }
}

function removeStrayClaudeMemPaths(): number {
  const home = homedir();
  let removedCount = 0;

  const npxRoot = join(home, '.npm', '_npx');
  if (existsSync(npxRoot)) {
    let hashDirs: string[] = [];
    try {
      hashDirs = readdirSync(npxRoot);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${npxRoot}:`, error instanceof Error ? error.message : String(error));
    }
    for (const hashDir of hashDirs) {
      const candidate = join(npxRoot, hashDir, 'node_modules', 'claude-mem');
      if (!existsSync(candidate)) continue;
      try {
        rmSync(candidate, { recursive: true, force: true });
        removedCount++;
      } catch (error: unknown) {
        console.warn(`[uninstall] Could not remove ${candidate}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const cacheRoot = join(home, '.cache', 'claude-cli-nodejs');
  if (existsSync(cacheRoot)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(cacheRoot);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${cacheRoot}:`, error instanceof Error ? error.message : String(error));
    }
    for (const projectDir of projectDirs) {
      const projectPath = join(cacheRoot, projectDir);
      let logEntries: string[] = [];
      try {
        logEntries = readdirSync(projectPath);
      } catch (error: unknown) {
        console.warn(`[uninstall] Could not read ${projectPath}:`, error instanceof Error ? error.message : String(error));
        continue;
      }
      for (const entry of logEntries) {
        if (!entry.startsWith('mcp-logs-plugin-claude-mem-')) continue;
        const logPath = join(projectPath, entry);
        try {
          rmSync(logPath, { recursive: true, force: true });
          removedCount++;
        } catch (error: unknown) {
          console.warn(`[uninstall] Could not remove ${logPath}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  const pluginDataDir = join(home, '.claude', 'plugins', 'data', 'claude-mem-thedotmack');
  if (existsSync(pluginDataDir)) {
    try {
      rmSync(pluginDataDir, { recursive: true, force: true });
      removedCount++;
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not remove ${pluginDataDir}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return removedCount;
}

export async function runUninstallCommand(): Promise<void> {
  p.intro(pc.bgRed(pc.white(' claude-mem uninstall ')));

  if (!isPluginInstalled()) {
    p.log.warn('claude-mem does not appear to be installed.');

    if (process.stdin.isTTY) {
      const shouldCleanup = await p.confirm({
        message: 'Clean up any remaining registration data anyway?',
        initialValue: false,
      });

      if (p.isCancel(shouldCleanup) || !shouldCleanup) {
        p.outro('Nothing to do.');
        return;
      }
    } else {
      p.outro('Nothing to do.');
      return;
    }
  } else if (process.stdin.isTTY) {
    const shouldContinue = await p.confirm({
      message: 'Are you sure you want to uninstall claude-mem?',
      initialValue: false,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel('Uninstall cancelled.');
      return;
    }
  }

  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  try {
    const result = await shutdownWorkerAndWait(workerPort, 10000);
    if (result.workerWasRunning) {
      p.log.info('Worker service stopped.');
    }
  } catch (error: unknown) {
    console.warn('[uninstall] Worker shutdown attempt failed:', error instanceof Error ? error.message : String(error));
  }

  // #2568 — server-runtime teardown. Gated on the installed/selected runtime so
  // the worker uninstall path is completely unchanged. The bundled Docker
  // compose stack lives under the marketplace dir; if it's present we treat the
  // stack as locally managed and instruct teardown (the actual `docker compose
  // down -v` is an operator/CI side effect, not run from this Node process).
  const selectedRuntime = readSelectedRuntime();
  const dockerStackManaged = existsSync(join(marketplaceDirectory(), 'docker-compose.yml'));
  const serverPlan = planServerRuntimeUninstall({ selectedRuntime, dockerStackManaged });
  if (serverPlan.isServerRuntime) {
    if (serverPlan.tearDownDockerStack) {
      p.log.info(
        'Server runtime detected. Tear down the bundled stack with '
          + '`docker compose down -v --remove-orphans` (stops + removes pg + redis/valkey).',
      );
    } else {
      p.log.info('Server runtime detected (externally managed stack — leaving Docker/pg/redis untouched).');
    }
    if (serverPlan.clearServerSettings) {
      clearServerRuntimeSettings(serverPlan.settingsKeysToClear);
      p.log.info('Server runtime settings cleared from ~/.claude-mem/settings.json.');
    }
  }

  await p.tasks([
    {
      title: 'Removing marketplace directory',
      task: async () => {
        const removed = removeMarketplaceDirectory();
        return removed
          ? `Marketplace directory removed ${pc.green('OK')}`
          : `Marketplace directory not found ${pc.dim('skipped')}`;
      },
    },
    {
      title: 'Removing cache directory',
      task: async () => {
        const removed = removeCacheDirectory();
        return removed
          ? `Cache directory removed ${pc.green('OK')}`
          : `Cache directory not found ${pc.dim('skipped')}`;
      },
    },
    {
      title: 'Removing marketplace registration',
      task: async () => {
        removeFromKnownMarketplaces();
        return `Marketplace registration removed ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing plugin registration',
      task: async () => {
        removeFromInstalledPlugins();
        return `Plugin registration removed ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing from Claude settings',
      task: async () => {
        removeFromClaudeSettings();
        return `Claude settings updated ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing legacy claude-mem shell alias',
      task: async () => {
        stripLegacyClaudeMemAlias();
        return `Legacy alias check complete ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing stray claude-mem caches and logs',
      task: async () => {
        const removed = removeStrayClaudeMemPaths();
        return removed > 0
          ? `Stray paths removed: ${removed} ${pc.green('OK')}`
          : `No stray paths found ${pc.dim('skipped')}`;
      },
    },
  ]);

  const ideCleanups: Array<{ label: string; fn: () => Promise<number> | number }> = [
    { label: 'Gemini CLI hooks', fn: async () => {
      const { uninstallGeminiCliHooks } = await import('../../services/integrations/GeminiCliHooksInstaller.js');
      return uninstallGeminiCliHooks();
    }},
    { label: 'Windsurf hooks', fn: async () => {
      const { uninstallWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
      return uninstallWindsurfHooks();
    }},
    { label: 'OpenCode plugin', fn: async () => {
      const { uninstallOpenCodePlugin } = await import('../../services/integrations/OpenCodeInstaller.js');
      return uninstallOpenCodePlugin();
    }},
    { label: 'OpenClaw plugin', fn: async () => {
      const { uninstallOpenClawPlugin } = await import('../../services/integrations/OpenClawInstaller.js');
      return uninstallOpenClawPlugin();
    }},
    { label: 'Codex CLI', fn: async () => {
      const { uninstallCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
      return uninstallCodexCli();
    }},
  ];

  for (const { label, fn } of ideCleanups) {
    try {
      const result = await fn();
      if (result === 0) {
        p.log.info(`${label}: removed.`);
      }
    } catch (error: unknown) {
      console.warn(`[uninstall] ${label} cleanup failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  p.note(
    [
      `Your data directory at ${pc.cyan('~/.claude-mem')} was preserved.`,
      'To remove it manually: rm -rf ~/.claude-mem',
    ].join('\n'),
    'Note',
  );

  // Capture BEFORE the data dir note becomes stale advice: consent and the
  // install ID still live in ~/.claude-mem, which uninstall preserves.
  await captureCliEvent('uninstall_completed', {}, { person: true });

  p.outro(pc.green('claude-mem has been uninstalled.'));
}

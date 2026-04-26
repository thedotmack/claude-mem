/**
 * Uninstall command for `npx claude-mem uninstall`.
 *
 * Removes the plugin from the marketplace directory, cache, plugin
 * registrations, and Claude settings. Optionally cleans up IDE-specific
 * configurations.
 *
 * Pure Node.js — no Bun APIs used.
 */
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
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

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

/**
 * Strip the legacy `claude-mem` shell alias/function from common shell rc files
 * (#2054). The alias used to be added by `installCLI()` in smart-install.js;
 * that function was deleted, but existing users still have the line. This is
 * a one-time best-effort cleanup — idempotent (no-op if the line is absent),
 * and safely matches only lines that BEGIN with `alias claude-mem=` or
 * `function claude-mem` to avoid mangling unrelated code.
 */
function stripLegacyClaudeMemAlias(): void {
  const home = homedir();
  const candidateFiles = [
    join(home, '.bashrc'),
    join(home, '.zshrc'),
    join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ];

  const aliasLineRegex = /^\s*(alias\s+claude-mem\s*=|function\s+claude-mem\b)/;

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
    if (filtered.length === lines.length) continue; // no match — leave file untouched
    try {
      writeFileSync(filePath, filtered.join('\n'));
      console.error(`Removed legacy claude-mem alias from ${filePath}`);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not rewrite ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

function removeFromClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    delete settings.enabledPlugins['claude-mem@thedotmack'];
    writeJsonFileAtomic(claudeSettingsPath(), settings);
  }
}

/**
 * Best-effort cleanup of stray claude-mem residue (#2106 item 4) that
 * accumulates outside of `~/.claude/plugins/marketplaces/thedotmack/`:
 *
 *   - `~/.npm/_npx/<hash>/node_modules/claude-mem` (npx install caches)
 *   - `~/.cache/claude-cli-nodejs/<project>/mcp-logs-plugin-claude-mem-*`
 *   - `~/.claude/plugins/data/claude-mem-thedotmack/`
 *
 * Each step is wrapped in its own try/catch — a failure on one path
 * (e.g. permissions denied on a single npx hash dir) must not abort
 * the rest. We log the failure and continue.
 *
 * Returns the count of paths actually removed (purely for reporting).
 */
function removeStrayClaudeMemPaths(): number {
  const home = homedir();
  let removedCount = 0;

  // 1. ~/.npm/_npx/*/node_modules/claude-mem
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

  // 2. ~/.cache/claude-cli-nodejs/*/mcp-logs-plugin-claude-mem-*
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

  // 3. ~/.claude/plugins/data/claude-mem-thedotmack/
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runUninstallCommand(): Promise<void> {
  p.intro(pc.bgRed(pc.white(' claude-mem uninstall ')));

  if (!isPluginInstalled()) {
    p.log.warn('claude-mem does not appear to be installed.');

    // Still offer to clean up partial state
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

  // Stop the worker and wait for it to exit before deleting files.
  // Resolve port via SettingsDefaultsManager so CLAUDE_MEM_WORKER_PORT env
  // takes priority and the per-UID default (37700 + uid % 100) is used
  // otherwise. Required for multi-account isolation (#2101).
  //
  // The worker's graceful shutdown also stops chroma-mcp via
  // GracefulShutdown -> ChromaMcpManager.stop(), so this single call
  // cascades to the chroma-mcp subprocess as well.
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  try {
    const result = await shutdownWorkerAndWait(workerPort, 10000);
    if (result.workerWasRunning) {
      p.log.info('Worker service stopped.');
    }
  } catch (error: unknown) {
    // shutdownWorkerAndWait swallows its own errors, but guard anyway.
    console.warn('[uninstall] Worker shutdown attempt failed:', error instanceof Error ? error.message : String(error));
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

  // Remove IDE-specific hooks and config (best-effort, each is independent)
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
      // IDE not configured or uninstaller errored — log and continue
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

  p.outro(pc.green('claude-mem has been uninstalled.'));
}

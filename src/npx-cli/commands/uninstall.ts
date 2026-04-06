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
import { existsSync, rmSync } from 'fs';
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

function removeFromClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    delete settings.enabledPlugins['claude-mem@thedotmack'];
    writeJsonFileAtomic(claudeSettingsPath(), settings);
  }
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

  // Stop the worker and wait for it to exit before deleting files
  const workerPort = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
  try {
    await fetch(`http://127.0.0.1:${workerPort}/api/admin/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    // Poll health endpoint until worker is gone (max 10s)
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await fetch(`http://127.0.0.1:${workerPort}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        // Still alive — keep waiting
      } catch {
        break; // Connection refused = worker is gone
      }
    }
    p.log.info('Worker service stopped.');
  } catch {
    // Worker may not be running — that is fine
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
    } catch {
      // IDE not configured or uninstaller errored — skip silently
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

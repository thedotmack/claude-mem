import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { expandHome } from '../utils/system.js';
import { findBinary } from '../utils/dependencies.js';

const MARKETPLACE_DIR = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const PLUGIN_CACHE_DIR = join(PLUGINS_DIR, 'cache', 'thedotmack');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const DATA_DIR = expandHome('~/.claude-mem');

const BUN_EXTRA_PATHS = ['~/.bun/bin/bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

function readJsonFile(filepath: string): any {
  if (!existsSync(filepath)) return {};
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

function writeJsonFile(filepath: string, data: any): void {
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Stop the running worker so file handles (and the port) are released before
 * we delete the plugin directory. Best-effort — failures are non-fatal.
 */
function stopWorker(): void {
  const workerScript = join(MARKETPLACE_DIR, 'plugin', 'scripts', 'worker-service.cjs');
  if (!existsSync(workerScript)) return;

  const bunInfo = findBinary('bun', BUN_EXTRA_PATHS);
  if (!bunInfo.found || !bunInfo.path) return;

  try {
    execSync(`"${bunInfo.path}" "${workerScript}" stop`, { stdio: 'pipe' });
  } catch {
    // Worker may already be stopped — ignore.
  }
}

/**
 * Remove the plugin entry from ~/.claude/settings.json enabledPlugins.
 */
function disablePluginInClaudeSettings(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return;
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH);
  if (settings.enabledPlugins && 'claude-mem@thedotmack' in settings.enabledPlugins) {
    delete settings.enabledPlugins['claude-mem@thedotmack'];
    writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
  }
}

/**
 * Unregister the plugin and marketplace from Claude Code's registries.
 */
function unregisterPlugin(): void {
  const installedPluginsPath = join(PLUGINS_DIR, 'installed_plugins.json');
  if (existsSync(installedPluginsPath)) {
    const installedPlugins = readJsonFile(installedPluginsPath);
    if (installedPlugins.plugins && 'claude-mem@thedotmack' in installedPlugins.plugins) {
      delete installedPlugins.plugins['claude-mem@thedotmack'];
      writeJsonFile(installedPluginsPath, installedPlugins);
    }
  }

  const knownMarketplacesPath = join(PLUGINS_DIR, 'known_marketplaces.json');
  if (existsSync(knownMarketplacesPath)) {
    const knownMarketplaces = readJsonFile(knownMarketplacesPath);
    if ('thedotmack' in knownMarketplaces) {
      delete knownMarketplaces['thedotmack'];
      writeJsonFile(knownMarketplacesPath, knownMarketplaces);
    }
  }
}

function removeDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runUninstall(): Promise<void> {
  const confirmed = await p.confirm({
    message: 'This will remove the claude-mem plugin from Claude Code. Continue?',
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Uninstall cancelled.');
    process.exit(0);
  }

  // Ask up front whether to also delete stored memories, so the whole run is
  // unattended after this point.
  let deleteData = false;
  if (existsSync(DATA_DIR)) {
    const answer = await p.confirm({
      message: `Also delete all stored memories and settings at ${pc.dim(DATA_DIR)}? This cannot be undone.`,
      initialValue: false,
    });
    if (p.isCancel(answer)) {
      p.cancel('Uninstall cancelled.');
      process.exit(0);
    }
    deleteData = answer;
  }

  const s = p.spinner();

  s.start('Stopping worker service...');
  stopWorker();
  s.stop(`Worker stopped ${pc.green('OK')}`);

  s.start('Removing plugin from Claude Code...');
  disablePluginInClaudeSettings();
  unregisterPlugin();
  removeDir(MARKETPLACE_DIR);
  removeDir(PLUGIN_CACHE_DIR);
  s.stop(`Plugin removed ${pc.green('OK')}`);

  if (deleteData) {
    s.start('Deleting stored memories...');
    removeDir(DATA_DIR);
    s.stop(`Memories deleted ${pc.green('OK')}`);
  } else {
    p.log.info(`Stored memories kept at ${pc.dim(DATA_DIR)}`);
  }

  p.outro(pc.green('claude-mem has been uninstalled. Restart Claude Code to finish.'));
}

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { IDE } from './ide-selection.js';

const MARKETPLACE_DIR = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function ensureDir(directoryPath: string): void {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

function copyDirWithExclusions(src: string, dest: string, excludes: string[]): void {
  // Ensure destination exists
  ensureDir(dest);

  // Clear destination directory
  const existing = readdirSync(dest);
  for (const file of existing) {
    const path = join(dest, file);
    rmSync(path, { recursive: true, force: true });
  }

  // Copy with exclusions
  function copyRecursive(srcPath: string, destPath: string) {
    ensureDir(destPath);
    const items = readdirSync(srcPath, { withFileTypes: true });

    for (const item of items) {
      if (excludes.includes(item.name)) continue;

      const srcItem = join(srcPath, item.name);
      const destItem = join(destPath, item.name);

      if (item.isDirectory()) {
        copyRecursive(srcItem, destItem);
      } else {
        cpSync(srcItem, destItem);
      }
    }
  }

  copyRecursive(src, dest);
}

function readJsonFile(filepath: string): any {
  if (!existsSync(filepath)) return {};
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

function writeJsonFile(filepath: string, data: any): void {
  ensureDir(join(filepath, '..'));
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function registerMarketplace(): void {
  const knownMarketplacesPath = join(PLUGINS_DIR, 'known_marketplaces.json');
  const knownMarketplaces = readJsonFile(knownMarketplacesPath);

  knownMarketplaces['thedotmack'] = {
    source: {
      source: 'github',
      repo: 'thedotmack/claude-mem',
    },
    installLocation: MARKETPLACE_DIR,
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };

  ensureDir(PLUGINS_DIR);
  writeJsonFile(knownMarketplacesPath, knownMarketplaces);
}

function registerPlugin(version: string): void {
  const installedPluginsPath = join(PLUGINS_DIR, 'installed_plugins.json');
  const installedPlugins = readJsonFile(installedPluginsPath);

  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};

  const pluginCachePath = join(PLUGINS_DIR, 'cache', 'thedotmack', 'claude-mem', version);
  const now = new Date().toISOString();

  installedPlugins.plugins['claude-mem@thedotmack'] = [
    {
      scope: 'user',
      installPath: pluginCachePath,
      version,
      installedAt: now,
      lastUpdated: now,
    },
  ];

  writeJsonFile(installedPluginsPath, installedPlugins);

  // Copy built plugin to cache directory
  ensureDir(pluginCachePath);
  const pluginSourceDir = join(MARKETPLACE_DIR, 'plugin');
  if (existsSync(pluginSourceDir)) {
    cpSync(pluginSourceDir, pluginCachePath, { recursive: true });
  }
}

function enablePluginInClaudeSettings(): void {
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH);

  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins['claude-mem@thedotmack'] = true;

  writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
}

function getPluginVersion(): string {
  const pluginJsonPath = join(MARKETPLACE_DIR, 'plugin', '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version ?? '1.0.0';
  }
  return '1.0.0';
}

export async function runInstallation(selectedIDEs: IDE[]): Promise<void> {
  const tempDir = join(tmpdir(), `claude-mem-install-${Date.now()}`);

  await p.tasks([
    {
      title: 'Cloning claude-mem repository',
      task: async (message) => {
        message('Downloading latest release...');
        execSync(
          `git clone --depth 1 https://github.com/thedotmack/claude-mem.git "${tempDir}"`,
          { stdio: 'pipe' },
        );
        return `Repository cloned ${pc.green('OK')}`;
      },
    },
    {
      title: 'Installing dependencies',
      task: async (message) => {
        message('Running npm install...');
        execSync('npm install', { cwd: tempDir, stdio: 'pipe' });
        return `Dependencies installed ${pc.green('OK')}`;
      },
    },
    {
      title: 'Building plugin',
      task: async (message) => {
        message('Compiling TypeScript and bundling...');
        execSync('npm run build', { cwd: tempDir, stdio: 'pipe' });
        return `Plugin built ${pc.green('OK')}`;
      },
    },
    {
      title: 'Registering plugin',
      task: async (message) => {
        message('Copying files to marketplace directory...');
        ensureDir(MARKETPLACE_DIR);

        // Copy from cloned repo to marketplace dir, excluding .git and lock files
        copyDirWithExclusions(tempDir, MARKETPLACE_DIR, ['.git', 'package-lock.json', 'bun.lock']);

        message('Registering marketplace...');
        registerMarketplace();

        message('Installing marketplace dependencies...');
        execSync('npm install', { cwd: MARKETPLACE_DIR, stdio: 'pipe' });

        message('Registering plugin in Claude Code...');
        const version = getPluginVersion();
        registerPlugin(version);

        message('Enabling plugin...');
        enablePluginInClaudeSettings();

        return `Plugin registered (v${getPluginVersion()}) ${pc.green('OK')}`;
      },
    },
  ]);

  // Cleanup temp directory (non-critical if it fails)
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Temp dir will be cleaned by OS eventually
  }

  if (selectedIDEs.includes('cursor')) {
    p.log.info('Cursor hook configuration will be available after first launch.');
    p.log.info('Run: claude-mem cursor-setup (coming soon)');
  }
}

export async function runUninstall(): Promise<void> {
  const confirm = await p.confirm({
    message: 'Are you sure you want to uninstall claude-mem? This action cannot be undone.',
    initialValue: false,
  });

  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Uninstall cancelled.');
    return;
  }

  await p.tasks([
    {
      title: 'Disabling plugin',
      task: async (message) => {
        message('Removing from Claude Code...');
        const settings = readJsonFile(CLAUDE_SETTINGS_PATH);

        if (settings.enabledPlugins) {
          delete settings.enabledPlugins['claude-mem@thedotmack'];
        }

        writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
        return `Plugin disabled ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing plugin files',
      task: async (message) => {
        message('Cleaning up marketplace directory...');

        if (existsSync(MARKETPLACE_DIR)) {
          rmSync(MARKETPLACE_DIR, { recursive: true, force: true });
        }

        return `Plugin files removed ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing plugin cache',
      task: async (message) => {
        message('Cleaning up cache...');

        const pluginCacheDir = join(PLUGINS_DIR, 'cache', 'thedotmack', 'claude-mem');
        if (existsSync(pluginCacheDir)) {
          rmSync(pluginCacheDir, { recursive: true, force: true });
        }

        return `Cache cleaned ${pc.green('OK')}`;
      },
    },
    {
      title: 'Removing plugin registration',
      task: async (message) => {
        message('Unregistering from Claude Code...');

        const installedPluginsPath = join(PLUGINS_DIR, 'installed_plugins.json');
        const installedPlugins = readJsonFile(installedPluginsPath);

        if (installedPlugins.plugins) {
          delete installedPlugins.plugins['claude-mem@thedotmack'];
        }

        writeJsonFile(installedPluginsPath, installedPlugins);

        return `Plugin unregistered ${pc.green('OK')}`;
      },
    },
  ]);

  p.outro(pc.green('✓ claude-mem has been uninstalled successfully.'));
}

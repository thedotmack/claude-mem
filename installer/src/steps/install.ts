import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { detectOS, detectArch } from '../utils/system.js';
import type { IDE } from './ide-selection.js';

const MARKETPLACE_DIR = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function ensureDir(directoryPath: string): void {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

function readJsonFile(filepath: string): any {
  if (!existsSync(filepath)) return {};
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return {};
  }
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

async function getLatestVersion(): Promise<string> {
  try {
    const response = await fetch('https://api.github.com/repos/thedotmack/claude-mem/releases/latest');
    if (!response.ok) throw new Error('Failed to fetch latest version');
    const data = await response.json() as { tag_name: string };
    return data.tag_name.replace(/^v/, '');
  } catch (error) {
    // Fallback if API fails
    return '10.3.1'; 
  }
}

export async function runInstallation(selectedIDEs: IDE[]): Promise<void> {
  const os = detectOS();
  const arch = detectArch();
  const version = await getLatestVersion();
  const tempDir = join(tmpdir(), `claude-mem-install-${Date.now()}`);
  ensureDir(tempDir);

  const artifactName = `claude-mem-${os}-${arch}.tar.gz`;
  const artifactUrl = `https://github.com/thedotmack/claude-mem/releases/download/v${version}/${artifactName}`;

  await p.tasks([
    {
      title: `Downloading claude-mem v${version} for ${os}-${arch}`,
      task: async (message) => {
        message(`Fetching ${artifactName}...`);
        const tarPath = join(tempDir, artifactName);
        
        // Use curl for download to handle redirects and progress reliably
        execSync(`curl -fsSL "${artifactUrl}" -o "${tarPath}"`, { stdio: 'pipe' });
        
        message('Extracting artifact...');
        // Artifact contains 'temp-plugin' folder
        execSync(`tar -xzf "${tarPath}" -C "${tempDir}"`, { stdio: 'pipe' });
        
        return `Artifact downloaded and extracted ${pc.green('OK')}`;
      },
    },
    {
      title: 'Registering plugin',
      task: async (message) => {
        message('Copying files to marketplace directory...');
        ensureDir(MARKETPLACE_DIR);

        const extractedPluginDir = join(tempDir, 'temp-plugin');
        const targetPluginDir = join(MARKETPLACE_DIR, 'plugin');
        
        // Ensure target directory exists and is clean
        if (existsSync(targetPluginDir)) {
          rmSync(targetPluginDir, { recursive: true, force: true });
        }
        ensureDir(targetPluginDir);

        // Copy from extracted folder to marketplace dir using portable Node.js cpSync
        cpSync(extractedPluginDir, targetPluginDir, { recursive: true });

        message('Registering marketplace...');
        registerMarketplace();

        message('Registering plugin in Claude Code...');
        registerPlugin(version);

        message('Enabling plugin...');
        enablePluginInClaudeSettings();

        return `Plugin registered (v${version}) ${pc.green('OK')}`;
      },
    },
  ]);

  // Cleanup temp directory
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Non-critical
  }

  if (selectedIDEs.includes('cursor')) {
    p.log.info('Cursor hook configuration will be available after first launch.');
    p.log.info('Run: claude-mem cursor-setup (coming soon)');
  }
}

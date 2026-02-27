/**
 * Install command for `npx claude-mem install`.
 *
 * Replaces the git-clone + build workflow. The npm package already ships
 * a pre-built `plugin/` directory; this command copies it into the right
 * locations and registers it with Claude Code.
 *
 * Pure Node.js — no Bun APIs used.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { cpSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  claudeSettingsPath,
  ensureDirectoryExists,
  installedPluginsPath,
  IS_WINDOWS,
  knownMarketplacesPath,
  marketplaceDirectory,
  npmPackagePluginDirectory,
  npmPackageRootDirectory,
  pluginCacheDirectory,
  pluginsDirectory,
  readJsonFileSafe,
  readPluginVersion,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { detectInstalledIDEs } from './ide-detection.js';

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

function registerMarketplace(): void {
  const knownMarketplaces = readJsonFileSafe(knownMarketplacesPath());

  knownMarketplaces['thedotmack'] = {
    source: {
      source: 'github',
      repo: 'thedotmack/claude-mem',
    },
    installLocation: marketplaceDirectory(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };

  ensureDirectoryExists(pluginsDirectory());
  writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
}

function registerPlugin(version: string): void {
  const installedPlugins = readJsonFileSafe(installedPluginsPath());

  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};

  const cachePath = pluginCacheDirectory(version);
  const now = new Date().toISOString();

  installedPlugins.plugins['claude-mem@thedotmack'] = [
    {
      scope: 'user',
      installPath: cachePath,
      version,
      installedAt: now,
      lastUpdated: now,
    },
  ];

  writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
}

function enablePluginInClaudeSettings(): void {
  const settings = readJsonFileSafe(claudeSettingsPath());

  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins['claude-mem@thedotmack'] = true;

  writeJsonFileAtomic(claudeSettingsPath(), settings);
}

// ---------------------------------------------------------------------------
// IDE setup dispatcher
// ---------------------------------------------------------------------------

async function setupIDEs(selectedIDEs: string[]): Promise<void> {
  for (const ideId of selectedIDEs) {
    switch (ideId) {
      case 'claude-code':
        // Claude Code picks up the plugin via marketplace registration — nothing
        // else to do beyond what registerMarketplace / registerPlugin already did.
        p.log.success('Claude Code: plugin registered via marketplace.');
        break;

      case 'cursor':
        p.log.info('Cursor: hook configuration available after first launch.');
        p.log.info(`  Run: npx claude-mem cursor-setup (coming soon)`);
        break;

      case 'gemini-cli': {
        const { installGeminiCliHooks } = await import('../../services/integrations/GeminiCliHooksInstaller.js');
        const geminiResult = await installGeminiCliHooks();
        if (geminiResult === 0) {
          p.log.success('Gemini CLI: hooks installed.');
        } else {
          p.log.error('Gemini CLI: hook installation failed.');
        }
        break;
      }

      case 'opencode': {
        const { installOpenCodeIntegration } = await import('../../services/integrations/OpenCodeInstaller.js');
        const openCodeResult = await installOpenCodeIntegration();
        if (openCodeResult === 0) {
          p.log.success('OpenCode: plugin installed.');
        } else {
          p.log.error('OpenCode: plugin installation failed.');
        }
        break;
      }

      case 'windsurf': {
        const { installWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
        const windsurfResult = await installWindsurfHooks();
        if (windsurfResult === 0) {
          p.log.success('Windsurf: hooks installed.');
        } else {
          p.log.error('Windsurf: hook installation failed.');
        }
        break;
      }

      case 'openclaw': {
        const { installOpenClawIntegration } = await import('../../services/integrations/OpenClawInstaller.js');
        const openClawResult = await installOpenClawIntegration();
        if (openClawResult === 0) {
          p.log.success('OpenClaw: plugin installed.');
        } else {
          p.log.error('OpenClaw: plugin installation failed.');
        }
        break;
      }

      case 'codex-cli': {
        const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
        const codexResult = await installCodexCli();
        if (codexResult === 0) {
          p.log.success('Codex CLI: transcript watching configured.');
        } else {
          p.log.error('Codex CLI: integration setup failed.');
        }
        break;
      }

      case 'copilot-cli':
      case 'antigravity':
      case 'goose':
      case 'crush':
      case 'roo-code':
      case 'warp': {
        const { MCP_IDE_INSTALLERS } = await import('../../services/integrations/McpIntegrations.js');
        const mcpInstaller = MCP_IDE_INSTALLERS[ideId];
        if (mcpInstaller) {
          const mcpResult = await mcpInstaller();
          const allIDEs = detectInstalledIDEs();
          const ideInfo = allIDEs.find((i) => i.id === ideId);
          const ideLabel = ideInfo?.label ?? ideId;
          if (mcpResult === 0) {
            p.log.success(`${ideLabel}: MCP integration installed.`);
          } else {
            p.log.error(`${ideLabel}: MCP integration failed.`);
          }
        }
        break;
      }

      default: {
        const allIDEs = detectInstalledIDEs();
        const ide = allIDEs.find((i) => i.id === ideId);
        if (ide && !ide.supported) {
          p.log.warn(`Support for ${ide.label} coming soon.`);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive IDE selection
// ---------------------------------------------------------------------------

async function promptForIDESelection(): Promise<string[]> {
  const detectedIDEs = detectInstalledIDEs();
  const detected = detectedIDEs.filter((ide) => ide.detected);

  if (detected.length === 0) {
    p.log.warn('No supported IDEs detected. Installing for Claude Code by default.');
    return ['claude-code'];
  }

  const options = detected.map((ide) => ({
    value: ide.id,
    label: ide.label,
    hint: ide.supported ? ide.hint : 'coming soon',
  }));

  const result = await p.multiselect({
    message: 'Which IDEs do you use?',
    options,
    initialValues: detected
      .filter((ide) => ide.supported)
      .map((ide) => ide.id),
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return result as string[];
}

// ---------------------------------------------------------------------------
// Core copy logic
// ---------------------------------------------------------------------------

function copyPluginToMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();

  ensureDirectoryExists(marketplaceDir);

  // Copy the entire npm package (not just plugin/) so that package.json,
  // node_modules, and scripts are all present in the marketplace dir.
  const packageRoot = npmPackageRootDirectory();
  cpSync(packageRoot, marketplaceDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      // Skip .git and other unnecessary directories
      if (source.includes('.git') && !source.includes('.claude-plugin')) return false;
      if (source.endsWith('.tgz')) return false;
      return true;
    },
  });
}

function copyPluginToCache(version: string): void {
  const sourcePluginDirectory = npmPackagePluginDirectory();
  const cachePath = pluginCacheDirectory(version);

  ensureDirectoryExists(cachePath);
  cpSync(sourcePluginDirectory, cachePath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// npm install in marketplace dir
// ---------------------------------------------------------------------------

function runNpmInstallInMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();
  const packageJsonPath = join(marketplaceDir, 'package.json');

  if (!existsSync(packageJsonPath)) return;

  execSync('npm install --production', {
    cwd: marketplaceDir,
    stdio: 'pipe',
    ...(IS_WINDOWS ? { shell: true as const } : {}),
  });
}

// ---------------------------------------------------------------------------
// Trigger smart-install for Bun / uv
// ---------------------------------------------------------------------------

function runSmartInstall(): void {
  const smartInstallPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'smart-install.js');

  if (!existsSync(smartInstallPath)) {
    p.log.warn('smart-install.js not found — skipping Bun/uv auto-install.');
    return;
  }

  try {
    execSync(`node "${smartInstallPath}"`, {
      stdio: 'inherit',
      ...(IS_WINDOWS ? { shell: true as const } : {}),
    });
  } catch {
    p.log.warn('smart-install encountered an issue. You may need to install Bun/uv manually.');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InstallOptions {
  /** When provided, skip the interactive IDE multi-select and use this IDE. */
  ide?: string;
}

export async function runInstallCommand(options: InstallOptions = {}): Promise<void> {
  const version = readPluginVersion();

  p.intro(pc.bgCyan(pc.black(' claude-mem install ')));
  p.log.info(`Version: ${pc.cyan(version)}`);
  p.log.info(`Platform: ${process.platform} (${process.arch})`);

  // Check for existing installation
  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));

  if (alreadyInstalled) {
    // Read existing version
    try {
      const existingPluginJson = JSON.parse(
        readFileSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      p.log.warn(`Existing installation detected (v${existingPluginJson.version ?? 'unknown'}).`);
    } catch {
      p.log.warn('Existing installation detected.');
    }

    if (process.stdin.isTTY) {
      const shouldContinue = await p.confirm({
        message: 'Overwrite existing installation?',
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel('Installation cancelled.');
        process.exit(0);
      }
    }
  }

  // IDE selection
  let selectedIDEs: string[];
  if (options.ide) {
    selectedIDEs = [options.ide];
    const allIDEs = detectInstalledIDEs();
    const match = allIDEs.find((i) => i.id === options.ide);
    if (match && !match.supported) {
      p.log.error(`Support for ${match.label} coming soon.`);
      process.exit(1);
    }
    if (!match) {
      p.log.error(`Unknown IDE: ${options.ide}`);
      p.log.info(`Available IDEs: ${allIDEs.map((i) => i.id).join(', ')}`);
      process.exit(1);
    }
  } else if (process.stdin.isTTY) {
    selectedIDEs = await promptForIDESelection();
  } else {
    // Non-interactive: default to claude-code
    selectedIDEs = ['claude-code'];
  }

  // Run tasks
  await p.tasks([
    {
      title: 'Copying plugin files',
      task: async (message) => {
        message('Copying to marketplace directory...');
        copyPluginToMarketplace();
        return `Plugin files copied ${pc.green('OK')}`;
      },
    },
    {
      title: 'Caching plugin version',
      task: async (message) => {
        message(`Caching v${version}...`);
        copyPluginToCache(version);
        return `Plugin cached (v${version}) ${pc.green('OK')}`;
      },
    },
    {
      title: 'Registering marketplace',
      task: async () => {
        registerMarketplace();
        return `Marketplace registered ${pc.green('OK')}`;
      },
    },
    {
      title: 'Registering plugin',
      task: async () => {
        registerPlugin(version);
        return `Plugin registered ${pc.green('OK')}`;
      },
    },
    {
      title: 'Enabling plugin in Claude settings',
      task: async () => {
        enablePluginInClaudeSettings();
        return `Plugin enabled ${pc.green('OK')}`;
      },
    },
    {
      title: 'Installing dependencies',
      task: async (message) => {
        message('Running npm install...');
        try {
          runNpmInstallInMarketplace();
          return `Dependencies installed ${pc.green('OK')}`;
        } catch {
          return `Dependencies may need manual install ${pc.yellow('!')}`;
        }
      },
    },
    {
      title: 'Setting up Bun and uv',
      task: async (message) => {
        message('Running smart-install...');
        try {
          runSmartInstall();
          return `Runtime dependencies ready ${pc.green('OK')}`;
        } catch {
          return `Runtime setup may need attention ${pc.yellow('!')}`;
        }
      },
    },
  ]);

  // IDE-specific setup
  await setupIDEs(selectedIDEs);

  // Summary
  const summaryLines = [
    `Version:     ${pc.cyan(version)}`,
    `Plugin dir:  ${pc.cyan(marketplaceDir)}`,
    `IDEs:        ${pc.cyan(selectedIDEs.join(', '))}`,
  ];

  p.note(summaryLines.join('\n'), 'Installation Complete');

  const nextSteps = [
    'Open Claude Code and start a conversation -- memory is automatic!',
    `View your memories: ${pc.underline('http://localhost:37777')}`,
    `Search past work: use ${pc.bold('/mem-search')} in Claude Code`,
    `Start worker: ${pc.bold('npx claude-mem start')}`,
  ];

  p.note(nextSteps.join('\n'), 'Next Steps');

  p.outro(pc.green('claude-mem installed successfully!'));
}

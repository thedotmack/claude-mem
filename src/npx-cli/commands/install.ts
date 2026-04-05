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
import { cpSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

// Non-TTY detection: @clack/prompts crashes with ENOENT in non-TTY environments
const isInteractive = process.stdin.isTTY === true;

/** Run a list of tasks, falling back to plain console.log when non-TTY */
interface TaskDescriptor {
  title: string;
  task: (message: (msg: string) => void) => Promise<string>;
}

async function runTasks(tasks: TaskDescriptor[]): Promise<void> {
  if (isInteractive) {
    await p.tasks(tasks);
  } else {
    for (const t of tasks) {
      const result = await t.task((msg: string) => console.log(`  ${msg}`));
      console.log(`  ${result}`);
    }
  }
}

/** Log helpers that fall back to console.log in non-TTY */
const log = {
  info: (msg: string) => isInteractive ? p.log.info(msg) : console.log(`  ${msg}`),
  success: (msg: string) => isInteractive ? p.log.success(msg) : console.log(`  ${msg}`),
  warn: (msg: string) => isInteractive ? p.log.warn(msg) : console.warn(`  ${msg}`),
  error: (msg: string) => isInteractive ? p.log.error(msg) : console.error(`  ${msg}`),
};
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
  readPluginVersion,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { detectInstalledIDEs } from './ide-detection.js';

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

function registerMarketplace(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});

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
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});

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
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});

  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins['claude-mem@thedotmack'] = true;

  writeJsonFileAtomic(claudeSettingsPath(), settings);
}

// ---------------------------------------------------------------------------
// IDE setup dispatcher
// ---------------------------------------------------------------------------

/** Returns a list of IDE IDs that failed setup. */
async function setupIDEs(selectedIDEs: string[]): Promise<string[]> {
  const failedIDEs: string[] = [];

  for (const ideId of selectedIDEs) {
    switch (ideId) {
      case 'claude-code': {
        // Claude Code uses its native plugin CLI — two commands handle
        // marketplace registration, plugin installation, and enablement.
        try {
          execSync(
            'claude plugin marketplace add thedotmack/claude-mem && claude plugin install claude-mem',
            { stdio: 'inherit' },
          );
          log.success('Claude Code: plugin installed via CLI.');
        } catch {
          log.error('Claude Code: plugin install failed. Is `claude` CLI on your PATH?');
          failedIDEs.push(ideId);
        }
        break;
      }

      case 'cursor': {
        const { installCursorHooks, configureCursorMcp } = await import('../../services/integrations/CursorHooksInstaller.js');
        const cursorResult = await installCursorHooks('user');
        if (cursorResult === 0) {
          const mcpResult = configureCursorMcp('user');
          if (mcpResult === 0) {
            log.success('Cursor: hooks + MCP installed.');
          } else {
            log.success('Cursor: hooks installed (MCP setup failed — run `npx claude-mem cursor mcp` to retry).');
          }
        } else {
          log.error('Cursor: hook installation failed.');
          failedIDEs.push(ideId);
        }
        break;
      }

      case 'gemini-cli': {
        const { installGeminiCliHooks } = await import('../../services/integrations/GeminiCliHooksInstaller.js');
        const geminiResult = await installGeminiCliHooks();
        if (geminiResult === 0) {
          log.success('Gemini CLI: hooks installed.');
        } else {
          log.error('Gemini CLI: hook installation failed.');
          failedIDEs.push(ideId);
        }
        break;
      }

      case 'opencode': {
        const { installOpenCodeIntegration } = await import('../../services/integrations/OpenCodeInstaller.js');
        const openCodeResult = await installOpenCodeIntegration();
        if (openCodeResult === 0) {
          log.success('OpenCode: plugin installed.');
        } else {
          log.error('OpenCode: plugin installation failed.');
          failedIDEs.push(ideId);
        }
        break;
      }

      case 'windsurf': {
        const { installWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
        const windsurfResult = await installWindsurfHooks();
        if (windsurfResult === 0) {
          log.success('Windsurf: hooks installed.');
        } else {
          log.error('Windsurf: hook installation failed.');
          failedIDEs.push(ideId);
        }
        break;
      }

      case 'openclaw': {
        const { installOpenClawIntegration } = await import('../../services/integrations/OpenClawInstaller.js');
        const openClawResult = await installOpenClawIntegration();
        if (openClawResult === 0) {
          log.success('OpenClaw: plugin installed.');
        } else {
          log.error('OpenClaw: plugin installation failed.');
          failedIDEs.push(ideId);
        }
        break;
      }

      case 'codex-cli': {
        const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
        const codexResult = await installCodexCli();
        if (codexResult === 0) {
          log.success('Codex CLI: transcript watching configured.');
        } else {
          log.error('Codex CLI: integration setup failed.');
          failedIDEs.push(ideId);
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
            log.success(`${ideLabel}: MCP integration installed.`);
          } else {
            log.error(`${ideLabel}: MCP integration failed.`);
            failedIDEs.push(ideId);
          }
        }
        break;
      }

      default: {
        const allIDEs = detectInstalledIDEs();
        const ide = allIDEs.find((i) => i.id === ideId);
        if (ide && !ide.supported) {
          log.warn(`Support for ${ide.label} coming soon.`);
        }
        break;
      }
    }
  }

  return failedIDEs;
}

// ---------------------------------------------------------------------------
// Interactive IDE selection
// ---------------------------------------------------------------------------

async function promptForIDESelection(): Promise<string[]> {
  const detectedIDEs = detectInstalledIDEs();
  const detected = detectedIDEs.filter((ide) => ide.detected);

  if (detected.length === 0) {
    log.warn('No supported IDEs detected. Installing for Claude Code by default.');
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
  const packageRoot = npmPackageRootDirectory();

  ensureDirectoryExists(marketplaceDir);

  // Only copy directories/files that are actually needed at runtime.
  // The npm package ships plugin/, package.json, node_modules/, openclaw/, dist/.
  // When running from a dev checkout, the root contains many extra dirs
  // (.claude, .agents, src, docs, etc.) that must NOT be copied.
  const allowedTopLevelEntries = [
    'plugin',
    'package.json',
    'package-lock.json',
    'node_modules',
    'openclaw',
    'dist',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
  ];

  for (const entry of allowedTopLevelEntries) {
    const sourcePath = join(packageRoot, entry);
    const destPath = join(marketplaceDir, entry);
    if (!existsSync(sourcePath)) continue;

    // Clean replace: remove stale files from previous installs before copying
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    cpSync(sourcePath, destPath, {
      recursive: true,
      force: true,
    });
  }
}

function copyPluginToCache(version: string): void {
  const sourcePluginDirectory = npmPackagePluginDirectory();
  const cachePath = pluginCacheDirectory(version);

  // Clean replace: remove stale cache before copying
  rmSync(cachePath, { recursive: true, force: true });
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

function runSmartInstall(): boolean {
  const smartInstallPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'smart-install.js');

  if (!existsSync(smartInstallPath)) {
    log.warn('smart-install.js not found — skipping Bun/uv auto-install.');
    return false;
  }

  try {
    execSync(`node "${smartInstallPath}"`, {
      stdio: 'inherit',
      ...(IS_WINDOWS ? { shell: true as const } : {}),
    });
    return true;
  } catch {
    log.warn('smart-install encountered an issue. You may need to install Bun/uv manually.');
    return false;
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

  if (isInteractive) {
    p.intro(pc.bgCyan(pc.black(' claude-mem install ')));
  } else {
    console.log('claude-mem install');
  }
  log.info(`Version: ${pc.cyan(version)}`);
  log.info(`Platform: ${process.platform} (${process.arch})`);

  // Check for existing installation
  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));

  if (alreadyInstalled) {
    // Read existing version
    try {
      const existingPluginJson = JSON.parse(
        readFileSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      log.warn(`Existing installation detected (v${existingPluginJson.version ?? 'unknown'}).`);
    } catch {
      log.warn('Existing installation detected.');
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
      log.error(`Support for ${match.label} coming soon.`);
      process.exit(1);
    }
    if (!match) {
      log.error(`Unknown IDE: ${options.ide}`);
      log.info(`Available IDEs: ${allIDEs.map((i) => i.id).join(', ')}`);
      process.exit(1);
    }
  } else if (process.stdin.isTTY) {
    selectedIDEs = await promptForIDESelection();
  } else {
    // Non-interactive: default to claude-code
    selectedIDEs = ['claude-code'];
  }

  // Non-Claude-Code IDEs need the manual file copy / registration flow.
  // Claude Code handles its own installation via `claude plugin install`.
  const needsManualInstall = selectedIDEs.some((id) => id !== 'claude-code');

  if (needsManualInstall) {
    await runTasks([
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
          return runSmartInstall()
            ? `Runtime dependencies ready ${pc.green('OK')}`
            : `Runtime setup may need attention ${pc.yellow('!')}`;
        },
      },
    ]);
  }

  // IDE-specific setup
  const failedIDEs = await setupIDEs(selectedIDEs);

  // Summary
  const installStatus = failedIDEs.length > 0 ? 'Installation Partial' : 'Installation Complete';
  const summaryLines = [
    `Version:     ${pc.cyan(version)}`,
    `Plugin dir:  ${pc.cyan(marketplaceDir)}`,
    `IDEs:        ${pc.cyan(selectedIDEs.join(', '))}`,
  ];
  if (failedIDEs.length > 0) {
    summaryLines.push(`Failed:      ${pc.red(failedIDEs.join(', '))}`);
  }

  if (isInteractive) {
    p.note(summaryLines.join('\n'), installStatus);
  } else {
    console.log(`\n  ${installStatus}`);
    summaryLines.forEach(l => console.log(`  ${l}`));
  }

  const workerPort = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
  const nextSteps = [
    'Open Claude Code and start a conversation -- memory is automatic!',
    `View your memories: ${pc.underline(`http://localhost:${workerPort}`)}`,
    `Search past work: use ${pc.bold('/mem-search')} in Claude Code`,
    `Start worker: ${pc.bold('npx claude-mem start')}`,
  ];

  if (isInteractive) {
    p.note(nextSteps.join('\n'), 'Next Steps');
    if (failedIDEs.length > 0) {
      p.outro(pc.yellow('claude-mem installed with some IDE setup failures.'));
    } else {
      p.outro(pc.green('claude-mem installed successfully!'));
    }
  } else {
    console.log('\n  Next Steps');
    nextSteps.forEach(l => console.log(`  ${l}`));
    if (failedIDEs.length > 0) {
      console.log('\nclaude-mem installed with some IDE setup failures.');
      process.exitCode = 1;
    } else {
      console.log('\nclaude-mem installed successfully!');
    }
  }
}

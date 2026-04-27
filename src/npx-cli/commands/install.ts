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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ensureWorkerStarted } from '../../services/worker-spawner.js';

/**
 * Read a setting with file-first priority: ~/.claude-mem/settings.json wins
 * over hardcoded defaults so the installer respects values it just persisted
 * within the same process. Env-var override is preserved by loadFromFile.
 */
function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

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
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
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
        } catch (error: unknown) {
          console.error('[install] Claude Code plugin install error:', error instanceof Error ? error.message : String(error));
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
    // No pre-selection — users must explicitly opt in to each IDE so we
    // never wire up an integration the user did not actually request (#2106).
    initialValues: [],
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
    encoding: 'utf8',
    ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
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
      encoding: 'utf8',
      ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
    });
    return true;
  } catch (error: unknown) {
    console.warn('[install] smart-install error:', error instanceof Error ? error.message : String(error));
    log.warn('smart-install encountered an issue. You may need to install Bun/uv manually.');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings file read-merge-write
// ---------------------------------------------------------------------------

/**
 * Path to the user's claude-mem settings file. Mirrors the resolution used
 * inside SettingsDefaultsManager (CLAUDE_MEM_DATA_DIR default = ~/.claude-mem).
 */
function settingsFilePath(): string {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  return join(dataDir, 'settings.json');
}

/**
 * Read-merge-write only the changed keys to ~/.claude-mem/settings.json.
 *
 * Mirrors the merge-then-write pattern from SettingsDefaultsManager.loadFromFile.
 * Does NOT rewrite the entire defaults object — only the keys passed in `updates`
 * are mutated. On permission/IO failure, logs an error and returns false; never
 * throws and never aborts the install.
 *
 * IMPORTANT: never include API key values in log lines.
 */
function mergeSettings(updates: Record<string, string>): boolean {
  const path = settingsFilePath();
  try {
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        // Handle legacy nested { env: {...} } schema same way the manager does.
        if (parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object') {
          current = { ...parsed.env };
        } else if (parsed && typeof parsed === 'object') {
          current = { ...parsed };
        }
      } catch (parseError: unknown) {
        console.warn('[install] Failed to parse existing settings.json, starting from empty:', parseError instanceof Error ? parseError.message : String(parseError));
        current = {};
      }
    } else {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      current[key] = value;
    }

    writeFileSync(path, JSON.stringify(current, null, 2), 'utf-8');
    return true;
  } catch (error: unknown) {
    log.error(`Failed to write settings to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider and model prompts
// ---------------------------------------------------------------------------

type ProviderId = 'claude' | 'gemini' | 'openrouter';

/**
 * Provider selection prompt (Sub-surface 1.A). Returns the resolved provider id.
 *
 * - On non-TTY: returns the existing setting (or default 'claude') without writes.
 * - On `options.provider`: writes settings non-interactively (key prompt still
 *   fires for non-claude branches when interactive — caller passes flag through).
 * - On interactive: prompts and persists settings on the gemini/openrouter branch.
 *
 * SECURITY: API keys are read with `p.password` (masked). Never logged.
 */
async function promptProvider(options: InstallOptions): Promise<ProviderId> {
  const initialProvider = (getSetting('CLAUDE_MEM_PROVIDER') as ProviderId) || 'claude';

  const persistClaudeProvider = () => {
    const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: 'claude' });
    if (wrote) log.info('Saved provider=claude to ~/.claude-mem/settings.json');
  };

  // Non-interactive: honor explicit --provider flag if present, else leave alone.
  if (!isInteractive) {
    if (options.provider) {
      if (options.provider === 'claude') {
        persistClaudeProvider();
        return 'claude';
      }
      // Non-TTY scripted install with a non-claude provider — we cannot prompt
      // for an API key, but we still persist CLAUDE_MEM_PROVIDER so the worker
      // actually selects the requested provider on next start. The user supplies
      // the API key via env var or by editing settings.json.
      const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: options.provider });
      if (wrote) log.info(`Saved provider=${options.provider} to ~/.claude-mem/settings.json`);
      log.warn(`Provider=${options.provider} requested non-interactively. API key prompt skipped — set CLAUDE_MEM_${options.provider.toUpperCase()}_API_KEY and CLAUDE_MEM_PROVIDER in settings.json or env manually if not already set.`);
      return options.provider;
    }
    return initialProvider;
  }

  let selectedProvider: ProviderId;
  if (options.provider) {
    selectedProvider = options.provider;
  } else {
    const result = await p.select<ProviderId>({
      message: 'Which LLM provider should claude-mem use to compress observations?',
      options: [
        { value: 'claude', label: 'Claude Code auth (default — no extra setup, uses your existing Claude Code subscription)' },
        { value: 'gemini', label: 'Gemini API key (free tier available — fast and cheap)' },
        { value: 'openrouter', label: 'OpenRouter API key (BYO model — wide selection of frontier and open models)' },
      ],
      initialValue: initialProvider,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    selectedProvider = result as ProviderId;
  }

  // Claude branch: persist so we overwrite any previously saved non-claude provider.
  // Defer to model prompt (1.B) for model selection.
  if (selectedProvider === 'claude') {
    persistClaudeProvider();
    return 'claude';
  }

  // gemini / openrouter branch: prompt for API key with masked input.
  const providerLabel = selectedProvider === 'gemini' ? 'Gemini' : 'OpenRouter';
  const keyEnvName = selectedProvider === 'gemini'
    ? 'CLAUDE_MEM_GEMINI_API_KEY'
    : 'CLAUDE_MEM_OPENROUTER_API_KEY';

  // If a non-empty key is already saved, skip silently to avoid clobbering.
  const existingKey = getSetting(keyEnvName as keyof SettingsDefaults) as string | undefined;
  if (existingKey && existingKey.trim().length > 0) {
    const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: selectedProvider });
    if (wrote) log.info(`Saved provider=${selectedProvider} to ~/.claude-mem/settings.json`);
    return selectedProvider;
  }

  const apiKeyResult = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: '*',
    validate: (v: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
  });

  if (p.isCancel(apiKeyResult)) {
    log.warn(`API key prompt cancelled — falling back to Claude provider.`);
    persistClaudeProvider();
    return 'claude';
  }

  const apiKey = String(apiKeyResult).trim();
  const wrote = mergeSettings({
    CLAUDE_MEM_PROVIDER: selectedProvider,
    [keyEnvName]: apiKey,
  });
  if (wrote) {
    // NEVER echo the key. Confirm only the destination.
    log.info(`Saved provider=${selectedProvider} to ~/.claude-mem/settings.json`);
  }
  return selectedProvider;
}

/**
 * Claude model selection prompt (Sub-surface 1.B). Only fires when the active
 * provider is 'claude'. Writes CLAUDE_MEM_MODEL via read-merge-write.
 */
async function promptClaudeModel(options: InstallOptions): Promise<void> {
  const allowed = new Set([
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
  ]);

  if (options.model) {
    if (!allowed.has(options.model)) {
      log.error(`Unknown Claude model: ${options.model}. Allowed: ${[...allowed].join(', ')}`);
      return;
    }
    const wrote = mergeSettings({ CLAUDE_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved Claude model=${options.model} to ~/.claude-mem/settings.json`);
    }
    return;
  }

  if (!isInteractive) return;

  const initialModel = getSetting('CLAUDE_MEM_MODEL');
  const initialValue = allowed.has(initialModel) ? initialModel : 'claude-haiku-4-5-20251001';

  const result = await p.select<string>({
    message: 'Which Claude model should claude-mem use to compress observations?\nThis runs whenever you and Claude touch a file — keep it cheap and fast.',
    options: [
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (recommended — fast, cheap, great for compression)' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced quality and cost)' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7 (highest quality, most expensive)' },
    ],
    initialValue,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }
  const selectedModel = result as string;

  const wrote = mergeSettings({ CLAUDE_MEM_MODEL: selectedModel });
  if (wrote) {
    log.info(`Saved Claude model=${selectedModel} to ~/.claude-mem/settings.json`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InstallOptions {
  /** When provided, skip the interactive IDE multi-select and use this IDE. */
  ide?: string;
  /** When provided, skip the interactive provider prompt and use this provider. */
  provider?: 'claude' | 'gemini' | 'openrouter';
  /** When provided, skip the interactive Claude model prompt and use this model id. */
  model?: string;
  /** When true, skip the worker auto-start runTasks entry. */
  noAutoStart?: boolean;
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
    } catch (error: unknown) {
      console.warn('[install] Failed to read existing plugin version:', error instanceof Error ? error.message : String(error));
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

  // Provider + Claude model selection (1.A + 1.B). Skipped entirely on non-TTY
  // unless --provider/--model flags are supplied (handled inside the helpers).
  const selectedProvider = await promptProvider(options);
  if (selectedProvider === 'claude') {
    await promptClaudeModel(options);
  }

  // Non-Claude-Code IDEs need the manual file copy / registration flow.
  // Claude Code handles its own installation via `claude plugin install`.
  const needsManualInstall = selectedIDEs.some((id) => id !== 'claude-code');

  // Capture worker-start status for the Next Steps branch (1.C → 1.D).
  let workerStarted = false;

  if (needsManualInstall) {
    // Shut down any running worker FIRST so it isn't holding open file
    // handles when we overwrite plugin files (#2106 item 3). Best-effort:
    // helper swallows its own errors when no worker is running.
    const installPort = getSetting('CLAUDE_MEM_WORKER_PORT');
    try {
      const result = await shutdownWorkerAndWait(installPort, 10000);
      if (result.workerWasRunning) {
        log.info('Stopped running worker before overwrite.');
      }
    } catch (error: unknown) {
      console.warn('[install] Pre-overwrite worker shutdown failed:', error instanceof Error ? error.message : String(error));
    }

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
          } catch (error: unknown) {
            console.warn('[install] npm install error:', error instanceof Error ? error.message : String(error));
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

  // Worker auto-start (1.C). Runs AFTER setupIDEs so the marketplace plugin
  // scripts exist on disk on a fresh `claude-code` install. Skipped on non-TTY
  // or with --no-auto-start. Failure does not abort install.
  await runTasks([
    {
      title: 'Starting worker daemon',
      task: async (message) => {
        if (!isInteractive || options.noAutoStart) {
          return isInteractive
            ? `Skipped (--no-auto-start)`
            : `Skipped (non-TTY)`;
        }
        const port = Number(getSetting('CLAUDE_MEM_WORKER_PORT'));
        const scriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
        message(`Spawning worker on port ${port}...`);
        const ok = await ensureWorkerStarted(port, scriptPath);
        workerStarted = ok;
        return ok
          ? `Worker running at http://localhost:${port} ${pc.green('OK')}`
          : `Worker did not start — try \`npx claude-mem start\` manually ${pc.yellow('!')}`;
      },
    },
  ]);

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

  // Resolve port via file-first getSetting so CLAUDE_MEM_WORKER_PORT env
  // takes priority and the per-UID default (37700 + uid % 100) is used
  // otherwise. Required for multi-account isolation (#2101).
  const workerPort = getSetting('CLAUDE_MEM_WORKER_PORT');

  // Probe the actually-bound port (#2106 item 6). smart-install just
  // started the worker; if it's reachable we report the real port the
  // worker bound to. If the probe fails, the worker is still spinning
  // up — say so plainly and exit cleanly. Don't loop, don't block.
  let actualPort: number | string = workerPort;
  let workerReady = false;
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${workerPort}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (healthResponse.ok) {
      workerReady = true;
      try {
        const body = await healthResponse.json() as { port?: number | string };
        if (body && (typeof body.port === 'number' || typeof body.port === 'string')) {
          actualPort = body.port;
        }
      } catch {
        // Health endpoint returned non-JSON — keep using the requested port.
      }
    }
  } catch {
    // Health probe failed — worker may still be starting.
  }

  const nextSteps = (workerStarted || workerReady)
    ? [
        `${pc.green('✓')} Worker running at ${pc.underline(`http://localhost:${actualPort}`)}`,
        `→ Open Claude Code in a project, then run ${pc.bold('/learn-codebase')} to have Claude read your repo end-to-end`,
        `→ Search past work: ask "did we already solve X?" or use ${pc.bold('/mem-search')}`,
        `→ Build focused brains: ${pc.bold('/knowledge-agent')}`,
        `Note: Close all Claude Code sessions before uninstalling, or ${pc.cyan('~/.claude-mem')} will be recreated by active hooks.`,
      ]
    : [
        `${pc.yellow('!')} Worker not yet ready on port ${pc.cyan(String(workerPort))} -- still starting up; check ${pc.bold('claude-mem status')} later, or start manually: ${pc.bold('npx claude-mem start')}`,
        `→ View your memories: ${pc.underline(`http://localhost:${workerPort}`)}`,
        `→ Search past work: ask "did we already solve X?" or use ${pc.bold('/mem-search')}`,
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

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ensureWorkerStarted } from '../../services/worker-spawner.js';
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';

function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

const isInteractive = process.stdin.isTTY === true;

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

async function setupIDEs(selectedIDEs: string[]): Promise<string[]> {
  const failedIDEs: string[] = [];

  for (const ideId of selectedIDEs) {
    switch (ideId) {
      case 'claude-code': {
        log.success('Claude Code: plugin registered (cache + settings written by npx).');
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
    initialValues: [],
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return result as string[];
}

function copyPluginToMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();
  const packageRoot = npmPackageRootDirectory();

  ensureDirectoryExists(marketplaceDir);

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

  rmSync(cachePath, { recursive: true, force: true });
  ensureDirectoryExists(cachePath);
  cpSync(sourcePluginDirectory, cachePath, { recursive: true, force: true });
}

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

function mergeSettings(updates: Record<string, string>): boolean {
  const path = USER_SETTINGS_PATH;
  try {
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
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

type ProviderId = 'claude' | 'gemini' | 'openrouter';

async function promptProvider(options: InstallOptions): Promise<ProviderId> {
  const initialProvider = (getSetting('CLAUDE_MEM_PROVIDER') as ProviderId) || 'claude';

  const persistClaudeProvider = () => {
    const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: 'claude' });
    if (wrote) log.info('Saved provider=claude to ~/.claude-mem/settings.json');
  };

  if (!isInteractive) {
    if (options.provider) {
      if (options.provider === 'claude') {
        persistClaudeProvider();
        return 'claude';
      }
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

  if (selectedProvider === 'claude') {
    persistClaudeProvider();
    return 'claude';
  }

  const providerLabel = selectedProvider === 'gemini' ? 'Gemini' : 'OpenRouter';
  const keyEnvName = selectedProvider === 'gemini'
    ? 'CLAUDE_MEM_GEMINI_API_KEY'
    : 'CLAUDE_MEM_OPENROUTER_API_KEY';

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
    log.info(`Saved provider=${selectedProvider} to ~/.claude-mem/settings.json`);
  }
  return selectedProvider;
}

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

export interface InstallOptions {
  ide?: string;
  provider?: 'claude' | 'gemini' | 'openrouter';
  model?: string;
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

  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));

  if (alreadyInstalled) {
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
    selectedIDEs = ['claude-code'];
  }

  const selectedProvider = await promptProvider(options);
  if (selectedProvider === 'claude') {
    await promptClaudeModel(options);
  }

  let workerStarted = false;

  {
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
        title: 'Setting up runtime (first install can take ~30s)',
        task: async (message) => {
          message('Checking Bun…');
          const { version: bunVersion } = await ensureBun();
          message('Checking uv…');
          const { version: uvVersion } = await ensureUv();
          const cacheDir = pluginCacheDirectory(version);
          if (!isInstallCurrent(cacheDir, version)) {
            message('Installing plugin dependencies…');
            const { bunPath } = await ensureBun();
            await installPluginDependencies(cacheDir, bunPath);
            writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
          }
          return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${pc.green('OK')}`;
        },
      },
    ]);
  }

  const failedIDEs = await setupIDEs(selectedIDEs);

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

  const workerPort = getSetting('CLAUDE_MEM_WORKER_PORT');

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

export async function runRepairCommand(): Promise<void> {
  const version = readPluginVersion();
  const cacheDir = pluginCacheDirectory(version);

  if (isInteractive) {
    p.intro(pc.bgCyan(pc.black(' claude-mem repair ')));
  } else {
    console.log('claude-mem repair');
  }
  log.info(`Version: ${pc.cyan(version)}`);

  await runTasks([
    {
      title: 'Setting up runtime',
      task: async (message) => {
        message('Checking Bun…');
        const { version: bunVersion } = await ensureBun();
        message('Checking uv…');
        const { version: uvVersion } = await ensureUv();
        message('Reinstalling plugin dependencies…');
        const { bunPath } = await ensureBun();
        await installPluginDependencies(cacheDir, bunPath);
        writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
        return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${pc.green('OK')}`;
      },
    },
  ]);

  if (isInteractive) {
    p.outro(pc.green('claude-mem repair complete.'));
  } else {
    console.log('claude-mem repair complete.');
  }
}

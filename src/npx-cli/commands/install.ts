import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'child_process';
import { spawnHidden } from '../../shared/spawn.js';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ensureWorkerStarted, type WorkerStartResult } from '../../services/worker-spawner.js';
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';
import { playBanner } from '../banner.js';

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

async function bufferConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  if (!isInteractive) {
    const result = await fn();
    return { result, output: '' };
  }
  let buffer = '';
  const append = (...args: unknown[]) => {
    buffer += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = append;
  console.error = append;
  console.warn = append;
  try {
    const result = await fn();
    return { result, output: buffer };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
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

function makeIDETask(ideId: string, failedIDEs: string[], pendingErrors: string[]): TaskDescriptor | null {
  const recordFailure = (label: string, output: string) => {
    failedIDEs.push(ideId);
    if (output && output.trim().length > 0) {
      pendingErrors.push(`${label}\n${output.trim()}`);
    }
  };

  switch (ideId) {
    case 'claude-code': {
      return {
        title: 'Claude Code: registering plugin',
        task: async () => `Claude Code: plugin registered ${pc.green('OK')}`,
      };
    }

    case 'cursor': {
      return {
        title: 'Cursor: installing hooks + MCP',
        task: async (message) => {
          message('Loading Cursor installer…');
          const { installCursorHooks, configureCursorMcp } = await import('../../services/integrations/CursorHooksInstaller.js');
          message('Installing Cursor hooks…');
          const { result: cursorResult, output: hooksOutput } = await bufferConsole(() => installCursorHooks('user'));
          if (cursorResult !== 0) {
            recordFailure('Cursor: hook installation failed', hooksOutput);
            return `Cursor: hook installation failed ${pc.red('FAIL')}`;
          }
          message('Configuring Cursor MCP…');
          const { result: mcpResult } = await bufferConsole(async () => configureCursorMcp('user'));
          if (mcpResult === 0) {
            return `Cursor: hooks + MCP installed ${pc.green('OK')}`;
          }
          return `Cursor: hooks installed; MCP setup failed — run \`npx claude-mem cursor mcp\` ${pc.yellow('!')}`;
        },
      };
    }

    case 'gemini-cli': {
      return {
        title: 'Gemini CLI: installing hooks',
        task: async (message) => {
          message('Loading Gemini CLI installer…');
          const { installGeminiCliHooks } = await import('../../services/integrations/GeminiCliHooksInstaller.js');
          message('Installing Gemini CLI hooks…');
          const { result, output } = await bufferConsole(() => installGeminiCliHooks());
          if (result !== 0) {
            recordFailure('Gemini CLI: hook installation failed', output);
            return `Gemini CLI: hook installation failed ${pc.red('FAIL')}`;
          }
          return `Gemini CLI: hooks installed ${pc.green('OK')}`;
        },
      };
    }

    case 'opencode': {
      return {
        title: 'OpenCode: installing plugin',
        task: async (message) => {
          message('Loading OpenCode installer…');
          const { installOpenCodeIntegration } = await import('../../services/integrations/OpenCodeInstaller.js');
          message('Installing OpenCode plugin…');
          const { result, output } = await bufferConsole(() => installOpenCodeIntegration());
          if (result !== 0) {
            recordFailure('OpenCode: plugin installation failed', output);
            return `OpenCode: plugin installation failed ${pc.red('FAIL')}`;
          }
          return `OpenCode: plugin installed ${pc.green('OK')}`;
        },
      };
    }

    case 'windsurf': {
      return {
        title: 'Windsurf: installing hooks',
        task: async (message) => {
          message('Loading Windsurf installer…');
          const { installWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
          message('Installing Windsurf hooks…');
          const { result, output } = await bufferConsole(() => installWindsurfHooks());
          if (result !== 0) {
            recordFailure('Windsurf: hook installation failed', output);
            return `Windsurf: hook installation failed ${pc.red('FAIL')}`;
          }
          return `Windsurf: hooks installed ${pc.green('OK')}`;
        },
      };
    }

    case 'openclaw': {
      return {
        title: 'OpenClaw: installing plugin',
        task: async (message) => {
          message('Loading OpenClaw installer…');
          const { installOpenClawIntegration } = await import('../../services/integrations/OpenClawInstaller.js');
          message('Copying plugin files…');
          const { result, output } = await bufferConsole(() => installOpenClawIntegration());
          if (result !== 0) {
            recordFailure('OpenClaw: plugin installation failed', output);
            return `OpenClaw: plugin installation failed ${pc.red('FAIL')}`;
          }
          return `OpenClaw: plugin installed ${pc.green('OK')}`;
        },
      };
    }

    case 'codex-cli': {
      return {
        title: 'Codex CLI: configuring transcript watching',
        task: async (message) => {
          message('Loading Codex CLI installer…');
          const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
          message('Configuring transcript watching…');
          const { result, output } = await bufferConsole(() => installCodexCli());
          if (result !== 0) {
            recordFailure('Codex CLI: integration setup failed', output);
            return `Codex CLI: integration setup failed ${pc.red('FAIL')}`;
          }
          return `Codex CLI: transcript watching configured ${pc.green('OK')}`;
        },
      };
    }

    case 'copilot-cli':
    case 'antigravity':
    case 'goose':
    case 'roo-code':
    case 'warp': {
      const allIDEs = detectInstalledIDEs();
      const ideInfo = allIDEs.find((i) => i.id === ideId);
      const ideLabel = ideInfo?.label ?? ideId;
      return {
        title: `${ideLabel}: installing MCP integration`,
        task: async (message) => {
          message('Loading MCP installer…');
          const { MCP_IDE_INSTALLERS } = await import('../../services/integrations/McpIntegrations.js');
          const mcpInstaller = MCP_IDE_INSTALLERS[ideId];
          if (!mcpInstaller) {
            return `${ideLabel}: MCP installer not found ${pc.yellow('!')}`;
          }
          message(`Configuring ${ideLabel} MCP…`);
          const { result, output } = await bufferConsole(() => mcpInstaller());
          if (result !== 0) {
            recordFailure(`${ideLabel}: MCP integration failed`, output);
            return `${ideLabel}: MCP integration failed ${pc.red('FAIL')}`;
          }
          return `${ideLabel}: MCP integration installed ${pc.green('OK')}`;
        },
      };
    }

    default: {
      const allIDEs = detectInstalledIDEs();
      const ide = allIDEs.find((i) => i.id === ideId);
      if (ide && !ide.supported) {
        return {
          title: `${ide.label}: skipping`,
          task: async () => `${ide.label}: support coming soon ${pc.yellow('!')}`,
        };
      }
      return null;
    }
  }
}

async function setupIDEs(selectedIDEs: string[]): Promise<string[]> {
  const failedIDEs: string[] = [];
  const pendingErrors: string[] = [];

  const tasks: TaskDescriptor[] = [];
  for (const ideId of selectedIDEs) {
    const taskDescriptor = makeIDETask(ideId, failedIDEs, pendingErrors);
    if (taskDescriptor) tasks.push(taskDescriptor);
  }

  if (tasks.length > 0) {
    await runTasks(tasks);
  }

  for (const errorBlock of pendingErrors) {
    log.warn(errorBlock);
  }

  return failedIDEs;
}

function detectShellConfigFile(): { path: string; shell: 'zsh' | 'bash' | 'fish' } {
  const home = homedir();
  const shellEnv = process.env.SHELL ?? '';

  if (shellEnv.includes('fish')) {
    return { path: join(home, '.config', 'fish', 'config.fish'), shell: 'fish' };
  }
  if (shellEnv.includes('zsh')) {
    return { path: join(home, '.zshrc'), shell: 'zsh' };
  }
  if (process.platform === 'darwin') {
    const bashProfile = join(home, '.bash_profile');
    if (existsSync(bashProfile)) return { path: bashProfile, shell: 'bash' };
  }
  return { path: join(home, '.bashrc'), shell: 'bash' };
}

function applyClaudeCodePathSetupIfNeeded(): void {
  const home = homedir();
  const claudeBinDir = join(home, '.local', 'bin');
  const claudeBinary = join(claudeBinDir, 'claude');

  if (!existsSync(claudeBinary)) return;

  const currentPath = process.env.PATH ?? '';
  const pathEntries = currentPath.split(':');
  if (pathEntries.includes(claudeBinDir)) return;

  const { path: configFile, shell } = detectShellConfigFile();
  const binPathLiteral = '$HOME/.local/bin';
  const exportLine = shell === 'fish'
    ? `set -gx PATH ${claudeBinDir} $PATH`
    : `export PATH="${binPathLiteral}:$PATH"`;

  let existing = '';
  if (existsSync(configFile)) {
    try {
      existing = readFileSync(configFile, 'utf-8');
    } catch (error: unknown) {
      log.warn(`Could not read ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      mkdirSync(dirname(configFile), { recursive: true });
    } catch {
      // Best-effort directory creation.
    }
  }

  if (existing.includes(claudeBinDir) || existing.includes(binPathLiteral)) {
    log.info(`Claude Code PATH already configured in ${configFile}`);
  } else {
    try {
      const trailing = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      const block = `${trailing}\n# Added by claude-mem installer for Claude Code\n${exportLine}\n`;
      writeFileSync(configFile, existing + block, 'utf-8');
      log.success(`Added Claude Code to PATH in ${configFile}`);
    } catch (error: unknown) {
      log.warn(`Could not update ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
      log.info(`Run manually: echo '${exportLine}' >> ${configFile}`);
      return;
    }
  }

  process.env.PATH = `${claudeBinDir}:${currentPath}`;
}

async function installClaudeCode(): Promise<boolean> {
  const command = IS_WINDOWS
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"'
    : 'curl -fsSL https://claude.ai/install.sh | bash';

  const spinner = isInteractive ? p.spinner() : null;
  spinner?.start('Installing Claude Code (this can take a few minutes — downloading the native build)…');

  return new Promise<boolean>((resolve) => {
    let captured = '';
    const child = spawnHidden(command, [], {
      shell: IS_WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash',
      stdio: spinner ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });

    child.stdout?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });

    child.on('error', (error: Error) => {
      spinner?.stop('Claude Code install failed', 1);
      if (captured) process.stderr.write(captured);
      log.error(`Claude Code install failed: ${error.message}`);
      log.info('You can install it manually later: https://claude.ai/install.sh');
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        spinner?.stop('Claude Code install failed', 1);
        if (captured) process.stderr.write(captured);
        log.error(`Claude Code install failed (exit ${code ?? 'unknown'})`);
        log.info('You can install it manually later: https://claude.ai/install.sh');
        resolve(false);
        return;
      }
      spinner?.stop('Claude Code installed');
      if (!IS_WINDOWS) {
        try {
          applyClaudeCodePathSetupIfNeeded();
        } catch (error: unknown) {
          log.warn(`Could not auto-apply PATH setup: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      resolve(true);
    });
  });
}

async function promptForIDESelection(): Promise<string[]> {
  let detectedIDEs = detectInstalledIDEs();
  const claudeCodeInfo = detectedIDEs.find((ide) => ide.id === 'claude-code');

  if (claudeCodeInfo && !claudeCodeInfo.detected) {
    log.warn('Claude Code is not installed. Claude-mem works best in Claude Code, but also works with the IDEs below.');
    const choice = await p.select<'install' | 'skip' | 'cancel'>({
      message: 'Install Claude Code now?',
      options: [
        { value: 'install', label: 'Yes — install Claude Code (recommended)' },
        { value: 'skip', label: 'No — pick another IDE below' },
        { value: 'cancel', label: 'Cancel installation' },
      ],
      initialValue: 'install',
    });
    if (p.isCancel(choice) || choice === 'cancel') {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (choice === 'install') {
      if (await installClaudeCode()) {
        detectedIDEs = detectInstalledIDEs();
      }
    }
  }

  const detected = detectedIDEs.filter((ide) => ide.detected);

  if (detected.length === 0) {
    log.warn('No supported IDEs detected — pick the one(s) you plan to use.');
  }

  const options = detectedIDEs.map((ide) => {
    const detectedTag = ide.detected ? ' [detected]' : '';
    const hint = ide.supported ? `${ide.hint}${detectedTag}` : `coming soon${detectedTag}`;
    return {
      value: ide.id,
      label: ide.label,
      hint,
    };
  });

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
      throw new Error(
        `Unknown Claude model: ${options.model}. Allowed: ${[...allowed].join(', ')}`,
      );
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
    await playBanner();
    p.intro(pc.bgCyan(pc.black(' claude-mem install ')));
  } else {
    console.log('claude-mem install');
  }
  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));

  let existingVersion: string | undefined;
  if (alreadyInstalled) {
    try {
      const existingPluginJson = JSON.parse(
        readFileSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      existingVersion = existingPluginJson.version ?? undefined;
    } catch (error: unknown) {
      console.warn('[install] Failed to read existing plugin version:', error instanceof Error ? error.message : String(error));
    }
  }

  const dot = pc.dim('·');
  const segments = [`${pc.bold('claude-mem')} ${pc.cyan(`v${version}`)}`];
  if (existingVersion && existingVersion !== version) {
    segments.push(`installed ${pc.yellow(`v${existingVersion}`)}`);
  } else if (existingVersion) {
    segments.push(pc.dim('reinstall'));
  }
  log.info(segments.join(` ${dot} `));

  if (alreadyInstalled) {
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

  let workerStartResult: WorkerStartResult = 'dead';
  // Claude Code consumes the marketplace plugin system directly, so any selection
  // (claude-code or otherwise) needs the marketplace + plugin registration steps.
  // The only time we'd skip is a hypothetical no-IDE install, which the prompt above
  // doesn't allow today.
  const needsMarketplace = selectedIDEs.length > 0;

  {
    if (needsMarketplace) {
      const installPort = getSetting('CLAUDE_MEM_WORKER_PORT');
      const shutdownSpinner = isInteractive ? p.spinner() : null;
      shutdownSpinner?.start('Stopping running worker (so we can overwrite cleanly)…');
      try {
        const result = await shutdownWorkerAndWait(installPort, 10000);
        if (shutdownSpinner) {
          shutdownSpinner.stop(
            result.workerWasRunning
              ? 'Stopped running worker before overwrite.'
              : 'No worker running — proceeding.',
          );
        } else if (result.workerWasRunning) {
          log.info('Stopped running worker before overwrite.');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (shutdownSpinner) {
          shutdownSpinner.stop(`Pre-overwrite worker shutdown failed: ${message}`, 1);
        } else {
          console.warn('[install] Pre-overwrite worker shutdown failed:', message);
        }
      }
    }

    const tasks: TaskDescriptor[] = [
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
    ];

    if (needsMarketplace) {
      tasks.unshift({
        title: 'Copying plugin files to marketplace',
        task: async (message) => {
          message('Copying to marketplace directory...');
          copyPluginToMarketplace();
          return `Plugin files copied ${pc.green('OK')}`;
        },
      });
      tasks.push({
        title: 'Installing marketplace dependencies',
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
      });
    }

    await runTasks(tasks);
  }

  const failedIDEs = await setupIDEs(selectedIDEs);

  const autoStartSkipped = !isInteractive || options.noAutoStart;

  await runTasks([
    {
      title: 'Starting worker daemon',
      task: async (message) => {
        if (autoStartSkipped) {
          return isInteractive
            ? `Skipped (--no-auto-start)`
            : `Skipped (non-TTY)`;
        }
        const port = Number(getSetting('CLAUDE_MEM_WORKER_PORT'));
        const marketplaceScriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
        const cacheScriptPath = join(pluginCacheDirectory(version), 'scripts', 'worker-service.cjs');
        const scriptPath = existsSync(marketplaceScriptPath) ? marketplaceScriptPath : cacheScriptPath;
        message(`Spawning worker on port ${port}...`);
        workerStartResult = await ensureWorkerStarted(port, scriptPath);
        switch (workerStartResult) {
          case 'ready':
            return `Worker ready at http://localhost:${port} ${pc.green('OK')}`;
          case 'warming':
            return `Worker starting on port ${port} — finishing in background ${pc.yellow('⏳')}`;
          case 'dead':
            return `Worker did not start — try \`npx claude-mem start\` manually ${pc.yellow('!')}`;
        }
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
  // Don't poll the worker or imply it's "still starting" when autostart was
  // intentionally skipped (--no-auto-start, or non-interactive default). The
  // user knows they have to start it themselves; lying about a starting worker
  // is misleading.
  if (!autoStartSkipped) {
    const healthSpinner = isInteractive ? p.spinner() : null;
    healthSpinner?.start(`Verifying worker on port ${workerPort}…`);
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
      healthSpinner?.stop(
        workerReady
          ? `Worker ready at http://localhost:${actualPort}`
          : `Worker reachable but not ready on port ${workerPort}`,
      );
    } catch {
      healthSpinner?.stop(`Worker not yet responding on port ${workerPort} (still starting)`);
    }
  }

  const finalWorkerState = workerStartResult as WorkerStartResult;
  const workerAlive = finalWorkerState !== 'dead' || workerReady;
  const workerHeadline = autoStartSkipped
    ? `${pc.yellow('!')} Worker autostart skipped — start it manually with ${pc.bold('npx claude-mem start')}`
    : workerReady || finalWorkerState === 'ready'
      ? `${pc.green('✓')} Worker running at ${pc.underline(`http://localhost:${actualPort}`)}`
      : `${pc.yellow('⏳')} Worker starting at ${pc.underline(`http://localhost:${actualPort}`)} — give it ~30s, then refresh`;
  const nextSteps = autoStartSkipped
    ? [
        workerHeadline,
        ``,
        `${pc.bold('First success:')} once the worker is running, keep ${pc.underline(`http://localhost:${workerPort}`)} open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.claude-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CLAUDE_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.claude-mem will be recreated by active hooks.')}`,
      ]
    : workerAlive
    ? [
        workerHeadline,
        ``,
        `${pc.bold('First success:')} keep that URL open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.claude-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CLAUDE_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.claude-mem will be recreated by active hooks.')}`,
      ]
    : [
        `${pc.yellow('!')} Worker not yet ready on port ${pc.cyan(String(workerPort))} -- still starting up; check ${pc.bold('claude-mem status')} later, or start manually: ${pc.bold('npx claude-mem start')}`,
        ``,
        `${pc.bold('First success:')} keep ${pc.underline(`http://localhost:${workerPort}`)} open in a browser, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
        ``,
        `${pc.bold('Two paths from here:')}`,
        `  ${pc.cyan('A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
        `  ${pc.cyan('B.')} Front-load it: open Claude Code and run ${pc.bold('/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
        ``,
        `Memory injection starts on your second session in a project.`,
        `Everything stays in ${pc.cyan('~/.claude-mem')} on this machine.`,
        ``,
        `${pc.dim('How it works: /how-it-works   ·   Disable first-session hint: CLAUDE_MEM_WELCOME_HINT_ENABLED=false')}`,
        `${pc.dim('Note: close all Claude Code sessions before uninstalling, or ~/.claude-mem will be recreated by active hooks.')}`,
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
        // Repair must regenerate the cache if it was wiped (e.g. user ran
        // `rm -rf ~/.claude/plugins/cache`). Without this, bun install would
        // fail immediately with no package.json to install against.
        if (!existsSync(join(cacheDir, 'package.json'))) {
          message('Cache missing — repopulating from npm package…');
          copyPluginToCache(version);
        }
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

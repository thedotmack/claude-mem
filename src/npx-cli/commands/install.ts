import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { loadTelemetryConfig, saveTelemetryConfig } from '../../services/telemetry/consent.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { buildSpawnSyncInvocation, lookupWindowsCommand, spawnHidden } from '../../shared/spawn.js';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { parseJsonWithBom, writeJsonFileAtomic as writeSettingsJsonAtomic } from '../../shared/atomic-json.js';
import { loadClaudeMemEnv, saveClaudeMemEnv } from '../../shared/EnvManager.js';
import { ensureWorkerStarted, type WorkerStartResult } from '../../services/worker-spawner.js';
import { formatHostForUrl } from '../../shared/worker-utils.js';
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';
import { playBanner } from '../banner.js';
import { normalizeRuntimeFlag } from './server-runtime-setup.js';
import { ErrorSeverity } from '../install/error-taxonomy.js';
import {
  createInstallSummary,
  flushSummary,
  installerError,
  InstallAbortError,
  type InstallSummary,
} from '../install/error-reporter.js';
import { extractEresolveBlock, isEresolve, runNpmStrict } from '../install/npm-install-helper.js';
import {
  buildProviderLabels,
  CMEM_INSTALLER_OAUTH_POLL_URL,
  CMEM_INSTALLER_OAUTH_START_URL,
  CMEM_PRO_BASE_URL,
  CMEM_PRO_MODEL,
  PROVIDER_PROMPT_MESSAGE,
} from '../cmem-pro-costs.js';
import { clearProFallback, isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import { PRO_TRIAL_PITCH, proTrialUrl } from '../../shared/pro-promo.js';
import {
  buildAnthropicMaxLocalSettings,
  buildCmemActivationSettings,
  buildHostObserverSettings,
  buildNonInteractiveOpenRouterSettings,
  buildPersonalOpenRouterSettings,
  resolveCmemMemoryCredentials,
} from '../cmem-memory-credentials.js';

function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

const isInteractive = process.stdin.isTTY === true;

/**
 * Which package manager launched this CLI (npx / bunx / pnpm / yarn), parsed
 * from npm_config_user_agent ("npm/10.8.2 node/v22.14.0 darwin arm64 ...").
 * Bounded enum for telemetry — never raw user-agent content.
 */
function detectInstallMethod(): string {
  const agent = process.env.npm_config_user_agent ?? '';
  const name = agent.split('/')[0]?.trim().toLowerCase();
  if (name === 'npm' || name === 'bun' || name === 'pnpm' || name === 'yarn') return name;
  if (process.versions.bun) return 'bun';
  return 'unknown';
}

/**
 * Claude Code CLI version, best effort. Hook/plugin behavior differs across
 * Claude Code releases, so this is key for diagnosing installs whose worker
 * never starts. Missing binary or timeout → undefined (dropped by scrubber).
 */
function readClaudeCodeVersionOutput(): string | undefined {
  const command = process.platform === 'win32'
    ? (lookupWindowsCommand('claude') ?? 'claude.cmd')
    : 'claude';
  const invocation = buildSpawnSyncInvocation(command, ['--version'], {
    timeout: 5000,
    encoding: 'utf-8',
  });
  const result = spawnSync(invocation.command, invocation.args, invocation.options);
  const output = (result.stdout ?? '').trim();
  if (!output) return undefined;
  // "2.0.14 (Claude Code)" → "2.0.14"
  return output.split(/\s+/)[0].slice(0, 40) || undefined;
}

function detectClaudeCodeVersion(): string | undefined {
  try {
    return readClaudeCodeVersionOutput();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn('[install] Could not detect Claude Code version:', err);
    return undefined;
  }
}

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

/**
 * Tick a task's spinner message with elapsed seconds. The multi-minute
 * dependency installs used to sit on one static message (and previously a
 * blocked event loop), which read as a stalled install. Returns a stop
 * function for a finally block. Non-interactive runs get the label once —
 * a per-second console.log line would spam CI logs.
 */
function startHeartbeat(message: (msg: string) => void, label: string): () => void {
  message(label);
  if (!isInteractive) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    message(`${label} ${styleText('dim', `(${elapsed}s — still working)`)}`);
  }, 1000);
  return () => clearInterval(timer);
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
import { readFlatSettings } from '../utils/settings.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
import { detectInstalledIDEs } from './ide-detection.js';
import { checkWindowsGitBash } from '../utils/windows-git-bash-preflight.js';

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

/**
 * Disable Claude Code's built-in auto-memory by setting CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
 * in ~/.claude/settings.json `env` block. claude-mem provides its own persistent memory
 * via plugin hooks; the built-in MEMORY.md system creates shadow state outside the user's
 * control and competes with claude-mem for context window tokens.
 *
 * Per anthropics/claude-code#23544, the env var is the only supported toggle.
 *
 * Idempotent: only writes when not already set, preserves existing env vars and other
 * settings keys, and merges atomically. Returns true when a write happened (for the
 * caller to surface in the install summary).
 */
export function disableClaudeAutoMemory(): boolean {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  const env = (settings.env && typeof settings.env === 'object') ? settings.env : {};

  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') {
    return false;
  }

  settings.env = { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  writeJsonFileAtomic(claudeSettingsPath(), settings);
  return true;
}

type ClaudeAutoMemoryChoice = 'disable' | 'leave-enabled' | 'not-applicable';

async function resolveClaudeAutoMemoryChoice(
  selectedIDEs: string[],
  options: InstallOptions,
): Promise<ClaudeAutoMemoryChoice> {
  if (!selectedIDEs.includes('claude-code')) {
    return 'not-applicable';
  }

  if (options.disableAutoMemory) {
    return 'disable';
  }

  if (!isInteractive) {
    return 'leave-enabled';
  }

  const choice = await p.select<'leave-enabled' | 'disable'>({
    message: 'Disable Claude Code auto-memory?',
    options: [
      {
        value: 'leave-enabled',
        label: 'Leave enabled',
        hint: 'Recommended; keeps Claude Code native memory visible on startup.',
      },
      {
        value: 'disable',
        label: 'Disable auto-memory',
        hint: 'Only if you explicitly want claude-mem to replace native startup memory.',
      },
    ],
    initialValue: 'leave-enabled',
  });

  if (p.isCancel(choice)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return choice;
}

function makeIDETask(ideId: string, summary: InstallSummary): TaskDescriptor | null {
  const recordFailure = (label: string, output: string) => {
    // Route every per-IDE failure through the central decision point. A single
    // IDE failure is FAIL_LOUD_PER_IDE (partial install); the summary headline
    // and exit code reflect it. The stderr is preserved verbatim in `details`.
    installerError(ErrorSeverity.FAIL_LOUD_PER_IDE, {
      component: label,
      ide: ideId,
      phase: 'ide-install',
      cause: new Error(label),
      details: output && output.trim().length > 0 ? output.trim().slice(0, 4000) : undefined,
    }, summary);
  };

  switch (ideId) {
    case 'claude-code': {
      return {
        title: 'Claude Code: registering plugin',
        task: async () => `Claude Code: plugin registered ${styleText('green', 'OK')}`,
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
            return `Cursor: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          message('Configuring Cursor MCP…');
          const { result: mcpResult } = await bufferConsole(async () => configureCursorMcp('user'));
          if (mcpResult === 0) {
            return `Cursor: hooks + MCP installed ${styleText('green', 'OK')}`;
          }
          return `Cursor: hooks installed; MCP setup failed — run \`npx claude-mem mcp\` ${styleText('yellow', '!')}`;
        },
      };
    }

    case 'grok-bot': {
      return {
        title: 'Grok Bot: installing transcript watch',
        task: async (message) => {
          message('Configuring Grok Bot transcript watch…');
          const { installGrokBotIntegration } = await import('../../services/integrations/GrokBotInstaller.js');
          const { result, output } = await bufferConsole(async () => installGrokBotIntegration());
          if (result !== 0) {
            recordFailure('Grok Bot: transcript watch installation failed', output);
            return `Grok Bot: transcript watch installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Grok Bot: transcript watch installed ${styleText('green', 'OK')}`;
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
            return `OpenCode: plugin installation failed ${styleText('red', 'FAIL')}`;
          }
          return `OpenCode: plugin installed ${styleText('green', 'OK')}`;
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
            return `Windsurf: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Windsurf: hooks installed ${styleText('green', 'OK')}`;
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
            return `OpenClaw: plugin installation failed ${styleText('red', 'FAIL')}`;
          }
          return `OpenClaw: plugin installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'codex-cli': {
      return {
        title: 'Codex CLI: registering hooks marketplace',
        task: async (message) => {
          message('Loading Codex CLI installer…');
          const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
          message('Registering native Codex hooks…');
          const { result, output } = await bufferConsole(() => installCodexCli(marketplaceDirectory()));
          if (result !== 0) {
            recordFailure('Codex CLI: integration setup failed', output);
            return `Codex CLI: integration setup failed ${styleText('red', 'FAIL')}`;
          }
          return `Codex CLI: hooks marketplace registered ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'antigravity': {
      return {
        title: 'Antigravity: installing hooks + MCP',
        task: async (message) => {
          message('Loading Antigravity CLI installer…');
          const { installAntigravityCliHooks } = await import('../../services/integrations/AntigravityCliHooksInstaller.js');
          message('Installing Antigravity hooks + MCP…');
          const { result, output } = await bufferConsole(() => installAntigravityCliHooks());
          if (result !== 0) {
            recordFailure('Antigravity: hooks + MCP installation failed', output);
            return `Antigravity: hooks + MCP installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Antigravity: hooks + MCP installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'copilot-cli':
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
            return `${ideLabel}: MCP installer not found ${styleText('yellow', '!')}`;
          }
          message(`Configuring ${ideLabel} MCP…`);
          const { result, output } = await bufferConsole(() => mcpInstaller());
          if (result !== 0) {
            recordFailure(`${ideLabel}: MCP integration failed`, output);
            return `${ideLabel}: MCP integration failed ${styleText('red', 'FAIL')}`;
          }
          return `${ideLabel}: MCP integration installed ${styleText('green', 'OK')}`;
        },
      };
    }

    default: {
      return null;
    }
  }
}

async function setupIDEs(selectedIDEs: string[], summary: InstallSummary): Promise<string[]> {
  const tasks: TaskDescriptor[] = [];
  for (const ideId of selectedIDEs) {
    const taskDescriptor = makeIDETask(ideId, summary);
    if (taskDescriptor) tasks.push(taskDescriptor);
  }

  if (tasks.length > 0) {
    await runTasks(tasks);
  }

  // FAIL_LOUD_PER_IDE failures were recorded on the summary; if EVERY selected
  // IDE failed, escalate to an ABORT (all-ides-failed) — a fully failed install
  // must not print "Installation Complete".
  if (selectedIDEs.length > 0 && summary.failedIDEs.length === selectedIDEs.length) {
    installerError(ErrorSeverity.ABORT, {
      component: 'all-ides',
      phase: 'ide-install',
      cause: new Error(`All ${selectedIDEs.length} selected IDE integrations failed.`),
    }, summary);
  }

  return summary.failedIDEs;
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
      // [ANTI-PATTERN IGNORED]: the failure is already surfaced to the user via the interactive-aware log.warn wrapper below (p.log.warn in a TTY, console.warn otherwise); a raw console call here would double-print.
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
      // [ANTI-PATTERN IGNORED]: the failure is already surfaced to the user via the interactive-aware log.warn wrapper below (p.log.warn in a TTY, console.warn otherwise), together with the manual remediation command.
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
  const installShell = IS_WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash';

  const spinner = isInteractive ? p.spinner() : null;
  spinner?.start('Installing Claude Code (this can take a few minutes — downloading the native build)…');

  return new Promise<boolean>((resolve) => {
    let captured = '';
    const child = spawnHidden(command, [], {
      shell: installShell,
      stdio: spinner ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });

    child.stdout?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });

    child.on('error', (error: Error) => {
      spinner?.error('Claude Code install failed');
      if (captured) process.stderr.write(captured);
      log.error(`Claude Code install failed: ${error.message}`);
      log.info('You can install it manually later: https://claude.ai/install.sh');
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        spinner?.error('Claude Code install failed');
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
          // [ANTI-PATTERN IGNORED]: the failure is already surfaced to the user via the interactive-aware log.warn wrapper below (p.log.warn in a TTY, console.warn otherwise); PATH setup is best-effort after a successful install.
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
    return {
      value: ide.id,
      label: ide.label,
      hint: `${ide.hint}${detectedTag}`,
    };
  });

  // Pre-check Claude Code (plus anything else detected). It is the IDE almost
  // everyone installing claude-mem is running, and an empty multiselect makes
  // the common case a required chore before the install can continue.
  const preselected = detectedIDEs
    .filter((ide) => ide.detected || ide.id === 'claude-code')
    .map((ide) => ide.id);

  const result = await p.multiselect({
    message: 'Which IDEs do you use?',
    options,
    initialValues: preselected,
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
    '.agents',
    '.codex-plugin',
    '.cursor-plugin',
    'claude-mem-cursor',
    'claude-mem-grok-bot',
    'plugin',
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

  writeTrimmedMarketplacePackageJson(packageRoot, marketplaceDir);
}

/**
 * Write a runtime-only package.json into the marketplace directory.
 *
 * The root package.json declares ~40 dev-only tree-sitter grammars whose peer
 * ranges conflict (@derekstride/tree-sitter-sql wants tree-sitter@^0.21.0 while
 * @tree-sitter-grammars/tree-sitter-lua wants tree-sitter@^0.22.4). Copying it
 * verbatim makes `npm install --omit=dev` still resolve those dev edges and
 * abort with ERESOLVE (#3636). A consumer install needs only the two live
 * runtime deps, so we strip devDependencies and trustedDependencies before npm
 * ever sees the graph.
 */
export function writeTrimmedMarketplacePackageJson(packageRoot: string, marketplaceDir: string): void {
  const sourcePath = join(packageRoot, 'package.json');
  if (!existsSync(sourcePath)) return;

  const pkg = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
  delete pkg.devDependencies;
  delete pkg.trustedDependencies;

  writeFileSync(join(marketplaceDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

function copyPluginToCache(version: string): void {
  const sourcePluginDirectory = npmPackagePluginDirectory();
  const cachePath = pluginCacheDirectory(version);

  rmSync(cachePath, { recursive: true, force: true });
  ensureDirectoryExists(cachePath);
  cpSync(sourcePluginDirectory, cachePath, { recursive: true, force: true });
}

function writeMarketplaceInstallMarkers(
  marketplaceDir: string,
  version: string,
  bunVersion: string,
  uvVersion: string,
): void {
  writeInstallMarker(marketplaceDir, version, bunVersion, uvVersion);
  // Hooks execute from marketplace/plugin, and Codex caches only that nested
  // directory. Keep the runtime marker beside the package.json the hook reads
  // so SessionStart does not report a completed install as missing.
  writeInstallMarker(join(marketplaceDir, 'plugin'), version, bunVersion, uvVersion);
}

/**
 * Install marketplace dependencies, strict-first.
 *
 * Phase 4 of plans/04-installer-transparency.md: the old code ALWAYS passed
 * `--legacy-peer-deps`, papering over any real peer conflict unconditionally.
 * Now we run strict first and only fall back to `--legacy-peer-deps` on a
 * confirmed ERESOLVE token, announced loudly. `--ignore-scripts` is the default
 * (v12.6.2 lesson: a transitive postinstall can hang the install).
 */
async function runNpmInstallInMarketplace(summary: InstallSummary): Promise<void> {
  const marketplaceDir = marketplaceDirectory();
  const packageJsonPath = join(marketplaceDir, 'package.json');

  if (!existsSync(packageJsonPath)) return;

  const baseFlags = ['install', '--omit=dev', '--ignore-scripts'];
  const strictResult = await runNpmStrict(marketplaceDir, baseFlags);
  if (strictResult.code === 0) return;

  if (strictResult.timedOut) {
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error('npm install timed out'),
      details: strictResult.stderr.slice(0, 4000),
    }, summary);
  }

  if (!isEresolve(strictResult.stderr)) {
    // A strict failure with no ERESOLVE is a real bug — never retry, ABORT.
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error(`npm install failed (exit ${strictResult.code})`),
      details: strictResult.stderr.slice(0, 4000),
    }, summary);
  }

  // Confirmed ERESOLVE — log loudly, attempt one fallback with --legacy-peer-deps.
  log.warn('npm reported an ERESOLVE peer-dependency conflict in marketplace deps; retrying once with --legacy-peer-deps.');
  log.warn(extractEresolveBlock(strictResult.stderr));

  const legacyResult = await runNpmStrict(marketplaceDir, [...baseFlags, '--legacy-peer-deps']);
  if (legacyResult.code === 0) {
    summary.warnings.push({
      component: 'marketplace-npm-install',
      message: 'tree-sitter peer-dep ERESOLVE was resolved with the --legacy-peer-deps fallback. Benign for the marketplace install; re-evaluate when tree-sitter peer ranges change.',
      remediation: 'No action required.',
    });
    return;
  }

  installerError(ErrorSeverity.ABORT, {
    component: 'marketplace-npm-install',
    phase: 'marketplace-deps',
    cause: new Error(`npm install --legacy-peer-deps still failed (exit ${legacyResult.code}): ERESOLVE`),
    details: legacyResult.stderr.slice(0, 4000),
  }, summary);
}

function mergeSettings(updates: Record<string, string>): boolean {
  const path = USER_SETTINGS_PATH;
  try {
    // Read the FULL document so we can write it back intact. The
    // Claude-Code-style settings.json wraps env vars in a top-level `env`
    // block and exposes peer keys at the root (hooks, permissions,
    // apiKeyHelper, model, statusLine, etc.). readFlatSettings unwraps the
    // env subtree for reads, but writing that flattened view back as the
    // entire file silently drops every non-env top-level key — destroying
    // user configuration that disableClaudeAutoMemory + writeJsonFileAtomic
    // had carefully written.
    //
    // Track whether the file uses the env-nested shape so we mutate only the
    // relevant subtree and preserve every other top-level key on write.
    let document: Record<string, unknown> = {};
    let envNested = false;
    if (existsSync(path)) {
      try {
        const parsed = parseJsonWithBom(readFileSync(path, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          document = parsed as Record<string, unknown>;
          envNested = typeof document.env === 'object' && document.env !== null;
        }
      } catch (parseError: unknown) {
        console.warn('[install] Failed to parse existing settings.json, starting from empty:', parseError instanceof Error ? parseError.message : String(parseError));
        document = {};
      }
    } else {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const target = envNested
      ? (document.env as Record<string, unknown>)
      : document;
    for (const [key, value] of Object.entries(updates)) {
      target[key] = value;
    }

    writeSettingsJsonAtomic(path, document);
    // settings.json can carry tokens (CMEM Pro setup token, provider API
    // keys); a fresh file inherits the umask (usually 0644), leaving them
    // world-readable. Tighten to owner-only. Fail-soft: a chmod failure must
    // never fail the settings write itself, but it is not silent.
    try {
      chmodSync(path, 0o600);
    } catch (chmodError: unknown) {
      log.warn(`Could not restrict permissions on ${path} to 0600: ${chmodError instanceof Error ? chmodError.message : String(chmodError)}`);
    }
    return true;
  } catch (error: unknown) {
    log.error(`Failed to write settings to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

type ProviderId = 'claude' | 'gemini' | 'openrouter' | 'host';
/**
 * What the installer prompt may offer. `cmem` is a prompt-only sentinel: picking
 * it configures the generic OpenAI-compatible path (base URL + model + key) and
 * persists CLAUDE_MEM_PROVIDER='openrouter'. The worker only understands
 * 'claude' | 'gemini' | 'openrouter', so 'cmem' must never reach settings.json.
 */
type ProviderChoice = ProviderId | 'cmem';
// Phase 1d: Persisted DB literals (`server_beta_schema_migrations`, job_type
// enums, `server-beta-worker` lockedBy marker) are intentionally preserved in
// the source code; runtime-selector dual-accepts both `'server'` and
// `'server-beta'` settings values, but the installer writes the new canonical
// form `'server'` going forward (settings keys: CLAUDE_MEM_SERVER_{URL,
// API_KEY,PROJECT_ID}).
type RuntimeId = 'worker' | 'server';

/** Read only persisted values: environment secrets must never be copied to disk. */
function readPersistedInstallerSettings(): Record<string, unknown> {
  try {
    return readFlatSettings(USER_SETTINGS_PATH) ?? {};
  } catch {
    // settings.json is optional and may be hand-edited; provider prompts retain
    // their normal recovery paths when it cannot be read.
    return {};
  }
}

function readRawStoredAuthMethod(): 'subscription' | 'api-key' | 'gateway' | undefined {
  try {
    const value = readFlatSettings(USER_SETTINGS_PATH)?.CLAUDE_MEM_CLAUDE_AUTH_METHOD;
    if (value === 'subscription' || value === 'api-key' || value === 'gateway') return value;
    return undefined;
  } catch {
    // [ANTI-PATTERN IGNORED]: settings.json is optional and may be absent or hand-edited into invalid JSON; falling back to env-based auth detection in resolveClaudeAuthMethod is the designed recovery.
    return undefined;
  }
}

function resolveClaudeAuthMethod(): 'subscription' | 'api-key' | 'gateway' {
  const stored = readRawStoredAuthMethod();
  if (stored) return stored;
  const env = loadClaudeMemEnv();
  if (env.ANTHROPIC_BASE_URL?.trim()) return 'gateway';
  if (env.ANTHROPIC_API_KEY?.trim()) return 'api-key';
  return 'subscription';
}

const DEFAULT_SERVER_RUNTIME_BASE_URL = 'http://127.0.0.1:37877';

async function promptRuntime(options: InstallOptions): Promise<RuntimeId> {
  // #2543 — non-interactive runtime selection via `--runtime`. When the flag is
  // present we never prompt and never fall back to the worker path: we resolve
  // the requested runtime deterministically and, for the server runtime, plan +
  // execute the server-specific setup (Docker stack, key gen, IDE MCP config).
  if (options.runtime !== undefined) {
    const requested = normalizeRuntimeFlag(options.runtime);
    if (requested === null) {
      log.error(`Unknown --runtime: ${options.runtime}. Allowed: worker, server`);
      process.exit(1);
    }
    if (requested === 'server') {
      await setupServerRuntimeNonInteractive(options);
      return 'server';
    }
    mergeSettings({ CLAUDE_MEM_RUNTIME: 'worker' });
    return 'worker';
  }

  if (!isInteractive) {
    mergeSettings({ CLAUDE_MEM_RUNTIME: 'worker' });
    return 'worker';
  }

  const selected = await p.select<RuntimeId>({
    message: 'Which runtime should claude-mem start after install?',
    options: [
      { value: 'worker', label: 'Worker', hint: 'stable compatibility path' },
      { value: 'server', label: 'Server (beta)', hint: 'REST V1, API keys, team-ready storage' },
    ],
    initialValue: 'worker',
  });

  if (p.isCancel(selected)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  mergeSettings({
    CLAUDE_MEM_RUNTIME: selected,
  });

  if (selected === 'server') {
    await maybeBootstrapServerApiKey();
  }
  return selected;
}

// #2543 — set up the server runtime non-interactively. Docker stack bring-up
// is config-only here (we log the command an operator must run / a CI
// provisioner executes); key generation reuses the same bootstrap path as the
// interactive flow (createServerApiKey via server-bootstrap), and the IDE MCP
// config target is recorded in settings so hooks resolve the server runtime.
async function setupServerRuntimeNonInteractive(options: InstallOptions): Promise<void> {
  const serverBaseUrl = (options.serverUrl ?? '').trim() || DEFAULT_SERVER_RUNTIME_BASE_URL;

  mergeSettings({ CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: serverBaseUrl });

  log.info(
    'Server runtime selected. Bring up the bundled stack with '
      + '`docker compose up -d postgres valkey claude-mem-server claude-mem-worker` '
      + `(pg + redis/valkey). The server listens at ${serverBaseUrl}.`,
  );

  // The server mounts its MCP endpoint at `<baseUrl>/mcp` over HTTP (vs. the
  // worker's stdio transport); trailing slashes are trimmed so we never emit
  // `http://host//mcp`.
  log.info(
    `IDE MCP config target for the server runtime: http ${serverBaseUrl.replace(/\/+$/, '')}/mcp`,
  );

  await maybeBootstrapServerApiKey();
}

async function maybeBootstrapServerApiKey(): Promise<void> {
  // Only attempt if Postgres is configured. Without DATABASE_URL we cannot
  // reach the api_keys table — the operator must configure the server first
  // and rerun `claude-mem server keys rotate`.
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    log.warn(
      'Skipping local hook API key bootstrap: CLAUDE_MEM_SERVER_DATABASE_URL is not set. '
        + 'Run `npx claude-mem server keys rotate` after configuring Postgres to provision a key.',
    );
    return;
  }
  try {
    await bootstrapAndPersistServerApiKey();
  } catch (error: unknown) {
    // [ANTI-PATTERN IGNORED]: the failure is already surfaced to the user via the interactive-aware log.warn wrapper below (p.log.warn in a TTY, console.warn otherwise), including the manual remediation command.
    log.warn(
      `Failed to bootstrap server API key: ${error instanceof Error ? error.message : String(error)}. `
        + 'Hooks will fall back to the worker until you run `npx claude-mem server keys rotate`.',
    );
  }
}

async function bootstrapAndPersistServerApiKey(): Promise<void> {
  const { bootstrapServerApiKey, persistServerSettings } = await import(
    '../../services/hooks/server-bootstrap.js'
  );
  const result = await bootstrapServerApiKey();
  persistServerSettings(USER_SETTINGS_PATH, {
    apiKey: result.rawKey,
    projectId: result.projectId,
  });
  log.info(
    `Provisioned local hook API key (project=${result.projectId.slice(0, 8)}…). `
      + 'Settings saved with mode 0600.',
  );
}

/**
 * Best-effort "open this URL in the user's browser". Every failure mode is
 * non-fatal — the caller has already printed the URL, so the worst case is the
 * user clicks it themselves.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawnSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    // [ANTI-PATTERN IGNORED]: opening a browser is a convenience, not a step of the
    // install; the recovery is the URL already printed above this call, which the
    // user can open by hand. A headless box legitimately has no opener at all.
  }
}

async function promptProvider(
  options: InstallOptions,
  /**
   * Null only when login was skipped, which happens solely for an explicit
   * `--provider claude`. That path cannot reach the CMEM branch below, which
   * re-checks rather than assuming.
   */
  pairing: InstallerOAuthPairing | null,
  version: string,
): Promise<ProviderId> {
  const initialProvider = (getSetting('CLAUDE_MEM_PROVIDER') as ProviderId) || 'claude';
  const persistedSettings = readPersistedInstallerSettings();

  const persistClaudeProvider = (authMethod?: 'subscription' | 'api-key' | 'gateway') => {
    const resolvedAuthMethod = authMethod ?? resolveClaudeAuthMethod();
    const wrote = mergeSettings({
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: resolvedAuthMethod,
    });
    if (wrote) log.info('Saved Claude Agent SDK configuration to ~/.claude-mem/settings.json');
  };

  const useSubscriptionAuth = () => {
    const wrote = mergeSettings(buildAnthropicMaxLocalSettings(persistedSettings));
    if (!wrote) {
      p.cancel('Could not save the local Anthropic Max configuration.');
      process.exit(1);
    }
    saveClaudeMemEnv({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    log.info('Disabled cloud sync and saved local Anthropic Max configuration.');
    log.info('Configured claude-mem to use your logged-in Claude SDK account.');
  };

  let selectedProvider: ProviderChoice;
  if (options.provider) {
    selectedProvider = options.provider;
  } else {
    if (!isInteractive) {
      throw new Error('Non-interactive provider validation did not run.');
    }
    const labels = buildProviderLabels();

    // Multiselect gives both choices square controls. Exactly one provider is
    // still required; selecting both re-opens the prompt instead of guessing.
    while (true) {
      const providerResult = await p.multiselect<ProviderChoice>({
        message: PROVIDER_PROMPT_MESSAGE,
        options: [
          { value: 'cmem', label: labels.cmem, hint: labels.cmemHint },
          { value: 'claude', label: labels.claude, hint: labels.claudeHint },
        ],
        // CMEM Pro pre-selected: it is the recommended path and the one the
        // funnel is built around. Selecting it no longer means "pay now" —
        // it opens the offer page to read first.
        initialValues: ['cmem'],
        required: true,
      });
      if (p.isCancel(providerResult)) {
        p.cancel('Installation cancelled.');
        process.exit(1);
      }
      if (providerResult.length === 1) {
        selectedProvider = providerResult[0];
        break;
      }
      log.warn('Select exactly one provider.');
    }
  }

  // CMEM Pro: no new provider code. The worker's OpenRouter client is a generic
  // OpenAI-compatible client whose endpoint and model both come from settings,
  // so "use the CMEM observer model" is four settings writes and nothing else.
  if (selectedProvider === 'cmem') {
    if (!pairing) {
      // Unreachable via the flag that skips login (it forces 'claude'), but a
      // future caller passing null here would otherwise enroll against nothing.
      throw new Error('CMEM Pro requires a signed-in claude-mem account.');
    }
    // The billing disclosure lives on the checkout page, not here. It is a term
    // of the charge, so it belongs on the screen that takes the payment method,
    // where it can be shown next to the price and the card field. Re-asking for
    // it in the terminal made the user consent twice to the same thing, before
    // ever seeing what they were agreeing to.
    const enrollment = await completeCmemTrialPairing(pairing, version);
    if (!enrollment) {
      p.cancel('CMEM Pro setup was not completed. Run npx claude-mem install to try again.');
      process.exit(1);
    }
    const cmemCredentials = resolveCmemMemoryCredentials(enrollment, persistedSettings);
    if (!cmemCredentials) {
      p.cancel('CMEM Pro did not return memory credentials. Run npx claude-mem install to try again.');
      process.exit(1);
    }

    const wrote = mergeSettings(buildCmemActivationSettings(cmemCredentials));
    if (!wrote) {
      p.cancel('Could not save the CMEM Pro configuration.');
      process.exit(1);
    }
    if (cmemCredentials.clearFallback) clearProFallback();
    log.info('CMEM Pro configured with your signed-in memory key.');
    return 'openrouter';
  }

  if (selectedProvider === 'claude') {
    useSubscriptionAuth();
    return 'claude';
  }

  if (selectedProvider === 'host') {
    const observerModel = options.ide === 'grok-bot' ? 'grok-bot' : 'cursor';
    const wrote = mergeSettings(buildHostObserverSettings(observerModel, persistedSettings));
    if (!wrote) {
      p.cancel('Could not save the host observer configuration.');
      process.exit(1);
    }
    log.info(`Configured host observer for ${observerModel}.`);
    return 'openrouter';
  }

  const providerLabel = selectedProvider === 'gemini' ? 'Gemini' : 'OpenRouter';
  const keyEnvName = selectedProvider === 'gemini'
    ? 'CLAUDE_MEM_GEMINI_API_KEY'
    : 'CLAUDE_MEM_OPENROUTER_API_KEY';

  const existingKey = getSetting(keyEnvName as keyof SettingsDefaults) as string | undefined;
  const existingOpenRouterBaseUrl = selectedProvider === 'openrouter'
    ? String(getSetting('CLAUDE_MEM_OPENROUTER_BASE_URL') ?? '')
    : '';
  const existingKeyIsCmem = selectedProvider === 'openrouter'
    && isCmemGatewayUrl(existingOpenRouterBaseUrl);
  if (existingKey && existingKey.trim().length > 0 && !existingKeyIsCmem) {
    const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: selectedProvider });
    if (wrote) log.info(`Saved provider=${selectedProvider} to ~/.claude-mem/settings.json`);
    return selectedProvider;
  }

  if (!isInteractive) {
    throw new Error(`Non-interactive ${providerLabel} configuration is missing a personal API key.`);
  }

  const apiKeyResult = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: '*',
    validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
  });

  if (p.isCancel(apiKeyResult)) {
    log.warn(`API key prompt cancelled — falling back to Claude provider.`);
    persistClaudeProvider();
    return 'claude';
  }

  const apiKey = String(apiKeyResult).trim();
  const updates = selectedProvider === 'openrouter'
    ? buildPersonalOpenRouterSettings(
      apiKey,
      readPersistedInstallerSettings(),
      SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL,
    )
    : {
      CLAUDE_MEM_PROVIDER: selectedProvider,
      [keyEnvName]: apiKey,
    };
  const wrote = mergeSettings(updates);
  if (wrote) {
    log.info(`Saved provider=${selectedProvider} to ~/.claude-mem/settings.json`);
  }
  return selectedProvider;
}

async function promptClaudeModel(options: InstallOptions): Promise<void> {
  const allowed = new Set([
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-opus-4-8',
  ]);
  const allowCustomModel = resolveClaudeAuthMethod() === 'gateway';

  if (options.model && !allowCustomModel) {
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
  if (options.model && allowCustomModel) {
    const wrote = mergeSettings({ CLAUDE_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved gateway model=${options.model} to ~/.claude-mem/settings.json`);
    }
    return;
  }

  if (!isInteractive) return;

  const initialModel = getSetting('CLAUDE_MEM_MODEL');

  if (allowCustomModel) {
    const result = await p.text({
      message: 'Which model should the gateway use?',
      placeholder: 'claude-haiku-4-5-20251001',
      defaultValue: initialModel || 'claude-haiku-4-5-20251001',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'Model required' : undefined,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    const selectedModel = String(result).trim();
    const wrote = mergeSettings({ CLAUDE_MEM_MODEL: selectedModel });
    if (wrote) {
      log.info(`Saved gateway model=${selectedModel} to ~/.claude-mem/settings.json`);
    }
    return;
  }

  const initialValue = allowed.has(initialModel) ? initialModel : 'claude-haiku-4-5-20251001';

  const result = await p.select<string>({
    message: 'Which Claude model should claude-mem use to compress observations?\nThis runs whenever you and Claude touch a file — keep it cheap and fast.',
    options: [
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (recommended — fast, cheap, great for compression)' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5 (balanced quality and cost)' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8 (highest quality, slowest)' },
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

// --- claude-mem OAuth pairing ----------------------------------------------
// Every installer authenticates through the same GitHub/Google OAuth screen as
// cmem.ai. Login only proves account ownership; provider selection happens
// afterward, and only the CMEM Pro choice continues into trial enrollment.

function nonEmptyTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const OAUTH_START_TIMEOUT_MS = 10_000;
const OAUTH_POLL_TIMEOUT_MS = 10_000;
const OAUTH_POLL_BUDGET_MS = 240_000;
const OAUTH_DEFAULT_POLL_INTERVAL_S = 3;

type InstallerPollStage = 'awaiting_login' | 'awaiting_checkout' | 'awaiting_approval';
type TrialPlan = 'trial' | 'pro' | 'none';

export interface InstallerOAuthPairing {
  pairingId: string;
  secret: string;
  userCode: string;
  authorizationUrl: string;
  checkoutUrl: string;
  pollIntervalMs: number;
  /** Defensive compatibility for a server that returns ready during login. */
  delivered?: TrialReadyResult;
}

function parseBrowserUrl(value: unknown, expectedPath: string): URL | null {
  const candidate = nonEmptyTrimmedString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const expectedOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
    if (
      parsed.origin !== expectedOrigin
      || parsed.pathname !== expectedPath
      || parsed.username
      || parsed.password
      || parsed.hash
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hasExactSearchParams(url: URL, expected: Record<string, string>): boolean {
  const entries = [...url.searchParams.entries()];
  const expectedEntries = Object.entries(expected);
  return entries.length === expectedEntries.length
    && expectedEntries.every(([key, value]) => url.searchParams.get(key) === value);
}

/**
 * The checkout URL must carry exactly `pairing` and `trial`, and nothing else —
 * but the trial LENGTH is not the installer's business to pin.
 *
 * This previously required `trial: '7'` exactly. That made the server unable to
 * change the offer without breaking every installer already published: a
 * `trial=30` URL was rejected outright, surfacing as "Could not start OAuth
 * login" with no hint that the length was the reason. The shape stays strict
 * (both params present, pairing must match, no extras); only the number is now
 * the server's to choose.
 */
function hasPairingAndTrialParams(url: URL, pairingId: string): boolean {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 2) return false;
  if (url.searchParams.get('pairing') !== pairingId) return false;
  const trial = url.searchParams.get('trial');
  if (trial === null || !/^[0-9]{1,3}$/.test(trial)) return false;
  const days = Number(trial);
  return days >= 1 && days <= 365;
}

/** Pure parser used by the mock-server contract tests. */
export function parseInstallerOAuthStartBody(body: unknown): InstallerOAuthPairing | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    pairing_id?: unknown;
    secret?: unknown;
    user_code?: unknown;
    authorization_url?: unknown;
    checkout_url?: unknown;
    poll_interval?: unknown;
  };
  const pairingId = nonEmptyTrimmedString(b.pairing_id);
  const secret = nonEmptyTrimmedString(b.secret);
  const userCode = nonEmptyTrimmedString(b.user_code);
  const authorizationUrl = parseBrowserUrl(b.authorization_url, '/login');
  const checkoutUrl = parseBrowserUrl(b.checkout_url, '/api/pro/trial/claim');
  if (
    !pairingId
    || !/^[0-9a-f]{32}$/.test(pairingId)
    || !secret
    || !/^[0-9a-f]{48}$/.test(secret)
    || !userCode
    || !/^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/.test(userCode)
    || !authorizationUrl
    || !checkoutUrl
  ) return null;

  const expectedOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
  const loginNext = authorizationUrl.searchParams.get('next');
  if (
    !loginNext
    || !loginNext.startsWith('/')
    || loginNext.startsWith('//')
    || !hasExactSearchParams(authorizationUrl, { next: loginNext })
  ) return null;

  const loginClaim = parseBrowserUrl(`${expectedOrigin}${loginNext}`, '/api/pro/trial/claim');
  if (
    !loginClaim
    || !hasExactSearchParams(loginClaim, { pairing: pairingId, login_only: '1' })
    || !hasPairingAndTrialParams(checkoutUrl, pairingId)
  ) return null;

  const pollIntervalS =
    typeof b.poll_interval === 'number' && Number.isFinite(b.poll_interval) && b.poll_interval > 0
      ? Math.min(Math.max(b.poll_interval, 1), 30)
      : OAUTH_DEFAULT_POLL_INTERVAL_S;

  return {
    pairingId,
    secret,
    userCode,
    authorizationUrl: authorizationUrl.toString(),
    checkoutUrl: checkoutUrl.toString(),
    pollIntervalMs: pollIntervalS * 1000,
  };
}

/** Starts an OAuth pairing. No email address or identity is accepted from the CLI. */
export async function startInstallerOAuthPairing(): Promise<InstallerOAuthPairing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_START_TIMEOUT_MS);
  try {
    const response = await fetch(CMEM_INSTALLER_OAUTH_START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'npx-installer', device_name: hostname() }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseInstallerOAuthStartBody(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything a ready poll delivers. The memory credentials are staged before
 * provider activation so one-shot delivery cannot be lost after enrollment.
 */
export interface TrialReadyResult {
  userId: string;
  setupToken: string;
  hubUrl: string;
  memoryKey: string;
  memoryBaseUrl: string;
  memoryModel: string;
  plan: TrialPlan;
  trialEndsAt: string | null;
}

export function buildTrialReadySettings(
  result: TrialReadyResult,
  deviceName: string = hostname(),
): Record<string, string> {
  return {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: result.setupToken,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: result.userId,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: result.hubUrl,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: deviceName,
    CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
    CLAUDE_MEM_PRO_TRIAL_ENDS_AT: result.trialEndsAt ?? '',
    CLAUDE_MEM_PRO_PLAN: result.plan,
    CLAUDE_MEM_PRO_MEMORY_KEY: result.memoryKey,
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: result.memoryBaseUrl,
    CLAUDE_MEM_PRO_MEMORY_MODEL: result.memoryModel,
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
  };
}

export function parseTrialReadyBody(body: unknown): TrialReadyResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    status?: unknown;
    user_id?: unknown;
    setup_token?: unknown;
    hub_url?: unknown;
    memory_key?: unknown;
    memory_base_url?: unknown;
    memory_model?: unknown;
    plan?: unknown;
    trial?: { ends_at?: unknown };
  };
  const userId = nonEmptyTrimmedString(b.user_id);
  const setupToken = nonEmptyTrimmedString(b.setup_token);
  const hubUrl = nonEmptyTrimmedString(b.hub_url);
  if (b.status !== 'ready' || !userId || !setupToken || !hubUrl) return null;

  return {
    userId,
    setupToken,
    hubUrl,
    memoryKey: nonEmptyTrimmedString(b.memory_key) ?? setupToken,
    memoryBaseUrl: nonEmptyTrimmedString(b.memory_base_url) ?? CMEM_PRO_BASE_URL,
    memoryModel: nonEmptyTrimmedString(b.memory_model) ?? CMEM_PRO_MODEL,
    plan: b.plan === 'trial' || b.plan === 'pro' || b.plan === 'none' ? b.plan : 'trial',
    trialEndsAt: nonEmptyTrimmedString(b.trial?.ends_at),
  };
}

type InstallerPollOutcome =
  | { kind: 'authenticated'; userId: string }
  | { kind: 'pending'; stage: InstallerPollStage }
  | ({ kind: 'ready' } & TrialReadyResult)
  | { kind: 'gone' }
  | { kind: 'unreachable' };

async function pollInstallerPairingOnce(pairing: InstallerOAuthPairing): Promise<InstallerPollOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(CMEM_INSTALLER_OAUTH_POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_id: pairing.pairingId, secret: pairing.secret }),
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410) return { kind: 'gone' };

    const body = await response.json().catch(() => ({})) as {
      status?: unknown;
      stage?: unknown;
      user_id?: unknown;
    };
    if (response.status === 202) {
      const stage: InstallerPollStage =
        body.stage === 'awaiting_checkout' || body.stage === 'awaiting_approval'
          ? body.stage
          : 'awaiting_login';
      return { kind: 'pending', stage };
    }
    if (response.ok && body.status === 'authenticated') {
      const userId = nonEmptyTrimmedString(body.user_id);
      return userId ? { kind: 'authenticated', userId } : { kind: 'unreachable' };
    }
    if (response.ok) {
      const ready = parseTrialReadyBody(body);
      return ready ? { kind: 'ready', ...ready } : { kind: 'unreachable' };
    }
    return { kind: 'unreachable' };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function sleepUnlessCancelled(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (isCancelled() || Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

async function waitForInstallerPairing(
  pairing: InstallerOAuthPairing,
  phase: 'login' | 'enrollment',
  version: string,
): Promise<InstallerPollOutcome | null> {
  const startedAt = Date.now();
  // The login phase must never name CMEM Pro. Logging in is required of every
  // user and happens BEFORE the provider choice, so naming a paid plan here
  // reads as an upsell attached to a mandatory step and muddies the funnel.
  // The poll loop prints whatever stage the server reports, so a server-side
  // 'awaiting_checkout' during login would otherwise leak the Pro wording.
  const stageMessages: Record<InstallerPollStage, string> = {
    awaiting_login: 'Waiting for OAuth login in the browser…',
    awaiting_checkout: phase === 'login'
      ? 'Waiting for the browser to finish signing you in…'
      : 'Waiting for CMEM Pro setup in the browser…',
    awaiting_approval: `Enter code ${pairing.userCode} in the browser to approve this device…`,
  };
  let stage: InstallerPollStage = phase === 'login' ? 'awaiting_login' : 'awaiting_checkout';
  log.info(stageMessages[stage]);

  let cancelled = false;
  const onStdinData = (chunk: Buffer | string): void => {
    if (typeof chunk === 'string' ? chunk.includes('\x03') : chunk.includes(0x03)) cancelled = true;
  };
  const onSigint = (): void => {
    cancelled = true;
  };
  const useRawInput = process.stdin.isTTY === true;
  const stdinWasRaw = process.stdin.isRaw === true;
  let changedRawMode = false;
  if (useRawInput) {
    process.stdin.on('data', onStdinData);
    if (!stdinWasRaw) {
      process.stdin.setRawMode(true);
      changedRawMode = true;
    }
    process.stdin.resume();
  }
  process.on('SIGINT', onSigint);

  try {
    let consecutiveFailures = 0;
    while (Date.now() - startedAt < OAUTH_POLL_BUDGET_MS) {
      if (cancelled) return null;
      const result = await pollInstallerPairingOnce(pairing);
      if (cancelled) return null;

      if (result.kind === 'authenticated' && phase === 'login') return result;
      if (result.kind === 'ready') return result;
      if (result.kind === 'gone') {
        log.error('This browser authorization expired. Run the installer again.');
        return null;
      }
      if (result.kind === 'unreachable') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          log.error('cmem.ai is not responding. Run the installer again when it is reachable.');
          return null;
        }
      } else {
        consecutiveFailures = 0;
        if (result.kind === 'pending' && result.stage !== stage) {
          stage = result.stage;
          log.info(stageMessages[stage]);
        }
      }
      await sleepUnlessCancelled(pairing.pollIntervalMs, () => cancelled);
    }

    await captureCliEvent('installer_oauth_timeout', {
      version,
      phase,
      duration_ms: Date.now() - startedAt,
    });
    log.error('Browser authorization timed out. Run the installer again.');
    return null;
  } finally {
    process.off('SIGINT', onSigint);
    if (useRawInput) {
      process.stdin.off('data', onStdinData);
      if (changedRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}

/**
 * Required account step. OAuth completes before provider choice and never
 * chooses or enrolls a paid provider on its own.
 */
export async function completeInstallerOAuthLogin(
  pairing: InstallerOAuthPairing,
  version: string,
): Promise<boolean> {
  const result = await waitForInstallerPairing(pairing, 'login', version);
  if (!result) return false;
  if (result.kind === 'ready') {
    if (!mergeSettings(buildTrialReadySettings(result))) return false;
    pairing.delivered = result;
  }
  log.success('OAuth login complete.');
  await captureCliEvent('installer_oauth_completed', { version });
  return result.kind === 'authenticated' || result.kind === 'ready';
}

/**
 * Holds until the user presses Return, then the caller opens the browser. The
 * URL is printed BEFORE this, so a user who cannot use an opener (headless box,
 * SSH) is never blocked — they can open it by hand and the wait still clears on
 * Return. Ctrl-C falls through to the normal SIGINT handling.
 *
 * Raw mode mirrors waitForInstallerPairing: only toggled when this call turned
 * it on, and always restored.
 */
async function waitForReturnToOpenBrowser(message: string): Promise<void> {
  if (!isInteractive || process.stdin.isTTY !== true) return;
  log.info(message);
  await new Promise<void>((resolve) => {
    const wasRaw = process.stdin.isRaw === true;
    let changedRawMode = false;
    const finish = (): void => {
      process.stdin.off('data', onData);
      if (changedRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes('\r') || text.includes('\n') || text.includes('\x03')) finish();
    };
    if (!wasRaw) {
      process.stdin.setRawMode(true);
      changedRawMode = true;
    }
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function requireInstallerOAuthLogin(version: string): Promise<InstallerOAuthPairing | null> {
  const spinner = isInteractive ? p.spinner() : null;
  spinner?.start('Starting secure OAuth login…');
  const pairing = await startInstallerOAuthPairing();
  if (!pairing) {
    spinner?.stop(styleText('red', 'Could not start OAuth login.'));
    log.error('OAuth login is required. Run npx claude-mem install again when cmem.ai is reachable.');
    return null;
  }
  spinner?.stop('OAuth login ready.');

  // No provider, plan, or pricing language on this step: logging in is required
  // of every user and runs BEFORE the provider choice, so anything about a paid
  // plan here is an upsell bolted onto a mandatory step.
  log.info(`Open this URL: ${pairing.authorizationUrl}`);
  await waitForReturnToOpenBrowser('Continue setup in browser... (hit return to open automatically)');
  openBrowser(pairing.authorizationUrl);
  await captureCliEvent('installer_oauth_started', { version });

  const completed = await completeInstallerOAuthLogin(pairing, version);
  return completed ? pairing : null;
}

function noteDeviceCode(pairing: InstallerOAuthPairing): void {
  const message = [
    styleText(['bold', 'cyan'], pairing.userCode),
    '',
    'Enter this code in the browser to approve this device.',
  ].join('\n');
  if (isInteractive) p.note(message, 'Your device code');
  else log.info(`Device code: ${pairing.userCode}`);
}

/**
 * Continues the already-authenticated pairing only after the CMEM Pro choice
 * and required trial acknowledgement.
 */
export async function completeCmemTrialPairing(
  pairing: InstallerOAuthPairing,
  version: string,
): Promise<TrialReadyResult | null> {
  if (pairing.delivered) return pairing.delivered;

  noteDeviceCode(pairing);
  // Deliberately NO return-wait here, unlike the login hand-off.
  //
  // A second wait at this point stalled the install: stdin has already been
  // through the login wait and a clack prompt by now, and the listener did not
  // reliably receive the keypress, so the flow stopped before it could even
  // print "Waiting for CMEM Pro setup in the browser…". Opening directly is
  // also the better behaviour here — the user has already chosen CMEM Pro, so
  // there is nothing left to confirm before the browser takes over.
  log.info(`Continue CMEM Pro setup: ${pairing.checkoutUrl}`);
  openBrowser(pairing.checkoutUrl);

  const result = await waitForInstallerPairing(pairing, 'enrollment', version);
  if (!result || result.kind !== 'ready') return null;

  const wrote = mergeSettings(buildTrialReadySettings(result));
  if (!wrote) {
    log.error('Could not save the one-time CMEM Pro credentials.');
    return null;
  }
  pairing.delivered = result;
  clearProFallback();
  log.success('CMEM Pro Free Trial active.');
  await captureCliEvent('trial_activated', { version });
  return result;
}

/**
 * Final step of the install flow: tell the user telemetry is on by default
 * (opt-out) and let them decide. Asked ONCE — a telemetry.json with a recorded
 * enabled decision means the user already chose, and we never re-nag. An
 * installId-only config (written by the worker's ID bootstrap) does NOT count
 * as a decision. Respects DO_NOT_TRACK (skip entirely: they already answered),
 * CI, and non-TTY. See docs/public/telemetry.mdx for what is/isn't collected.
 */
async function promptTelemetryOptIn(): Promise<void> {
  if (!isInteractive) return;
  if (process.env.CI) return;
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt !== 'false') return;
  const existing = loadTelemetryConfig();
  if (existing?.enabled !== undefined) return;

  p.log.message(styleText('dim', 
    'Anonymous install ID only — no prompts, file paths, code, or project names, ever.\n'
    + 'Details: https://docs.claude-mem.ai/telemetry · Change anytime: claude-mem telemetry disable',
  ));
  const consent = await p.confirm({
    message: 'Share anonymized usage data with CMEM? It is on by default and helps us make the product better.',
    initialValue: true,
  });
  if (p.isCancel(consent)) return;

  saveTelemetryConfig({
    enabled: consent === true,
    installId: existing?.installId || randomUUID(),
    decidedAt: new Date().toISOString(),
  });
  log.success(consent ? 'Thanks! Anonymized usage sharing is on.' : 'No problem — telemetry is off.');
}

/**
 * Whether an install still has an account question to answer.
 *
 * `--provider claude` and `--provider host` are exempt: they either run on the
 * user's own Anthropic plan or the logged-in host agent and need no claude-mem
 * credentials. `gemini` and
 * `openrouter` are NOT exempt — openrouter is the transport for the cmem
 * gateway, so an explicit `openrouter` install may still be reaching cmem.ai.
 * With no flag at all the provider screen can still offer CMEM Pro, so login
 * must happen first.
 */
export function providerNeedsAccount(provider: InstallOptions['provider']): boolean {
  return provider !== 'claude' && provider !== 'host';
}

export interface InstallOptions {
  ide?: string;
  provider?: 'claude' | 'gemini' | 'openrouter' | 'host';
  model?: string;
  noAutoStart?: boolean;
  disableAutoMemory?: boolean;
  // #2543 — non-interactive runtime selection. `server` is the operator-facing
  // alias for the canonical `server-beta` runtime id.
  runtime?: 'worker' | 'server' | 'server-beta';
  // Base URL the server runtime (and the injected IDE MCP config) targets.
  serverUrl?: string;
}

async function requireWorkerStopped(
  port: number | string,
  phase: 'pre-overwrite' | 'provider-cutover',
  summary: InstallSummary,
): Promise<void> {
  const spinner = isInteractive ? p.spinner() : null;
  const action = phase === 'pre-overwrite'
    ? 'Stopping running worker (so we can overwrite cleanly)…'
    : 'Confirming the old worker is stopped before provider cutover…';
  spinner?.start(action);

  try {
    const result = await shutdownWorkerAndWait(port, 10000);
    if (!result.stopped) {
      spinner?.error('Running worker did not stop; refusing to overwrite its live configuration.');
      installerError(ErrorSeverity.ABORT, {
        component: 'worker-shutdown',
        phase,
        cause: new Error('The existing worker did not stop within 10 seconds.'),
        remediation: 'Run `npx claude-mem stop`, verify it exits, then run `npx claude-mem install` again.',
      }, summary);
    }

    const stopMessage = result.workerWasRunning
      ? 'Stopped running worker before configuration cutover.'
      : 'No worker running — proceeding.';
    if (spinner) spinner.stop(stopMessage);
    else if (result.workerWasRunning) log.info(stopMessage);
  } catch (error: unknown) {
    if (error instanceof InstallAbortError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (spinner) spinner.error(`Worker shutdown failed: ${message}`);
    else console.warn('[install] Worker shutdown failed:', message);
    installerError(ErrorSeverity.ABORT, {
      component: 'worker-shutdown',
      phase,
      cause: error,
      remediation: 'Run `npx claude-mem stop`, verify it exits, then run `npx claude-mem install` again.',
    }, summary);
  }
}

function validateNonInteractiveProvider(
  options: InstallOptions,
  summary: InstallSummary,
): void {
  if (isInteractive) return;

  if (!options.provider) {
    installerError(ErrorSeverity.ABORT, {
      component: 'provider-selection',
      phase: 'non-interactive-validation',
      cause: new Error('A provider must be explicit when stdin is not interactive.'),
      remediation: 'Re-run with `--provider claude`, or run the installer in an interactive terminal to compare CMEM Pro and local benefits.',
    }, summary);
  }

  if (options.provider === 'host') return;
  if (options.provider !== 'gemini' && options.provider !== 'openrouter') return;
  const keyName = options.provider === 'gemini'
    ? 'CLAUDE_MEM_GEMINI_API_KEY'
    : 'CLAUDE_MEM_OPENROUTER_API_KEY';
  const key = String(getSetting(keyName as keyof SettingsDefaults) ?? '').trim();
  const configuredCmemKey = options.provider === 'openrouter'
    && isCmemGatewayUrl(String(getSetting('CLAUDE_MEM_OPENROUTER_BASE_URL') ?? ''));
  if (!key || configuredCmemKey) {
    installerError(ErrorSeverity.ABORT, {
      component: 'provider-credentials',
      phase: 'non-interactive-validation',
      cause: new Error(`${options.provider} requires a preconfigured personal API key when stdin is not interactive.`),
      remediation: `Save ${keyName} first, or run the installer in an interactive terminal so it can ask securely.`,
    }, summary);
  }
}

export async function runInstallCommand(options: InstallOptions = {}): Promise<void> {
  const summary = createInstallSummary();
  try {
    await runInstallCommandInner(options, summary);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err instanceof InstallAbortError) {
      // err.category.id is OUR taxonomy id (error-taxonomy.ts), never a message.
      await captureCliEvent('install_failed', {
        error_category: err.category.id,
        interactive: isInteractive,
        install_method: detectInstallMethod(),
        claude_code_version: detectClaudeCodeVersion(),
      }, { person: true });
      // Flush whatever warnings accrued before the abort, then print the
      // remediation headline and exit non-zero. ABORT must never reach the
      // "Installation Complete" path.
      flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.error(`  ${line}`)));
      const headline = `Installation Aborted: ${err.category.id}`;
      if (isInteractive) {
        p.log.error(headline);
        p.log.error(err.remediation);
        p.outro(styleText('red', 'claude-mem installation aborted.'));
      } else {
        console.error(`\n  ${headline}`);
        console.error(`  ${err.remediation}`);
        console.error(`  ${err.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

async function runInstallCommandInner(options: InstallOptions, summary: InstallSummary): Promise<void> {
  const installStartedAt = Date.now();
  const version = readPluginVersion();
  validateNonInteractiveProvider(options, summary);
  // Captured by the runtime-setup task below; reported on install_completed
  // so funnel dropoff can be sliced by toolchain versions.
  let installedBunVersion: string | undefined;
  let installedUvVersion: string | undefined;

  if (isInteractive) {
    await playBanner();
    p.intro(styleText(['bgCyan', 'black'], ' claude-mem install '));
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

  const dot = styleText('dim', '·');
  const segments = [`${styleText('bold', 'claude-mem')} ${styleText('cyan', `v${version}`)}`];
  if (existingVersion && existingVersion !== version) {
    segments.push(`installed ${styleText('yellow', `v${existingVersion}`)}`);
  } else if (existingVersion) {
    segments.push(styleText('dim', 'reinstall'));
  }
  log.info(segments.join(` ${dot} `));

  // All claude-mem hooks run via `"shell": "bash"`; on Windows, Claude Code
  // resolves that through Git for Windows with no WSL fallback. Surfacing it
  // here — rather than letting the first hook throw an unbranded error — is
  // a warning, not a hard stop: the operator may install Git for Windows
  // after this run and hooks will start working without a reinstall.
  if (IS_WINDOWS) {
    const gitBash = checkWindowsGitBash();
    if (!gitBash.ok) {
      log.warn(gitBash.detail);
    }
  }

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

  const selectedRuntime = await promptRuntime(options);

  let workerStartResult: WorkerStartResult = 'dead';
  // Claude Code consumes the marketplace plugin system directly, so any selection
  // (claude-code or otherwise) needs the marketplace + plugin registration steps.
  // The only time we'd skip is a hypothetical no-IDE install, which the prompt above
  // doesn't allow today.
  const needsMarketplace = selectedIDEs.length > 0;

  {
    if (needsMarketplace) {
      const installPort = getSetting('CLAUDE_MEM_WORKER_PORT');
      await requireWorkerStopped(installPort, 'pre-overwrite', summary);
    }

    const tasks: TaskDescriptor[] = [
      {
        title: 'Caching plugin version',
        task: async (message) => {
          message(`Caching v${version}...`);
          copyPluginToCache(version);
          return `Plugin cached (v${version}) ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Registering marketplace',
        task: async () => {
          registerMarketplace();
          return `Marketplace registered ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Registering plugin',
        task: async () => {
          registerPlugin(version);
          return `Plugin registered ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Enabling plugin in Claude settings',
        task: async () => {
          enablePluginInClaudeSettings();
          return `Plugin enabled ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Setting up runtime (first install can take ~30s)',
        task: async (message) => {
          message('Checking Bun…');
          const { version: bunVersion } = await ensureBun(summary);
          message('Checking uv…');
          const { version: uvVersion } = await ensureUv(summary);
          installedBunVersion = bunVersion;
          installedUvVersion = uvVersion;
          const cacheDir = pluginCacheDirectory(version);
          if (!isInstallCurrent(cacheDir, version)) {
            const { bunPath } = await ensureBun();
            const stopHeartbeat = startHeartbeat(message, 'Installing plugin dependencies (bun install)…');
            try {
              await installPluginDependencies(cacheDir, bunPath);
            } finally {
              stopHeartbeat();
            }
            writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
          }
          writeInstallMarker(join(marketplaceDirectory(), 'plugin'), version, bunVersion, uvVersion);
          return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${styleText('green', 'OK')}`;
        },
      },
    ];

    if (needsMarketplace) {
      tasks.unshift({
        title: 'Copying plugin files to marketplace',
        task: async (message) => {
          message('Copying to marketplace directory...');
          copyPluginToMarketplace();
          return `Plugin files copied ${styleText('green', 'OK')}`;
        },
      });
      tasks.push({
        title: 'Installing marketplace dependencies',
        task: async (message) => {
          // runNpmInstallInMarketplace throws InstallAbortError on a real
          // failure (non-ERESOLVE, or ERESOLVE that --legacy-peer-deps could
          // not fix). We deliberately do NOT swallow it here — the top-level
          // handler turns it into "Installation Aborted" + exit 1.
          const stopHeartbeat = startHeartbeat(message, 'Running npm install…');
          try {
            await runNpmInstallInMarketplace(summary);
            writeMarketplaceInstallMarkers(
              marketplaceDirectory(),
              version,
              installedBunVersion ?? 'unknown',
              installedUvVersion ?? 'unknown',
            );
          } finally {
            stopHeartbeat();
          }
          return `Dependencies installed ${styleText('green', 'OK')}`;
        },
      });
    }

    await runTasks(tasks);
  }

  const failedIDEs = await setupIDEs(selectedIDEs, summary);

  // Optionally disable Claude Code's built-in auto-memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)
  // when the user explicitly opts in, either through the interactive prompt or
  // via --disable-auto-memory. claude-mem's hook-based memory is the intended
  // source of cross-session context, but we no longer mutate settings.json silently.
  // Four-state so the summary can distinguish "wrote", "already set", "left enabled",
  // and "failed". A boolean would conflate the error path with a deliberate no-op.
  let autoMemoryStatus: 'disabled' | 'already-disabled' | 'left-enabled' | 'failed' | null = null;
  const autoMemoryChoice = await resolveClaudeAutoMemoryChoice(selectedIDEs, options);
  if (autoMemoryChoice === 'disable') {
    try {
      const wrote = disableClaudeAutoMemory();
      autoMemoryStatus = wrote ? 'disabled' : 'already-disabled';
      if (wrote) {
        log.success('Claude Code: auto-memory disabled (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1).');
      } else {
        log.info('Claude Code: auto-memory already disabled, leaving settings.json untouched.');
      }
    } catch (error: unknown) {
      // Don't fail the install over this — WARN_CONTINUE via the central handler.
      autoMemoryStatus = 'failed';
      const err = error instanceof Error ? error : new Error(String(error));
      // [ANTI-PATTERN IGNORED]: recorded via installerError(WARN_CONTINUE) and flushed after the spinners; a direct console call would be clobbered by the clack UI.
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'auto-memory',
        phase: 'post-ide',
        cause: err,
      }, summary);
    }
  } else if (autoMemoryChoice === 'leave-enabled') {
    autoMemoryStatus = 'left-enabled';
    log.info('Claude Code: leaving native auto-memory enabled unless you explicitly opt in to disabling it.');
  }

  // Login is account-first for every install EXCEPT one that has already named
  // a provider needing no claude-mem account. `--provider claude` runs memory
  // on the user's own Anthropic plan and never touches cmem.ai, so gating it on
  // browser OAuth made an unrelated cmem.ai outage fail an install that could
  // have completed offline — and there is no account question left to ask,
  // because the flag already answered it.
  //
  // Deliberately keyed on the explicit flag, not on reachability: a silent
  // fallback to a local install whenever cmem.ai is down would quietly change
  // what the user gets. This only skips a step the user's own flag made moot.
  let oauthPairing: InstallerOAuthPairing | null = null;
  if (providerNeedsAccount(options.provider)) {
    oauthPairing = await requireInstallerOAuthLogin(version);
    if (!oauthPairing) {
      if (isInteractive) p.cancel('OAuth login is required to finish installation.');
      else console.error('OAuth login is required to finish installation.');
      process.exit(1);
    }
  } else {
    const skipReason = options.provider === 'host'
      ? 'host observer uses the logged-in host agent over a local OpenAI-compatible shim.'
      : '--provider claude runs memory on your own Anthropic plan.';
    log.info(`Skipping claude-mem login: ${skipReason}`);
  }
  const selectedProvider = await promptProvider(options, oauthPairing, version);
  const cloudSyncConfigured = [
    getSetting('CLAUDE_MEM_CLOUD_SYNC_TOKEN'),
    getSetting('CLAUDE_MEM_CLOUD_SYNC_USER_ID'),
    getSetting('CLAUDE_MEM_CLOUD_SYNC_HUB_URL'),
  ].every((value) => typeof value === 'string' && value.trim().length > 0);
  if (selectedProvider === 'claude') {
    await promptClaudeModel(options);
  }

  // The server runtime is brought up via its own stack (Docker pg+redis +
  // `claude-mem server start`), NOT the worker-service spawner. Skip the
  // worker-only autostart entirely so the server runtime never invokes the
  // worker path (#2543).
  const autoStartSkipped = !isInteractive || options.noAutoStart || selectedRuntime === 'server';

  await runTasks([
    {
      title: selectedRuntime === 'server' ? 'Starting server daemon' : 'Starting worker daemon',
      task: async (message) => {
        if (selectedRuntime === 'server') {
          return `Server runtime selected — start it with ${styleText('bold', 'npx claude-mem server start')} ${styleText('dim', '(or via Docker compose)')}`;
        }
        if (autoStartSkipped) {
          return isInteractive
            ? `Skipped (--no-auto-start)`
            : `Skipped (non-TTY)`;
        }
        const port = Number(getSetting('CLAUDE_MEM_WORKER_PORT'));
        const marketplaceScriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
        const cacheScriptPath = join(pluginCacheDirectory(version), 'scripts', 'worker-service.cjs');
        const scriptPath = existsSync(marketplaceScriptPath) ? marketplaceScriptPath : cacheScriptPath;
        // selectedRuntime is narrowed to 'worker' here: the server case
        // returned above and never reaches the worker-service spawner.
        message(`Spawning worker on port ${port}...`);
        // Stop any worker that came up during install with the previous
        // provider so the RAM queue cannot mix old/new settings. Runtime
        // POST /api/settings still must not recycle a healthy worker.
        await requireWorkerStopped(port, 'provider-cutover', summary);
        workerStartResult = await ensureWorkerStarted(port, scriptPath);
        switch (workerStartResult) {
          case 'ready':
            return `Worker ready at http://localhost:${port} ${styleText('green', 'OK')}`;
          case 'warming':
            return `Worker starting on port ${port} — finishing in background ${styleText('yellow', '⏳')}`;
          case 'dead':
            return `Worker did not start — try \`npx claude-mem start\` manually ${styleText('yellow', '!')}`;
        }
      },
    },
  ]);

  // "Installation Complete" only when no ABORT fired (we'd have thrown) AND no
  // IDE failed. Any failed IDE => "Installation Partial". Reads summary.failedIDEs
  // (which captures failures that happen AFTER bufferConsole returns), not a
  // stale local count.
  const hasFailures = summary.failedIDEs.length > 0;
  const installStatus = hasFailures ? 'Installation Partial' : 'Installation Complete';
  const accountStatus = providerNeedsAccount(options.provider)
    ? 'OAuth login complete'
    : (options.provider === 'host' ? 'Not required (host observer)' : 'Not required (local provider)');
  const summaryLines = [
    `Version:     ${styleText('cyan', version)}`,
    `Plugin dir:  ${styleText('cyan', marketplaceDir)}`,
    `IDEs:        ${styleText('cyan', selectedIDEs.join(', '))}`,
  ];
  summaryLines.push(`Account:     ${styleText('cyan', accountStatus)}`);
  summaryLines.push(`Cloud sync:  ${styleText('cyan', cloudSyncConfigured ? 'ON (CMEM Pro)' : 'OFF (local)')}`);
  if (autoMemoryStatus === 'disabled') {
    summaryLines.push(`Auto-memory: ${styleText('cyan', 'disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'already-disabled') {
    summaryLines.push(`Auto-memory: ${styleText('cyan', 'already disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'left-enabled') {
    summaryLines.push(`Auto-memory: ${styleText('cyan', 'left enabled')} (native Claude Code memory preserved)`);
  } else if (autoMemoryStatus === 'failed') {
    summaryLines.push(`Auto-memory: ${styleText('red', 'write failed')} (see warning above)`);
  }
  if (failedIDEs.length > 0) {
    summaryLines.push(`Failed:      ${styleText('red', failedIDEs.join(', '))}`);
  }

  if (isInteractive) {
    p.note(summaryLines.join('\n'), installStatus);
  } else {
    console.log(`\n  ${installStatus}`);
    summaryLines.forEach(l => console.log(`  ${l}`));
  }

  // Flush all WARN_CONTINUE / FAIL_LOUD_PER_IDE warnings + remediation AFTER the
  // spinners and summary note (a live print would be clobbered by clack).
  flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.log(`  ${line}`)));

  const workerHost = getSetting('CLAUDE_MEM_WORKER_HOST');
  const workerUrlHost = formatHostForUrl(workerHost);
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
      const healthResponse = await fetch(`http://${workerUrlHost}:${workerPort}/api/health`, {
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

    // A sign-in just wrote cloud-sync settings the worker booted with, so
    // one cheap read of /api/sync/status confirms sync is really configured.
    // Purely informational and fail-soft — a warming worker legitimately
    // can't answer yet, and the state is always visible via the cloud-sync skill.
    if (cloudSyncConfigured && workerReady) {
      try {
        const syncResponse = await fetch(`http://${workerUrlHost}:${actualPort}/api/sync/status`, {
          signal: AbortSignal.timeout(3000),
        });
        if (syncResponse.ok) {
          const sync = await syncResponse.json() as { configured?: boolean };
          if (sync && sync.configured === false) {
            log.warn('Cloud sync: worker has not picked up the sync settings yet — it will on its next restart.');
          } else {
            log.success('Cloud sync: configured — the worker is reporting sync status.');
          }
        }
      } catch {
        // [ANTI-PATTERN IGNORED]: this read-through is purely informational; a worker still warming up legitimately can't answer, and sync state stays visible via the cloud-sync skill.
      }
    }
  }

  const finalWorkerState = workerStartResult as WorkerStartResult;
  const workerAlive = finalWorkerState !== 'dead' || workerReady;
  const runtimeLabel = selectedRuntime === 'server' ? 'Server' : 'Worker';
  const runtimeStartCommand = selectedRuntime === 'server' ? 'npx claude-mem server start' : 'npx claude-mem start';
  const workerBaseUrl = `http://${workerUrlHost}:${actualPort}`;
  const configuredWorkerBaseUrl = `http://${workerUrlHost}:${workerPort}`;
  const workerHeadline = autoStartSkipped
    ? `${styleText('yellow', '!')} ${runtimeLabel} autostart skipped — start it manually with ${styleText('bold', runtimeStartCommand)}`
    : workerReady || finalWorkerState === 'ready'
      ? `${styleText('green', '✓')} ${runtimeLabel} running at ${styleText('underline', workerBaseUrl)}`
      : `${styleText('yellow', '⏳')} ${runtimeLabel} starting at ${styleText('underline', workerBaseUrl)} — give it ~30s, then refresh`;
  const nextStepsHeadline = autoStartSkipped || workerAlive
    ? workerHeadline
    : `${styleText('yellow', '!')} Worker not yet ready on port ${styleText('cyan', String(workerPort))} -- still starting up; check ${styleText('bold', 'claude-mem status')} later, or start manually: ${styleText('bold', 'npx claude-mem start')}`;
  const firstSuccessOpener = autoStartSkipped
    ? `once the worker is running, keep ${styleText('underline', configuredWorkerBaseUrl)} open in a browser`
    : workerAlive
      ? 'keep that URL open in a browser'
      : `keep ${styleText('underline', configuredWorkerBaseUrl)} open in a browser`;
  // Last screen of the funnel: it should read as an invitation to start, not a
  // manual. Everything here has to earn its line.
  //
  // Cut deliberately: the WELCOME_HINT_ENABLED env var (opting out of a hint
  // they have not seen yet), the uninstall warning (uninstall trivia on the
  // install screen), and the A/B "two paths" framing that dressed up "just
  // start working" as a decision the user has to make.
  const nextSteps = [
    nextStepsHeadline,
    ``,
    `${styleText('bold', 'Start working.')} Memory builds passively from your first prompt — observations stream in as Claude reads, edits, and runs commands.`,
    `To watch them live, ${firstSuccessOpener}.`,
    ``,
    `Memory injection starts on your second session in a project.`,
    cloudSyncConfigured
      ? 'Memory syncs across your signed-in CMEM Pro agents and devices.'
      : `Everything stays in ${styleText('cyan', '~/.claude-mem')} on this machine.`,
    ...(cloudSyncConfigured ? [] : [`${PRO_TRIAL_PITCH}: ${styleText('underline', proTrialUrl('installer'))}`]),
    ``,
    `${styleText('dim', `Optional: ${'/learn-codebase'} ingests a whole repo up front (~5 min)   ·   How it works: /how-it-works`)}`,
  ];

  if (isInteractive) {
    p.note(nextSteps.join('\n'), 'Next Steps');
    // Deliberately the last interaction of the flow: consent is asked after
    // the product is installed and working, never as a gate in front of it.
    await promptTelemetryOptIn();
    if (failedIDEs.length > 0) {
      p.outro(styleText('yellow', 'claude-mem installed with some IDE setup failures.'));
    } else {
      p.outro(styleText('green', 'claude-mem installed successfully!'));
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

  // After promptTelemetryOptIn so a just-made consent choice is honored.
  // ide/provider/runtime_mode/install_method are installer enums, the
  // *_version values are tool version strings — never user data.
  await captureCliEvent('install_completed', {
    ide: selectedIDEs.join(','),
    provider: selectedProvider,
    runtime_mode: selectedRuntime,
    is_update: alreadyInstalled,
    outcome: failedIDEs.length > 0 ? 'partial' : 'ok',
    duration_ms: Date.now() - installStartedAt,
    interactive: isInteractive,
    install_method: detectInstallMethod(),
    bun_version: installedBunVersion,
    uv_version: installedUvVersion,
    claude_code_version: detectClaudeCodeVersion(),
  }, { person: true });
}

async function runRepairCommandInner(summary: InstallSummary): Promise<void> {
  const version = readPluginVersion();
  const cacheDir = pluginCacheDirectory(version);
  const marketplaceDir = marketplaceDirectory();
  let bunVersion = 'unknown';
  let uvVersion = 'unknown';

  if (isInteractive) {
    p.intro(styleText(['bgCyan', 'black'], ' claude-mem repair '));
  } else {
    console.log('claude-mem repair');
  }
  log.info(`Version: ${styleText('cyan', version)}`);

  await runTasks([
    {
      title: 'Setting up runtime',
      task: async (message) => {
        message('Checking Bun…');
        const bun = await ensureBun(summary);
        bunVersion = bun.version;
        message('Checking uv…');
        const uv = await ensureUv(summary);
        uvVersion = uv.version;
        // Repair must regenerate the cache if it was wiped (e.g. user ran
        // `rm -rf ~/.claude/plugins/cache`). Without this, bun install would
        // fail immediately with no package.json to install against.
        if (!existsSync(join(cacheDir, 'package.json'))) {
          message('Cache missing — repopulating from npm package…');
          copyPluginToCache(version);
        }
        message('Reinstalling plugin dependencies…');
        const { bunPath } = bun;
        await installPluginDependencies(cacheDir, bunPath);
        writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
        return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${styleText('green', 'OK')}`;
      },
    },
    {
      title: 'Repairing marketplace runtime',
      task: async (message) => {
        message('Repopulating marketplace root from npm package…');
        copyPluginToMarketplace();
        message('Reinstalling marketplace dependencies…');
        const stopHeartbeat = startHeartbeat(message, 'Running npm install…');
        try {
          await runNpmInstallInMarketplace(summary);
          writeMarketplaceInstallMarkers(marketplaceDir, version, bunVersion, uvVersion);
        } finally {
          stopHeartbeat();
        }
        return `Marketplace runtime ready ${styleText('green', 'OK')}`;
      },
    },
  ]);

  flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.log(`  ${line}`)));

  if (isInteractive) {
    p.outro(styleText('green', 'claude-mem repair complete.'));
  } else {
    console.log('claude-mem repair complete.');
  }
}

export async function runRepairCommand(): Promise<void> {
  const summary = createInstallSummary();
  try {
    await runRepairCommandInner(summary);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err instanceof InstallAbortError) {
      flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.error(`  ${line}`)));
      const headline = `Repair Aborted: ${err.category.id}`;
      if (isInteractive) {
        p.log.error(headline);
        p.log.error(err.remediation);
        p.outro(styleText('red', 'claude-mem repair aborted.'));
      } else {
        console.error(`\n  ${headline}`);
        console.error(`  ${err.remediation}`);
        console.error(`  ${err.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

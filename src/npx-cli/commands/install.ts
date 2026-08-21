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
  CMEM_PRO_BASE_URL,
  CMEM_PRO_KEY_PATTERN,
  CMEM_PRO_MODEL,
  CMEM_PRO_MONTHLY_USD,
  CMEM_PRO_SIGNUP_URL,
  CMEM_PRO_TRIAL_DAYS,
  CMEM_PRO_TRIAL_POLL_URL,
  CMEM_PRO_TRIAL_START_URL,
  costPer1kObservations,
  fetchBlendedRates,
} from '../cmem-pro-costs.js';
import { PRO_TRIAL_PITCH, proTrialUrl } from '../../shared/pro-promo.js';

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
          return `Cursor: hooks installed; MCP setup failed — run \`npx claude-mem cursor mcp\` ${styleText('yellow', '!')}`;
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
    '.agents',
    '.codex-plugin',
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

type ProviderId = 'claude' | 'gemini' | 'openrouter';
/**
 * What the installer prompt may offer. `cmem` is a prompt-only sentinel: picking
 * it configures the generic OpenAI-compatible path (base URL + model + key) and
 * persists CLAUDE_MEM_PROVIDER='openrouter'. The worker only understands
 * 'claude' | 'gemini' | 'openrouter', so 'cmem' must never reach settings.json.
 */
type ProviderChoice = ProviderId | 'cmem';
type ClaudeAccessMode = 'subscription' | 'api-key';
type ClaudeApiMode = 'direct' | 'gateway';
// Phase 1d: Persisted DB literals (`server_beta_schema_migrations`, job_type
// enums, `server-beta-worker` lockedBy marker) are intentionally preserved in
// the source code; runtime-selector dual-accepts both `'server'` and
// `'server-beta'` settings values, but the installer writes the new canonical
// form `'server'` going forward (settings keys: CLAUDE_MEM_SERVER_{URL,
// API_KEY,PROJECT_ID}).
type RuntimeId = 'worker' | 'server';

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

async function promptProvider(options: InstallOptions): Promise<ProviderId> {
  const initialProvider = (getSetting('CLAUDE_MEM_PROVIDER') as ProviderId) || 'claude';

  const persistClaudeProvider = (authMethod?: 'subscription' | 'api-key' | 'gateway') => {
    const resolvedAuthMethod = authMethod ?? resolveClaudeAuthMethod();
    const wrote = mergeSettings({
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: resolvedAuthMethod,
    });
    if (wrote) log.info('Saved Claude Agent SDK configuration to ~/.claude-mem/settings.json');
  };

  const useSubscriptionAuth = () => {
    persistClaudeProvider('subscription');
    saveClaudeMemEnv({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    log.info('Configured claude-mem to use your logged-in Claude SDK account.');
  };

  const configureDirectApiKey = async (): Promise<void> => {
    const existing = loadClaudeMemEnv().ANTHROPIC_API_KEY || '';
    if (existing.trim().length > 0) {
      const choice = await p.select<'keep' | 'replace'>({
        message: 'An Anthropic API key is already configured. Keep it or enter a new one?',
        options: [
          { value: 'keep', label: 'Keep existing key' },
          { value: 'replace', label: 'Enter a new key (rotate)' },
        ],
        initialValue: 'keep',
      });
      if (p.isCancel(choice)) {
        log.warn('API key prompt cancelled — leaving existing configuration untouched.');
        return;
      }
      if (choice === 'keep') {
        saveClaudeMemEnv({
          ANTHROPIC_API_KEY: existing.trim(),
          ANTHROPIC_BASE_URL: '',
          ANTHROPIC_AUTH_TOKEN: '',
        });
        persistClaudeProvider('api-key');
        return;
      }
    }

    const apiKeyResult = await p.password({
      message: 'Paste your Anthropic API key:',
      mask: '*',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
    });

    if (p.isCancel(apiKeyResult)) {
      log.warn('API key prompt cancelled — leaving existing configuration untouched.');
      return;
    }

    saveClaudeMemEnv({
      ANTHROPIC_API_KEY: String(apiKeyResult).trim(),
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    persistClaudeProvider('api-key');
    log.info('Saved Anthropic API key for the Claude Agent SDK path.');
  };

  const configureGateway = async (): Promise<void> => {
    const existing = loadClaudeMemEnv();
    const baseUrlResult = await p.text({
      message: 'Gateway URL:',
      placeholder: existing.ANTHROPIC_BASE_URL || 'http://localhost:4000',
      defaultValue: existing.ANTHROPIC_BASE_URL || '',
      validate: (v?: string) => {
        const value = v?.trim() ?? '';
        if (!value) return 'Gateway URL required';
        try {
          new URL(value);
          return undefined;
        } catch {
          // [ANTI-PATTERN IGNORED]: a URL parse failure here just means the user typed an invalid gateway URL; the recovery is the inline validation message the prompt displays on every attempt.
          return 'Enter a valid URL, for example http://localhost:4000';
        }
      },
    });

    if (p.isCancel(baseUrlResult)) {
      log.warn('Gateway setup cancelled — leaving existing configuration untouched.');
      return;
    }

    const tokenResult = await p.password({
      message: 'Gateway key/token (leave blank to keep current token, or type a new one):',
      mask: '*',
    });

    const tokenCancelled = p.isCancel(tokenResult);
    const tokenInput = tokenCancelled ? '' : String(tokenResult).trim();
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: String(baseUrlResult).trim(),
    };
    if (!tokenCancelled && tokenInput.length > 0) {
      env.ANTHROPIC_AUTH_TOKEN = tokenInput;
    }
    saveClaudeMemEnv(env);
    persistClaudeProvider('gateway');
    if (tokenCancelled || tokenInput.length === 0) {
      log.info('Gateway URL saved; existing gateway token preserved.');
    } else {
      log.info('Configured Claude Agent SDK gateway in ~/.claude-mem/.env.');
    }
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

  const runClaudeAuthFlow = async (): Promise<void> => {
    const resolvedAuthMethod = resolveClaudeAuthMethod();
    const initialAccessMode: ClaudeAccessMode =
      resolvedAuthMethod === 'subscription' ? 'subscription' : 'api-key';

    const result = await p.select<ClaudeAccessMode>({
      message: 'Do you use a subscription plan or an API key/gateway for the memory agent?',
      options: [
        { value: 'subscription', label: 'Subscription plan (recommended — uses your logged-in Claude SDK account)' },
        { value: 'api-key', label: 'API key or gateway (Anthropic, LiteLLM, or compatible proxy)' },
      ],
      initialValue: initialAccessMode,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (result === 'subscription') {
      useSubscriptionAuth();
      return;
    }

    const apiModeResult = await p.select<ClaudeApiMode>({
      message: 'How should claude-mem connect?',
      options: [
        { value: 'direct', label: 'Anthropic API key' },
        { value: 'gateway', label: 'LiteLLM or custom gateway' },
      ],
      initialValue: resolvedAuthMethod === 'gateway' || loadClaudeMemEnv().ANTHROPIC_BASE_URL ? 'gateway' : 'direct',
    });

    if (p.isCancel(apiModeResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    if (apiModeResult === 'gateway') {
      await configureGateway();
    } else {
      await configureDirectApiKey();
    }
  };

  let selectedProvider: ProviderChoice;
  if (options.provider) {
    selectedProvider = options.provider;
  } else {
    // Rates are looked up live so the prompt never quotes a stale price. The
    // lookup is timeout-bounded and falls back silently, so an offline install
    // still gets a working prompt — just with last-known figures.
    const labels = await buildProviderLabels();

    const providerResult = await p.select<ProviderChoice>({
      message: 'Which memory provider do you want to use?',
      options: [
        { value: 'cmem', label: labels.cmem, hint: labels.cmemHint },
        { value: 'openrouter', label: labels.openrouter },
        { value: 'gemini', label: labels.gemini },
        { value: 'claude', label: labels.claude },
      ],
      initialValue: 'cmem',
    });
    if (p.isCancel(providerResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    selectedProvider = providerResult;
  }

  // CMEM Pro: no new provider code. The worker's OpenRouter client is a generic
  // OpenAI-compatible client whose endpoint and model both come from settings,
  // so "use the CMEM observer model" is four settings writes and nothing else.
  if (selectedProvider === 'cmem') {
    p.note(
      `${CMEM_PRO_TRIAL_DAYS} days free, then $${CMEM_PRO_MONTHLY_USD}/mo — card required, cancel anytime.\n`
        + `Opening ${CMEM_PRO_SIGNUP_URL}\n`
        + "Sign in, start your free month, and copy the key you're shown.",
      `cmem Pro — ${CMEM_PRO_TRIAL_DAYS} days free`,
    );
    openBrowser(CMEM_PRO_SIGNUP_URL);

    const keyResult = await p.text({
      message: 'Paste your CMEM Pro key (starts with cm_pro_):',
      validate: (v?: string) =>
        CMEM_PRO_KEY_PATTERN.test((v ?? '').trim())
          ? undefined
          : 'That does not look like a CMEM Pro key.',
    });

    if (p.isCancel(keyResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    const wrote = mergeSettings({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_PRO_BASE_URL,
      CLAUDE_MEM_OPENROUTER_MODEL: CMEM_PRO_MODEL,
      CLAUDE_MEM_OPENROUTER_API_KEY: String(keyResult).trim(),
    });
    if (wrote) log.info('Saved CMEM Pro configuration to ~/.claude-mem/settings.json');

    p.note(
      'Next: finish cloud sync in the browser — press NEXT on the page.',
      'CMEM Pro ready',
    );
    await promptProFallbackProvider();
    return 'openrouter';
  }

  if (selectedProvider === 'claude') {
    await runClaudeAuthFlow();
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
    validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
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

type FallbackChoice = 'claude' | 'gemini' | 'none';

/**
 * Second choice of the Pro paths: what claude-mem should run on when the Pro
 * allowance runs out (allowance_exhausted / subscription_inactive from the
 * gateway flips the 24h pro-fallback marker — see src/shared/pro-fallback.ts).
 * Asked right after Pro is configured, while the user is still in provider
 * headspace. openrouter is deliberately absent: its settings slots carry the
 * Pro token. Non-TTY / cancel: the 'claude' default in SettingsDefaultsManager
 * stands, so there is nothing to write.
 */
async function promptProFallbackProvider(): Promise<void> {
  if (!isInteractive) return;

  const fallbackResult = await p.select<FallbackChoice>({
    message: 'If your Pro allowance runs out, claude-mem can keep working on a fallback provider. Fall back to:',
    options: [
      { value: 'claude', label: 'Claude plan (recommended)', hint: 'no key needed' },
      { value: 'gemini', label: 'Gemini API key', hint: 'requires Gemini API key' },
      { value: 'none', label: 'No fallback', hint: 'pause memory generation instead' },
    ],
    initialValue: 'claude',
  });

  let choice: FallbackChoice = p.isCancel(fallbackResult) ? 'claude' : fallbackResult;

  if (choice === 'gemini') {
    // Same key slot and prompt shape as the gemini branch of promptProvider —
    // an already-stored key is reused, never re-asked.
    const existingKey = getSetting('CLAUDE_MEM_GEMINI_API_KEY');
    if (!existingKey || existingKey.trim().length === 0) {
      const apiKeyResult = await p.password({
        message: 'Paste your Gemini API key:',
        mask: '*',
        validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
      });
      if (p.isCancel(apiKeyResult)) {
        log.warn('Gemini key prompt cancelled — using your Claude plan as the fallback instead.');
        choice = 'claude';
      } else {
        mergeSettings({ CLAUDE_MEM_GEMINI_API_KEY: String(apiKeyResult).trim() });
      }
    }
  }

  const wrote = mergeSettings({ CLAUDE_MEM_FALLBACK_PROVIDER: choice });
  if (wrote) log.info(`Saved fallback=${choice} to ~/.claude-mem/settings.json`);
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
      { value: 'claude-opus-4-8', label: 'Opus 4.8 (highest quality, most expensive)' },
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

// --- cmem Pro 30-day trial opt-in -------------------------------------------
// The first interaction of the install (replaces the old CMEM Online waitlist
// opt-in — one funnel, not two). Entering an email POSTs to cmem.ai, which
// creates the account server-side and emails a sign-in link; the response is a
// pairing id/secret this installer polls at the provider step
// (completeTrialPairing) to receive credentials once the human has finished
// login + Stripe checkout (card, $0 today) in the browser. The server-side
// contract lives in cmem-pro-mvp `plans/2026-08-08-seven-day-trial-npx-funnel.md`.
// Every network call here is timeout-bounded and fail-soft: a cmem.ai outage
// must never break `npx claude-mem install`.

const SIGNUP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TRIAL_START_TIMEOUT_MS = 10_000;
const TRIAL_POLL_TIMEOUT_MS = 10_000;
/**
 * Total time the provider step waits for the browser steps. Card entry is
 * slower than a login click, hence minutes, not seconds; past the budget the
 * install falls back to the normal provider prompt rather than stranding the
 * session.
 */
const TRIAL_POLL_BUDGET_MS = 240_000;
/** Poll cadence fallback when the start response omits poll_interval. */
const TRIAL_DEFAULT_POLL_INTERVAL_S = 3;
const TRIAL_UNREACHABLE_WARNING = "Couldn't reach cmem.ai — start the trial later with npx claude-mem install";
const TRIAL_FINISH_LATER_WARNING = 'No worries — finish anytime: npx claude-mem install';

interface TrialPairing {
  pairingId: string;
  secret: string;
  pollIntervalMs: number;
  /**
   * Device-authorization user code (e.g. "WXYZ-4823") the human must type into
   * the browser to approve THIS device before poll delivers credentials. Null
   * when the server predates the approval step (older contract) — the flow
   * then works the old way with no approval stage. Display-only: never written
   * to settings, never sent to telemetry.
   */
  userCode: string | null;
  /**
   * OAuth signup path: a cmem.ai login URL that claims this pairing after a
   * GitHub/Google sign-in — the email-free route for brand-new accounts. Null
   * when the server predates the OAuth-signup contract; the flow then works
   * exactly as before (email link only). Display-only, like userCode.
   */
  claimUrl: string | null;
}

interface StoredTrialState {
  email: string;
  /** 'link_sent' (started, credentials never picked up) | 'active' (done). */
  state: string;
}

function parseStoredTrialState(): StoredTrialState | null {
  const flat = readFlatSettings(USER_SETTINGS_PATH);
  if (!flat) return null;
  const email = typeof flat.CLAUDE_MEM_PRO_TRIAL_EMAIL === 'string' ? flat.CLAUDE_MEM_PRO_TRIAL_EMAIL : '';
  if (!email) return null;
  return {
    email,
    state: typeof flat.CLAUDE_MEM_PRO_TRIAL_STATE === 'string' ? flat.CLAUDE_MEM_PRO_TRIAL_STATE : '',
  };
}

function readStoredTrialState(): StoredTrialState | null {
  try {
    return parseStoredTrialState();
  } catch {
    // [ANTI-PATTERN IGNORED]: settings.json is optional and may be missing or hand-edited into invalid JSON; treating that as "no stored trial state" simply re-offers the trial, the designed recovery for this never-blocking flow.
    return null;
  }
}

/**
 * POST /api/pro/trial/start. Returns the pairing on 200, null on ANY failure
 * (bad status, malformed body, network error, 10s timeout) — callers surface
 * the failure with a log.warn and the install continues as if skipped.
 */
async function startTrialPairing(email: string): Promise<TrialPairing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIAL_START_TIMEOUT_MS);
  try {
    const res = await fetch(CMEM_PRO_TRIAL_START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'npx-installer', device_name: hostname() }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { pairing_id?: unknown; secret?: unknown; poll_interval?: unknown; user_code?: unknown; claim_url?: unknown };
    if (typeof body.pairing_id !== 'string' || typeof body.secret !== 'string') return null;
    // Clamp the server-controlled cadence to [1s, 30s]: the 240s poll budget
    // is only checked at the top of the loop, so an unclamped interval could
    // defeat it (and a sub-second one would hammer the endpoint).
    const pollIntervalS = typeof body.poll_interval === 'number' && Number.isFinite(body.poll_interval) && body.poll_interval > 0
      ? Math.min(Math.max(body.poll_interval, 1), 30)
      : TRIAL_DEFAULT_POLL_INTERVAL_S;
    // user_code arrived with the device-approval contract; an older server
    // omits it and the flow degrades gracefully (no code note, no approval
    // stage copy) — see TrialPairing.userCode.
    const userCode = typeof body.user_code === 'string' && body.user_code.trim().length > 0
      ? body.user_code.trim()
      : null;
    // claim_url arrived with the OAuth-signup contract; optional so older
    // servers behave exactly as today — see TrialPairing.claimUrl.
    const claimUrl = typeof body.claim_url === 'string' && body.claim_url.trim().length > 0
      ? body.claim_url.trim()
      : null;
    return { pairingId: body.pairing_id, secret: body.secret, pollIntervalMs: pollIntervalS * 1000, userCode, claimUrl };
  } catch {
    // [ANTI-PATTERN IGNORED]: network/timeout failures here are NOT silent — every caller pairs the null return with a log.warn telling the user how to start the trial later; the install itself must proceed regardless.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type TrialPollStage = 'awaiting_login' | 'awaiting_checkout' | 'awaiting_approval';

type TrialPollOutcome =
  | { kind: 'pending'; stage: TrialPollStage }
  | { kind: 'ready'; userId: string; setupToken: string; hubUrl: string; trialEndsAt: string | null }
  /** 410 expired/delivered or 404 unknown — this pairing will never succeed. */
  | { kind: 'gone' }
  /** Network error, timeout, 5xx/429, or malformed body — maybe transient. */
  | { kind: 'unreachable' };

/** One POST to /api/pro/trial/poll, timeout-bounded. Never throws. */
async function pollTrialOnce(pairing: TrialPairing): Promise<TrialPollOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIAL_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(CMEM_PRO_TRIAL_POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_id: pairing.pairingId, secret: pairing.secret }),
      signal: controller.signal,
    });
    if (res.status === 410 || res.status === 404) return { kind: 'gone' };
    if (res.status === 202) {
      const body = await res.json().catch(() => ({})) as { stage?: unknown };
      return {
        kind: 'pending',
        stage: body.stage === 'awaiting_checkout' || body.stage === 'awaiting_approval'
          ? body.stage
          : 'awaiting_login',
      };
    }
    if (res.ok) {
      const body = await res.json() as {
        status?: unknown;
        user_id?: unknown;
        setup_token?: unknown;
        hub_url?: unknown;
        trial?: { ends_at?: unknown };
      };
      if (
        body.status === 'ready'
        && typeof body.user_id === 'string'
        && typeof body.setup_token === 'string'
        && typeof body.hub_url === 'string'
      ) {
        return {
          kind: 'ready',
          userId: body.user_id,
          setupToken: body.setup_token,
          hubUrl: body.hub_url,
          trialEndsAt: typeof body.trial?.ends_at === 'string' ? body.trial.ends_at : null,
        };
      }
      return { kind: 'unreachable' };
    }
    return { kind: 'unreachable' };
  } catch {
    // [ANTI-PATTERN IGNORED]: a failed poll is an expected transient during the human's browser dance; completeTrialPairing counts consecutive failures and warns loudly before giving up.
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep in 250ms slices so a Ctrl+C — which clack's active spinner converts
 * into `isCancelled` without killing the process — interrupts the wait
 * promptly instead of after a full poll interval.
 */
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

/**
 * Show the device-approval code the human must type into the browser (after
 * the magic-link login) to approve this device — the step that closes the
 * pairing-hijack hole, so it must be impossible to miss. No-op when the
 * server didn't send a code (older contract: no approval step exists).
 */
/**
 * OAuth alternative to the emailed sign-in link: print the claim URL when the
 * server sent one (OAuth-signup contract). No-op for older servers — the
 * email-only flow stays byte-for-byte what it was.
 */
function noteTrialClaimUrl(pairing: TrialPairing): void {
  if (!pairing.claimUrl) return;
  log.info(`Or sign in with GitHub/Google to claim: ${styleText('underline', pairing.claimUrl)}`);
}

function noteTrialUserCode(pairing: TrialPairing): void {
  if (!pairing.userCode) return;
  p.note(
    [
      styleText(['bold', 'cyan'], pairing.userCode),
      '',
      "You'll type this in the browser to approve this device.",
    ].join('\n'),
    'Your device code',
  );
}

/**
 * First message after the banner: the cmem Pro free-week pitch. Entering an
 * email starts the trial server-side (account + sign-in email) and returns
 * the pairing the provider step later polls; Enter (or any failure) returns
 * null and the install proceeds exactly as before. Deliberately non-blocking:
 * the human does email + Stripe in the browser while the install works
 * through the IDE/runtime steps.
 */
async function promptProTrialOptIn(version: string): Promise<TrialPairing | null> {
  // Interactive-only, and easy to turn off for CI / scripted installs.
  if (!isInteractive) return null;
  if (process.env.CI) return null;
  if (String(process.env.CLAUDE_MEM_ONLINE_OPTIN ?? '').trim().toLowerCase() === 'false') return null;

  const prior = readStoredTrialState();
  if (prior) {
    // We already captured this email — never re-pitch. If a previous install
    // sent a link that was never picked up (state 'link_sent'; the pairing TTL
    // is 30 minutes, so it has long expired), ask before sending a fresh one:
    // a silent resend would email the user (and start the 240s poll) on every
    // future install/update forever. Decline leaves state untouched, so the
    // offer repeats next time; CLAUDE_MEM_ONLINE_OPTIN=false kills it outright.
    if (prior.state !== 'link_sent') return null;

    const resendChoice = await p.confirm({
      message: `You started a cmem Pro trial earlier — send a fresh sign-in link to ${prior.email}?`,
      initialValue: false,
    });
    if (p.isCancel(resendChoice) || resendChoice !== true) return null;

    const spin = p.spinner();
    spin.start(`Resending your cmem Pro sign-in link to ${prior.email}…`);
    const resendStartedAt = Date.now();
    const pairing = await startTrialPairing(prior.email);
    if (!pairing) {
      spin.stop(styleText('yellow', 'Could not resend the sign-in link.'));
      log.warn(TRIAL_UNREACHABLE_WARNING);
      return null;
    }
    mergeSettings({ CLAUDE_MEM_PRO_TRIAL_AT: new Date().toISOString() });
    spin.stop('Sign-in link resent.');
    p.note(
      'Check your email — click the sign-in link and add a card ($0 today).\nInstall continues; we pick it up automatically.',
      'Link sent',
    );
    noteTrialClaimUrl(pairing);
    noteTrialUserCode(pairing);
    await captureCliEvent('trial_link_sent', { version, duration_ms: Date.now() - resendStartedAt });
    return pairing;
  }

  // The alt-path figure is live-fetched (with a bounded timeout and baked
  // fallback) so the pitch never quotes a stale price. Framing rule: never
  // print a $/1k figure for Pro itself — it is a flat subscription that does
  // not bill the user's tokens.
  const { rates } = await fetchBlendedRates();
  const haikuPer1k = costPer1kObservations(rates.claude);

  p.note(
    [
      styleText(['bold', 'cyan'], 'Free month of Pro: cloud memory generation + sync across machines.'),
      '',
      'Memory generation runs on our metered models instead of your',
      `Anthropic plan — the default Haiku path burns ~$${haikuPer1k}/1k observations`,
      "of your plan's tokens; Pro takes $0 from it.",
      `${CMEM_PRO_TRIAL_DAYS} days free, then $${CMEM_PRO_MONTHLY_USD}/mo — card required, cancel anytime.`,
      '',
      "Enter your email to start (we'll send a sign-in link) — or press",
      'Enter to skip and use local generation.',
    ].join('\n'),
    `cmem Pro — ${CMEM_PRO_TRIAL_DAYS} days free`,
  );

  const emailResult = await p.text({
    message: 'Your email (press Enter to skip):',
    placeholder: 'you@company.com',
    defaultValue: '',
    validate: (v?: string) => {
      const value = (v ?? '').trim();
      if (value.length === 0) return undefined; // empty = skip, not an error
      if (!SIGNUP_EMAIL_RE.test(value)) return "That doesn't look like an email — fix it, or clear the field to skip.";
      return undefined;
    },
  });

  if (p.isCancel(emailResult)) return null;
  const email = String(emailResult).trim();
  if (email.length === 0) return null;

  await captureCliEvent('trial_email_submitted', { version });

  const spin = p.spinner();
  spin.start('Starting your free month — sending the sign-in link…');
  const startRequestAt = Date.now();
  const pairing = await startTrialPairing(email);
  if (!pairing) {
    spin.stop(styleText('yellow', 'Could not start the trial.'));
    // NOT fail-silent (unlike the old waitlist opt-in): the user typed an
    // email expecting something to happen, so say what went wrong and how to
    // retry. Nothing is persisted, so the next install re-offers the trial.
    log.warn(TRIAL_UNREACHABLE_WARNING);
    return null;
  }

  // Don't-re-nag persistence: a stored email means we never re-pitch. The
  // provider step flips STATE to 'active' once credentials arrive; until then
  // 'link_sent' makes future installs offer to resend the link (confirm
  // prompt above).
  mergeSettings({
    CLAUDE_MEM_PRO_TRIAL_EMAIL: email,
    CLAUDE_MEM_PRO_TRIAL_AT: new Date().toISOString(),
    CLAUDE_MEM_PRO_TRIAL_STATE: 'link_sent',
  });
  spin.stop('Sign-in link sent.');
  p.note(
    'Check your email — click the sign-in link and add a card ($0 today).\nInstall continues; we pick it up automatically.',
    'Link sent',
  );
  noteTrialClaimUrl(pairing);
  noteTrialUserCode(pairing);
  await captureCliEvent('trial_link_sent', { version, duration_ms: Date.now() - startRequestAt });
  return pairing;
}

/**
 * The jump-forward: runs at the provider step when the opt-in produced a
 * pairing. Polls cmem.ai until the human finishes login + checkout in the
 * browser, then writes provider + cloud-sync settings in ONE mergeSettings
 * call and skips the provider prompt entirely (returns 'openrouter').
 *
 * Every failure mode — pairing expiry, poll budget exhaustion, Ctrl+C,
 * cmem.ai outage — returns null with a warning, and the caller falls through
 * to the normal provider prompt: the trial can never break the install.
 */
async function completeTrialPairing(pairing: TrialPairing, version: string): Promise<'openrouter' | null> {
  const startedAt = Date.now();
  const stageMessages: Record<TrialPollStage, string> = {
    awaiting_login: 'Waiting for you to click the sign-in link…',
    awaiting_checkout: 'Waiting for checkout ($0 today)…',
    // Device-approval stage: the human types the user code shown at opt-in
    // into the browser. Generic copy when an older-contract server never sent
    // a code but still (unexpectedly) reports this stage — never crash on it.
    awaiting_approval: pairing.userCode
      ? `Enter code ${pairing.userCode} in the browser to approve this device…`
      : 'Waiting for approval in the browser…',
  };
  let stage: TrialPollStage = 'awaiting_login';

  // Honest copy: on the common path clack's raw-mode keypress handler turns
  // Ctrl+C during a spinner into a clean exit of the WHOLE installer (the
  // ETX fallback below only catches the rare press clack misses), so tell
  // the user exactly that before the wait begins.
  log.info(styleText('dim', 'Ctrl+C exits — finish anytime with npx claude-mem install'));

  const spin = p.spinner({ cancelMessage: 'Stopped waiting for the browser steps.' });
  spin.start(stageMessages[stage]);

  // Ctrl+C handling. The preceding prompt's readline close() leaves stdin
  // explicitly PAUSED, so during a bare spinner the Ctrl+C byte would sit
  // unread in the tty buffer and the "cancel key exits" behavior clack gives
  // every other spinner in this file would not fire until much later
  // (observed empirically). Resume stdin for the duration of the poll so the
  // first Ctrl+C is delivered immediately — normally clack's raw-mode
  // keypress handler then exits cleanly (its standard spinner behavior); the
  // data listener below is the fallback that turns any press clack misses
  // into a graceful escape to the provider prompt. Restored in the finally.
  let ctrlCPressed = false;
  const onStdinData = (chunk: Buffer | string): void => {
    if (typeof chunk === 'string' ? chunk.includes('\x03') : chunk.includes(0x03)) {
      ctrlCPressed = true;
    }
  };
  process.stdin.on('data', onStdinData);
  process.stdin.resume();
  const wasCancelled = (): boolean => spin.isCancelled || ctrlCPressed;

  const bailCancelled = async (): Promise<null> => {
    if (!spin.isCancelled) spin.cancel('Stopped waiting for the browser steps.');
    log.warn(TRIAL_FINISH_LATER_WARNING);
    await captureCliEvent('trial_poll_timeout', {
      version,
      stage,
      outcome: 'cancelled',
      duration_ms: Date.now() - startedAt,
    });
    return null;
  };

  try {
    let consecutiveFailures = 0;
    while (Date.now() - startedAt < TRIAL_POLL_BUDGET_MS) {
      if (wasCancelled()) return bailCancelled();

      const result = await pollTrialOnce(pairing);
      // Re-check: Ctrl+C may have landed during the (up to 10s) poll request.
      if (wasCancelled()) return bailCancelled();

      if (result.kind === 'ready') {
        // ONE mergeSettings call: the seven funnel keys (provider trio + key,
        // sync trio) land atomically so an interruption can never leave the
        // provider configured without sync or vice versa. Device id/name are
        // deliberately absent — the worker mints them on first CloudSync start.
        const wrote = mergeSettings({
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_PRO_BASE_URL,
          CLAUDE_MEM_OPENROUTER_MODEL: CMEM_PRO_MODEL,
          CLAUDE_MEM_OPENROUTER_API_KEY: result.setupToken,
          CLAUDE_MEM_CLOUD_SYNC_TOKEN: result.setupToken,
          CLAUDE_MEM_CLOUD_SYNC_USER_ID: result.userId,
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: result.hubUrl,
          CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
        });
        if (!wrote) {
          // mergeSettings already logged the write error. The setup token was
          // delivered exactly once and is now lost — fall back to the normal
          // provider prompt rather than pretending Pro is configured.
          spin.stop(styleText('yellow', 'Could not save cmem Pro settings.'));
          log.warn(TRIAL_FINISH_LATER_WARNING);
          return null;
        }
        const endsAt = result.trialEndsAt ? new Date(result.trialEndsAt) : null;
        const endsAtLabel = endsAt && !Number.isNaN(endsAt.getTime())
          ? endsAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : `in ${CMEM_PRO_TRIAL_DAYS} days`;
        spin.stop('cmem Pro credentials received.');
        p.note(
          `✓ Free month active — cloud generation + sync ON.\n$${CMEM_PRO_MONTHLY_USD}/mo starts ${endsAtLabel}; cancel anytime at cmem.ai.`,
          'cmem Pro ready',
        );
        await captureCliEvent('trial_activated', { version, duration_ms: Date.now() - startedAt });
        return 'openrouter';
      }

      if (result.kind === 'gone') {
        spin.stop(styleText('yellow', 'That sign-in link has expired.'));
        log.warn(TRIAL_FINISH_LATER_WARNING);
        await captureCliEvent('trial_poll_timeout', {
          version,
          stage,
          outcome: 'expired',
          duration_ms: Date.now() - startedAt,
        });
        return null;
      }

      if (result.kind === 'unreachable') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          spin.stop(styleText('yellow', 'cmem.ai is not responding.'));
          log.warn(TRIAL_UNREACHABLE_WARNING);
          await captureCliEvent('trial_poll_timeout', {
            version,
            stage,
            outcome: 'unreachable',
            duration_ms: Date.now() - startedAt,
          });
          return null;
        }
      } else {
        consecutiveFailures = 0;
        if (result.stage !== stage) {
          stage = result.stage;
          spin.message(stageMessages[stage]);
        }
      }

      await sleepUnlessCancelled(pairing.pollIntervalMs, wasCancelled);
    }

    if (wasCancelled()) return bailCancelled();
    spin.stop(styleText('yellow', 'Still waiting on the browser steps — moving on.'));
    log.warn(TRIAL_FINISH_LATER_WARNING);
    await captureCliEvent('trial_poll_timeout', {
      version,
      stage,
      outcome: 'timeout',
      duration_ms: Date.now() - startedAt,
    });
    return null;
  } finally {
    process.stdin.off('data', onStdinData);
    // Re-pause so stdin is in the same state the next clack prompt expects
    // (each prompt resumes it itself).
    process.stdin.pause();
  }
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

export interface InstallOptions {
  ide?: string;
  provider?: 'claude' | 'gemini' | 'openrouter';
  model?: string;
  noAutoStart?: boolean;
  disableAutoMemory?: boolean;
  // #2543 — non-interactive runtime selection. `server` is the operator-facing
  // alias for the canonical `server-beta` runtime id.
  runtime?: 'worker' | 'server' | 'server-beta';
  // Base URL the server runtime (and the injected IDE MCP config) targets.
  serverUrl?: string;
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

  // An explicit --provider flag wins over the trial funnel: never pitch,
  // email, poll, or override a provider the operator asked for by name.
  const trialPairing = options.provider ? null : await promptProTrialOptIn(version);

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
  // Jump-forward: a pairing from the trial opt-in means the human is doing
  // (or has done) login + checkout in the browser — poll for credentials
  // instead of asking which provider to use. Any failure (expired link, poll
  // budget, Ctrl+C, cmem.ai outage) falls through to the normal prompt.
  let selectedProvider: ProviderId | null = null;
  if (trialPairing && !options.provider) {
    selectedProvider = await completeTrialPairing(trialPairing, version);
  }
  const trialActivated = selectedProvider === 'openrouter';
  if (trialActivated) {
    // Outside completeTrialPairing on purpose: its poll loop holds a raw
    // stdin data listener, and prompting is done from the normal clean-stdin
    // state every other clack prompt in this file runs in.
    await promptProFallbackProvider();
  }
  if (selectedProvider === null) {
    selectedProvider = await promptProvider(options);
  }
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
        const stopMessage = result.workerWasRunning ? 'Stopped running worker before overwrite.' : 'No worker running — proceeding.';
        if (shutdownSpinner) {
          shutdownSpinner.stop(stopMessage);
        } else if (result.workerWasRunning) {
          log.info('Stopped running worker before overwrite.');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (shutdownSpinner) {
          shutdownSpinner.error(`Pre-overwrite worker shutdown failed: ${message}`);
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
  const summaryLines = [
    `Version:     ${styleText('cyan', version)}`,
    `Plugin dir:  ${styleText('cyan', marketplaceDir)}`,
    `IDEs:        ${styleText('cyan', selectedIDEs.join(', '))}`,
  ];
  if (trialActivated) {
    summaryLines.push(`Cloud sync:  ${styleText('cyan', 'ON (cmem Pro free month)')}`);
  }
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

    // Trial installs just wrote cloud-sync settings the worker booted with, so
    // one cheap read of /api/sync/status confirms sync is really configured.
    // Purely informational and fail-soft — a warming worker legitimately
    // can't answer yet, and the state is always visible via the cloud-sync skill.
    if (trialActivated && workerReady) {
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
  const nextSteps = [
    nextStepsHeadline,
    ``,
    `${styleText('bold', 'First success:')} ${firstSuccessOpener}, then open Claude Code in any project. Observations stream in as Claude reads, edits, and runs commands.`,
    ``,
    `${styleText('bold', 'Two paths from here:')}`,
    `  ${styleText('cyan', 'A.')} Just start working. Memory builds passively from your first prompt. (Recommended.)`,
    `  ${styleText('cyan', 'B.')} Front-load it: open Claude Code and run ${styleText('bold', '/learn-codebase')} to ingest the whole repo (~5 min, optional).`,
    ``,
    `Memory injection starts on your second session in a project.`,
    `Everything stays in ${styleText('cyan', '~/.claude-mem')} on this machine.`,
    ``,
    // Suppressed when the trial was just activated in this same run — pitching
    // an offer the user already accepted 30 seconds ago reads as broken.
    ...(trialActivated
      ? []
      : [
          `${styleText(['bold', 'cyan'], PRO_TRIAL_PITCH)}`,
          `  ${styleText('underline', proTrialUrl('installer'))}`,
          ``,
        ]),
    `${styleText('dim', 'How it works: /how-it-works   ·   Disable first-session hint: CLAUDE_MEM_WELCOME_HINT_ENABLED=false')}`,
    `${styleText('dim', 'Note: close all Claude Code sessions before uninstalling, or ~/.claude-mem will be recreated by active hooks.')}`,
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

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { loadTelemetryConfig, saveTelemetryConfig } from '../../services/telemetry/consent.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { spawnHidden } from '../../shared/spawn.js';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { loadClaudeMemEnv, saveClaudeMemEnv } from '../../shared/EnvManager.js';
import { ensureWorkerStarted, type WorkerStartResult } from '../../services/worker-spawner.js';
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';
import { playBanner } from '../banner.js';
import { normalizeRuntimeFlag, planServerRuntimeInstall } from './server-runtime-setup.js';
import { ErrorSeverity } from '../install/error-taxonomy.js';
import {
  createInstallSummary,
  flushSummary,
  installerError,
  InstallAbortError,
  type InstallSummary,
} from '../install/error-reporter.js';
import { extractEresolveBlock, isEresolve, runNpmStrict } from '../install/npm-install-helper.js';

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
function detectClaudeCodeVersion(): string | undefined {
  try {
    const result = spawnSync('claude', ['--version'], {
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === 'win32',
      encoding: 'utf-8',
    });
    const output = (result.stdout ?? '').trim();
    if (!output) return undefined;
    // "2.0.14 (Claude Code)" → "2.0.14"
    return output.split(/\s+/)[0].slice(0, 40) || undefined;
  } catch {
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
    message(`${label} ${pc.dim(`(${elapsed}s — still working)`)}`);
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
        title: 'Codex CLI: registering hooks marketplace',
        task: async (message) => {
          message('Loading Codex CLI installer…');
          const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
          message('Registering native Codex hooks…');
          const { result, output } = await bufferConsole(() => installCodexCli(marketplaceDirectory()));
          if (result !== 0) {
            recordFailure('Codex CLI: integration setup failed', output);
            return `Codex CLI: integration setup failed ${pc.red('FAIL')}`;
          }
          return `Codex CLI: hooks marketplace registered ${pc.green('OK')}`;
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
type ClaudeAccessMode = 'subscription' | 'api-key';
type ClaudeApiMode = 'direct' | 'gateway';
type RuntimeId = 'worker' | 'server-beta';

function readRawStoredAuthMethod(): 'subscription' | 'api-key' | 'gateway' | undefined {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return undefined;
    const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
    const value = flat.CLAUDE_MEM_CLAUDE_AUTH_METHOD;
    if (value === 'subscription' || value === 'api-key' || value === 'gateway') return value;
    return undefined;
  } catch {
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
    if (requested === 'server-beta') {
      await setupServerRuntimeNonInteractive(options);
      return 'server-beta';
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
      { value: 'server-beta', label: 'Server (beta)', hint: 'REST V1, API keys, team-ready storage' },
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

  if (selected === 'server-beta') {
    await maybeBootstrapServerBetaApiKey();
  }
  return selected;
}

// #2543 — execute the server-runtime install plan. Pure planning lives in
// server-runtime-setup.ts (unit-tested); this function performs the side
// effects the plan describes. Docker stack bring-up is config-only here (we log
// the command an operator must run / a CI provisioner executes); key generation
// reuses the same bootstrap path as the interactive flow (createServerApiKey +
// DEFAULT_LOCAL_API_KEY_SCOPES via server-beta-bootstrap), and the IDE MCP
// config target is recorded in settings so hooks resolve the server runtime.
async function setupServerRuntimeNonInteractive(options: InstallOptions): Promise<void> {
  const serverBaseUrl = (options.serverUrl ?? '').trim() || DEFAULT_SERVER_RUNTIME_BASE_URL;
  const hasDatabaseUrl = Boolean((process.env.CLAUDE_MEM_SERVER_DATABASE_URL ?? '').trim());
  const plan = planServerRuntimeInstall({ serverBaseUrl, hasDatabaseUrl });

  mergeSettings(plan.settings);

  if (plan.bringUpDockerStack) {
    log.info(
      'Server runtime selected. Bring up the bundled stack with '
        + '`docker compose up -d postgres valkey claude-mem-server claude-mem-worker` '
        + `(pg + redis/valkey). The server listens at ${serverBaseUrl}.`,
    );
  }

  log.info(
    `IDE MCP config target for the server runtime: ${plan.mcpServerConfig.type} ${plan.mcpServerConfig.url}`,
  );

  if (plan.generateApiKey) {
    await maybeBootstrapServerBetaApiKey();
  }
  for (const note of plan.notes) {
    log.warn(note);
  }
}

async function maybeBootstrapServerBetaApiKey(): Promise<void> {
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
    const { bootstrapServerBetaApiKey, persistServerBetaSettings } = await import(
      '../../services/hooks/server-beta-bootstrap.js'
    );
    const result = await bootstrapServerBetaApiKey();
    persistServerBetaSettings(USER_SETTINGS_PATH, {
      apiKey: result.rawKey,
      projectId: result.projectId,
    });
    log.info(
      `Provisioned local hook API key (project=${result.projectId.slice(0, 8)}…). `
        + 'Settings saved with mode 0600.',
    );
  } catch (error: unknown) {
    log.warn(
      `Failed to bootstrap server-beta API key: ${error instanceof Error ? error.message : String(error)}. `
        + 'Hooks will fall back to the worker until you run `npx claude-mem server keys rotate`.',
    );
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

  let selectedProvider: ProviderId;
  if (options.provider) {
    selectedProvider = options.provider;
  } else {
    const providerResult = await p.select<ProviderId>({
      message: 'Which memory provider do you want to use?',
      options: [
        { value: 'claude', label: 'Claude Agent SDK (recommended)' },
        { value: 'gemini', label: 'Gemini' },
        { value: 'openrouter', label: 'OpenRouter' },
      ],
      initialValue: initialProvider,
    });
    if (p.isCancel(providerResult)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }
    selectedProvider = providerResult;
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

async function promptClaudeModel(options: InstallOptions): Promise<void> {
  const allowed = new Set([
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
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

// --- CMEM Online email opt-in ----------------------------------------------
// Interactive, optional. The CLI POSTs the email + optional note to the live
// waitlist endpoint (cmem.ai/api/waitlist), which handles persistence, dedup,
// and the confirmation email server-side. CLAUDE_MEM_SIGNUP_URL overrides the
// default for testing/staging. No API keys ever ship in the npx package — the
// endpoint is unauthenticated and the secret (Resend) stays server-side.
// Anything that goes wrong here is swallowed — a marketing opt-in must never
// block or fail the install.

const DEFAULT_SIGNUP_ENDPOINT = 'https://cmem.ai/api/waitlist';
const SIGNUP_ENDPOINT = process.env.CLAUDE_MEM_SIGNUP_URL?.trim() || DEFAULT_SIGNUP_ENDPOINT;
const SIGNUP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StoredSignup {
  email: string;
  note: string;
  sent: boolean;
}

function readStoredSignup(): StoredSignup | null {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return null;
    const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
    const email = typeof flat.CLAUDE_MEM_ONLINE_SIGNUP_EMAIL === 'string' ? flat.CLAUDE_MEM_ONLINE_SIGNUP_EMAIL : '';
    if (!email) return null;
    return {
      email,
      note: typeof flat.CLAUDE_MEM_ONLINE_SIGNUP_NOTE === 'string' ? flat.CLAUDE_MEM_ONLINE_SIGNUP_NOTE : '',
      sent: flat.CLAUDE_MEM_ONLINE_SIGNUP_SENT === 'true',
    };
  } catch {
    return null;
  }
}

async function submitOnlineSignup(payload: { email: string; note: string; version: string }): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(SIGNUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: payload.email,
        note: payload.note,
        version: payload.version,
        platform: process.platform,
        source: 'npx-installer',
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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

  p.log.message(pc.dim(
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

async function promptCmemOnlineOptIn(version: string): Promise<void> {
  // Interactive-only, and easy to turn off for CI / scripted installs.
  if (!isInteractive) return;
  if (process.env.CI) return;
  if (String(process.env.CLAUDE_MEM_ONLINE_OPTIN ?? '').trim().toLowerCase() === 'false') return;

  const prior = readStoredSignup();
  if (prior) {
    // We already captured this email — don't re-nag. If a previous send never
    // reached the service, quietly retry once now and record the result.
    if (!prior.sent) {
      const ok = await submitOnlineSignup({ email: prior.email, note: prior.note, version });
      if (ok) mergeSettings({ CLAUDE_MEM_ONLINE_SIGNUP_SENT: 'true' });
    }
    return;
  }

  p.note(
    [
      pc.bold(pc.cyan('New! CMEM Online: every mem everywhere all at once.')),
      '',
      "Share your email and we'll send you a link. We're rolling this out to our",
      'top users first, then everyone ASAP.',
    ].join('\n'),
    'CMEM Online',
  );

  const emailResult = await p.text({
    message: 'Your work email (press Enter to skip):',
    placeholder: 'you@company.com',
    defaultValue: '',
    validate: (v?: string) => {
      const value = (v ?? '').trim();
      if (value.length === 0) return undefined; // empty = skip, not an error
      if (!SIGNUP_EMAIL_RE.test(value)) return "That doesn't look like an email — fix it, or clear the field to skip.";
      return undefined;
    },
  });

  if (p.isCancel(emailResult)) return;
  const email = String(emailResult).trim();
  if (email.length === 0) return;

  const noteResult = await p.text({
    message: 'Optionally: what are you working on, or how can we help you and your team? (Enter to skip)',
    placeholder: 'e.g. migrating a monorepo, onboarding a 5-dev team…',
    defaultValue: '',
  });
  const note = p.isCancel(noteResult) ? '' : String(noteResult).trim();

  const spin = p.spinner();
  spin.start('Signing you up for CMEM Online…');
  const ok = await submitOnlineSignup({ email, note, version });
  // Persist locally regardless of the network result so we never re-prompt;
  // a failed send is retried silently on the next install (see above).
  mergeSettings({
    CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: email,
    CLAUDE_MEM_ONLINE_SIGNUP_NOTE: note,
    CLAUDE_MEM_ONLINE_SIGNUP_AT: new Date().toISOString(),
    CLAUDE_MEM_ONLINE_SIGNUP_SENT: ok ? 'true' : 'false',
  });
  if (ok) {
    spin.stop(`You're on the list — we'll email ${pc.cyan(email)} your CMEM Online link.`);
  } else {
    spin.stop(pc.yellow(`Saved ${email} — we'll finish signing you up next time you run the installer.`));
  }
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
    if (error instanceof InstallAbortError) {
      // error.category.id is OUR taxonomy id (error-taxonomy.ts), never a message.
      await captureCliEvent('install_failed', {
        error_category: error.category.id,
        interactive: isInteractive,
        install_method: detectInstallMethod(),
        claude_code_version: detectClaudeCodeVersion(),
      }, { person: true });
      // Flush whatever warnings accrued before the abort, then print the
      // remediation headline and exit non-zero. ABORT must never reach the
      // "Installation Complete" path.
      flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.error(`  ${line}`)));
      const headline = `Installation Aborted: ${error.category.id}`;
      if (isInteractive) {
        p.log.error(headline);
        p.log.error(error.remediation);
        p.outro(pc.red('claude-mem installation aborted.'));
      } else {
        console.error(`\n  ${headline}`);
        console.error(`  ${error.remediation}`);
        console.error(`  ${error.message}`);
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

  await promptCmemOnlineOptIn(version);

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

  const selectedRuntime = await promptRuntime(options);
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
          // runNpmInstallInMarketplace throws InstallAbortError on a real
          // failure (non-ERESOLVE, or ERESOLVE that --legacy-peer-deps could
          // not fix). We deliberately do NOT swallow it here — the top-level
          // handler turns it into "Installation Aborted" + exit 1.
          const stopHeartbeat = startHeartbeat(message, 'Running npm install…');
          try {
            await runNpmInstallInMarketplace(summary);
          } finally {
            stopHeartbeat();
          }
          return `Dependencies installed ${pc.green('OK')}`;
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
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'auto-memory',
        phase: 'post-ide',
        cause: error,
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
  const autoStartSkipped = !isInteractive || options.noAutoStart || selectedRuntime === 'server-beta';

  await runTasks([
    {
      title: selectedRuntime === 'server-beta' ? 'Starting server beta daemon' : 'Starting worker daemon',
      task: async (message) => {
        if (selectedRuntime === 'server-beta') {
          return `Server runtime selected — start it with ${pc.bold('npx claude-mem server start')} ${pc.dim('(or via Docker compose)')}`;
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
        // selectedRuntime is narrowed to 'worker' here: the server-beta case
        // returned above and never reaches the worker-service spawner.
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

  // "Installation Complete" only when no ABORT fired (we'd have thrown) AND no
  // IDE failed. Any failed IDE => "Installation Partial". Reads summary.failedIDEs
  // (which captures failures that happen AFTER bufferConsole returns), not a
  // stale local count.
  const hasFailures = summary.failedIDEs.length > 0;
  const installStatus = hasFailures ? 'Installation Partial' : 'Installation Complete';
  const summaryLines = [
    `Version:     ${pc.cyan(version)}`,
    `Plugin dir:  ${pc.cyan(marketplaceDir)}`,
    `IDEs:        ${pc.cyan(selectedIDEs.join(', '))}`,
  ];
  if (autoMemoryStatus === 'disabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'already-disabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('already disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'left-enabled') {
    summaryLines.push(`Auto-memory: ${pc.cyan('left enabled')} (native Claude Code memory preserved)`);
  } else if (autoMemoryStatus === 'failed') {
    summaryLines.push(`Auto-memory: ${pc.red('write failed')} (see warning above)`);
  }
  if (failedIDEs.length > 0) {
    summaryLines.push(`Failed:      ${pc.red(failedIDEs.join(', '))}`);
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
  const runtimeLabel = selectedRuntime === 'server-beta' ? 'Server beta' : 'Worker';
  const runtimeStartCommand = selectedRuntime === 'server-beta' ? 'npx claude-mem server start' : 'npx claude-mem start';
  const workerHeadline = autoStartSkipped
    ? `${pc.yellow('!')} ${runtimeLabel} autostart skipped — start it manually with ${pc.bold(runtimeStartCommand)}`
    : workerReady || finalWorkerState === 'ready'
      ? `${pc.green('✓')} ${runtimeLabel} running at ${pc.underline(`http://localhost:${actualPort}`)}`
      : `${pc.yellow('⏳')} ${runtimeLabel} starting at ${pc.underline(`http://localhost:${actualPort}`)} — give it ~30s, then refresh`;
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
    // Deliberately the last interaction of the flow: consent is asked after
    // the product is installed and working, never as a gate in front of it.
    await promptTelemetryOptIn();
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

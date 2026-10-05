/**
 * T3 Code delegates turns to native providers. Register their real plugins,
 * so hooks, project-scoped context and MCP search use the same capture path
 * as the CLI. No T3 database writes or duplicate transcript ingestion.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseShell } from 'shell-quote';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { buildSpawnSyncInvocation, lookupWindowsCommand } from '../../shared/spawn.js';
import { disableCodexPluginForHome, installCodexPluginForHome } from './CodexCliInstaller.js';

const CLAUDE_PLUGIN = 'claude-mem@thedotmack';
const CODEX_PLUGIN = 'claude-mem@claude-mem-local';
type Driver = 'codex' | 'claudeAgent';
type Document = Record<string, unknown>;

export interface T3CodeProvider {
  id: string;
  driver: Driver;
  command: string;
  homePath: string;
  environment: NodeJS.ProcessEnv;
  launchArgs: string;
}

export interface T3CodeOptions {
  settingsPath?: string;
  environment?: NodeJS.ProcessEnv;
  /** Allows fixture CLIs in tests; production uses the native executable. */
  spawn?: (provider: T3CodeProvider, args: string[]) => SpawnSyncReturns<string>;
}

function isRecord(value: unknown): value is Document {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDocument(file: string): Document {
  const value = readJsonFileWithBom<unknown>(file);
  if (!isRecord(value)) throw new Error(`Expected a JSON object in ${file}`);
  return value;
}

function expandPath(value: string): string {
  if (value === '~') return homedir();
  if (/^~[/\\]/.test(value)) return join(homedir(), value.slice(2));
  return value;
}

export function t3CodeSettingsPath(options: T3CodeOptions = {}): string {
  const env = options.environment ?? process.env;
  const override = options.settingsPath ?? env.CLAUDE_MEM_T3CODE_SETTINGS_PATH;
  if (override) return resolve(expandPath(override));
  const base = expandPath(env.T3CODE_HOME?.trim() || join(homedir(), '.t3'));
  return resolve(base, 'userdata', 'settings.json');
}

function stringSetting(config: Document, key: string): string {
  if (config[key] === undefined) return '';
  if (typeof config[key] !== 'string') throw new Error(`T3 Code ${key} must be a string`);
  return config[key] as string;
}

function managedCodexCommand(settingsPath: string): string {
  // T3's CodexInstallation acquires tools/codex/<active version>/bin/codex.
  const root = join(dirname(dirname(settingsPath)), 'tools', 'codex');
  const active = readDocument(join(root, 'active.json'));
  if (typeof active.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(active.version)) {
    throw new Error('T3 Code managed Codex has an invalid active version; finish its setup in T3 Code.');
  }
  const command = join(root, active.version, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (!existsSync(command)) throw new Error('T3 Code managed Codex is not installed; finish its setup in T3 Code.');
  return command;
}

/** Explicit instances win over legacy providers, including disabled entries. */
export function discoverT3CodeProviders(settingsPath: string, baseEnv: NodeJS.ProcessEnv = process.env, forRemoval = false): T3CodeProvider[] {
  const settings = readDocument(settingsPath);
  const instances = settings.providerInstances ?? {};
  const legacy = settings.providers ?? {};
  if (!isRecord(instances) || !isRecord(legacy)) throw new Error('Invalid T3 Code provider settings.');
  const entries: Array<[string, Document]> = Object.entries(instances).map(([id, value]) => {
    if (!isRecord(value)) throw new Error(`Invalid T3 Code provider instance: ${id}`);
    return [id, value];
  });
  for (const driver of ['codex', 'claudeAgent'] as const) {
    if (Object.hasOwn(instances, driver) || !Object.hasOwn(legacy, driver)) continue;
    if (!isRecord(legacy[driver])) throw new Error(`Invalid T3 Code ${driver} settings.`);
    entries.push([driver, { driver, config: legacy[driver] }]);
  }
  // A newly initialized settings document may not yet persist provider defaults.
  if (entries.length === 0 && Object.keys(legacy).length === 0) entries.push(['codex', { driver: 'codex' }]);

  const providers: T3CodeProvider[] = [];
  for (const [id, instance] of entries) {
    if (instance.driver !== 'codex' && instance.driver !== 'claudeAgent') continue;
    const config = instance.config ?? {};
    if (!isRecord(config)) throw new Error(`Invalid config for T3 Code provider ${id}`);
    if (!forRemoval && (instance.enabled === false || config.enabled === false)) continue;
    const driver = instance.driver;
    const environment = { ...baseEnv };
    if (instance.environment !== undefined && !Array.isArray(instance.environment)) {
      throw new Error(`Invalid environment for T3 Code provider ${id}`);
    }
    for (const variable of (instance.environment ?? []) as unknown[]) {
      if (!isRecord(variable) || typeof variable.name !== 'string' || typeof variable.value !== 'string') {
        throw new Error(`Invalid environment variable for T3 Code provider ${id}`);
      }
      // Plugin installation needs no model credentials. T3 resolves redacted
      // credentials from its own store when it actually launches the provider.
      if (variable.sensitive !== true && variable.valueRedacted !== true) environment[variable.name] = variable.value;
    }
    const managed = driver === 'codex' && config.setupMode === 'managed';
    const homeVariable = driver === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const homeValue = stringSetting(config, 'homePath').trim()
      || (!managed ? environment[homeVariable]?.trim() : '')
      || join(homedir(), driver === 'codex' ? '.codex' : '.claude');
    // Codex shadow homes share config.toml and plugins with this source home.
    // Install into the source, never create a shadow config that blocks T3's links.
    const homePath = resolve(expandPath(homeValue));
    environment[homeVariable] = homePath;
    let command = managed && !forRemoval ? managedCodexCommand(settingsPath) : expandPath(stringSetting(config, 'binaryPath').trim() || (driver === 'codex' ? 'codex' : 'claude'));
    if (process.platform === 'win32' && !/[\/\\]/.test(command)) command = lookupWindowsCommand(command) ?? (/\.(?:cmd|bat|exe|com)$/i.test(command) ? command : `${command}.cmd`);
    providers.push({ id, driver, command, homePath, environment, launchArgs: stringSetting(config, 'launchArgs') });
  }
  return providers;
}

export function assertT3CodePluginLoading(provider: T3CodeProvider): void {
  const tokens = parseShell(provider.launchArgs);
  if (tokens.some(token => typeof token !== 'string')) throw new Error(`Unsupported launch arguments for T3 Code provider ${provider.id}`);
  const args = tokens as string[];
  if (provider.driver === 'claudeAgent') {
    let sources: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--setting-sources') sources = args[i + 1] ?? '';
      else if (args[i].startsWith('--setting-sources=')) sources = args[i].slice('--setting-sources='.length);
    }
    if (sources !== undefined && !sources.split(',').includes('user')) {
      throw new Error(`T3 Code provider ${provider.id} excludes user settings. Include user in --setting-sources in T3 Code Settings, then reinstall.`);
    }
    if (args.some(arg => /^--(?:strict-mcp-config|disable-all-hooks)(?:=true)?$/.test(arg))) {
      throw new Error(`T3 Code provider ${provider.id} disables plugin MCP or hooks in launchArgs. Remove that override in T3 Code Settings, then reinstall.`);
    }
  } else if (args.some((arg, index) => (arg === '--disable' && args[index + 1] === 'hooks') || arg === '--disable=hooks'
    || /^(?:features\.hooks|plugins\."?claude-mem@(?:claude-mem-local|thedotmack)"?\.enabled)\s*=\s*false$/.test(arg.replace(/^(?:--config|-c)=/, '')))) {
    throw new Error(`T3 Code provider ${provider.id} disables Claude-Mem in launchArgs. Remove that override in T3 Code Settings, then reinstall.`);
  }
}

function spawnProvider(provider: T3CodeProvider, args: string[]): SpawnSyncReturns<string> {
  const invocation = buildSpawnSyncInvocation(provider.command, args, {
    env: provider.environment, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  return spawnSync(invocation.command, invocation.args, invocation.options);
}

function runProvider(provider: T3CodeProvider, args: string[], spawn: NonNullable<T3CodeOptions['spawn']>): void {
  const result = spawn(provider, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${provider.command} ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 2000)}`);
  }
}

function pluginEnabled(provider: T3CodeProvider, requireHooks = true): boolean {
  const file = join(provider.homePath, provider.driver === 'codex' ? 'config.toml' : 'settings.json');
  if (!existsSync(file)) return false;
  if (provider.driver === 'claudeAgent') {
    const settings = readDocument(file);
    return isRecord(settings.enabledPlugins) && settings.enabledPlugins[CLAUDE_PLUGIN] === true;
  }
  const content = readFileSync(file, 'utf-8');
  const enabledInTable = (header: string, key: string): boolean => {
    let inTable = false;
    let enabled = false;
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) inTable = line.replace(/\s+#.*$/, '').trim() === header;
      else if (inTable) {
        const value = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`));
        if (value) enabled = value[1] === 'true';
      }
    }
    return enabled;
  };
  return enabledInTable(`[plugins."${CODEX_PLUGIN}"]`, 'enabled')
    && (!requireHooks || enabledInTable('[features]', 'hooks'));
}

export async function installT3Code(marketplaceRoot: string, options: T3CodeOptions = {}): Promise<number> {
  try {
    const root = resolve(marketplaceRoot);
    for (const file of ['.claude-plugin/marketplace.json', 'plugin/.claude-plugin/plugin.json', 'plugin/scripts/worker-service.cjs', 'plugin/scripts/mcp-server.cjs']) {
      if (!existsSync(join(root, file))) throw new Error(`Claude-Mem plugin bundle is missing ${file}; rerun the main installer.`);
    }
    const providers = discoverT3CodeProviders(t3CodeSettingsPath(options), options.environment);
    if (providers.length === 0) throw new Error('No enabled Codex or Claude Code provider found in T3 Code settings.');
    // Refuse incompatible launch flags before changing any provider home.
    providers.forEach(assertT3CodePluginLoading);
    const spawn = options.spawn ?? spawnProvider;
    const installed = new Set<string>();
    let failed = false;
    for (const provider of providers) {
      const key = `${provider.driver}:${provider.homePath}`;
      if (installed.has(key)) continue;
      try {
        if (provider.driver === 'codex') {
          installCodexPluginForHome({ marketplaceRoot: root, homePath: provider.homePath, spawn: args => spawn(provider, args) });
        } else {
          const knownPath = join(provider.homePath, 'plugins', 'known_marketplaces.json');
          const known = existsSync(knownPath) ? readDocument(knownPath) : {};
          const marketplace = known.thedotmack;
          // The main installer already registers the default Claude home.
          if (!isRecord(marketplace)) {
            runProvider(provider, ['plugin', 'marketplace', 'add', root], spawn);
          } else if (marketplace.installLocation !== root
            && (!isRecord(marketplace.source) || (marketplace.source.repo !== 'thedotmack/claude-mem' && marketplace.source.path !== root))) {
            throw new Error('The thedotmack marketplace points to another source. Repair its registration with the main Claude-Mem installer.');
          }
          runProvider(provider, ['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'user'], spawn);
          // Claude returns a failure for `plugin enable` when already enabled.
          if (!pluginEnabled(provider)) runProvider(provider, ['plugin', 'enable', CLAUDE_PLUGIN, '--scope', 'user'], spawn);
        }
        installed.add(key);
        console.log(`T3 Code ${provider.id}: hooks + MCP registered in ${provider.homePath}`);
      } catch (error) {
        failed = true;
        console.error(`T3 Code ${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log('Restart T3 Code and start a new thread. Trust Claude-Mem hooks if your provider prompts for approval.');
    return failed ? 1 : 0;
  } catch (error) {
    console.error(`T3 Code setup failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Open T3 Code once to create its settings. For a custom server, set CLAUDE_MEM_T3CODE_SETTINGS_PATH to its settings.json.');
    return 1;
  }
}

/** Disable only Claude-Mem; native homes may also be shared with the CLI. */
export function uninstallT3Code(options: T3CodeOptions = {}): number {
  const file = t3CodeSettingsPath(options);
  if (!existsSync(file)) return 0;
  try {
    for (const provider of discoverT3CodeProviders(file, options.environment, true)) {
      if (!pluginEnabled(provider, false)) continue;
      if (provider.driver === 'codex') disableCodexPluginForHome(provider.homePath);
      else {
        const settingsPath = join(provider.homePath, 'settings.json');
        const settings = readDocument(settingsPath);
        (settings.enabledPlugins as Document)[CLAUDE_PLUGIN] = false;
        writeJsonFileAtomic(settingsPath, settings);
      }
    }
    console.log('Claude-Mem disabled in T3 Code provider homes. Restart T3 Code.');
    return 0;
  } catch (error) {
    console.error(`T3 Code removal failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function t3CodeStatus(options: T3CodeOptions = {}): number {
  try {
    const providers = discoverT3CodeProviders(t3CodeSettingsPath(options), options.environment);
    let complete = providers.length > 0;
    for (const provider of providers) {
      assertT3CodePluginLoading(provider);
      const enabled = pluginEnabled(provider);
      complete &&= enabled;
      console.log(`T3 Code ${provider.id}: ${enabled ? 'plugin enabled' : 'not installed'} (${provider.homePath})`);
    }
    console.log('Hook approval is managed by the native provider; start a new thread to verify capture.');
    return complete ? 0 : 1;
  } catch (error) {
    console.error(`T3 Code status failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

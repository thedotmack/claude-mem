import path from 'path';
import { homedir } from 'os';
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from 'child_process';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
} from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { CONTEXT_BLOCK_CLOSE, CONTEXT_BLOCK_OPEN, LIBRARY_GROUPS } from '../wire-gateway/library/agent-library-targets.js';
import { applyLibraryForInstaller, hasLibraryRecord, removeLibraryForInstaller } from '../wire-gateway/library/library-runtime.js';
import { stripLegacyContextBlock } from '../wire-gateway/library/text-block.js';
import type { ConfigMemberItem, LibraryMigration } from '../wire-gateway/library/types.js';
import { paths } from '../../shared/paths.js';
import { buildSpawnSyncInvocation, type SpawnSyncInvocation } from '../../shared/spawn.js';

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');
const CODEX_TRANSCRIPT_WATCH_CONFIG_PATH = paths.transcriptsConfig();
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');
const MARKETPLACE_NAME = 'claude-mem-local';
const CODEX_PLUGIN_ID = `claude-mem@${MARKETPLACE_NAME}`;
const LEGACY_CODEX_PLUGIN_IDS = ['claude-mem@thedotmack'];
const MIN_CODEX_MARKETPLACE_VERSION = '0.128.0';
const REQUIRED_MARKETPLACE_FILES = [
  path.join('.agents', 'plugins', 'marketplace.json'),
  path.join('plugin', '.codex-plugin', 'plugin.json'),
  path.join('plugin', '.mcp.json'),
  path.join('plugin', 'hooks', 'codex-hooks.json'),
  path.join('plugin', 'skills', 'mem-search', 'SKILL.md'),
];
const WINDOWS_CODEX_EXTENSIONS = new Set(['.cmd', '.exe', '.bat', '.com']);
const MACOS_CODEX_BUNDLE_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];

export function isExecutableFile(
  candidate: string,
  access: (path: string, mode: number) => void = accessSync,
): boolean {
  try {
    access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isUsableCodexBundle(
  candidate: string,
  probe: typeof spawnSync = spawnSync,
): boolean {
  const result = probe(candidate, ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  return !result.error && result.status === 0;
}

function commandExists(command: string): boolean {
  if (path.isAbsolute(command)) return isExecutableFile(command);

  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [command], { stdio: 'ignore', windowsHide: true });
    } else {
      execFileSync('which', [command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    // [ANTI-PATTERN IGNORED]: where/which exits non-zero whenever the probed command is absent from PATH; that is the expected negative probe result and commandExists reports it as false.
    return false;
  }
}

function findAncestorWithCodexMarketplace(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, '.agents', 'plugins', 'marketplace.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function missingMarketplaceFiles(root: string): string[] {
  return REQUIRED_MARKETPLACE_FILES.filter((entry) => !existsSync(path.join(root, entry)));
}

function assertCodexMarketplaceRoot(root: string): string {
  const resolved = path.resolve(root);
  const missing = missingMarketplaceFiles(resolved);
  if (missing.length > 0) {
    throw new Error(`Codex marketplace root ${resolved} is missing required files: ${missing.join(', ')}`);
  }
  return resolved;
}

function resolvePluginMarketplaceRoot(preferredRoot?: string): string {
  if (preferredRoot) {
    return assertCodexMarketplaceRoot(preferredRoot);
  }

  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = findAncestorWithCodexMarketplace(candidate);
    if (resolved && missingMarketplaceFiles(resolved).length === 0) return resolved;
  }

  throw new Error('Could not locate a Codex marketplace root with .agents/plugins/marketplace.json and plugin/.codex-plugin/plugin.json. Run npx claude-mem@latest install from the package or repo root.');
}

function lookupCodexOnWindows(): string | null {
  let stdout: string;
  try {
    stdout = execFileSync('where.exe', ['codex'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('WORKER', 'Failed to locate codex via where; falling back to codex.cmd', { command: 'where codex' }, err);
    return null;
  }

  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return candidates.find((candidate) => WINDOWS_CODEX_EXTENSIONS.has(path.extname(candidate).toLowerCase()))
    ?? candidates[0]
    ?? null;
}

export function lookupCodexOnMacOS(
  commandInPath: (command: string) => boolean = commandExists,
  candidateAvailable: (candidate: string) => boolean = isUsableCodexBundle,
): string | null {
  if (commandInPath('codex')) return 'codex';
  return MACOS_CODEX_BUNDLE_PATHS.find((candidate) => candidateAvailable(candidate)) ?? null;
}

export function resolveCodexCommand(
  platform: NodeJS.Platform = process.platform,
  windowsLookup: () => string | null = lookupCodexOnWindows,
  macOSLookup: () => string | null = lookupCodexOnMacOS,
): string {
  if (platform === 'win32') return windowsLookup() ?? 'codex.cmd';
  if (platform === 'darwin') return macOSLookup() ?? 'codex';
  return 'codex';
}

export function resolveCodexSpawnInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  windowsLookup: () => string | null = lookupCodexOnWindows,
  macOSLookup: () => string | null = lookupCodexOnMacOS,
): SpawnSyncInvocation {
  const resolvedCommand = resolveCodexCommand(platform, windowsLookup, macOSLookup);
  return buildSpawnSyncInvocation(resolvedCommand, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }, platform);
}

/**
 * Spawn the `codex` CLI.
 *
 * Issue #2695: on Windows `codex` is installed as `codex.cmd` (a PATH shim).
 * `child_process.spawnSync('codex', args)` without a shell does not consult
 * PATHEXT, so resolve the shim first. Native executables run directly; .cmd
 * and .bat shims use an explicit cmd.exe wrapper without the shell option.
 */
export function codexSpawn(args: string[]): SpawnSyncReturns<string> {
  const invocation = resolveCodexSpawnInvocation(args);
  return spawnSync(invocation.command, invocation.args, invocation.options);
}

type CodexSpawn = (args: string[]) => SpawnSyncReturns<string>;

function runCodex(args: string[], spawn: CodexSpawn = codexSpawn): void {
  const result = spawn(args);
  const output = console;
  const stdout = result.stdout?.trimEnd();
  const stderr = result.stderr?.trimEnd();

  if (stdout) output.log(stdout);
  if (stderr) output.error(stderr);

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const exitCode = result.status ?? 'unknown';
    throw new Error(`codex ${args.join(' ')} failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`);
  }
}

function isMarketplaceDifferentSourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`marketplace '${MARKETPLACE_NAME}' is already added from a different source`)
    || message.includes(`marketplace \`${MARKETPLACE_NAME}\` is already added from a different source`);
}

function registerCodexMarketplace(marketplaceRoot: string, run = runCodex): void {
  try {
    run(['plugin', 'marketplace', 'add', marketplaceRoot]);
    return;
  } catch (error) {
    if (!isMarketplaceDifferentSourceError(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  console.warn(`  Codex marketplace ${MARKETPLACE_NAME} is already registered from another source; replacing it with ${marketplaceRoot}.`);
  run(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  run(['plugin', 'marketplace', 'add', marketplaceRoot]);
}

/** A header's trailing comment is not part of its name; quoted hashes are. */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote !== null) {
      if (quote === '"' && character === '\\') index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Preserve line indices while excluding multiline string contents from table/key recognition. */
function tomlStructuralLines(lines: string[]): string[] {
  let multiline: '"""' | "'''" | null = null;
  return lines.map((line) => {
    const structural = multiline === null ? stripTomlComment(line) : '';
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < line.length; index++) {
      if (multiline !== null) {
        if (multiline === '"""' && line[index] === '\\') {
          index++;
        } else if (line.startsWith(multiline, index)) {
          // TOML permits one or two quote characters immediately before the closing delimiter.
          const character = multiline[0];
          let count = 3;
          while (count < 5 && line[index + count] === character) count++;
          index += count - 1;
          multiline = null;
        }
      } else if (quote !== null) {
        if (quote === '"' && line[index] === '\\') index++;
        else if (line[index] === quote) quote = null;
      } else if (line[index] === '#') {
        break;
      } else if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        multiline = line.slice(index, index + 3) as '"""' | "'''";
        index += 2;
      } else if (line[index] === '"' || line[index] === "'") {
        quote = line[index] as '"' | "'";
      }
    }
    return structural;
  });
}

function normalizeTomlHeader(line: string): string | null {
  const match = stripTomlComment(line).trim().match(/^\[([^\]]+)\]\s*$/);
  if (!match) return null;
  return match[1].replace(/\s+/g, '').replace(/"/g, '');
}

/**
 * Read a `[marketplaces.<name>]` entry out of Codex's config.toml.
 *
 * Returns null when the marketplace is not registered. `source` is null when
 * the entry exists but declares no source. Headers and values may carry
 * trailing comments, as in the rest of this file's TOML handling.
 */
export function readRegisteredMarketplace(
  content: string,
  marketplaceName: string,
): { source: string | null; sourceType: string | null } | null {
  const structuralLines = tomlStructuralLines(content.split('\n'));
  const headerIndex = structuralLines.findIndex(
    (line) => normalizeTomlHeader(line) === `marketplaces.${marketplaceName}`,
  );
  if (headerIndex === -1) return null;

  let source: string | null = null;
  let sourceType: string | null = null;
  for (let index = headerIndex + 1; index < structuralLines.length; index += 1) {
    const line = structuralLines[index];
    if (/^\s*\[/.test(line)) break;
    const sourceMatch = line.match(/^\s*source\s*=\s*"(.*)"\s*$/);
    if (sourceMatch) source = sourceMatch[1];
    const typeMatch = line.match(/^\s*source_type\s*=\s*"(.*)"\s*$/);
    if (typeMatch) sourceType = typeMatch[1];
  }
  return { source, sourceType };
}

/**
 * A registered local marketplace whose directory has been deleted or gutted.
 *
 * Only `local` sources are checked: git/npm sources are fetched into a cache,
 * so their `source` is a URL that will never exist on disk and must not be
 * mistaken for a broken path.
 */
export function isStaleLocalMarketplace(
  entry: { source: string | null; sourceType: string | null } | null,
  isUsableRoot: (root: string) => boolean,
): boolean {
  if (!entry?.source) return false;
  if (entry.sourceType !== null && entry.sourceType !== 'local') return false;
  return !isUsableRoot(entry.source);
}

function isUsableMarketplaceRoot(root: string): boolean {
  return existsSync(root) && missingMarketplaceFiles(root).length === 0;
}

/**
 * Codex refuses to load ANY marketplace while one registered source is
 * unreadable: `codex plugin list` hard-errors and every plugin silently stops
 * loading, claude-mem included. Drop a stale registration before re-adding so
 * a moved or deleted checkout self-heals instead of wedging the whole CLI.
 */
function repairStaleMarketplaceRegistration(): void {
  if (!existsSync(CODEX_CONFIG_PATH)) return;

  let entry: ReturnType<typeof readRegisteredMarketplace>;
  try {
    entry = readRegisteredMarketplace(readFileSync(CODEX_CONFIG_PATH, 'utf-8'), MARKETPLACE_NAME);
  } catch (error) {
    logger.warn('WORKER', 'Could not read Codex config while checking for a stale marketplace', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!isStaleLocalMarketplace(entry, isUsableMarketplaceRoot)) return;

  console.warn(`  Codex marketplace ${MARKETPLACE_NAME} points at ${entry?.source}, which is missing or incomplete.`);
  console.warn('  Removing the stale registration so Codex can load plugins again.');
  runCodex(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
}

/**
 * The pre-plugin `[mcp_servers.mcp-search]` server a claude-mem install wrote
 * (the block names claude-mem): removed with its tool child tables, so Codex
 * falls back to the plugin-managed MCP declaration.
 */
function legacyMcpSearchRemoval(configPath: string): LibraryMigration {
  return {
    file: configPath,
    format: 'toml',
    compute: (document) => {
      const server = (document as { mcp_servers?: Record<string, unknown> }).mcp_servers?.['mcp-search'];
      return server !== undefined && JSON.stringify(server).includes('claude-mem') ? [{ op: 'delete', keyPath: ['mcp_servers', 'mcp-search'] }] : [];
    },
  };
}

function codexPluginGroup(configPath: string): string {
  return `${LIBRARY_GROUPS.settings}:${configPath}`;
}

function codexHooksFeatureGroup(configPath: string): string {
  return `${LIBRARY_GROUPS.settings}:${configPath}:features`;
}

/** The settings that make Codex load claude-mem's plugin: hooks on, the old plugin id off, the plugin on (or off). */
function codexPluginSettings(configPath: string, enabled: boolean): ConfigMemberItem[] {
  const setting = (id: string, keyPath: string[], value: boolean, group = codexPluginGroup(configPath)): ConfigMemberItem => ({
    kind: 'setting', id: `setting:${configPath}:${id}`, group,
    place: 'member', file: configPath, format: 'toml', keyPath, value, whenUnrecorded: 'replace-and-stash',
  });
  // A claude-mem plugin id (current or legacy) found turned on before the
  // first write was turned on by claude-mem (an install from before the
  // record), so it is not stashed as the user's: a remove turns it off, as
  // uninstall always did, instead of turning claude-mem back on.
  const claudeMemPlugin = (pluginId: string, value: boolean): ConfigMemberItem => ({
    ...setting(`plugins.${pluginId}`, ['plugins', pluginId, 'enabled'], value),
    isPreLibraryValue: (current) => current === true,
    valueAfterRemoveOfPreLibraryValue: false,
  });
  return [
    // Its own group: turning the plugin off leaves Codex's hooks feature as it is.
    ...(enabled ? [setting('features.hooks', ['features', 'hooks'], true, codexHooksFeatureGroup(configPath))] : []),
    ...LEGACY_CODEX_PLUGIN_IDS.map((legacyPluginId) => claudeMemPlugin(legacyPluginId, false)),
    claudeMemPlugin(CODEX_PLUGIN_ID, enabled),
  ];
}

/**
 * Turn claude-mem's Codex plugin on or off in a config.toml through the
 * Library (the Phase 7 TOML editor: comments, order and every other key stay).
 * Returns whether the file changed. `agentId` is whose record it is: Codex
 * CLI's own, or T3 Code's for a provider home.
 */
export function writeCodexPluginConfig(enabled: boolean, configPath = CODEX_CONFIG_PATH, agentId = 'codex-cli'): boolean {
  if (!enabled && !existsSync(configPath)) return false;
  const result = applyLibraryForInstaller({
    agentId,
    items: codexPluginSettings(configPath, enabled),
    ownedGroups: enabled ? [codexPluginGroup(configPath), codexHooksFeatureGroup(configPath)] : [codexPluginGroup(configPath)],
    migrations: enabled ? [legacyMcpSearchRemoval(configPath)] : [],
  });
  return result.filesWritten.length > 0;
}

/**
 * Take claude-mem's settings out of a config.toml: values claude-mem set go,
 * values that were there before come back. An install from before the
 * Library left no record; for it the plugin is turned off, as uninstall
 * always did.
 */
function removeCodexPluginConfig(configPath = CODEX_CONFIG_PATH): boolean {
  if (!existsSync(configPath)) return false;
  const hadRecord = hasLibraryRecord('codex-cli');
  const result = removeLibraryForInstaller({
    agentId: 'codex-cli',
    items: [],
    groups: [codexPluginGroup(configPath), codexHooksFeatureGroup(configPath)],
    migrations: hadRecord ? [] : [{
      file: configPath,
      format: 'toml',
      compute: (document) => {
        const plugins = (document as { plugins?: Record<string, { enabled?: unknown }> }).plugins ?? {};
        return [CODEX_PLUGIN_ID, ...LEGACY_CODEX_PLUGIN_IDS]
          .filter((pluginId) => plugins[pluginId]?.enabled === true)
          .map((pluginId) => ({ op: 'set' as const, keyPath: ['plugins', pluginId, 'enabled'], value: false }));
      },
    }],
  });
  return result.filesWritten.length > 0;
}

function enableCodexPluginConfig(): void {
  const changed = writeCodexPluginConfig(true);
  console.log(`  Enabled Codex plugin: ${CODEX_PLUGIN_ID}${changed ? '' : ' (already enabled)'}`);
}

function disableCodexPluginConfig(): void {
  const changed = removeCodexPluginConfig();
  console.log(`  Removed claude-mem's Codex plugin settings: ${CODEX_PLUGIN_ID}${changed ? '' : ' (none left)'}`);
}

function extractSemver(value: string): string | null {
  return value.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function assertCodexMarketplaceSupported(spawn: CodexSpawn = codexSpawn): void {
  const result = spawn(['--version']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.warn(`  Could not determine Codex CLI version. Continuing; plugin marketplace support requires ${MIN_CODEX_MARKETPLACE_VERSION} or newer.${output ? `\n${output}` : ''}`);
    return;
  }

  const version = extractSemver(output);
  if (!version) {
    console.warn(`  Could not parse Codex CLI version from "${output || '<empty>'}". Continuing; plugin marketplace support requires ${MIN_CODEX_MARKETPLACE_VERSION} or newer.`);
    return;
  }

  if (version.localeCompare(MIN_CODEX_MARKETPLACE_VERSION, undefined, { numeric: true }) < 0) {
    throw new Error(`Codex CLI ${version} is too old for plugin marketplace support. Update Codex CLI to ${MIN_CODEX_MARKETPLACE_VERSION} or newer, then run: npx claude-mem@latest install`);
  }
}

function removeCodexAgentsMdContext(): boolean {
  if (!existsSync(CODEX_AGENTS_MD_PATH)) return true;

  try {
    readAndStripContextTags();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to clean AGENTS.md context', { error: message });
    return false;
  }
}

export function readAndStripContextTags(agentsMdPath = CODEX_AGENTS_MD_PATH): void {
  const result = applyLibraryForInstaller({
    agentId: 'codex-cli',
    items: [],
    ownedGroups: [],
    migrations: [{
      file: agentsMdPath,
      format: 'text',
      computeText: (text) => {
        const remaining = stripLegacyContextBlock(text, CONTEXT_BLOCK_OPEN, CONTEXT_BLOCK_CLOSE, '\n\n');
        return remaining === null ? null : { text: remaining ? `${remaining}\n` : '' };
      },
    }],
  });
  if (result.filesWritten.includes(agentsMdPath)) console.log(`  Removed legacy global context from ${agentsMdPath}`);
}

const cleanupLegacyCodexAgentsMdContext = removeCodexAgentsMdContext;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCodexTranscriptWatch(watch: Record<string, unknown>): boolean {
  return watch.name === 'codex' || watch.schema === 'codex';
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function isLegacyCodexAgentsContext(context: Record<string, unknown>): boolean {
  if (context.mode !== 'agents') return false;

  const updateOn = context.updateOn;
  const hasLegacyUpdateOn = Array.isArray(updateOn)
    && updateOn.length === 2
    && updateOn.includes('session_start')
    && updateOn.includes('session_end');
  if (!hasLegacyUpdateOn) return false;

  if (context.path === undefined) return true;
  return typeof context.path === 'string'
    && path.resolve(expandHome(context.path)) === CODEX_AGENTS_MD_PATH;
}

function disableCodexTranscriptAgentsContext(): boolean {
  if (!existsSync(CODEX_TRANSCRIPT_WATCH_CONFIG_PATH)) return true;

  try {
    stripLegacyTranscriptWatchContexts();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to disable Codex transcript AGENTS.md context', { error: message });
    return false;
  }
}

export function stripLegacyTranscriptWatchContexts(configPath = CODEX_TRANSCRIPT_WATCH_CONFIG_PATH): void {
  const result = applyLibraryForInstaller({
    agentId: 'codex-cli',
    items: [],
    ownedGroups: [],
    migrations: [{
      file: configPath,
      format: 'json',
      compute: (document) => {
        const watches = (document as { watches?: unknown }).watches;
        if (!Array.isArray(watches)) return [];
        return watches.flatMap((watch, index) => (
          isRecord(watch) && isCodexTranscriptWatch(watch) && isRecord(watch.context) && isLegacyCodexAgentsContext(watch.context)
            ? [{ op: 'delete' as const, keyPath: ['watches', String(index), 'context'] }]
            : []
        ));
      },
    }],
  });
  if (result.filesWritten.includes(configPath)) console.log(`  Disabled legacy Codex transcript AGENTS.md context in ${configPath}`);
}

const cleanupLegacyCodexTranscriptAgentsContext = disableCodexTranscriptAgentsContext;

export async function installCodexCli(marketplaceRootOverride?: string): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (native hooks)...\n');

  if (!commandExists(resolveCodexCommand())) {
    console.error('Codex CLI was not found on PATH.');
    console.error('Install Codex, then run: npx claude-mem@latest install');
    return 1;
  }

  try {
    return performCodexInstall(marketplaceRootOverride);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

/** Install into the shared home used by a T3 Code provider, without changing process.env. */
export function installCodexPluginForHome(options: {
  marketplaceRoot: string;
  homePath: string;
  spawn: CodexSpawn;
  /** Whose Library record the settings go in (default: T3 Code, the only caller). */
  agentId?: string;
}): void {
  const root = assertCodexMarketplaceRoot(options.marketplaceRoot);
  assertCodexMarketplaceSupported(options.spawn);
  const run = (args: string[]) => runCodex(args, options.spawn);
  registerCodexMarketplace(root, run);
  run(['plugin', 'add', CODEX_PLUGIN_ID]);
  writeCodexPluginConfig(true, path.join(options.homePath, 'config.toml'), options.agentId ?? 't3code');
}

export function disableCodexPluginForHome(homePath: string, agentId = 't3code'): void {
  writeCodexPluginConfig(false, path.join(homePath, 'config.toml'), agentId);
}

function performCodexInstall(marketplaceRootOverride?: string): number {
  assertCodexMarketplaceSupported();
  const marketplaceRoot = resolvePluginMarketplaceRoot(marketplaceRootOverride);

  console.log(`  Registering Codex plugin marketplace: ${marketplaceRoot}`);
  repairStaleMarketplaceRegistration();
  registerCodexMarketplace(marketplaceRoot);
  enableCodexPluginConfig();
  runCodex(['plugin', 'add', CODEX_PLUGIN_ID]);
  console.log('  Installed Codex plugin cache.');
  if (!cleanupLegacyCodexAgentsMdContext()) {
    console.warn(`  Native Codex hooks registered, but failed to remove legacy AGENTS.md context from ${CODEX_AGENTS_MD_PATH}.`);
  }
  if (!cleanupLegacyCodexTranscriptAgentsContext()) {
    console.warn(`  Native Codex hooks registered, but failed to disable legacy transcript AGENTS.md context in ${CODEX_TRANSCRIPT_WATCH_CONFIG_PATH}.`);
  }

  if (!verifyCodexPluginLoaded()) {
    console.error(`
Installation failed: Codex does not list ${CODEX_PLUGIN_ID}.

Codex will not load the plugin, so no memory context will be injected.
Inspect the plugin and marketplace state with:
  codex plugin list
`);
    return 1;
  }

  console.log(`
Installation complete!

Codex marketplace: ${MARKETPLACE_NAME}
Plugin source:     ${marketplaceRoot}

Next steps:
  1. Open Codex CLI in your project
  2. Review and trust the six claude-mem hooks when Codex prompts you
  3. Restart sessions opened before trusting the hooks

For a fresh setup, the supported entry point is:
  npx claude-mem@latest install
`);
  return 0;
}

/**
 * Surface a failed install instead of reporting success into a void: a plugin
 * that Codex cannot list will silently never inject context.
 *
 * Returns false only when Codex positively reported the plugin as absent. An
 * unusable `plugin list` (spawn error, non-zero exit) means the state is
 * unknown, not broken; the install steps themselves succeeded, so that warns
 * and continues rather than failing a good install on an unrelated CLI hiccup.
 */
export function verifyCodexPluginLoaded(spawn: CodexSpawn = codexSpawn): boolean {
  const result = spawn(['plugin', 'list']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  if (result.error || result.status !== 0) {
    console.warn('  Could not verify the Codex plugin list. Check with: codex plugin list');
    if (output) console.warn(`  ${output.split('\n')[0]}`);
    return true;
  }

  if (!output.includes(CODEX_PLUGIN_ID)) {
    console.error(`  Codex did not list ${CODEX_PLUGIN_ID} after install.`);
    return false;
  }

  console.log(`  Verified Codex lists ${CODEX_PLUGIN_ID}.`);
  return true;
}

export function uninstallCodexCli(): number {
  console.log('\nUninstalling Claude-Mem Codex CLI integration...\n');

  let failed = false;

  try {
    disableCodexPluginConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nCodex plugin config update failed: ${message}`);
    failed = true;
  }

  try {
    if (commandExists(resolveCodexCommand())) {
      runCodex(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    } else {
      console.log('  Codex CLI not found; skipping marketplace removal.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nCodex marketplace removal failed: ${message}`);
    failed = true;
  }

  try {
    if (!cleanupLegacyCodexAgentsMdContext()) {
      console.error(`\nFailed to remove legacy AGENTS.md context from ${CODEX_AGENTS_MD_PATH}.`);
      failed = true;
    }
    if (!cleanupLegacyCodexTranscriptAgentsContext()) {
      console.error(`\nFailed to disable legacy transcript AGENTS.md context in ${CODEX_TRANSCRIPT_WATCH_CONFIG_PATH}.`);
      failed = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nLegacy context cleanup failed: ${message}`);
    failed = true;
  }

  if (failed) {
    console.error('\nUninstallation completed with errors.');
    return 1;
  }

  console.log('\nUninstallation complete!');
  console.log('Restart Codex CLI to apply changes.\n');

  return 0;
}

import path from 'path';
import { homedir } from 'os';
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
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

function commandExists(command: string): boolean {
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

/**
 * The durable, claude-mem-owned marketplace location.
 *
 * Codex records the marketplace source as an absolute path in config.toml and
 * re-reads it on every launch. Registering a transient directory (an npx cache
 * entry, a git worktree, a temp clone) therefore breaks permanently the moment
 * that directory goes away — and a dead source makes Codex refuse to load ANY
 * marketplace, not just this one. Always prefer the stable path.
 */
export function stableMarketplaceRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  return path.join(configDir, 'plugins', 'marketplaces', 'thedotmack');
}

function resolvePluginMarketplaceRoot(preferredRoot?: string): string {
  if (preferredRoot) {
    return assertCodexMarketplaceRoot(preferredRoot);
  }

  const stableRoot = stableMarketplaceRoot();
  if (missingMarketplaceFiles(stableRoot).length === 0) {
    return path.resolve(stableRoot);
  }

  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = findAncestorWithCodexMarketplace(candidate);
    if (resolved && missingMarketplaceFiles(resolved).length === 0) {
      console.warn(`  Registering Codex marketplace from ${resolved} because ${stableRoot} is not populated.`);
      console.warn('  If that directory is removed, re-run: npx claude-mem@latest install');
      return resolved;
    }
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

export function resolveCodexCommand(
  platform: NodeJS.Platform = process.platform,
  windowsLookup: () => string | null = lookupCodexOnWindows,
): string {
  if (platform !== 'win32') return 'codex';
  return windowsLookup() ?? 'codex.cmd';
}

export function resolveCodexSpawnInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  windowsLookup: () => string | null = lookupCodexOnWindows,
): SpawnSyncInvocation {
  const resolvedCommand = resolveCodexCommand(platform, windowsLookup);
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

function runCodex(args: string[]): void {
  const result = codexSpawn(args);
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

/**
 * Read a `[marketplaces.<name>]` entry out of Codex's config.toml.
 *
 * Returns null when the marketplace is not registered. `source` is null when
 * the entry exists but declares no source.
 */
export function readRegisteredMarketplace(
  content: string,
  marketplaceName: string,
): { source: string | null; sourceType: string | null } | null {
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === `[marketplaces.${marketplaceName}]`
      || trimmed === `[marketplaces."${marketplaceName}"]`;
  });
  if (headerIndex === -1) return null;

  let source: string | null = null;
  let sourceType: string | null = null;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    const sourceMatch = lines[index].match(/^\s*source\s*=\s*"(.*)"\s*$/);
    if (sourceMatch) source = sourceMatch[1];
    const typeMatch = lines[index].match(/^\s*source_type\s*=\s*"(.*)"\s*$/);
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
 * unreadable — `codex plugin list` hard-errors and every plugin silently stops
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

function registerCodexMarketplace(marketplaceRoot: string): void {
  repairStaleMarketplaceRegistration();

  try {
    runCodex(['plugin', 'marketplace', 'add', marketplaceRoot]);
    return;
  } catch (error) {
    if (!isMarketplaceDifferentSourceError(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  console.warn(`  Codex marketplace ${MARKETPLACE_NAME} is already registered from another source; replacing it with ${marketplaceRoot}.`);
  runCodex(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  runCodex(['plugin', 'marketplace', 'add', marketplaceRoot]);
}

export function setTomlBooleanInTable(content: string, header: string, key: string, enabled: boolean): string {
  const booleanLine = `${key} = ${enabled ? 'true' : 'false'}`;
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${header}\n${booleanLine}\n`;
  }

  let sectionEnd = headerIndex + 1;
  while (sectionEnd < lines.length && !/^\s*\[/.test(lines[sectionEnd])) {
    sectionEnd += 1;
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^\\s*${escapedKey}\\s*=`);
  const keyIndex = lines.findIndex(
    (line, index) => index > headerIndex && index < sectionEnd && keyPattern.test(line),
  );

  if (keyIndex === -1) {
    lines.splice(headerIndex + 1, 0, booleanLine);
  } else {
    lines[keyIndex] = booleanLine;
  }

  return lines.join('\n');
}

export function setTomlPluginEnabled(content: string, pluginId: string, enabled: boolean): string {
  const escapedPluginId = pluginId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return setTomlBooleanInTable(content, `[plugins."${escapedPluginId}"]`, 'enabled', enabled);
}

export function setTomlFeatureEnabled(content: string, featureName: string, enabled: boolean): string {
  return setTomlBooleanInTable(content, '[features]', featureName, enabled);
}

function normalizeTomlHeader(line: string): string | null {
  const match = line.trim().match(/^\[([^\]]+)\]\s*$/);
  if (!match) return null;
  return match[1].replace(/\s+/g, '').replace(/"/g, '');
}

function isLegacyMcpSearchHeader(normalizedHeader: string | null): boolean {
  return normalizedHeader === 'mcp_servers.mcp-search';
}

function isLegacyMcpSearchChildHeader(normalizedHeader: string | null): boolean {
  return typeof normalizedHeader === 'string' && normalizedHeader.startsWith('mcp_servers.mcp-search.');
}

function isClaudeMemMcpSearchBlock(block: string): boolean {
  return /claude-mem/.test(block);
}

export function removeLegacyCodexMcpSearchConfig(content: string): string {
  const lines = content.split('\n');
  const blocks: Array<{ header: string | null; text: string }> = [];
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const header = normalizeTomlHeader(line);
    if (header !== null) {
      blocks.push({ header: currentHeader, text: currentLines.join('\n') });
      currentHeader = header;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  blocks.push({ header: currentHeader, text: currentLines.join('\n') });

  const removeLegacyMcpSearch = blocks.some(
    (block) => isLegacyMcpSearchHeader(block.header) && isClaudeMemMcpSearchBlock(block.text),
  );
  if (!removeLegacyMcpSearch) return content;

  const kept = blocks.filter((block) =>
    !isLegacyMcpSearchHeader(block.header) && !isLegacyMcpSearchChildHeader(block.header)
  );
  // The stale claude-mem-owned server can have tool child tables; remove the
  // whole subtree so Codex falls back to the plugin-managed MCP declaration.
  return kept.map((block) => block.text).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function writeCodexPluginConfig(enabled: boolean): boolean {
  if (!enabled && !existsSync(CODEX_CONFIG_PATH)) return false;
  mkdirSync(CODEX_DIR, { recursive: true });
  const current = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, 'utf-8') : '';
  let next = current;

  if (enabled) {
    next = setTomlFeatureEnabled(next, 'hooks', true);
    next = removeLegacyCodexMcpSearchConfig(next);
  }
  for (const legacyPluginId of LEGACY_CODEX_PLUGIN_IDS) {
    next = setTomlPluginEnabled(next, legacyPluginId, false);
  }
  next = setTomlPluginEnabled(next, CODEX_PLUGIN_ID, enabled);

  if (next === current) return false;
  writeFileSync(CODEX_CONFIG_PATH, next);
  return true;
}

function enableCodexPluginConfig(): void {
  const changed = writeCodexPluginConfig(true);
  console.log(`  Enabled Codex plugin: ${CODEX_PLUGIN_ID}${changed ? '' : ' (already enabled)'}`);
}

function disableCodexPluginConfig(): void {
  const changed = writeCodexPluginConfig(false);
  console.log(`  Disabled Codex plugin: ${CODEX_PLUGIN_ID}${changed ? '' : ' (already disabled)'}`);
}

function extractSemver(value: string): string | null {
  return value.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function assertCodexMarketplaceSupported(): void {
  const result = codexSpawn(['--version']);
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

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  try {
    readAndStripContextTags(startTag, endTag);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to clean AGENTS.md context', { error: message });
    return false;
  }
}

function readAndStripContextTags(startTag: string, endTag: string): void {
  const content = readFileSync(CODEX_AGENTS_MD_PATH, 'utf-8');

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) return;

  const before = content.substring(0, startIdx).replace(/\n+$/, '');
  const after = content.substring(endIdx + endTag.length).replace(/^\n+/, '');
  const finalContent = (before + (after ? '\n\n' + after : '')).trim();

  if (finalContent) {
    writeFileSync(CODEX_AGENTS_MD_PATH, finalContent + '\n');
  } else {
    writeFileSync(CODEX_AGENTS_MD_PATH, '');
  }

  console.log(`  Removed legacy global context from ${CODEX_AGENTS_MD_PATH}`);
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

function stripLegacyTranscriptWatchContexts(): void {
  const parsed = JSON.parse(readFileSync(CODEX_TRANSCRIPT_WATCH_CONFIG_PATH, 'utf-8')) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.watches)) return;

  let changed = false;
  for (const watch of parsed.watches) {
    if (!isRecord(watch) || !isCodexTranscriptWatch(watch)) continue;
    if (!isRecord(watch.context) || !isLegacyCodexAgentsContext(watch.context)) continue;
    delete watch.context;
    changed = true;
  }

  if (changed) {
    writeFileSync(CODEX_TRANSCRIPT_WATCH_CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log(`  Disabled legacy Codex transcript AGENTS.md context in ${CODEX_TRANSCRIPT_WATCH_CONFIG_PATH}`);
  }
}

const cleanupLegacyCodexTranscriptAgentsContext = disableCodexTranscriptAgentsContext;

export async function installCodexCli(marketplaceRootOverride?: string): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (native hooks)...\n');

  if (!commandExists('codex')) {
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

function performCodexInstall(marketplaceRootOverride?: string): number {
  assertCodexMarketplaceSupported();
  const marketplaceRoot = resolvePluginMarketplaceRoot(marketplaceRootOverride);

  console.log(`  Registering Codex plugin marketplace: ${marketplaceRoot}`);
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

  verifyCodexPluginLoaded();

  console.log(`
Installation complete!

Codex marketplace: ${MARKETPLACE_NAME}
Plugin source:     ${marketplaceRoot}

Next steps:
  1. Open Codex CLI in your project
  2. Restart any running Codex sessions so native hooks are loaded
  3. Approve the claude-mem hooks when Codex prompts you to trust them.
     Codex will not run them until you do, and memory context will be
     missing from your sessions until then. Verify with: codex plugin list

For a fresh setup, the supported entry point is:
  npx claude-mem@latest install
`);
  return 0;
}

/**
 * Surface a failed install instead of reporting success into a void: a plugin
 * that Codex cannot list will silently never inject context.
 */
function verifyCodexPluginLoaded(): void {
  const result = codexSpawn(['plugin', 'list']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  if (result.error || result.status !== 0) {
    console.warn('  Could not verify the Codex plugin list. Check with: codex plugin list');
    if (output) console.warn(`  ${output.split('\n')[0]}`);
    return;
  }

  if (!output.includes(CODEX_PLUGIN_ID)) {
    console.warn(`  Codex did not list ${CODEX_PLUGIN_ID} after install. Check with: codex plugin list`);
    return;
  }

  console.log(`  Verified Codex lists ${CODEX_PLUGIN_ID}.`);
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
    if (commandExists('codex')) {
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

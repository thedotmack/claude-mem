
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { buildSpawnSyncInvocation, lookupWindowsCommand } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import { CONTEXT_TAG_OPEN, findContextBlockRange } from '../../utils/context-injection.js';
import { getMcpServerAbsolutePath, getNodeAbsolutePath } from './install-paths.js';

const OPENCODE_PLUGIN_CONFIG_PATH = './plugins/claude-mem.js';
const OPENCODE_MCP_SERVER_KEY = 'claude-mem';

/**
 * Partial-install exit code: the plugin was registered but its MCP entry could
 * not be, because the server script did not resolve. Distinct from a hard
 * failure (1) so the caller can still finish context injection and let the CLI
 * report a partial install — with the warning in its captured output — instead
 * of printing a blanket success.
 */
export const OPENCODE_MCP_REGISTRATION_INCOMPLETE = 2;

/**
 * Partial-install exit code: everything is installed, but the claude-mem block
 * an older install left in the global AGENTS.md could not be removed, so
 * OpenCode still shows that stale memory in every project. The CLI reports it
 * as a warning with the remedy rather than a clean success.
 */
export const OPENCODE_OLD_CONTEXT_BLOCK_LEFT = 3;

type OpenCodeConfig = {
  $schema?: string;
  plugin?: unknown;
  plugins?: unknown;
  [key: string]: unknown;
};
type PluginAPI = 1 | 2;

export function resolveOpenCodePluginAPI(): PluginAPI {
  const override = process.env.CLAUDE_MEM_OPENCODE_API;
  if (override !== undefined) {
    if (override === 'v1' || override === '1') return 1;
    if (override === 'v2' || override === '2') return 2;
    throw new Error('CLAUDE_MEM_OPENCODE_API must be v1 or v2.');
  }
  for (const name of ['opencode', 'opencode2']) {
    const command = process.platform === 'win32' ? lookupWindowsCommand(name) : name;
    if (!command) continue;
    const invocation = buildSpawnSyncInvocation(command, ['--version'], {
      encoding: 'utf8', timeout: 3_000, env: sanitizeEnv(process.env),
    });
    const result = spawnSync(invocation.command, invocation.args, invocation.options);
    if (result.status !== 0) continue;
    const major = result.stdout?.trim().match(/^(?:opencode2?\s+)?([12])\./)?.[1];
    if (major) return Number(major) as PluginAPI;
  }
  // Existing config-only installs keep v1; v2 users without a CLI can override.
  return 1;
}

function pluginTarget(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry[0];
  if (entry && typeof entry === 'object') return (entry as { package?: unknown }).package;
  return entry;
}
function isManagedReference(entry: unknown): boolean {
  const target = pluginTarget(entry);
  return target === OPENCODE_PLUGIN_CONFIG_PATH || target === getInstalledPluginPath();
}
function readConfig(): { config: OpenCodeConfig; raw: string } {
  const raw = existsSync(getOpenCodeConfigPath()) ? readFileSync(getOpenCodeConfigPath(), 'utf8') : '{}\n';
  const errors: ParseError[] = [];
  const config = parse(raw.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true }) as OpenCodeConfig;
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid OpenCode config: ' + getOpenCodeConfigPath());
  }
  if (config.mcp !== undefined && (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp))) {
    throw new Error('Invalid OpenCode mcp configuration; expected an object.');
  }
  return { config, raw };
}
/** Change our entries only, retaining comments and unrelated plugin/MCP values. */
function writeConfig(original: OpenCodeConfig, next: OpenCodeConfig, source: string): void {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  let raw = source.replace(/^\uFEFF/, '');
  const edit = (keys: (string | number)[], value: unknown): void => {
    raw = applyEdits(raw, modify(raw, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  };
  if (original.$schema !== next.$schema) edit(['$schema'], next.$schema);
  for (const key of ['plugin', 'plugins'] as const) {
    if (JSON.stringify(original[key]) === JSON.stringify(next[key])) continue;
    if (Array.isArray(original[key]) && Array.isArray(next[key])) {
      const entries = original[key];
      for (let index = entries.length - 1; index >= 0; index--) if (isManagedReference(entries[index])) edit([key, index], undefined);
      for (const entry of next[key].filter(isManagedReference)) edit([key, -1], entry);
    } else edit([key], next[key]);
  }
  const before = getOpenCodeMcpEntry(original);
  const after = getOpenCodeMcpEntry(next);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    if (next.mcp === undefined) edit(['mcp'], undefined);
    else if (original.mcp === undefined) edit(['mcp'], next.mcp);
    else {
      if (JSON.stringify(before[OPENCODE_MCP_SERVER_KEY]) !== JSON.stringify(after[OPENCODE_MCP_SERVER_KEY])) {
        edit(['mcp', OPENCODE_MCP_SERVER_KEY], after[OPENCODE_MCP_SERVER_KEY]);
      }
      const oldServers = objectEntry(before.servers);
      const newServers = objectEntry(after.servers);
      if (after.servers === undefined && before.servers !== undefined) edit(['mcp', 'servers'], undefined);
      else if (JSON.stringify(oldServers[OPENCODE_MCP_SERVER_KEY]) !== JSON.stringify(newServers[OPENCODE_MCP_SERVER_KEY])) {
        edit(['mcp', 'servers', OPENCODE_MCP_SERVER_KEY], newServers[OPENCODE_MCP_SERVER_KEY]);
      }
    }
  }
  mkdirSync(getOpenCodeConfigDirectory(), { recursive: true });
  writeFileSync(getOpenCodeConfigPath(), bom + raw, 'utf8');
}
function objectEntry(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function getOpenCodeConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'opencode');
}

export function getOpenCodePluginsDirectory(): string {
  return path.join(getOpenCodeConfigDirectory(), 'plugins');
}

export function getOpenCodeConfigPath(): string {
  const jsonc = path.join(getOpenCodeConfigDirectory(), 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return path.join(getOpenCodeConfigDirectory(), 'opencode.json');
}

export function getOpenCodeAgentsMdPath(): string {
  return path.join(getOpenCodeConfigDirectory(), 'AGENTS.md');
}

export function getInstalledPluginPath(): string {
  return path.join(getOpenCodePluginsDirectory(), 'claude-mem.js');
}

function getOpenCodePluginEntries(config: OpenCodeConfig, key: 'plugin' | 'plugins' = 'plugin'): unknown[] {
  if (Array.isArray(config[key])) {
    return config[key];
  }
  return config[key] === undefined ? [] : [config[key]];
}

export function addOpenCodePluginReference(config: OpenCodeConfig, api: PluginAPI = 1): OpenCodeConfig {
  const key = api === 2 ? 'plugins' : 'plugin';
  const otherKey = api === 2 ? 'plugin' : 'plugins';
  const existing = getOpenCodePluginEntries(config, key);
  let found = false;
  const plugins = existing.filter(entry => {
    if (!isManagedReference(entry)) return true;
    if (found) return false;
    found = true; return true;
  });
  if (!found) plugins.push(OPENCODE_PLUGIN_CONFIG_PATH);
  const next = { ...config, [key]: plugins };
  if (config[otherKey] !== undefined) {
    next[otherKey] = getOpenCodePluginEntries(config, otherKey).filter(entry => !isManagedReference(entry));
    if (!(next[otherKey] as unknown[]).length) delete next[otherKey];
  }
  return next;
}

export function removeOpenCodePluginReference(config: OpenCodeConfig): OpenCodeConfig {
  const next = { ...config };
  for (const key of ['plugin', 'plugins'] as const) if (config[key] !== undefined) {
    next[key] = getOpenCodePluginEntries(config, key).filter(entry => !isManagedReference(entry));
  }
  return next;
}

function getOpenCodeMcpEntry(config: OpenCodeConfig): Record<string, unknown> {
  return (config.mcp && typeof config.mcp === 'object')
    ? config.mcp as Record<string, unknown>
    : {};
}

/**
 * Register claude-mem's MCP server in opencode.json as a local MCP server that
 * launches `node <absolute-path-to-mcp-server.cjs>` — OpenCode does NOT do
 * `${CLAUDE_PLUGIN_ROOT}` substitution, so the path must be baked absolute
 * (Rule B in install-paths.ts). Other MCP servers are preserved untouched.
 * Returns the config unchanged (no mcp entry) when the server script cannot be
 * resolved, so a broken build never corrupts the user's opencode.json.
 */
export function addOpenCodeMcpReference(config: OpenCodeConfig, api: PluginAPI = 1): OpenCodeConfig {
  return addOpenCodeMcpReferenceWithStatus(config, api).config;
}

/**
 * `addOpenCodeMcpReference` plus whether this run actually resolved its own
 * `mcp-server.cjs`. The caller must not infer that from the resulting config:
 * a pre-existing `mcp["claude-mem"]` entry — stale, or pointing at an unrelated
 * existing file — would masquerade as a successful registration. Surfacing the
 * resolution outcome is what lets the install report partial failure honestly.
 */
function addOpenCodeMcpReferenceWithStatus(
  config: OpenCodeConfig,
  api: PluginAPI = 1,
): { config: OpenCodeConfig; mcpServerResolved: boolean } {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) return { config, mcpServerResolved: false };

  const command = [getNodeAbsolutePath(), mcpServerPath];
  const existingMcp = getOpenCodeMcpEntry(config);
  const servers = api === 2 ? objectEntry(existingMcp.servers) : existingMcp;
  const selected = servers[OPENCODE_MCP_SERVER_KEY];
  const other = api === 2 ? existingMcp[OPENCODE_MCP_SERVER_KEY] : objectEntry(existingMcp.servers)[OPENCODE_MCP_SERVER_KEY];
  const current = selected ?? other;
  if (
    current
    && typeof current === 'object'
    && (current as { type?: unknown }).type === 'local'
    && Array.isArray((current as { command?: unknown }).command)
    && JSON.stringify((current as { command: unknown[] }).command) === JSON.stringify(command)
    && selected !== undefined && other === undefined
  ) {
    return { config, mcpServerResolved: true };
  }

  const entry = { ...objectEntry(current), type: 'local', command, ...(api === 2 ? { codemode: objectEntry(current).codemode ?? false } : {}) };
  if (api === 2 && 'enabled' in entry) {
    if (entry.enabled === false) (entry as Record<string, unknown>).disabled = true;
    delete (entry as Record<string, unknown>).enabled;
  }
  const nextMcp = { ...existingMcp };
  if (api === 2) {
    delete nextMcp[OPENCODE_MCP_SERVER_KEY];
    nextMcp.servers = { ...servers, [OPENCODE_MCP_SERVER_KEY]: entry };
  } else {
    nextMcp[OPENCODE_MCP_SERVER_KEY] = entry;
    if (nextMcp.servers && OPENCODE_MCP_SERVER_KEY in objectEntry(nextMcp.servers)) {
      const remaining = { ...objectEntry(nextMcp.servers) }; delete remaining[OPENCODE_MCP_SERVER_KEY];
      if (Object.keys(remaining).length) nextMcp.servers = remaining; else delete nextMcp.servers;
    }
  }
  return {
    config: {
      ...config,
      mcp: nextMcp,
    },
    mcpServerResolved: true,
  };
}

/**
 * Remove only claude-mem's MCP entry from opencode.json, preserving every other
 * MCP server. The `mcp` block itself is dropped when it becomes empty.
 */
export function removeOpenCodeMcpReference(config: OpenCodeConfig): OpenCodeConfig {
  const existingMcp = getOpenCodeMcpEntry(config);
  if (!(OPENCODE_MCP_SERVER_KEY in existingMcp) && !(OPENCODE_MCP_SERVER_KEY in objectEntry(existingMcp.servers))) {
    return config;
  }

  const { [OPENCODE_MCP_SERVER_KEY]: _removed, ...remainingMcp } = existingMcp;
  if (remainingMcp.servers) {
    const servers = { ...objectEntry(remainingMcp.servers) }; delete servers[OPENCODE_MCP_SERVER_KEY];
    if (Object.keys(servers).length) remainingMcp.servers = servers; else delete remainingMcp.servers;
  }
  const next: OpenCodeConfig = { ...config, mcp: remainingMcp };
  if (Object.keys(remainingMcp).length === 0) {
    delete next.mcp;
  }
  return next;
}

export function registerOpenCodePluginInConfig(api: PluginAPI = 1): number {
  const configPath = getOpenCodeConfigPath();
  const defaultConfig: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
  };

  try {
    const document = readConfig();
    const config = existsSync(configPath) ? document.config : defaultConfig;
    const withPlugin = addOpenCodePluginReference(config, api);
    const { config: updatedConfig, mcpServerResolved } = addOpenCodeMcpReferenceWithStatus(withPlugin, api);

    writeConfig(document.config, updatedConfig, document.raw);

    // Warn conservatively whenever this run could not resolve its own MCP
    // server script. The final config is deliberately NOT consulted: a retained
    // entry cannot be trusted as claude-mem's server just because its command
    // names an existing file, and a stale entry must not be silently reported
    // as a successful registration. The warning goes to stderr (captured by the
    // installer's console buffer) as well as the log file, and the partial
    // result is returned to the caller — a log-file-only warning plus a success
    // exit would let the user believe the integration is complete.
    if (!mcpServerResolved) {
      const message = 'MCP server script not found — claude-mem MCP server could not be registered';
      logger.warn('OPENCODE', message, { path: configPath });
      console.warn(`  ${message}: ${configPath}`);
      return OPENCODE_MCP_REGISTRATION_INCOMPLETE;
    }

    console.log(`  Plugin registered in: ${configPath}`);
    logger.info('OPENCODE', 'Plugin registered in config', { path: configPath });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to register OpenCode plugin in config: ${message}`);
    return 1;
  }
}

export function deregisterOpenCodePluginFromConfig(): number {
  const configPath = getOpenCodeConfigPath();
  if (!existsSync(configPath)) {
    return 0;
  }

  try {
    const { config, raw } = readConfig();
    const updatedConfig = removeOpenCodeMcpReference(removeOpenCodePluginReference(config));

    writeConfig(config, updatedConfig, raw);
    console.log(`  Plugin deregistered from: ${configPath}`);
    logger.info('OPENCODE', 'Plugin deregistered from config', { path: configPath });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deregister OpenCode plugin from config: ${message}`);
    return 1;
  }
}

export function findBuiltPluginPath(api: PluginAPI = 1): string | null {
  const entry = api === 2 ? 'v2.js' : 'index.js';
  const possiblePaths = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
      'dist', 'opencode-plugin', entry,
    ),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'opencode-plugin', entry),
  ];

  for (const candidatePath of possiblePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

export function installOpenCodePlugin(): number {
  let api: PluginAPI;
  try {
    api = resolveOpenCodePluginAPI();
    const { config } = readConfig();
    if (api === 2 && getOpenCodePluginEntries(config).some(entry => !isManagedReference(entry))) {
      throw new Error('Other OpenCode v1 plugin entries remain. Migrate those plugins to v2 before installing; your configuration was preserved. See https://opencode.ai/v2/docs/migrate-v1');
    }
    if (api === 2 && Object.keys(getOpenCodeMcpEntry(config)).some(key =>
      !['servers', 'timeout', OPENCODE_MCP_SERVER_KEY].includes(key),
    )) {
      throw new Error('Other OpenCode v1 MCP entries remain. Move them to mcp.servers before installing v2; your configuration was preserved. See https://opencode.ai/v2/docs/mcp-servers');
    }
    if (['plugin', 'plugins'].some(key => getOpenCodePluginEntries(config, key as 'plugin' | 'plugins').some(entry =>
      typeof pluginTarget(entry) === 'string' && String(pluginTarget(entry)).startsWith('@ephemushroom/opencode-claude-mem'),
    ))) {
      throw new Error('Disable @ephemushroom/opencode-claude-mem before installing first-party capture; the existing connector configuration was preserved.');
    }
  } catch (error) { console.error(String(error)); return 1; }
  const builtPluginPath = findBuiltPluginPath(api);
  if (!builtPluginPath) {
    console.error('Could not find built OpenCode plugin bundle.');
    console.error(`  Expected at: dist/opencode-plugin/${api === 2 ? 'v2.js' : 'index.js'}`);
    console.error('  Run the build first: npm run build');
    return 1;
  }

  const pluginsDirectory = getOpenCodePluginsDirectory();
  const destinationPath = getInstalledPluginPath();
  const license = path.join(path.dirname(builtPluginPath), 'THIRD-PARTY-LICENSE.txt');
  if (api === 2 && !existsSync(license)) {
    console.error('OpenCode v2 contributor license is missing; rebuild the package.');
    return 1;
  }

  try {
    mkdirSync(pluginsDirectory, { recursive: true });

    copyFileSync(builtPluginPath, destinationPath);
    if (existsSync(license)) copyFileSync(license, path.join(pluginsDirectory, 'claude-mem.LICENSE.txt'));

    console.log(`  Plugin installed to: ${destinationPath}`);
    logger.info('OPENCODE', 'Plugin installed', { destination: destinationPath });

    const registerResult = registerOpenCodePluginInConfig(api);
    if (registerResult !== 0) {
      return registerResult;
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenCode plugin: ${message}`);
    return 1;
  }
}

function writeOrRemoveCleanedAgentsMd(agentsMdPath: string, trimmedContent: string): void {
  if (
    trimmedContent.length === 0 ||
    trimmedContent === '# Claude-Mem Memory Context'
  ) {
    unlinkSync(agentsMdPath);
    console.log(`  Removed empty AGENTS.md`);
  } else {
    writeFileSync(agentsMdPath, trimmedContent + '\n', 'utf-8');
    console.log(`  Cleaned context from AGENTS.md`);
  }
}

export function uninstallOpenCodePlugin(): number {
  let hasErrors = false;

  const pluginPath = getInstalledPluginPath();
  if (existsSync(pluginPath)) {
    try {
      unlinkSync(pluginPath);
      console.log(`  Removed plugin: ${pluginPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to remove plugin: ${message}`);
      hasErrors = true;
    }
  }
  const license = path.join(getOpenCodePluginsDirectory(), 'claude-mem.LICENSE.txt');
  if (existsSync(license)) {
    try { unlinkSync(license); } catch (error) { console.error(String(error)); hasErrors = true; }
  }

  if (deregisterOpenCodePluginFromConfig() !== 0) {
    hasErrors = true;
  }

  if (!removeContextBlockFromAgentsMd()) {
    hasErrors = true;
  }

  return hasErrors ? 1 : 0;
}

/**
 * Strip claude-mem's context block from OpenCode's global AGENTS.md
 * (`~/.config/opencode/AGENTS.md`). Older installs wrote memory there, read
 * from the `opencode` project key, which nothing has written since #3803.
 * OpenCode loads that file for every project, so one stale block showed up in
 * all of them. The plugin now injects each project's own context into the
 * system prompt instead. The user's own content in the file stays, and a file
 * holding nothing else is removed. Returns false when the file could not be
 * read or rewritten.
 */
export function removeContextBlockFromAgentsMd(): boolean {
  const agentsMdPath = getOpenCodeAgentsMdPath();
  if (!existsSync(agentsMdPath)) return true;

  let content: string;
  try {
    content = readFileSync(agentsMdPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to read AGENTS.md: ${message}`);
    return false;
  }

  const block = findContextBlockRange(content);
  if (!block) return true;

  const trimmedContent = (
    content.slice(0, block.start).trimEnd() +
    '\n' +
    content.slice(block.end).trimStart()
  ).trim();
  try {
    writeOrRemoveCleanedAgentsMd(agentsMdPath, trimmedContent);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to clean AGENTS.md: ${message}`);
    return false;
  }
}

export function checkOpenCodeStatus(): number {
  console.log('\nClaude-Mem OpenCode Integration Status\n');

  const configDirectory = getOpenCodeConfigDirectory();
  const pluginPath = getInstalledPluginPath();
  const agentsMdPath = getOpenCodeAgentsMdPath();

  console.log(`Config directory: ${configDirectory}`);
  console.log(`  Exists: ${existsSync(configDirectory) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Plugin: ${pluginPath}`);
  console.log(`  Installed: ${existsSync(pluginPath) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Context: injected by the plugin into each request's system prompt`);
  if (existsSync(agentsMdPath) && readFileSync(agentsMdPath, 'utf-8').includes(CONTEXT_TAG_OPEN)) {
    console.log(`  Leftover claude-mem block from an older install in ${agentsMdPath}`);
    console.log(`  (shown in every OpenCode project): re-run the install to remove it`);
  }
  console.log('');

  console.log(`MCP server (opencode.json):`);
  try {
    if (existsSync(getOpenCodeConfigPath())) {
      const { config } = readConfig();
      const mcp = getOpenCodeMcpEntry(config);
      const mcpEntry = objectEntry(mcp.servers)[OPENCODE_MCP_SERVER_KEY] ?? mcp[OPENCODE_MCP_SERVER_KEY];
      if (mcpEntry && typeof mcpEntry === 'object') {
        const command = (mcpEntry as { command?: unknown }).command;
        console.log(`  Registered: yes`);
        console.log(`  Command: ${Array.isArray(command) ? command.join(' ') : 'unknown'}`);
      } else {
        console.log(`  Registered: no`);
      }
    } else {
      console.log(`  Registered: no (${getOpenCodeConfigPath()} does not exist)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  Registered: unknown (could not read config: ${message})`);
  }

  console.log('');
  return 0;
}

export async function installOpenCodeIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem for OpenCode...\n');

  const pluginResult = installOpenCodePlugin();
  const mcpIncomplete = pluginResult === OPENCODE_MCP_REGISTRATION_INCOMPLETE;
  if (pluginResult !== 0 && !mcpIncomplete) {
    return pluginResult;
  }

  // The plugin injects each project's memory itself; a block an older install
  // left in the global AGENTS.md would show stale memory in every project.
  const oldContextBlockRemoved = removeContextBlockFromAgentsMd();
  if (!oldContextBlockRemoved) {
    logger.warn('OPENCODE', 'Could not remove the old claude-mem block from the global AGENTS.md during install', {
      path: getOpenCodeAgentsMdPath(),
    });
  }

  if (mcpIncomplete) {
    console.warn(`
OpenCode integration installed partially!

Plugin installed to: ${getInstalledPluginPath()}
MCP server: NOT registered (mcp-server.cjs not found)

Next steps:
  1. Restore the plugin build, then re-run the OpenCode install to register the MCP server
  2. Restart OpenCode to load the plugin
`);
    return OPENCODE_MCP_REGISTRATION_INCOMPLETE;
  }

  if (!oldContextBlockRemoved) {
    console.warn(`
OpenCode integration installed, but the old claude-mem memory block in
${getOpenCodeAgentsMdPath()} could not be removed (see above).
OpenCode shows that stale block in every project until it is deleted.
`);
    return OPENCODE_OLD_CONTEXT_BLOCK_LEFT;
  }

  console.log(`
Installation complete!

Plugin installed to: ${getInstalledPluginPath()}
Memory context: injected by the plugin into each project's requests

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart OpenCode to load the plugin
  3. Memory capture is automatic from then on
`);

  return 0;
}

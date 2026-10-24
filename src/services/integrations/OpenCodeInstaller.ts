
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { buildSpawnSyncInvocation, lookupWindowsCommand } from '../../shared/spawn.js';
import { logger } from '../../utils/logger.js';
import { getMcpServerAbsolutePath, getNodeAbsolutePath } from './install-paths.js';
import {
  CONTEXT_BLOCK_CLOSE as CONTEXT_TAG_CLOSE,
  CONTEXT_BLOCK_OPEN as CONTEXT_TAG_OPEN,
  LIBRARY_GROUPS,
  OPENCODE_MCP_SERVER_KEY,
  OPENCODE_PLUGIN_CONFIG_PATH,
  mcpMemberItem,
} from '../wire-gateway/library/agent-library-targets.js';
import { encodeMcpServerEntry } from '../wire-gateway/library/mcp-servers.js';
import { applyLibraryForInstaller, removeLibraryForInstaller } from '../wire-gateway/library/library-runtime.js';
import { stripLegacyContextBlock } from '../wire-gateway/library/text-block.js';
import type {
  ConfigMemberItem,
  JsonArrayEntryItem,
  JsonFileStyle,
  LibraryConfigEdit,
  LibraryItem,
  LibraryMigration,
  LibraryValue,
  OwnedFileItem,
} from '../wire-gateway/library/types.js';

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

/** OpenCode's plugin API: 1 for OpenCode 1.x, 2 for OpenCode 2.x. */
export type OpenCodePluginApi = 1 | 2;

type OpenCodeVersion = [major: number, minor: number, patch: number];

/**
 * The oldest OpenCode that loads the plugin. Its default export is a
 * `{ id, server, setup }` definition object, and 1.3.4 is the first release
 * whose loader reads `server` from an object; older ones call every export
 * as a function and reject it.
 */
const OPENCODE_MIN_SUPPORTED_VERSION: OpenCodeVersion = [1, 3, 4];

/**
 * Reads `opencode --version` output: "1.18.35", "2.0.22", or
 * "opencode v2.0.23" (the form 2.0.23 prints, found live in #4519).
 */
export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  const match = output.match(/^\s*(?:opencode2?\s+)?v?(\d+)\.(\d+)\.(\d+)/im);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareOpenCodeVersions(left: OpenCodeVersion, right: OpenCodeVersion): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * The newest OpenCode on PATH, or null when none answers `--version`.
 * OpenCode 2 installs its CLI as both `opencode` and `opencode2`.
 */
export function detectOpenCodeVersion(): OpenCodeVersion | null {
  let newest: OpenCodeVersion | null = null;
  for (const name of ['opencode', 'opencode2']) {
    const command = process.platform === 'win32' ? lookupWindowsCommand(name) : name;
    if (!command) continue;
    const invocation = buildSpawnSyncInvocation(command, ['--version'], {
      env: { ...process.env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const result = spawnSync(invocation.command, invocation.args, invocation.options);
    if (result.status !== 0 || typeof result.stdout !== 'string') continue;
    const version = parseOpenCodeVersion(result.stdout);
    if (version && (!newest || compareOpenCodeVersions(version, newest) > 0)) newest = version;
  }
  return newest;
}

/** OpenCode 1 when no CLI answers: that is the config every install wrote before. */
function openCodePluginApiFor(version: OpenCodeVersion | null): OpenCodePluginApi {
  return version && version[0] >= 2 ? 2 : 1;
}

export function getOpenCodeConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  return path.join(homedir(), '.config', 'opencode');
}

export function getOpenCodePluginsDirectory(): string {
  return path.join(getOpenCodeConfigDirectory(), 'plugins');
}

export function getOpenCodeConfigPath(): string {
  return path.join(getOpenCodeConfigDirectory(), 'opencode.json');
}

export function getOpenCodeAgentsMdPath(): string {
  return path.join(getOpenCodeConfigDirectory(), 'AGENTS.md');
}

export function getInstalledPluginPath(): string {
  return path.join(getOpenCodePluginsDirectory(), 'claude-mem.js');
}

function getOpenCodeMcpEntry(config: OpenCodeConfig): Record<string, unknown> {
  return (config.mcp && typeof config.mcp === 'object')
    ? config.mcp as Record<string, unknown>
    : {};
}

const OPENCODE_DEFAULT_CONFIG: Record<string, LibraryValue> = { $schema: 'https://opencode.ai/config.json' };

function opencodeJsonStyles(): Record<string, JsonFileStyle> {
  return { [getOpenCodeConfigPath()]: { finalNewline: true, initialDocument: OPENCODE_DEFAULT_CONFIG } };
}

/** OpenCode 1's `plugin` entry for claude-mem's plugin file. */
function opencodePluginReferenceItem(): JsonArrayEntryItem {
  return {
    kind: 'setting', id: 'setting:plugin-reference', group: LIBRARY_GROUPS.settings, place: 'json-array-entry',
    file: getOpenCodeConfigPath(), arrayKeyPath: ['plugin'], entry: OPENCODE_PLUGIN_CONFIG_PATH,
    scalarIsOneEntryArray: true,
    isPreLibraryEntry: (entry) => entry === OPENCODE_PLUGIN_CONFIG_PATH,
  };
}

/**
 * claude-mem's MCP server in opencode.json: a local server that launches
 * `node <absolute mcp-server.cjs>` (OpenCode does no `${CLAUDE_PLUGIN_ROOT}`
 * substitution, Rule B in install-paths.ts). null when the server script
 * cannot be resolved, so a broken build never registers a dead server.
 */
function opencodeMcpItem(): ConfigMemberItem | null {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) return null;
  return {
    ...mcpMemberItem(getOpenCodeConfigPath(), ['mcp', OPENCODE_MCP_SERVER_KEY], encodeMcpServerEntry({ transport: 'stdio', command: getNodeAbsolutePath(), args: [mcpServerPath] }, 'opencode')),
    dropEmptiedParentOnRemove: true,
  };
}

/**
 * OpenCode 2 loads `plugins/claude-mem.js` from its plugin directory by
 * itself and drops a configured plugin path that is a file ("configured
 * plugin path must be a directory" on every start): claude-mem's entry is
 * taken out of `plugin` and `plugins` instead.
 */
function opencodePluginReferenceRemoval(): LibraryMigration {
  return {
    file: getOpenCodeConfigPath(),
    format: 'json',
    compute: (document) => {
      const edits: LibraryConfigEdit[] = [];
      for (const key of ['plugin', 'plugins']) {
        const value = (document as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const entries = Array.isArray(value) ? value : [value];
        const kept = entries.filter((entry) => entry !== OPENCODE_PLUGIN_CONFIG_PATH);
        if (kept.length !== entries.length) edits.push({ op: 'set', keyPath: [key], value: kept as LibraryValue });
      }
      return edits;
    },
  };
}

/**
 * Register the plugin and claude-mem's MCP server in opencode.json through
 * the Library. OpenCode 1 gets the `plugin` entry every install has written;
 * for OpenCode 2 it is removed (see opencodePluginReferenceRemoval).
 */
export function registerOpenCodePluginInConfig(api: OpenCodePluginApi = 1): number {
  const configPath = getOpenCodeConfigPath();
  try {
    const mcpItem = opencodeMcpItem();
    const items: LibraryItem[] = api === 2 ? [] : [opencodePluginReferenceItem()];
    if (mcpItem) items.push(mcpItem);
    applyLibraryForInstaller({
      agentId: 'opencode',
      items,
      ownedGroups: [LIBRARY_GROUPS.settings, LIBRARY_GROUPS.mcp],
      jsonStyles: opencodeJsonStyles(),
      migrations: api === 2 ? [opencodePluginReferenceRemoval()] : [],
    });

    // Warn conservatively whenever this run could not resolve its own MCP
    // server script: a retained entry cannot be trusted as claude-mem's
    // server, and a stale one must not be reported as a successful
    // registration. The partial result goes back to the caller.
    if (!mcpItem) {
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

/** Take claude-mem's plugin entries and MCP server out of opencode.json; everything else stays. */
export function deregisterOpenCodePluginFromConfig(): number {
  const configPath = getOpenCodeConfigPath();
  if (!existsSync(configPath)) {
    return 0;
  }
  try {
    const mcpItem = opencodeMcpItem();
    removeLibraryForInstaller({
      agentId: 'opencode',
      items: [opencodePluginReferenceItem(), ...(mcpItem ? [mcpItem] : [{ ...mcpMemberItem(configPath, ['mcp', OPENCODE_MCP_SERVER_KEY], {}), dropEmptiedParentOnRemove: true }])],
      groups: [LIBRARY_GROUPS.settings, LIBRARY_GROUPS.mcp],
      jsonStyles: opencodeJsonStyles(),
      migrations: [opencodePluginReferenceRemoval()],
    });
    console.log(`  Plugin deregistered from: ${configPath}`);
    logger.info('OPENCODE', 'Plugin deregistered from config', { path: configPath });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deregister OpenCode plugin from config: ${message}`);
    return 1;
  }
}

export function findBuiltPluginPath(): string | null {
  const possiblePaths = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
      'dist', 'opencode-plugin', 'index.js',
    ),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'opencode-plugin', 'index.js'),
  ];

  for (const candidatePath of possiblePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

export function installOpenCodePlugin(version: OpenCodeVersion | null = detectOpenCodeVersion()): number {
  if (version && compareOpenCodeVersions(version, OPENCODE_MIN_SUPPORTED_VERSION) < 0) {
    console.warn(
      `  OpenCode ${version.join('.')} cannot load the claude-mem plugin; it needs OpenCode ${OPENCODE_MIN_SUPPORTED_VERSION.join('.')} or later. Update OpenCode, then restart it.`,
    );
  }

  const builtPluginPath = findBuiltPluginPath();
  if (!builtPluginPath) {
    console.error('Could not find built OpenCode plugin bundle.');
    console.error('  Expected at: dist/opencode-plugin/index.js');
    console.error('  Run the build first: npm run build');
    return 1;
  }

  const destinationPath = getInstalledPluginPath();

  try {
    applyLibraryForInstaller({
      agentId: 'opencode',
      items: [opencodePluginFileItem(readFileSync(builtPluginPath))],
      ownedGroups: [LIBRARY_GROUPS.bundle],
    });

    console.log(`  Plugin installed to: ${destinationPath}`);
    logger.info('OPENCODE', 'Plugin installed', { destination: destinationPath });

    const registerResult = registerOpenCodePluginInConfig(openCodePluginApiFor(version));
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

/** The plugin bundle in OpenCode's plugin directory: claude-mem's own file (it may also be there from an install before the Library). */
function opencodePluginFileItem(contents: Uint8Array): OwnedFileItem {
  return { kind: 'bundle', id: 'bundle:plugin', group: LIBRARY_GROUPS.bundle, place: 'file', path: getInstalledPluginPath(), contents };
}

export function uninstallOpenCodePlugin(): number {
  let hasErrors = false;

  const pluginPath = getInstalledPluginPath();
  try {
    removeLibraryForInstaller({ agentId: 'opencode', items: [opencodePluginFileItem(new Uint8Array(0))], groups: [LIBRARY_GROUPS.bundle] });
    console.log(`  Removed plugin: ${pluginPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to remove plugin: ${message}`);
    hasErrors = true;
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
  try {
    const result = applyLibraryForInstaller({
      agentId: 'opencode',
      items: [],
      ownedGroups: [],
      migrations: [{
        file: agentsMdPath,
        format: 'text',
        computeText: (text) => {
          const remaining = stripLegacyContextBlock(text, CONTEXT_TAG_OPEN, CONTEXT_TAG_CLOSE, '\n');
          if (remaining === null) return null;
          return remaining.length === 0 || remaining === '# Claude-Mem Memory Context' ? { deleteFile: true } : { text: `${remaining}\n` };
        },
      }],
    });
    if (result.filesWritten.includes(agentsMdPath)) console.log(existsSync(agentsMdPath) ? `  Cleaned context from AGENTS.md` : `  Removed empty AGENTS.md`);
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
      const config = JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8')) as OpenCodeConfig;
      const mcpEntry = getOpenCodeMcpEntry(config)[OPENCODE_MCP_SERVER_KEY];
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

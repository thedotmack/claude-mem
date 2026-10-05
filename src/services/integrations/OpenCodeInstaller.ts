
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'fs';
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
  [key: string]: unknown;
};

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

function getOpenCodePluginEntries(config: OpenCodeConfig): unknown[] {
  if (Array.isArray(config.plugin)) {
    return config.plugin;
  }
  return config.plugin === undefined ? [] : [config.plugin];
}

export function addOpenCodePluginReference(config: OpenCodeConfig): OpenCodeConfig {
  const existingPlugins = getOpenCodePluginEntries(config);
  if (existingPlugins.includes(OPENCODE_PLUGIN_CONFIG_PATH)) {
    return config;
  }

  return {
    ...config,
    plugin: [...existingPlugins, OPENCODE_PLUGIN_CONFIG_PATH],
  };
}

export function removeOpenCodePluginReference(config: OpenCodeConfig): OpenCodeConfig {
  return {
    ...config,
    plugin: getOpenCodePluginEntries(config).filter(
      (plugin) => plugin !== OPENCODE_PLUGIN_CONFIG_PATH,
    ),
  };
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
export function addOpenCodeMcpReference(config: OpenCodeConfig): OpenCodeConfig {
  return addOpenCodeMcpReferenceWithStatus(config).config;
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
): { config: OpenCodeConfig; mcpServerResolved: boolean } {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) return { config, mcpServerResolved: false };

  const command = [getNodeAbsolutePath(), mcpServerPath];
  const existingMcp = getOpenCodeMcpEntry(config);
  const current = existingMcp[OPENCODE_MCP_SERVER_KEY];
  if (
    current
    && typeof current === 'object'
    && (current as { type?: unknown }).type === 'local'
    && Array.isArray((current as { command?: unknown }).command)
    && JSON.stringify((current as { command: unknown[] }).command) === JSON.stringify(command)
  ) {
    return { config, mcpServerResolved: true };
  }

  return {
    config: {
      ...config,
      mcp: {
        ...existingMcp,
        [OPENCODE_MCP_SERVER_KEY]: { type: 'local', command },
      },
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
  if (!(OPENCODE_MCP_SERVER_KEY in existingMcp)) {
    return config;
  }

  const { [OPENCODE_MCP_SERVER_KEY]: _removed, ...remainingMcp } = existingMcp;
  const next: OpenCodeConfig = { ...config, mcp: remainingMcp };
  if (Object.keys(remainingMcp).length === 0) {
    delete next.mcp;
  }
  return next;
}

export function registerOpenCodePluginInConfig(): number {
  const configPath = getOpenCodeConfigPath();
  const defaultConfig: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
  };

  try {
    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, 'utf-8')) as OpenCodeConfig
      : defaultConfig;
    const withPlugin = addOpenCodePluginReference(config);
    const { config: updatedConfig, mcpServerResolved } = addOpenCodeMcpReferenceWithStatus(withPlugin);

    writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');

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
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as OpenCodeConfig;
    const updatedConfig = removeOpenCodeMcpReference(removeOpenCodePluginReference(config));

    writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');
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

export function installOpenCodePlugin(): number {
  const builtPluginPath = findBuiltPluginPath();
  if (!builtPluginPath) {
    console.error('Could not find built OpenCode plugin bundle.');
    console.error('  Expected at: dist/opencode-plugin/index.js');
    console.error('  Run the build first: npm run build');
    return 1;
  }

  const pluginsDirectory = getOpenCodePluginsDirectory();
  const destinationPath = getInstalledPluginPath();

  try {
    mkdirSync(pluginsDirectory, { recursive: true });

    copyFileSync(builtPluginPath, destinationPath);

    console.log(`  Plugin installed to: ${destinationPath}`);
    logger.info('OPENCODE', 'Plugin installed', { destination: destinationPath });

    const registerResult = registerOpenCodePluginInConfig();
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

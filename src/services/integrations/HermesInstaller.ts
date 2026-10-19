import path from 'path';
import { homedir } from 'os';
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'fs';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';
import { replaceOwnedFiles } from '../../shared/owned-file-install.js';
import { getMcpServerAbsolutePath, getNodeAbsolutePath } from './install-paths.js';
import {
  HermesConfigShapeError,
  hasMcpServer,
  matchesMcpReceipt,
  putMcpServer,
  readMemoryProvider,
  removeMcpServer,
  restoreMemoryProvider,
  selectMemoryProvider,
  type McpReceipt,
  type ProviderReceipt,
} from './hermes-config-yaml.js';

/**
 * Hermes Agent (Nous Research) installer.
 *
 * Hermes finds memory providers in `$HERMES_HOME/plugins/<name>/` (a folder
 * whose `__init__.py` registers a MemoryProvider) and runs the one named by
 * `memory.provider` in `$HERMES_HOME/config.yaml`; MCP servers are listed
 * under `mcp_servers`. This installer:
 *
 *  - copies the provider (hermes/claude-mem/) to `$HERMES_HOME/plugins/claude-mem/`,
 *  - sets `memory.provider: claude-mem`,
 *  - adds `mcp_servers.claude-mem` (claude-mem's search tools) unless an entry of
 *    that name is already there and is not ours.
 *
 * A receipt in the plugin folder records what config.yaml held before, so
 * uninstall puts back exactly that and removes only what install added.
 */

export const HERMES_PLUGIN_NAME = 'claude-mem';
const OWNED_FILES = ['__init__.py', 'client.py', 'plugin.yaml', 'README.md'];
const RECEIPT_FILE = '.claude-mem-install.json';

interface HermesReceipt {
  version: 1;
  /** Present when install selected the provider. */
  provider?: ProviderReceipt;
  /** Present when install added (and so owns) mcp_servers.claude-mem. */
  mcp?: McpReceipt;
  /** Install wrote config.yaml where Hermes had none. */
  createdConfig?: boolean;
}

export function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'hermes');
  }
  return path.join(homedir(), '.hermes');
}

export function hermesPluginDirectory(): string {
  return path.join(hermesHome(), 'plugins', HERMES_PLUGIN_NAME);
}

function hermesConfigPath(): string {
  return path.join(hermesHome(), 'config.yaml');
}

/** The shipped provider. Only the marketplace copy is trusted by default; a
 *  checkout is used only behind the explicit dev opt-in, never process.cwd()
 *  alone (an untrusted repository would become a persistent Hermes plugin). */
export function findHermesPluginSource(): string | null {
  const roots = [MARKETPLACE_ROOT];
  if (process.env.CLAUDE_MEM_DEV_HOOK_SOURCE === '1') roots.push(process.cwd());
  for (const root of roots) {
    const candidate = path.join(root, 'hermes', HERMES_PLUGIN_NAME);
    if (OWNED_FILES.every(name => existsSync(path.join(candidate, name)))) return candidate;
  }
  return null;
}

function readReceipt(): HermesReceipt | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(hermesPluginDirectory(), RECEIPT_FILE), 'utf-8'));
    return parsed && parsed.version === 1 ? parsed as HermesReceipt : null;
  } catch {
    return null;
  }
}

function readConfig(): string {
  return existsSync(hermesConfigPath()) ? readFileSync(hermesConfigPath(), 'utf-8') : '';
}

function writeConfig(text: string): void {
  const target = hermesConfigPath();
  // config.yaml can hold credentials: the replacement keeps the file's own
  // permissions, and is never readable by others while it is being written.
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const staging = `${target}.claude-mem-${process.pid}.tmp`;
  writeFileSync(staging, text, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(staging, mode);
  renameSync(staging, target);
}

function mcpEntry(mcpServerPath: string) {
  // Hermes starts MCP servers with a filtered environment, so a data dir
  // chosen through the environment is passed on explicitly.
  const env = process.env.CLAUDE_MEM_DATA_DIR ? { CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR } : undefined;
  return { command: getNodeAbsolutePath(), args: [mcpServerPath], ...(env ? { env } : {}) };
}

export function installHermesIntegration(): number {
  const source = findHermesPluginSource();
  if (!source) {
    console.error('Could not find the Hermes plugin shipped with claude-mem.');
    console.error('  Expected at: <marketplace>/hermes/claude-mem/');
    console.error('  Re-run `npx claude-mem install` to populate the marketplace,');
    console.error('  or set CLAUDE_MEM_DEV_HOOK_SOURCE=1 to resolve from the cwd (dev only).');
    return 1;
  }
  const mcpServerPath = getMcpServerAbsolutePath();

  try {
    // Work out every config change before anything is written, so a config
    // this installer cannot edit leaves the user's Hermes exactly as it was.
    const previous = readReceipt();
    const configExisted = existsSync(hermesConfigPath());
    const original = readConfig();
    let text = original;
    const receipt: HermesReceipt = { version: 1 };
    if (previous?.createdConfig || !configExisted) receipt.createdConfig = true;

    const current = readMemoryProvider(text);
    if (current === HERMES_PLUGIN_NAME && previous?.provider) {
      receipt.provider = previous.provider;
    } else if (current !== HERMES_PLUGIN_NAME) {
      const selected = selectMemoryProvider(text, HERMES_PLUGIN_NAME);
      text = selected.text;
      receipt.provider = selected.receipt;
      if (current) console.log(`  Hermes memory provider was "${current}"; uninstall puts it back.`);
    }

    if (mcpServerPath) {
      const ours = previous?.mcp && matchesMcpReceipt(text, HERMES_PLUGIN_NAME, previous.mcp);
      if (!hasMcpServer(text, HERMES_PLUGIN_NAME) || ours) {
        const added = putMcpServer(text, HERMES_PLUGIN_NAME, mcpEntry(mcpServerPath));
        text = added.text;
        receipt.mcp = { ...added.receipt, mcpHeader: ours ? previous!.mcp!.mcpHeader : added.receipt.mcpHeader };
      } else {
        console.log('  mcp_servers.claude-mem already exists in config.yaml; left as it is.');
      }
    } else {
      console.log('  claude-mem MCP server not found; Hermes gets memory but not the search tools.');
    }

    const files = OWNED_FILES.map(name => ({ name, contents: readFileSync(path.join(source, name)) }));
    replaceOwnedFiles(hermesPluginDirectory(), files);
    writeFileSync(path.join(hermesPluginDirectory(), RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n', 'utf-8');
    if (text !== original) writeConfig(text);

    console.log(`  Hermes plugin installed to: ${hermesPluginDirectory()}`);
    console.log(`  Hermes config updated: ${hermesConfigPath()} (memory.provider: claude-mem${receipt.mcp ? ', mcp_servers.claude-mem' : ''})`);
    console.log('  Start a new Hermes session to load it.');
    return 0;
  } catch (error) {
    if (error instanceof HermesConfigShapeError) {
      console.error(`Hermes config.yaml was not changed: ${error.message}.`);
      console.error('  Set it by hand:  memory: { provider: claude-mem }  and re-run the installer.');
      return 1;
    }
    console.error(`Failed to install the Hermes plugin: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function uninstallHermesIntegration(): number {
  const directory = hermesPluginDirectory();
  const receipt = readReceipt();
  if (!receipt && !OWNED_FILES.some(name => existsSync(path.join(directory, name)))) {
    console.log('  Hermes plugin not installed; nothing to remove.');
    return 0;
  }
  try {
    if (receipt && existsSync(hermesConfigPath())) {
      const original = readConfig();
      let text = original;
      if (receipt.provider) text = restoreMemoryProvider(text, HERMES_PLUGIN_NAME, receipt.provider);
      if (receipt.mcp) text = removeMcpServer(text, HERMES_PLUGIN_NAME, receipt.mcp);
      if (receipt.createdConfig && text.trim() === '') rmSync(hermesConfigPath(), { force: true });
      else if (text !== original) writeConfig(text);
    }
    for (const name of [...OWNED_FILES, RECEIPT_FILE]) rmSync(path.join(directory, name), { force: true });
    // Python leaves compiled copies of the provider beside it.
    const cache = path.join(directory, '__pycache__');
    if (existsSync(cache)) {
      for (const name of readdirSync(cache)) {
        if (/^(__init__|client)\..+\.pyc$/.test(name)) rmSync(path.join(cache, name), { force: true });
      }
      if (readdirSync(cache).length === 0) rmdirSync(cache);
    }
    if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
    console.log(`  Removed Hermes plugin: ${directory}`);
    return 0;
  } catch (error) {
    if (error instanceof HermesConfigShapeError) {
      console.error(`Hermes config.yaml was not changed: ${error.message}. Remove memory.provider: claude-mem by hand.`);
      return 1;
    }
    console.error(`Failed to remove the Hermes plugin: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

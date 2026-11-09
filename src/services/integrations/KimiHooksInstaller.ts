/**
 * KimiHooksInstaller.ts — first-class Kimi Code CLI harness integration.
 *
 * Kimi hooks live in `[[hooks]]` tables inside $KIMI_CODE_HOME/config.toml,
 * in a marker-delimited block claude-mem manages; the MCP server is
 * registered in $KIMI_CODE_HOME/mcp.json. Both are written by the Library
 * engine (wire-gateway/library), which records what it wrote, backs the file
 * up first and checks the TOML still parses. Absolute paths are baked per
 * Rule B (install-paths.ts): Kimi performs no variable substitution on hook
 * commands.
 */
import { existsSync, readFileSync } from 'fs';
import { kimiConfigPath, kimiMcpJsonPath } from '../../shared/kimi-paths.js';
import {
  KIMI_MARKER_BEGIN,
  KIMI_MARKER_END,
  LIBRARY_GROUPS,
  kimiHooksItem,
  kimiMcpItem,
  libraryRemovalEnvironment,
} from '../wire-gateway/library/agent-library-targets.js';
import {
  applyLibraryForInstaller,
  currentLibraryInstallEnvironment,
  removeLibraryForInstaller,
} from '../wire-gateway/library/library-runtime.js';
import type { LibraryItem } from '../wire-gateway/library/types.js';

export { KIMI_MARKER_BEGIN, KIMI_MARKER_END };

/** Kimi's hooks block and MCP server as a remove looks for them (libraryRemovalEnvironment: no plugin folder needed). */
function kimiRemovalItems(): { items: LibraryItem[] } {
  const environment = libraryRemovalEnvironment(currentLibraryInstallEnvironment());
  const items: LibraryItem[] = [];
  if (environment.workerServicePath) items.push(kimiHooksItem(kimiConfigPath(), environment.bunPath, environment.workerServicePath));
  if (environment.mcpServerPath) items.push(kimiMcpItem(kimiMcpJsonPath(), environment.nodePath, environment.mcpServerPath));
  return { items };
}

export function installKimiHooks(): number {
  const environment = currentLibraryInstallEnvironment();
  if (!environment.workerServicePath) {
    console.error('Could not find worker-service.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const configPath = kimiConfigPath();
  try {
    applyLibraryForInstaller({
      agentId: 'kimi',
      items: [kimiHooksItem(configPath, environment.bunPath, environment.workerServicePath)],
      ownedGroups: [LIBRARY_GROUPS.hooks],
    });
    console.log(`  Installed Kimi hooks into ${configPath}`);
    console.log(`    Bun runtime: ${environment.bunPath}`);
    console.log(`    Worker: ${environment.workerServicePath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to install Kimi hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function configureKimiMcp(): number {
  const environment = currentLibraryInstallEnvironment();
  if (!environment.mcpServerPath) {
    console.error('Could not find mcp-server.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const mcpPath = kimiMcpJsonPath();
  try {
    const result = applyLibraryForInstaller({
      agentId: 'kimi',
      items: [kimiMcpItem(mcpPath, environment.nodePath, environment.mcpServerPath)],
      ownedGroups: [LIBRARY_GROUPS.mcp],
    });
    if (result.items[0]?.outcome === 'left-to-user') {
      console.log('  MCP server mcp-search already configured in mcp.json');
      return 0;
    }
    console.log(`  Configured MCP server in ${mcpPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to configure Kimi MCP: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Remove the hooks block and the `mcp-search` server claude-mem wrote: the
 * recorded ones, or (from an install before the Library) the block between
 * claude-mem's markers and an `mcp-search` that runs claude-mem's server.
 */
export function uninstallKimiHooks(): number {
  try {
    removeLibraryForInstaller({ agentId: 'kimi', items: kimiRemovalItems().items });
    console.log('  Removed claude-mem hooks and MCP server from Kimi Code');
    return 0;
  } catch (error) {
    console.error(`Failed to uninstall Kimi hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function checkKimiHooksStatus(): number {
  const configPath = kimiConfigPath();
  const installed = existsSync(configPath) && readFileSync(configPath, 'utf-8').includes(KIMI_MARKER_BEGIN);
  if (installed) {
    console.log(`  Kimi hooks: installed (${configPath})`);
    return 0;
  }
  console.log('  Kimi hooks: not installed');
  return 1;
}

export async function handleKimiCommand(subcommand: string | undefined, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const hooks = installKimiHooks();
      const mcp = configureKimiMcp();
      return hooks === 0 && mcp === 0 ? 0 : 1;
    }
    case 'uninstall':
      return uninstallKimiHooks();
    case 'status':
      return checkKimiHooksStatus();
    default:
      console.log('Usage: claude-mem kimi <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}

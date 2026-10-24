
import path from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { toBmpSafe } from '../../utils/bmp-safe.js';
import { getMcpServerAbsolutePath, getNodeAbsolutePath } from './install-paths.js';
import {
  LIBRARY_GROUPS,
  PLACEHOLDER_CONTEXT,
  contextBlockItem,
  mcpMemberItem,
  nodeMcpServerEntry,
} from '../wire-gateway/library/agent-library-targets.js';
import { encodeMcpServerEntry } from '../wire-gateway/library/mcp-servers.js';
import {
  applyLibraryForInstaller,
  currentLibraryInstallEnvironment,
  removeLibraryForInstaller,
  withoutInstructionsWhenWireInjects,
} from '../wire-gateway/library/library-runtime.js';
import type { ConfigMemberItem, LibraryItem } from '../wire-gateway/library/types.js';

interface McpInstallerConfig {
  ideId: string;
  ideLabel: string;
  configPath: string;
  configKey: 'servers' | 'mcpServers';
  contextPath?: string;
}

function installMcpIntegration(config: McpInstallerConfig): () => Promise<number> {
  return async (): Promise<number> => {
    console.log(`\nInstalling Claude-Mem MCP integration for ${config.ideLabel}...\n`);

    const mcpServerPath = getMcpServerAbsolutePath();
    if (!mcpServerPath) {
      console.error('Could not find MCP server script');
      console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
      return 1;
    }

    const configPath = config.configPath;

    const skipWarpConfigWrite = config.ideId === 'warp' && !existsSync(path.dirname(configPath));

    const contextPath = config.contextPath;

    try {
      writeMcpConfigAndContext(config, configPath, mcpServerPath, skipWarpConfigWrite, contextPath);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nInstallation failed: ${message}`);
      return 1;
    }
  };
}

function writeMcpConfigAndContext(
  config: McpInstallerConfig,
  configPath: string,
  mcpServerPath: string,
  skipWarpConfigWrite: boolean,
  contextPath: string | undefined,
): void {
  const environment = { ...currentLibraryInstallEnvironment(), mcpServerPath };
  const items: LibraryItem[] = [];
  if (!skipWarpConfigWrite) items.push(mcpMemberItem(configPath, [config.configKey, 'claude-mem'], nodeMcpServerEntry(environment)));
  // #2787: astral (surrogate-pair) code points are stripped so a context truncation can't split one.
  if (contextPath) items.push(contextBlockItem(contextPath, toBmpSafe(PLACEHOLDER_CONTEXT), 'after-trimmed-text'));
  applyLibraryForInstaller({
    agentId: config.ideId,
    items: withoutInstructionsWhenWireInjects(config.ideId, items),
    ownedGroups: [LIBRARY_GROUPS.mcp, LIBRARY_GROUPS.instructions],
  });

  if (skipWarpConfigWrite) {
    console.log(`  Note: ~/.warp/ not found. MCP may need to be configured via Warp Drive UI.`);
  } else {
    console.log(`  MCP config written to: ${configPath}`);
  }
  if (contextPath) {
    console.log(`  Context placeholder written to: ${contextPath}`);
  }

  const summaryLines = [`\nInstallation complete!\n`];
  summaryLines.push(`MCP config:  ${configPath}`);
  if (contextPath) {
    summaryLines.push(`Context:     ${contextPath}`);
  }
  summaryLines.push('');
  summaryLines.push(`Note: This is an MCP-only integration providing search tools and context.`);
  summaryLines.push(`Transcript capture is not available for ${config.ideLabel}.`);
  if (config.ideId === 'warp') {
    summaryLines.push('If MCP config via file is not supported, configure MCP through Warp Drive UI.');
  }
  summaryLines.push('');
  summaryLines.push('Next steps:');
  summaryLines.push('  1. Start claude-mem worker: npx claude-mem start');
  summaryLines.push(`  2. Restart ${config.ideLabel} to pick up the MCP server`);
  summaryLines.push('');
  console.log(summaryLines.join('\n'));
}

const COPILOT_CLI_CONFIG: McpInstallerConfig = {
  ideId: 'copilot-cli',
  ideLabel: 'Copilot CLI',
  configPath: path.join(homedir(), '.github', 'copilot', 'mcp.json'),
  configKey: 'servers',
  contextPath: path.join(process.cwd(), '.github', 'copilot-instructions.md'),
};

const ROO_CODE_CONFIG: McpInstallerConfig = {
  ideId: 'roo-code',
  ideLabel: 'Roo Code',
  configPath: path.join(process.cwd(), '.roo', 'mcp.json'),
  configKey: 'mcpServers',
  contextPath: path.join(process.cwd(), '.roo', 'rules', 'claude-mem-context.md'),
};

const WARP_CONFIG: McpInstallerConfig = {
  ideId: 'warp',
  ideLabel: 'Warp',
  configPath: path.join(homedir(), '.warp', '.mcp.json'),
  configKey: 'mcpServers',
  contextPath: path.join(process.cwd(), 'WARP.md'),
};

function getGooseConfigPath(): string {
  return path.join(homedir(), '.config', 'goose', 'config.yaml');
}

/** claude-mem in Goose's top-level `extensions` mapping, the only place Goose starts MCP servers from (it never reads `mcpServers` in config.yaml). */
function gooseExtensionItem(mcpServerPath: string, configPath: string = getGooseConfigPath()): ConfigMemberItem {
  const entry = encodeMcpServerEntry({ transport: 'stdio', command: getNodeAbsolutePath(), args: [mcpServerPath] }, 'goose');
  return mcpMemberItem(configPath, ['extensions', 'claude-mem'], entry, LIBRARY_GROUPS.mcp, 'yaml');
}

export async function installGooseMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Goose...\n');

  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  const configPath = getGooseConfigPath();

  try {
    mergeGooseYamlConfig(configPath, mcpServerPath);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

/** Remove claude-mem from Goose's extensions so Goose stops launching a deleted MCP server. Returns 0 when an entry was removed. */
export function uninstallGooseMcpIntegration(configPath: string = getGooseConfigPath()): number {
  if (!existsSync(configPath)) return 1;
  const result = removeLibraryForInstaller({ agentId: 'goose', items: [gooseExtensionItem(getMcpServerAbsolutePath() ?? '', configPath)] });
  if (!result.items.some((item) => item.outcome === 'removed' || item.outcome === 'restored')) return 1;
  console.log(`  Removed claude-mem from the Goose extensions of: ${configPath}`);
  return 0;
}

/** Register claude-mem in Goose's config.yaml with the Phase 7 YAML editor: every other line stays as written. */
export function mergeGooseYamlConfig(configPath: string, mcpServerPath: string): void {
  applyLibraryForInstaller({ agentId: 'goose', items: [gooseExtensionItem(mcpServerPath, configPath)], ownedGroups: [LIBRARY_GROUPS.mcp] });
  console.log(`  Registered claude-mem in the Goose extensions of: ${configPath}`);

  console.log(`
Installation complete!

MCP config:  ${configPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Goose.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Goose to pick up the MCP server
`);
}

// NOTE: 'antigravity' is intentionally absent here. It graduated from an
// MCP-only integration to a full hooks+MCP installer — see
// AntigravityCliHooksInstaller.ts, which owns Antigravity's install/uninstall
// end-to-end. Leaving an entry here too would create two competing install
// paths for the same IDE.
export const MCP_IDE_INSTALLERS: Record<string, () => Promise<number>> = {
  'copilot-cli': installMcpIntegration(COPILOT_CLI_CONFIG),
  'goose': installGooseMcpIntegration,
  'roo-code': installMcpIntegration(ROO_CODE_CONFIG),
  'warp': installMcpIntegration(WARP_CONFIG),
};

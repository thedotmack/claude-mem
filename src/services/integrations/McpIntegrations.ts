
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getMcpServerAbsolutePath, getNodeAbsolutePath } from './install-paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { stripUtf8Bom } from '../../shared/atomic-json.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';

export const PLACEHOLDER_CONTEXT = `# claude-mem: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.`;

export function buildMcpServerEntry(mcpServerPath: string): { command: string; args: string[] } {
  return {
    command: getNodeAbsolutePath(),
    args: [mcpServerPath],
  };
}

export function writeMcpJsonConfig(
  configFilePath: string,
  mcpServerPath: string,
  serversKeyName: string = 'mcpServers',
): void {
  const parentDirectory = path.dirname(configFilePath);
  mkdirSync(parentDirectory, { recursive: true });

  const existingConfig = readJsonSafe<Record<string, any>>(configFilePath, {});

  if (!existingConfig[serversKeyName]) {
    existingConfig[serversKeyName] = {};
  }

  existingConfig[serversKeyName]['claude-mem'] = buildMcpServerEntry(mcpServerPath);

  writeFileSync(configFilePath, JSON.stringify(existingConfig, null, 2) + '\n');
}

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
  if (skipWarpConfigWrite) {
    console.log(`  Note: ~/.warp/ not found. MCP may need to be configured via Warp Drive UI.`);
  } else {
    writeMcpJsonConfig(configPath, mcpServerPath, config.configKey);
    console.log(`  MCP config written to: ${configPath}`);
  }

  if (contextPath) {
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
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
  configPath: path.join(homedir(), '.warp', 'mcp.json'),
  configKey: 'mcpServers',
  contextPath: path.join(process.cwd(), 'WARP.md'),
};

function getGooseConfigPath(): string {
  return path.join(homedir(), '.config', 'goose', 'config.yaml');
}

function buildGooseClaudeMemExtensionLines(mcpServerPath: string, indent: string): string[] {
  return [
    `${indent}claude-mem:`,
    `${indent}  enabled: true`,
    `${indent}  type: stdio`,
    `${indent}  name: claude-mem`,
    `${indent}  cmd: ${getNodeAbsolutePath()}`,
    `${indent}  args:`,
    `${indent}    - ${mcpServerPath}`,
    `${indent}  timeout: 300`,
  ];
}

function leadingSpaceCount(line: string): number {
  return line.length - line.trimStart().length;
}

function isYamlContentLine(line: string): boolean {
  return line.trim() !== '' && !line.trimStart().startsWith('#');
}

/**
 * `content` with claude-mem set in the top-level `extensions` mapping, the
 * only place Goose starts MCP servers from: it never reads a `mcpServers` key
 * in config.yaml. Every other line stays as written, including the
 * `mcpServers` block that earlier installs left behind.
 */
function upsertGooseExtension(content: string, mcpServerPath: string): string {
  const lines = content.split('\n');
  const header = lines.findIndex(line => line.startsWith('extensions:'));
  if (header === -1) {
    const existingLines = content.trimEnd() ? [content.trimEnd()] : [];
    return [...existingLines, 'extensions:', ...buildGooseClaudeMemExtensionLines(mcpServerPath, '  ')].join('\n') + '\n';
  }
  if (isYamlContentLine(lines[header].slice('extensions:'.length))) {
    throw new Error('Goose config.yaml sets extensions inline; write it as a block mapping and install again');
  }

  // The mapping runs to the next top-level key; entries keep the indent of those already there.
  let end = header + 1;
  while (end < lines.length && !(isYamlContentLine(lines[end]) && leadingSpaceCount(lines[end]) === 0)) end++;
  const firstEntry = lines.slice(header + 1, end).find(isYamlContentLine);
  const indent = ' '.repeat(firstEntry ? leadingSpaceCount(firstEntry) : 2);
  const extension = buildGooseClaudeMemExtensionLines(mcpServerPath, indent);

  const existing = lines.findIndex((line, index) => index > header && index < end && line.trimEnd() === `${indent}claude-mem:`);
  if (existing === -1) {
    return [...lines.slice(0, header + 1), ...extension, ...lines.slice(header + 1)].join('\n');
  }
  let existingEnd = existing + 1;
  while (existingEnd < end && isYamlContentLine(lines[existingEnd]) && leadingSpaceCount(lines[existingEnd]) > indent.length) {
    existingEnd++;
  }
  return [...lines.slice(0, existing), ...extension, ...lines.slice(existingEnd)].join('\n');
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
  const configDirectory = path.dirname(configPath);

  try {
    mkdirSync(configDirectory, { recursive: true });
    mergeGooseYamlConfig(configPath, mcpServerPath);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function mergeGooseYamlConfig(configPath: string, mcpServerPath: string): void {
  const yamlContent = existsSync(configPath) ? stripUtf8Bom(readFileSync(configPath, 'utf-8')) : '';
  writeFileSync(configPath, upsertGooseExtension(yamlContent, mcpServerPath));
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
// end-to-end (reusing writeMcpJsonConfig/buildMcpServerEntry from this file
// for its MCP half). Leaving an entry here too would create two competing
// install paths for the same IDE.
export const MCP_IDE_INSTALLERS: Record<string, () => Promise<number>> = {
  'copilot-cli': installMcpIntegration(COPILOT_CLI_CONFIG),
  'goose': installGooseMcpIntegration,
  'roo-code': installMcpIntegration(ROO_CODE_CONFIG),
  'warp': installMcpIntegration(WARP_CONFIG),
};

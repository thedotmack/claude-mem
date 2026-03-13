/**
 * McpIntegrations - MCP-based IDE integrations for claude-mem
 *
 * Handles MCP config writing and context injection for IDEs that support
 * the Model Context Protocol. These are "MCP-only" integrations: they provide
 * search tools and context injection but do NOT capture transcripts.
 *
 * Supported IDEs:
 *   - Copilot CLI
 *   - Antigravity (Gemini)
 *   - Goose
 *   - Crush
 *   - Roo Code
 *   - Warp
 *
 * All IDEs point to the same MCP server: plugin/scripts/mcp-server.cjs
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findMcpServerPath } from './CursorHooksInstaller.js';

// ============================================================================
// Shared Constants
// ============================================================================

const CONTEXT_TAG_OPEN = '<claude-mem-context>';
const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

const PLACEHOLDER_CONTEXT = `# claude-mem: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.`;

// ============================================================================
// Shared Utilities
// ============================================================================

/**
 * Build the standard MCP server entry that all IDEs use.
 * Points to the same mcp-server.cjs script.
 */
function buildMcpServerEntry(mcpServerPath: string): { command: string; args: string[] } {
  return {
    command: 'node',
    args: [mcpServerPath],
  };
}

/**
 * Read a JSON file safely, returning a default value if it doesn't exist or is corrupt.
 */
function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger.error('MCP', `Corrupt JSON file, using default`, { path: filePath }, error as Error);
    return defaultValue;
  }
}

/**
 * Inject or update a <claude-mem-context> section in a markdown file.
 * Creates the file if it doesn't exist. Preserves content outside the tags.
 */
function injectContextIntoMarkdownFile(filePath: string, contextContent: string): void {
  const parentDirectory = path.dirname(filePath);
  mkdirSync(parentDirectory, { recursive: true });

  const wrappedContent = `${CONTEXT_TAG_OPEN}\n${contextContent}\n${CONTEXT_TAG_CLOSE}`;

  if (existsSync(filePath)) {
    let existingContent = readFileSync(filePath, 'utf-8');

    const tagStartIndex = existingContent.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = existingContent.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      // Replace existing section
      existingContent =
        existingContent.slice(0, tagStartIndex) +
        wrappedContent +
        existingContent.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length);
    } else {
      // Append section
      existingContent = existingContent.trimEnd() + '\n\n' + wrappedContent + '\n';
    }

    writeFileSync(filePath, existingContent, 'utf-8');
  } else {
    writeFileSync(filePath, wrappedContent + '\n', 'utf-8');
  }
}

/**
 * Write a standard MCP JSON config file, merging with existing config.
 * Supports both { "mcpServers": { ... } } and { "servers": { ... } } formats.
 */
function writeMcpJsonConfig(
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

// ============================================================================
// Copilot CLI
// ============================================================================

/**
 * Get the Copilot CLI MCP config path.
 * Copilot CLI uses ~/.github/copilot/mcp.json for user-level MCP config.
 */
function getCopilotCliMcpConfigPath(): string {
  return path.join(homedir(), '.github', 'copilot', 'mcp.json');
}

/**
 * Get the Copilot CLI context injection path for the current workspace.
 * Copilot reads instructions from .github/copilot-instructions.md in the workspace.
 */
function getCopilotCliContextPath(): string {
  return path.join(process.cwd(), '.github', 'copilot-instructions.md');
}

/**
 * Install claude-mem MCP integration for Copilot CLI.
 *
 * - Writes MCP config to ~/.github/copilot/mcp.json
 * - Injects context into .github/copilot-instructions.md in the workspace
 *
 * @returns 0 on success, 1 on failure
 */
export async function installCopilotCliMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Copilot CLI...\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  try {
    // Write MCP config — Copilot CLI uses { "servers": { ... } } format
    const configPath = getCopilotCliMcpConfigPath();
    writeMcpJsonConfig(configPath, mcpServerPath, 'servers');
    console.log(`  MCP config written to: ${configPath}`);

    // Inject context into workspace instructions
    const contextPath = getCopilotCliContextPath();
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
    console.log(`  Context placeholder written to: ${contextPath}`);

    console.log(`
Installation complete!

MCP config:  ${configPath}
Context:     ${contextPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Copilot CLI.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Copilot CLI to pick up the MCP server
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Antigravity
// ============================================================================

/**
 * Get the Antigravity MCP config path.
 * Antigravity stores MCP config at ~/.gemini/antigravity/mcp_config.json.
 */
function getAntigravityMcpConfigPath(): string {
  return path.join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
}

/**
 * Get the Antigravity context injection path for the current workspace.
 * Antigravity reads agent rules from .agent/rules/ in the workspace.
 */
function getAntigravityContextPath(): string {
  return path.join(process.cwd(), '.agent', 'rules', 'claude-mem-context.md');
}

/**
 * Install claude-mem MCP integration for Antigravity.
 *
 * - Writes MCP config to ~/.gemini/antigravity/mcp_config.json
 * - Injects context into .agent/rules/claude-mem-context.md in the workspace
 *
 * @returns 0 on success, 1 on failure
 */
export async function installAntigravityMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Antigravity...\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  try {
    // Write MCP config
    const configPath = getAntigravityMcpConfigPath();
    writeMcpJsonConfig(configPath, mcpServerPath);
    console.log(`  MCP config written to: ${configPath}`);

    // Inject context into workspace rules
    const contextPath = getAntigravityContextPath();
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
    console.log(`  Context placeholder written to: ${contextPath}`);

    console.log(`
Installation complete!

MCP config:  ${configPath}
Context:     ${contextPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Antigravity.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Antigravity to pick up the MCP server
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Goose
// ============================================================================

/**
 * Get the Goose config path.
 * Goose stores its config at ~/.config/goose/config.yaml.
 */
function getGooseConfigPath(): string {
  return path.join(homedir(), '.config', 'goose', 'config.yaml');
}

/**
 * Check if a YAML string already has a claude-mem entry under mcpServers.
 * Uses string matching to avoid needing a YAML parser.
 */
function gooseConfigHasClaudeMemEntry(yamlContent: string): boolean {
  // Look for "claude-mem:" indented under mcpServers
  return yamlContent.includes('claude-mem:') &&
    yamlContent.includes('mcpServers:');
}

/**
 * Build the Goose YAML MCP server block as a string.
 * Produces properly indented YAML without needing a parser.
 */
function buildGooseMcpYamlBlock(mcpServerPath: string): string {
  // Goose expects the mcpServers section at the top level
  return [
    'mcpServers:',
    '  claude-mem:',
    '    command: node',
    '    args:',
    `      - ${mcpServerPath}`,
  ].join('\n');
}

/**
 * Build just the claude-mem server entry (for appending under existing mcpServers).
 */
function buildGooseClaudeMemEntryYaml(mcpServerPath: string): string {
  return [
    '  claude-mem:',
    '    command: node',
    '    args:',
    `      - ${mcpServerPath}`,
  ].join('\n');
}

/**
 * Install claude-mem MCP integration for Goose.
 *
 * - Writes/merges MCP config into ~/.config/goose/config.yaml
 * - Uses string manipulation for YAML (no parser dependency)
 *
 * @returns 0 on success, 1 on failure
 */
export async function installGooseMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Goose...\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  try {
    const configPath = getGooseConfigPath();
    const configDirectory = path.dirname(configPath);
    mkdirSync(configDirectory, { recursive: true });

    if (existsSync(configPath)) {
      let yamlContent = readFileSync(configPath, 'utf-8');

      if (gooseConfigHasClaudeMemEntry(yamlContent)) {
        // Already configured — replace the claude-mem block
        // Find the claude-mem entry and replace it
        const claudeMemPattern = /( {2}claude-mem:\n(?:.*\n)*?(?= {2}\S|\n\n|$))/;
        const newEntry = buildGooseClaudeMemEntryYaml(mcpServerPath) + '\n';

        if (claudeMemPattern.test(yamlContent)) {
          yamlContent = yamlContent.replace(claudeMemPattern, newEntry);
        }
        writeFileSync(configPath, yamlContent);
        console.log(`  Updated existing claude-mem entry in: ${configPath}`);
      } else if (yamlContent.includes('mcpServers:')) {
        // mcpServers section exists but no claude-mem entry — append under it
        const mcpServersIndex = yamlContent.indexOf('mcpServers:');
        const insertionPoint = mcpServersIndex + 'mcpServers:'.length;
        const newEntry = '\n' + buildGooseClaudeMemEntryYaml(mcpServerPath);

        yamlContent =
          yamlContent.slice(0, insertionPoint) +
          newEntry +
          yamlContent.slice(insertionPoint);

        writeFileSync(configPath, yamlContent);
        console.log(`  Added claude-mem to existing mcpServers in: ${configPath}`);
      } else {
        // No mcpServers section — append the entire block
        const mcpBlock = '\n' + buildGooseMcpYamlBlock(mcpServerPath) + '\n';
        yamlContent = yamlContent.trimEnd() + '\n' + mcpBlock;
        writeFileSync(configPath, yamlContent);
        console.log(`  Appended mcpServers section to: ${configPath}`);
      }
    } else {
      // File doesn't exist — create from template
      const templateContent = buildGooseMcpYamlBlock(mcpServerPath) + '\n';
      writeFileSync(configPath, templateContent);
      console.log(`  Created config with MCP server: ${configPath}`);
    }

    console.log(`
Installation complete!

MCP config:  ${configPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Goose.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Goose to pick up the MCP server
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Crush
// ============================================================================

/**
 * Get the Crush MCP config path.
 * Crush stores MCP config at ~/.config/crush/mcp.json.
 */
function getCrushMcpConfigPath(): string {
  return path.join(homedir(), '.config', 'crush', 'mcp.json');
}

/**
 * Install claude-mem MCP integration for Crush.
 *
 * - Writes MCP config to ~/.config/crush/mcp.json
 *
 * @returns 0 on success, 1 on failure
 */
export async function installCrushMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Crush...\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  try {
    // Write MCP config
    const configPath = getCrushMcpConfigPath();
    writeMcpJsonConfig(configPath, mcpServerPath);
    console.log(`  MCP config written to: ${configPath}`);

    console.log(`
Installation complete!

MCP config:  ${configPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Crush.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Crush to pick up the MCP server
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Roo Code
// ============================================================================

/**
 * Get the Roo Code MCP config path for the current workspace.
 * Roo Code reads MCP config from .roo/mcp.json in the workspace.
 */
function getRooCodeMcpConfigPath(): string {
  return path.join(process.cwd(), '.roo', 'mcp.json');
}

/**
 * Get the Roo Code context injection path for the current workspace.
 * Roo Code reads rules from .roo/rules/ in the workspace.
 */
function getRooCodeContextPath(): string {
  return path.join(process.cwd(), '.roo', 'rules', 'claude-mem-context.md');
}

/**
 * Install claude-mem MCP integration for Roo Code.
 *
 * - Writes MCP config to .roo/mcp.json in the workspace
 * - Injects context into .roo/rules/claude-mem-context.md in the workspace
 *
 * @returns 0 on success, 1 on failure
 */
export async function installRooCodeMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Roo Code...\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  try {
    // Write MCP config to workspace
    const configPath = getRooCodeMcpConfigPath();
    writeMcpJsonConfig(configPath, mcpServerPath);
    console.log(`  MCP config written to: ${configPath}`);

    // Inject context into workspace rules
    const contextPath = getRooCodeContextPath();
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
    console.log(`  Context placeholder written to: ${contextPath}`);

    console.log(`
Installation complete!

MCP config:  ${configPath}
Context:     ${contextPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Roo Code.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Roo Code to pick up the MCP server
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Warp
// ============================================================================

/**
 * Get the Warp context injection path for the current workspace.
 * Warp reads project-level instructions from WARP.md in the project root.
 */
function getWarpContextPath(): string {
  return path.join(process.cwd(), 'WARP.md');
}

/**
 * Get the Warp MCP config path.
 * Warp stores MCP config at ~/.warp/mcp.json when supported.
 */
function getWarpMcpConfigPath(): string {
  return path.join(homedir(), '.warp', 'mcp.json');
}

/**
 * Install claude-mem MCP integration for Warp.
 *
 * - Writes MCP config to ~/.warp/mcp.json
 * - Injects context into WARP.md in the project root
 *
 * @returns 0 on success, 1 on failure
 */
export async function installWarpMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Warp...\n');

  const mcpServerPath = findMcpServerPath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  try {
    // Write MCP config — Warp may also support configuring MCP via Warp Drive UI
    const configPath = getWarpMcpConfigPath();
    if (existsSync(path.dirname(configPath))) {
      writeMcpJsonConfig(configPath, mcpServerPath);
      console.log(`  MCP config written to: ${configPath}`);
    } else {
      console.log(`  Note: ~/.warp/ not found. MCP may need to be configured via Warp Drive UI.`);
    }

    // Inject context into project-level WARP.md
    const contextPath = getWarpContextPath();
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
    console.log(`  Context placeholder written to: ${contextPath}`);

    console.log(`
Installation complete!

MCP config:  ${configPath}
Context:     ${contextPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Warp.
If MCP config via file is not supported, configure MCP through Warp Drive UI.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Warp to pick up the MCP server
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Unified Installer (used by npx install command)
// ============================================================================

/**
 * Map of IDE identifiers to their install functions.
 * Used by the install command to dispatch to the correct integration.
 */
export const MCP_IDE_INSTALLERS: Record<string, () => Promise<number>> = {
  'copilot-cli': installCopilotCliMcpIntegration,
  'antigravity': installAntigravityMcpIntegration,
  'goose': installGooseMcpIntegration,
  'crush': installCrushMcpIntegration,
  'roo-code': installRooCodeMcpIntegration,
  'warp': installWarpMcpIntegration,
};

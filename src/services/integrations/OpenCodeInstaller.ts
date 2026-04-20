/**
 * OpenCodeInstaller - OpenCode IDE integration installer for claude-mem
 *
 * Installs the claude-mem plugin into OpenCode's plugin directory and
 * sets up context injection via AGENTS.md.
 *
 * Install strategy: File-based (Option A)
 * - Copies the built plugin to the OpenCode plugins directory
 * - Plugins in that directory are auto-loaded at startup
 *
 * Context injection:
 * - Appends/updates <claude-mem-context> section in AGENTS.md
 *
 * Respects OPENCODE_CONFIG_DIR env var for config directory resolution.
 */

import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { CONTEXT_TAG_OPEN, CONTEXT_TAG_CLOSE, injectContextIntoMarkdownFile } from '../../utils/context-injection.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve the OpenCode config directory.
 * Respects OPENCODE_CONFIG_DIR env var, falls back to ~/.config/opencode.
 */
export function getOpenCodeConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  return path.join(homedir(), '.config', 'opencode');
}

/**
 * Resolve the OpenCode plugins directory.
 */
export function getOpenCodePluginsDirectory(): string {
  return path.join(getOpenCodeConfigDirectory(), 'plugins');
}

/**
 * Resolve the AGENTS.md path for context injection.
 */
export function getOpenCodeAgentsMdPath(): string {
  return path.join(getOpenCodeConfigDirectory(), 'AGENTS.md');
}

/**
 * Resolve the path to the installed plugin file.
 */
export function getInstalledPluginPath(): string {
  return path.join(getOpenCodePluginsDirectory(), 'claude-mem.js');
}

// ============================================================================
// Plugin Installation
// ============================================================================

/**
 * Find the built OpenCode plugin bundle.
 * Searches in: dist/opencode-plugin/index.js (built output),
 * then marketplace location.
 */
export function findBuiltPluginPath(): string | null {
  const possiblePaths = [
    // Marketplace install location (production)
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
      'dist', 'opencode-plugin', 'index.js',
    ),
    // Development location (relative to this module's package root)
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'opencode-plugin', 'index.js'),
  ];

  for (const candidatePath of possiblePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Install the claude-mem plugin into OpenCode's plugins directory.
 * Copies the built plugin bundle to ~/.config/opencode/plugins/claude-mem.js
 *
 * @returns 0 on success, 1 on failure
 */
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
    // Create plugins directory if needed
    mkdirSync(pluginsDirectory, { recursive: true });

    // Copy plugin bundle
    copyFileSync(builtPluginPath, destinationPath);

    console.log(`  Plugin installed to: ${destinationPath}`);
    logger.info('OPENCODE', 'Plugin installed', { destination: destinationPath });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenCode plugin: ${message}`);
    return 1;
  }
}

// ============================================================================
// Context Injection (AGENTS.md)
// ============================================================================

/**
 * Inject or update claude-mem context in OpenCode's AGENTS.md file.
 *
 * If the file doesn't exist, creates it with the context section.
 * If the file exists, replaces the existing <claude-mem-context> section
 * or appends one at the end.
 *
 * @param contextContent - The context content to inject (without tags)
 * @returns 0 on success, 1 on failure
 */
export function injectContextIntoAgentsMd(contextContent: string): number {
  const agentsMdPath = getOpenCodeAgentsMdPath();

  try {
    injectContextIntoMarkdownFile(agentsMdPath, contextContent, '# Claude-Mem Memory Context');
    logger.info('OPENCODE', 'Context injected into AGENTS.md', { path: agentsMdPath });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to inject context into AGENTS.md: ${message}`);
    return 1;
  }
}

/**
 * Sync context from the worker into OpenCode's AGENTS.md.
 * Fetches context from the worker API and writes it to AGENTS.md.
 *
 * @param port - Worker port number
 * @param project - Project name for context filtering
 */
export async function syncContextToAgentsMd(
  port: number,
  project: string,
): Promise<void> {
  try {
    await fetchAndInjectOpenCodeContext(port, project);
  } catch (error) {
    // Worker not available — non-critical
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not available during context sync', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not available during context sync', {}, new Error(String(error)));
    }
  }
}

async function fetchRealContextFromWorker(): Promise<string | null> {
  const workerPort = getWorkerPort();
  const healthResponse = await fetch(`http://127.0.0.1:${workerPort}/api/readiness`);
  if (!healthResponse.ok) return null;

  const contextResponse = await fetch(
    `http://127.0.0.1:${workerPort}/api/context/inject?project=opencode`,
  );
  if (!contextResponse.ok) return null;

  const realContext = await contextResponse.text();
  return realContext && realContext.trim() ? realContext : null;
}

async function fetchAndInjectOpenCodeContext(port: number, project: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`,
  );
  if (!response.ok) return;

  const contextText = await response.text();
  if (contextText && contextText.trim()) {
    const injectResult = injectContextIntoAgentsMd(contextText);
    if (injectResult !== 0) {
      logger.warn('OPENCODE', 'Failed to inject context into AGENTS.md during sync');
    }
  }
}

// ============================================================================
// Uninstallation
// ============================================================================

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

/**
 * Remove the claude-mem plugin from OpenCode.
 * Removes the plugin file and cleans up the AGENTS.md context section.
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallOpenCodePlugin(): number {
  let hasErrors = false;

  // Remove plugin file
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

  // Remove context section from AGENTS.md
  const agentsMdPath = getOpenCodeAgentsMdPath();
  if (existsSync(agentsMdPath)) {
    let content: string;
    try {
      content = readFileSync(agentsMdPath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to read AGENTS.md: ${message}`);
      hasErrors = true;
      content = '';
    }

    const tagStartIndex = content.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = content.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      content =
        content.slice(0, tagStartIndex).trimEnd() +
        '\n' +
        content.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length).trimStart();

      const trimmedContent = content.trim();
      try {
        writeOrRemoveCleanedAgentsMd(agentsMdPath, trimmedContent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  Failed to clean AGENTS.md: ${message}`);
        hasErrors = true;
      }
    }
  }

  return hasErrors ? 1 : 0;
}

// ============================================================================
// Status Check
// ============================================================================

/**
 * Check OpenCode integration status.
 *
 * @returns 0 always (informational only)
 */
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

  console.log(`Context (AGENTS.md): ${agentsMdPath}`);
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, 'utf-8');
    const hasContextTags = content.includes(CONTEXT_TAG_OPEN);
    console.log(`  Exists: yes`);
    console.log(`  Has claude-mem context: ${hasContextTags ? 'yes' : 'no'}`);
  } else {
    console.log(`  Exists: no`);
  }

  console.log('');
  return 0;
}

// ============================================================================
// Full Install Flow (used by npx install command)
// ============================================================================

/**
 * Run the full OpenCode installation: plugin + context injection.
 *
 * @returns 0 on success, 1 on failure
 */
export async function installOpenCodeIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem for OpenCode...\n');

  // Step 1: Install plugin
  const pluginResult = installOpenCodePlugin();
  if (pluginResult !== 0) {
    return pluginResult;
  }

  // Step 2: Create initial context in AGENTS.md
  const placeholderContext = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem search tools for manual memory queries.`;

  // Try to fetch real context from worker first
  let contextToInject = placeholderContext;
  let contextSource = 'placeholder';
  try {
    const realContext = await fetchRealContextFromWorker();
    if (realContext) {
      contextToInject = realContext;
      contextSource = 'existing memory';
    }
  } catch (error) {
    // Worker not available — use placeholder
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not available during OpenCode install', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not available during OpenCode install', {}, new Error(String(error)));
    }
  }

  const injectResult = injectContextIntoAgentsMd(contextToInject);
  if (injectResult !== 0) {
    logger.warn('OPENCODE', `Failed to inject ${contextSource} context into AGENTS.md during install`);
  } else {
    if (contextSource === 'existing memory') {
      console.log('  Context injected from existing memory');
    } else {
      console.log('  Placeholder context created (worker not running)');
    }
  }

  console.log(`
Installation complete!

Plugin installed to: ${getInstalledPluginPath()}
Context file: ${getOpenCodeAgentsMdPath()}

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart OpenCode to load the plugin
  3. Memory capture is automatic from then on
`);

  return 0;
}

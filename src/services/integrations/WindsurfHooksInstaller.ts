/**
 * WindsurfHooksInstaller - Windsurf IDE integration for claude-mem
 *
 * Handles:
 * - Windsurf hooks installation/uninstallation to ~/.codeium/windsurf/hooks.json
 * - Context file generation (.windsurf/rules/claude-mem-context.md)
 * - Project registry management for auto-context updates
 *
 * Windsurf hooks.json format:
 *   {
 *     "hooks": {
 *       "<event_name>": [{ "command": "...", "show_output": false, "working_directory": "..." }]
 *     }
 *   }
 *
 * Events registered (all post-action, non-blocking):
 *   - pre_user_prompt      — session init + context injection
 *   - post_write_code      — code generation observation
 *   - post_run_command     — command execution observation
 *   - post_mcp_tool_use    — MCP tool results
 *   - post_cascade_response — full AI response
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';

// ============================================================================
// Types
// ============================================================================

interface WindsurfHookEntry {
  command: string;
  show_output: boolean;
  working_directory: string;
}

interface WindsurfHooksJson {
  hooks: {
    [eventName: string]: WindsurfHookEntry[];
  };
}

interface WindsurfProjectRegistry {
  [projectName: string]: {
    workspacePath: string;
    installedAt: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** User-level hooks config — global coverage across all Windsurf workspaces */
const WINDSURF_HOOKS_DIR = path.join(homedir(), '.codeium', 'windsurf');
const WINDSURF_HOOKS_JSON_PATH = path.join(WINDSURF_HOOKS_DIR, 'hooks.json');

/** Windsurf context rule limit: 6,000 chars per file */
const WINDSURF_CONTEXT_CHAR_LIMIT = 6000;

/** Registry file for tracking projects with Windsurf hooks */
const WINDSURF_REGISTRY_FILE = path.join(DATA_DIR, 'windsurf-projects.json');

/** Hook events we register */
const WINDSURF_HOOK_EVENTS = [
  'pre_user_prompt',
  'post_write_code',
  'post_run_command',
  'post_mcp_tool_use',
  'post_cascade_response',
] as const;

// ============================================================================
// Project Registry
// ============================================================================

/**
 * Read the Windsurf project registry
 */
export function readWindsurfRegistry(): WindsurfProjectRegistry {
  try {
    if (!existsSync(WINDSURF_REGISTRY_FILE)) return {};
    return JSON.parse(readFileSync(WINDSURF_REGISTRY_FILE, 'utf-8'));
  } catch (error) {
    logger.error('WINDSURF', 'Failed to read registry, using empty', {
      file: WINDSURF_REGISTRY_FILE,
    }, error as Error);
    return {};
  }
}

/**
 * Write the Windsurf project registry
 */
export function writeWindsurfRegistry(registry: WindsurfProjectRegistry): void {
  const dir = path.dirname(WINDSURF_REGISTRY_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(WINDSURF_REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Register a project for auto-context updates
 */
export function registerWindsurfProject(projectName: string, workspacePath: string): void {
  const registry = readWindsurfRegistry();
  registry[projectName] = {
    workspacePath,
    installedAt: new Date().toISOString(),
  };
  writeWindsurfRegistry(registry);
  logger.info('WINDSURF', 'Registered project for auto-context updates', { projectName, workspacePath });
}

/**
 * Unregister a project from auto-context updates
 */
export function unregisterWindsurfProject(projectName: string): void {
  const registry = readWindsurfRegistry();
  if (registry[projectName]) {
    delete registry[projectName];
    writeWindsurfRegistry(registry);
    logger.info('WINDSURF', 'Unregistered project', { projectName });
  }
}

/**
 * Update Windsurf context files for all registered projects matching this project name.
 * Called by SDK agents after saving a summary.
 */
export async function updateWindsurfContextForProject(projectName: string, port: number): Promise<void> {
  const registry = readWindsurfRegistry();
  const entry = registry[projectName];

  if (!entry) return; // Project doesn't have Windsurf hooks installed

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
    );

    if (!response.ok) return;

    const context = await response.text();
    if (!context || !context.trim()) return;

    writeWindsurfContextFile(entry.workspacePath, context);
    logger.debug('WINDSURF', 'Updated context file', { projectName, workspacePath: entry.workspacePath });
  } catch (error) {
    // Background context update — failure is non-critical
    logger.error('WINDSURF', 'Failed to update context file', { projectName }, error as Error);
  }
}

// ============================================================================
// Context File
// ============================================================================

/**
 * Write context to the workspace-level Windsurf rules directory.
 * Windsurf rules are workspace-scoped: .windsurf/rules/claude-mem-context.md
 * Rule file limit: 6,000 chars per file.
 */
export function writeWindsurfContextFile(workspacePath: string, context: string): void {
  const rulesDir = path.join(workspacePath, '.windsurf', 'rules');
  const rulesFile = path.join(rulesDir, 'claude-mem-context.md');
  const tempFile = `${rulesFile}.tmp`;

  mkdirSync(rulesDir, { recursive: true });

  let content = `# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

${context}

---
*Auto-updated by claude-mem after each session. Use MCP search tools for detailed queries.*
`;

  // Enforce Windsurf's 6K char limit
  if (content.length > WINDSURF_CONTEXT_CHAR_LIMIT) {
    content = content.slice(0, WINDSURF_CONTEXT_CHAR_LIMIT - 50) +
      '\n\n*[Truncated — use MCP search for full history]*\n';
  }

  // Atomic write: temp file + rename
  writeFileSync(tempFile, content);
  renameSync(tempFile, rulesFile);
}

// ============================================================================
// Hook Installation
// ============================================================================

/**
 * Build the hook command string for a given event.
 * Uses bun to run worker-service.cjs with the windsurf platform adapter.
 */
function buildHookCommand(bunPath: string, workerServicePath: string, eventName: string): string {
  // Map Windsurf event names to unified CLI hook commands
  const eventToCommand: Record<string, string> = {
    'pre_user_prompt': 'session-init',
    'post_write_code': 'file-edit',
    'post_run_command': 'observation',
    'post_mcp_tool_use': 'observation',
    'post_cascade_response': 'observation',
  };

  const hookCommand = eventToCommand[eventName] ?? 'observation';

  // Escape backslashes for JSON on Windows
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook windsurf ${hookCommand}`;
}

/**
 * Read existing hooks.json, merge our hooks, and write back.
 * Preserves any existing hooks from other tools.
 */
function mergeAndWriteHooksJson(
  bunPath: string,
  workerServicePath: string,
  workingDirectory: string,
): void {
  mkdirSync(WINDSURF_HOOKS_DIR, { recursive: true });

  // Read existing hooks.json if present
  let existingConfig: WindsurfHooksJson = { hooks: {} };
  if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
    try {
      existingConfig = JSON.parse(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8'));
      if (!existingConfig.hooks) {
        existingConfig.hooks = {};
      }
    } catch (error) {
      logger.error('WINDSURF', 'Corrupt hooks.json, starting fresh', {
        path: WINDSURF_HOOKS_JSON_PATH,
      }, error as Error);
      existingConfig = { hooks: {} };
    }
  }

  // For each event, add our hook entry (remove any previous claude-mem entries first)
  for (const eventName of WINDSURF_HOOK_EVENTS) {
    const command = buildHookCommand(bunPath, workerServicePath, eventName);

    const hookEntry: WindsurfHookEntry = {
      command,
      show_output: false,
      working_directory: workingDirectory,
    };

    // Get existing hooks for this event, filtering out old claude-mem ones
    const existingHooks = (existingConfig.hooks[eventName] ?? []).filter(
      (hook) => !hook.command.includes('worker-service') || !hook.command.includes('windsurf')
    );

    existingConfig.hooks[eventName] = [...existingHooks, hookEntry];
  }

  writeFileSync(WINDSURF_HOOKS_JSON_PATH, JSON.stringify(existingConfig, null, 2));
}

/**
 * Install Windsurf hooks to ~/.codeium/windsurf/hooks.json (user-level).
 * Merges with existing hooks.json to preserve other integrations.
 */
export async function installWindsurfHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Windsurf hooks (user level)...\n');

  // Find the worker-service.cjs path
  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  // Find bun executable — required because worker-service.cjs uses bun:sqlite
  const bunPath = findBunPath();

  // IMPORTANT: Tilde expansion is NOT supported in working_directory — use absolute paths
  const workingDirectory = path.dirname(workerServicePath);

  try {
    console.log(`  Using Bun runtime: ${bunPath}`);
    console.log(`  Worker service: ${workerServicePath}`);

    // Merge our hooks into the existing hooks.json
    mergeAndWriteHooksJson(bunPath, workerServicePath, workingDirectory);
    console.log(`  Created/merged hooks.json`);

    // Set up initial context for the current workspace
    const workspaceRoot = process.cwd();
    await setupWindsurfProjectContext(workspaceRoot);

    console.log(`
Installation complete!

Hooks installed to: ${WINDSURF_HOOKS_JSON_PATH}
Using unified CLI: bun worker-service.cjs hook windsurf <command>

Events registered:
  - pre_user_prompt      (session init + context injection)
  - post_write_code      (code generation observation)
  - post_run_command     (command execution observation)
  - post_mcp_tool_use    (MCP tool results)
  - post_cascade_response (full AI response)

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Windsurf to load the hooks
  3. Context is injected via .windsurf/rules/claude-mem-context.md (workspace-level)
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Setup initial context file for a Windsurf workspace
 */
async function setupWindsurfProjectContext(workspaceRoot: string): Promise<void> {
  const port = getWorkerPort();
  const projectName = path.basename(workspaceRoot);
  let contextGenerated = false;

  console.log(`  Generating initial context...`);

  try {
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/readiness`);
    if (healthResponse.ok) {
      const contextResponse = await fetch(
        `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
      );
      if (contextResponse.ok) {
        const context = await contextResponse.text();
        if (context && context.trim()) {
          writeWindsurfContextFile(workspaceRoot, context);
          contextGenerated = true;
          console.log(`  Generated initial context from existing memory`);
        }
      }
    }
  } catch (error) {
    // Worker not running during install — non-critical
    logger.debug('WINDSURF', 'Worker not running during install', {}, error as Error);
  }

  if (!contextGenerated) {
    // Create placeholder context file
    const rulesDir = path.join(workspaceRoot, '.windsurf', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const rulesFile = path.join(rulesDir, 'claude-mem-context.md');
    const placeholderContent = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
`;
    writeFileSync(rulesFile, placeholderContent);
    console.log(`  Created placeholder context file (will populate after first session)`);
  }

  // Register project for automatic context updates after summaries
  registerWindsurfProject(projectName, workspaceRoot);
  console.log(`  Registered for auto-context updates`);
}

/**
 * Uninstall Windsurf hooks — removes claude-mem entries from hooks.json
 */
export function uninstallWindsurfHooks(): number {
  console.log('\nUninstalling Claude-Mem Windsurf hooks...\n');

  try {
    // Remove our entries from hooks.json (preserve other integrations)
    if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
      try {
        const config: WindsurfHooksJson = JSON.parse(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8'));

        for (const eventName of WINDSURF_HOOK_EVENTS) {
          if (config.hooks[eventName]) {
            config.hooks[eventName] = config.hooks[eventName].filter(
              (hook) => !hook.command.includes('worker-service') || !hook.command.includes('windsurf')
            );
            // Remove empty arrays
            if (config.hooks[eventName].length === 0) {
              delete config.hooks[eventName];
            }
          }
        }

        // If no hooks remain, remove the file entirely
        if (Object.keys(config.hooks).length === 0) {
          unlinkSync(WINDSURF_HOOKS_JSON_PATH);
          console.log(`  Removed hooks.json (no hooks remaining)`);
        } else {
          writeFileSync(WINDSURF_HOOKS_JSON_PATH, JSON.stringify(config, null, 2));
          console.log(`  Removed claude-mem entries from hooks.json (other hooks preserved)`);
        }
      } catch (error) {
        // Corrupt file — just remove it
        unlinkSync(WINDSURF_HOOKS_JSON_PATH);
        console.log(`  Removed corrupt hooks.json`);
      }
    } else {
      console.log(`  No hooks.json found`);
    }

    // Remove context file from the current workspace
    const workspaceRoot = process.cwd();
    const contextFile = path.join(workspaceRoot, '.windsurf', 'rules', 'claude-mem-context.md');
    if (existsSync(contextFile)) {
      unlinkSync(contextFile);
      console.log(`  Removed context file`);
    }

    // Unregister project
    const projectName = path.basename(workspaceRoot);
    unregisterWindsurfProject(projectName);
    console.log(`  Unregistered from auto-context updates`);

    console.log(`\nUninstallation complete!\n`);
    console.log('Restart Windsurf to apply changes.');

    return 0;
  } catch (error) {
    console.error(`\nUninstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Check Windsurf hooks installation status
 */
export function checkWindsurfHooksStatus(): number {
  console.log('\nClaude-Mem Windsurf Hooks Status\n');

  if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
    console.log(`User-level: Installed`);
    console.log(`   Config: ${WINDSURF_HOOKS_JSON_PATH}`);

    try {
      const config: WindsurfHooksJson = JSON.parse(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8'));
      const registeredEvents = WINDSURF_HOOK_EVENTS.filter(
        (event) => config.hooks[event]?.some(
          (hook) => hook.command.includes('worker-service') && hook.command.includes('windsurf')
        )
      );
      console.log(`   Events: ${registeredEvents.length}/${WINDSURF_HOOK_EVENTS.length} registered`);
      for (const event of registeredEvents) {
        console.log(`     - ${event}`);
      }
    } catch {
      console.log(`   Mode: Unable to parse hooks.json`);
    }

    // Check for context file in current workspace
    const contextFile = path.join(process.cwd(), '.windsurf', 'rules', 'claude-mem-context.md');
    if (existsSync(contextFile)) {
      console.log(`   Context: Active (current workspace)`);
    } else {
      console.log(`   Context: Not yet generated for this workspace`);
    }
  } else {
    console.log(`User-level: Not installed`);
    console.log(`\nNo hooks installed. Run: claude-mem windsurf install\n`);
  }

  console.log('');
  return 0;
}

/**
 * Handle windsurf subcommand for hooks installation
 */
export async function handleWindsurfCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installWindsurfHooks();

    case 'uninstall':
      return uninstallWindsurfHooks();

    case 'status':
      return checkWindsurfHooksStatus();

    default: {
      console.log(`
Claude-Mem Windsurf Integration

Usage: claude-mem windsurf <command>

Commands:
  install     Install Windsurf hooks (user-level, ~/.codeium/windsurf/hooks.json)
  uninstall   Remove Windsurf hooks
  status      Check installation status

Examples:
  claude-mem windsurf install      # Install hooks globally
  claude-mem windsurf uninstall    # Remove hooks
  claude-mem windsurf status       # Check if hooks are installed

For more info: https://docs.claude-mem.ai/windsurf
      `);
      return 0;
    }
  }
}

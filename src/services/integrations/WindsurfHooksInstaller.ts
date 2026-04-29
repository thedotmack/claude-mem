
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';

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
  [workspacePath: string]: {
    installedAt: string;
  };
}

const WINDSURF_HOOKS_DIR = path.join(homedir(), '.codeium', 'windsurf');
const WINDSURF_HOOKS_JSON_PATH = path.join(WINDSURF_HOOKS_DIR, 'hooks.json');

const WINDSURF_CONTEXT_CHAR_LIMIT = 6000;

const WINDSURF_REGISTRY_FILE = path.join(DATA_DIR, 'windsurf-projects.json');

const WINDSURF_HOOK_EVENTS = [
  'pre_user_prompt',
  'post_write_code',
  'post_run_command',
  'post_mcp_tool_use',
  'post_cascade_response',
] as const;

export function readWindsurfRegistry(): WindsurfProjectRegistry {
  try {
    if (!existsSync(WINDSURF_REGISTRY_FILE)) return {};
    return JSON.parse(readFileSync(WINDSURF_REGISTRY_FILE, 'utf-8'));
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to read registry, using empty', { file: WINDSURF_REGISTRY_FILE }, error);
    } else {
      logger.error('WORKER', 'Failed to read registry, using empty', { file: WINDSURF_REGISTRY_FILE }, new Error(String(error)));
    }
    return {};
  }
}

export function writeWindsurfRegistry(registry: WindsurfProjectRegistry): void {
  const dir = path.dirname(WINDSURF_REGISTRY_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(WINDSURF_REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

export function registerWindsurfProject(workspacePath: string): void {
  const registry = readWindsurfRegistry();
  registry[workspacePath] = {
    installedAt: new Date().toISOString(),
  };
  writeWindsurfRegistry(registry);
  logger.info('WINDSURF', 'Registered project for auto-context updates', { workspacePath });
}

export function unregisterWindsurfProject(workspacePath: string): void {
  const registry = readWindsurfRegistry();
  if (registry[workspacePath]) {
    delete registry[workspacePath];
    writeWindsurfRegistry(registry);
    logger.info('WINDSURF', 'Unregistered project', { workspacePath });
  }
}

export async function updateWindsurfContextForProject(projectName: string, workspacePath: string, port: number): Promise<void> {
  const registry = readWindsurfRegistry();
  const entry = registry[workspacePath];

  if (!entry) return; 

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
    );

    if (!response.ok) return;

    const context = await response.text();
    if (!context || !context.trim()) return;

    writeWindsurfContextFile(workspacePath, context);
    logger.debug('WINDSURF', 'Updated context file', { projectName, workspacePath });
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to update context file', { projectName, workspacePath }, error);
    } else {
      logger.error('WORKER', 'Failed to update context file', { projectName, workspacePath }, new Error(String(error)));
    }
  }
}

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

  if (content.length > WINDSURF_CONTEXT_CHAR_LIMIT) {
    content = content.slice(0, WINDSURF_CONTEXT_CHAR_LIMIT - 50) +
      '\n\n*[Truncated — use MCP search for full history]*\n';
  }

  writeFileSync(tempFile, content);
  renameSync(tempFile, rulesFile);
}

function buildHookCommand(bunPath: string, workerServicePath: string, eventName: string): string {
  const eventToCommand: Record<string, string> = {
    'pre_user_prompt': 'session-init',
    'post_write_code': 'file-edit',
    'post_run_command': 'observation',
    'post_mcp_tool_use': 'observation',
    'post_cascade_response': 'observation',
  };

  const hookCommand = eventToCommand[eventName] ?? 'observation';

  return `"${bunPath}" "${workerServicePath}" hook windsurf ${hookCommand}`;
}

function mergeAndWriteHooksJson(
  bunPath: string,
  workerServicePath: string,
  workingDirectory: string,
): void {
  mkdirSync(WINDSURF_HOOKS_DIR, { recursive: true });

  let existingConfig: WindsurfHooksJson = { hooks: {} };
  if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
    try {
      existingConfig = JSON.parse(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8'));
      if (!existingConfig.hooks) {
        existingConfig.hooks = {};
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error('WORKER', 'Corrupt hooks.json, refusing to overwrite', { path: WINDSURF_HOOKS_JSON_PATH }, error);
      } else {
        logger.error('WORKER', 'Corrupt hooks.json, refusing to overwrite', { path: WINDSURF_HOOKS_JSON_PATH }, new Error(String(error)));
      }
      throw new Error(`Corrupt hooks.json at ${WINDSURF_HOOKS_JSON_PATH}, refusing to overwrite`);
    }
  }

  for (const eventName of WINDSURF_HOOK_EVENTS) {
    const command = buildHookCommand(bunPath, workerServicePath, eventName);

    const hookEntry: WindsurfHookEntry = {
      command,
      show_output: false,
      working_directory: workingDirectory,
    };

    const existingHooks = (existingConfig.hooks[eventName] ?? []).filter(
      (hook) => !hook.command.includes('worker-service') || !hook.command.includes('windsurf')
    );

    existingConfig.hooks[eventName] = [...existingHooks, hookEntry];
  }

  writeFileSync(WINDSURF_HOOKS_JSON_PATH, JSON.stringify(existingConfig, null, 2));
}

export async function installWindsurfHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Windsurf hooks (user level)...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  if (!bunPath) {
    console.error('Could not find Bun runtime');
    console.error('   Install Bun: curl -fsSL https://bun.sh/install | bash');
    return 1;
  }

  const workingDirectory = path.dirname(workerServicePath);

  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  const workspaceRoot = process.cwd();

  try {
    await writeWindsurfHooksAndSetupContext(bunPath, workerServicePath, workingDirectory, workspaceRoot);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

async function writeWindsurfHooksAndSetupContext(
  bunPath: string,
  workerServicePath: string,
  workingDirectory: string,
  workspaceRoot: string,
): Promise<void> {
  mergeAndWriteHooksJson(bunPath, workerServicePath, workingDirectory);
  console.log(`  Created/merged hooks.json`);

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
}

async function setupWindsurfProjectContext(workspaceRoot: string): Promise<void> {
  const port = getWorkerPort();
  const projectName = path.basename(workspaceRoot);
  let contextGenerated = false;

  console.log(`  Generating initial context...`);

  try {
    contextGenerated = await fetchWindsurfContextFromWorker(port, projectName, workspaceRoot);
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not running during install', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not running during install', {}, new Error(String(error)));
    }
  }

  if (!contextGenerated) {
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

  registerWindsurfProject(workspaceRoot);
  console.log(`  Registered for auto-context updates`);
}

async function fetchWindsurfContextFromWorker(
  port: number,
  projectName: string,
  workspaceRoot: string,
): Promise<boolean> {
  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/readiness`);
  if (!healthResponse.ok) return false;

  const contextResponse = await fetch(
    `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`,
  );
  if (!contextResponse.ok) return false;

  const context = await contextResponse.text();
  if (context && context.trim()) {
    writeWindsurfContextFile(workspaceRoot, context);
    console.log(`  Generated initial context from existing memory`);
    return true;
  }
  return false;
}

export function uninstallWindsurfHooks(): number {
  console.log('\nUninstalling Claude-Mem Windsurf hooks...\n');

  if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
    try {
      removeClaudeMemHookEntries();
    } catch (error) {
      if (error instanceof Error) {
        logger.error('WORKER', 'Could not parse hooks.json during uninstall', { path: WINDSURF_HOOKS_JSON_PATH }, error);
      } else {
        logger.error('WORKER', 'Could not parse hooks.json during uninstall', { path: WINDSURF_HOOKS_JSON_PATH }, new Error(String(error)));
      }
      console.log(`  Warning: could not parse hooks.json — leaving file intact to preserve other hooks`);
    }
  } else {
    console.log(`  No hooks.json found`);
  }

  const workspaceRoot = process.cwd();

  try {
    removeWindsurfContextAndUnregister(workspaceRoot);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

function removeClaudeMemHookEntries(): void {
  const parsed = JSON.parse(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8')) as Partial<WindsurfHooksJson>;
  const config: WindsurfHooksJson = { hooks: parsed.hooks ?? {} };

  for (const eventName of WINDSURF_HOOK_EVENTS) {
    const eventHooks = config.hooks[eventName] ?? [];
    if (eventHooks.length > 0) {
      config.hooks[eventName] = eventHooks.filter(
        (hook) => !hook.command.includes('worker-service') || !hook.command.includes('windsurf'),
      );
      if (config.hooks[eventName].length === 0) {
        delete config.hooks[eventName];
      }
    }
  }

  if (Object.keys(config.hooks).length === 0) {
    unlinkSync(WINDSURF_HOOKS_JSON_PATH);
    console.log(`  Removed hooks.json (no hooks remaining)`);
  } else {
    writeFileSync(WINDSURF_HOOKS_JSON_PATH, JSON.stringify(config, null, 2));
    console.log(`  Removed claude-mem entries from hooks.json (other hooks preserved)`);
  }
}

function removeWindsurfContextAndUnregister(workspaceRoot: string): void {
  const contextFile = path.join(workspaceRoot, '.windsurf', 'rules', 'claude-mem-context.md');
  if (existsSync(contextFile)) {
    unlinkSync(contextFile);
    console.log(`  Removed context file`);
  }

  unregisterWindsurfProject(workspaceRoot);
  console.log(`  Unregistered from auto-context updates`);

  console.log(`\nUninstallation complete!\n`);
  console.log('Restart Windsurf to apply changes.');
}

export function checkWindsurfHooksStatus(): number {
  console.log('\nClaude-Mem Windsurf Hooks Status\n');

  if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
    console.log(`User-level: Installed`);
    console.log(`   Config: ${WINDSURF_HOOKS_JSON_PATH}`);

    let parsedConfig: Partial<WindsurfHooksJson> | null = null;
    try {
      parsedConfig = JSON.parse(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8'));
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'Unable to parse hooks.json', { path: WINDSURF_HOOKS_JSON_PATH }, normalizedError);
      console.log(`   Mode: Unable to parse hooks.json`);
    }

    if (parsedConfig) {
      const registeredEvents = WINDSURF_HOOK_EVENTS.filter(
        (event) => (parsedConfig?.hooks?.[event] ?? []).some(
          (hook) => hook.command.includes('worker-service') && hook.command.includes('windsurf')
        )
      );
      console.log(`   Events: ${registeredEvents.length}/${WINDSURF_HOOK_EVENTS.length} registered`);
      for (const event of registeredEvents) {
        console.log(`     - ${event}`);
      }
    }

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

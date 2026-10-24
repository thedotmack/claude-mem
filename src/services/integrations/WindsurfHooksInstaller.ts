
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { formatHostForUrl, getWorkerHost, getWorkerPort } from '../../shared/worker-utils.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { DATA_DIR } from '../../shared/paths.js';
import { getBunAbsolutePath as findBunPath, getWorkerServiceAbsolutePath as findWorkerServicePath } from './install-paths.js';
import {
  LIBRARY_GROUPS,
  WINDSURF_HOOK_TABLE,
  WINDSURF_PLACEHOLDER_RULES,
  libraryRemovalEnvironment,
  rulesFileItem,
  windsurfHookItems,
  windsurfRulesPath,
} from '../wire-gateway/library/agent-library-targets.js';
import {
  applyLibraryForInstaller,
  currentLibraryInstallEnvironment,
  removeLibraryForInstaller,
  withoutInstructionsWhenWireInjects,
} from '../wire-gateway/library/library-runtime.js';

interface WindsurfHookEntry {
  command: string;
  show_output: boolean;
  working_directory?: string;
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

const WINDSURF_HOOK_EVENTS = WINDSURF_HOOK_TABLE.map((row) => row.event);

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

/**
 * Windsurf's hooks and (for this workspace) its rules file, through the
 * Library engine: only entries claude-mem wrote are replaced, and every other
 * hook in ~/.codeium/windsurf/hooks.json keeps its place and bytes.
 */
function windsurfLibraryRequest(workspaceRoot: string, rulesContents: string | null | undefined, forRemoval = false) {
  const installEnvironment = { ...currentLibraryInstallEnvironment(), cwd: workspaceRoot };
  const environment = forRemoval ? libraryRemovalEnvironment(installEnvironment) : installEnvironment;
  const { items, jsonStyles } = windsurfHookItems(environment);
  const ownedGroups: string[] = [LIBRARY_GROUPS.hooks];
  if (rulesContents !== undefined) {
    const rulesItem = rulesFileItem(windsurfRulesPath(workspaceRoot), rulesContents, workspaceRoot);
    items.push(...withoutInstructionsWhenWireInjects('windsurf', [rulesItem]));
    ownedGroups.push(rulesItem.group);
  }
  return { agentId: 'windsurf', items, ownedGroups, jsonStyles };
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

  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  const workspaceRoot = process.cwd();

  try {
    await writeWindsurfHooksAndSetupContext(workspaceRoot);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

async function writeWindsurfHooksAndSetupContext(workspaceRoot: string): Promise<void> {
  const generatedContext = await setupWindsurfProjectContext(workspaceRoot);
  // A context the worker generated was written by writeWindsurfContextFile; it is recorded, not rewritten.
  applyLibraryForInstaller(windsurfLibraryRequest(workspaceRoot, generatedContext ? null : WINDSURF_PLACEHOLDER_RULES));
  console.log(`  Created/merged hooks.json`);
  if (!generatedContext) console.log(`  Created placeholder context file (will populate after first session)`);

  registerWindsurfProject(workspaceRoot);
  console.log(`  Registered for auto-context updates`);

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

/** Ask a running worker for this workspace's context; true when it was written to the rules file. */
async function setupWindsurfProjectContext(workspaceRoot: string): Promise<boolean> {
  const port = getWorkerPort();
  const projectName = getProjectContext(workspaceRoot).primary;
  console.log(`  Generating initial context...`);
  try {
    return await fetchWindsurfContextFromWorker(port, projectName, workspaceRoot);
  } catch (error) {
    logger.debug('WORKER', 'Worker not running during install', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

async function fetchWindsurfContextFromWorker(
  port: number,
  projectName: string,
  workspaceRoot: string,
): Promise<boolean> {
  const workerUrl = `http://${formatHostForUrl(getWorkerHost())}:${port}`;
  const healthResponse = await fetch(`${workerUrl}/api/readiness`);
  if (!healthResponse.ok) return false;

  const contextResponse = await fetch(
    `${workerUrl}/api/context/inject?project=${encodeURIComponent(projectName)}`,
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

  const workspaceRoot = process.cwd();
  try {
    // Built for removal: with the plugin folder gone the items still carry the signatures pre-Library entries are found by.
    const request = windsurfLibraryRequest(workspaceRoot, null, true);
    removeLibraryForInstaller({ agentId: 'windsurf', items: request.items, jsonStyles: request.jsonStyles });
    console.log(`  Removed claude-mem entries from hooks.json (other hooks preserved)`);
    unregisterWindsurfProject(workspaceRoot);
    console.log(`  Unregistered from auto-context updates`);
    console.log(`\nUninstallation complete!\n`);
    console.log('Restart Windsurf to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkWindsurfHooksStatus(): number {
  console.log('\nClaude-Mem Windsurf Hooks Status\n');

  if (existsSync(WINDSURF_HOOKS_JSON_PATH)) {
    console.log(`User-level: Installed`);
    console.log(`   Config: ${WINDSURF_HOOKS_JSON_PATH}`);

    let parsedConfig: Partial<WindsurfHooksJson> | null = null;
    try {
      parsedConfig = parseJsonWithBom(readFileSync(WINDSURF_HOOKS_JSON_PATH, 'utf-8'));
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

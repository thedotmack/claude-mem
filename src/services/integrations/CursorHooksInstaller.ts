
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { getProjectContext } from '../../utils/project-name.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import {
  readCursorRegistry as readCursorRegistryFromFile,
  registerCursorProject as registerCursorProjectInFile,
  unregisterCursorProject as unregisterCursorProjectInFile,
  writeContextFile,
  type CursorProjectRegistry
} from '../../utils/cursor-utils.js';
import type { CursorInstallTarget } from './types.js';
import {
  getMcpServerAbsolutePath,
  getWorkerServiceAbsolutePath,
  getBunAbsolutePath,
} from './install-paths.js';
import {
  CURSOR_LEGACY_HOOK_SCRIPT_BASENAMES,
  CURSOR_PLACEHOLDER_RULES,
  cursorHookItems,
  cursorMcpItem,
  isLegacyClaudeMemCursorHook,
  isUnifiedClaudeMemCursorHook,
  libraryRemovalEnvironment,
  rulesFileItem,
  type LibraryInstallEnvironment,
} from '../wire-gateway/library/agent-library-targets.js';
import {
  applyLibraryForInstaller,
  currentLibraryInstallEnvironment,
  removeLibraryForInstaller,
  withoutInstructionsWhenWireInjects,
} from '../wire-gateway/library/library-runtime.js';

const CURSOR_REGISTRY_FILE = path.join(DATA_DIR, 'cursor-projects.json');

export function readCursorRegistry(): CursorProjectRegistry {
  return readCursorRegistryFromFile(CURSOR_REGISTRY_FILE);
}

export function registerCursorProject(projectName: string, workspacePath: string): void {
  registerCursorProjectInFile(CURSOR_REGISTRY_FILE, projectName, workspacePath);
  logger.info('CURSOR', 'Registered project for auto-context updates', { projectName, workspacePath });
}

export function unregisterCursorProject(projectName: string): void {
  unregisterCursorProjectInFile(CURSOR_REGISTRY_FILE, projectName);
  logger.info('CURSOR', 'Unregistered project', { projectName });
}

export async function updateCursorContextForProject(projectName: string): Promise<void> {
  const registry = readCursorRegistry();
  const entry = registry[projectName];

  if (!entry) return; 

  try {
    const response = await workerHttpRequest(
      `/api/context/inject?project=${encodeURIComponent(projectName)}`
    );

    if (!response.ok) return;

    const context = await response.text();
    if (!context || !context.trim()) return;

    writeContextFile(entry.workspacePath, context);
    logger.debug('CURSOR', 'Updated context file', { projectName, workspacePath: entry.workspacePath });
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to update context file', { projectName }, error);
    } else {
      logger.error('WORKER', 'Failed to update context file', { projectName }, new Error(String(error)));
    }
  }
}

export function getTargetDir(target: CursorInstallTarget): string | null {
  switch (target) {
    case 'project':
      return path.join(process.cwd(), '.cursor');
    case 'user':
      return path.join(homedir(), '.cursor');
    case 'enterprise':
      if (process.platform === 'darwin') {
        return '/Library/Application Support/Cursor';
      } else if (process.platform === 'linux') {
        return '/etc/cursor';
      } else if (process.platform === 'win32') {
        return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Cursor');
      }
      return null;
    default:
      return null;
  }
}

export function configureCursorMcp(target: CursorInstallTarget): number {
  const mcpServerPath = getMcpServerAbsolutePath();

  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  const targetDir = getTargetDir(target);
  if (!targetDir) {
    console.error(`Invalid target: ${target}. Use: project or user`);
    return 1;
  }

  const mcpJsonPath = path.join(targetDir, 'mcp.json');

  try {
    configureCursorMcpFile(mcpJsonPath, mcpServerPath);
    console.log(`  Configured MCP server in ${target === 'user' ? '~/.cursor' : '.cursor'}/mcp.json`);
    console.log(`    Server path: ${mcpServerPath}`);

    return 0;
  } catch (error) {
    console.error(`Failed to configure MCP: ${(error as Error).message}`);
    return 1;
  }
}

export async function installCursorHooks(target: CursorInstallTarget): Promise<number> {
  console.log(`\nInstalling Claude-Mem Cursor hooks (${target} level)...\n`);

  const targetDir = getTargetDir(target);
  if (!targetDir) {
    console.error(`Invalid target: ${target}. Use: project, user, or enterprise`);
    return 1;
  }

  const workerServicePath = getWorkerServiceAbsolutePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const workspaceRoot = process.cwd();
  const bunPath = getBunAbsolutePath();
  console.log(`  Using Bun runtime: ${bunPath}`);

  try {
    await writeHooksJsonAndSetupProject(workerServicePath, target, targetDir, workspaceRoot);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    if (target === 'enterprise') {
      console.error('   Tip: Enterprise installation may require sudo/admin privileges');
    }
    return 1;
  }
}

/** Register claude-mem's MCP server in a Cursor mcp.json through the Library; every other server stays. */
export function configureCursorMcpFile(mcpJsonPath: string, mcpServerScriptPath: string): void {
  const { item, jsonStyles } = cursorMcpItem(mcpServerScriptPath, mcpJsonPath);
  applyLibraryForInstaller({ agentId: 'cursor', items: [item], ownedGroups: [item.group], jsonStyles });
}

/**
 * The hooks (and, for a project, its rules file) through the Library: only
 * entries claude-mem wrote — recorded, or from an earlier install by their
 * command — are replaced; every other hook in hooks.json stays where it is.
 */
function cursorLibraryRequest(targetDir: string, workspaceRoot: string, rulesContents: string | null | undefined, environment: LibraryInstallEnvironment = currentLibraryInstallEnvironment()) {
  const { items, jsonStyles } = cursorHookItems(environment, targetDir);
  const ownedGroups = [items[0].group];
  if (rulesContents !== undefined) {
    const rulesItem = rulesFileItem(path.join(targetDir, 'rules', 'claude-mem-context.mdc'), rulesContents, workspaceRoot);
    items.push(...withoutInstructionsWhenWireInjects('cursor', [rulesItem]));
    ownedGroups.push(rulesItem.group);
  }
  return { agentId: 'cursor', items, ownedGroups, jsonStyles };
}

async function writeHooksJsonAndSetupProject(
  workerServicePath: string,
  target: CursorInstallTarget,
  targetDir: string,
  workspaceRoot: string,
): Promise<void> {
  const generatedContext = target === 'project' ? await generateProjectContext(workspaceRoot) : false;
  const rulesContents = target !== 'project' ? undefined : generatedContext ? null : CURSOR_PLACEHOLDER_RULES;
  applyLibraryForInstaller(cursorLibraryRequest(targetDir, workspaceRoot, rulesContents));
  console.log(`  Wrote hooks.json (unified CLI mode, existing hooks preserved)`);
  console.log(`  Worker service: ${workerServicePath}`);

  if (target === 'project') {
    if (!generatedContext) console.log(`  Created placeholder context file (will populate after first session)`);
    registerCursorProject(getProjectContext(workspaceRoot).primary, workspaceRoot);
    console.log(`  Registered for auto-context updates`);
  }

  console.log(`
Installation complete!

Hooks installed to: ${targetDir}/hooks.json
Using unified CLI: bun worker-service.cjs hook cursor <command>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Cursor to load the hooks
  3. Check Cursor Settings → Hooks tab to verify

Context Injection:
  Context from past sessions is stored in .cursor/rules/claude-mem-context.mdc
  and automatically included in every chat. It updates after each session ends.
`);
}

/** Ask a running worker for the project's context; true when it was written to the rules file. */
async function generateProjectContext(workspaceRoot: string): Promise<boolean> {
  const projectName = getProjectContext(workspaceRoot).primary;
  console.log(`  Generating initial context...`);
  try {
    return await fetchInitialContextFromWorker(projectName, workspaceRoot);
  } catch (error) {
    logger.debug('WORKER', 'Worker not running during install', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

async function fetchInitialContextFromWorker(
  projectName: string,
  workspaceRoot: string,
): Promise<boolean> {
  const healthResponse = await workerHttpRequest('/api/readiness');
  if (!healthResponse.ok) return false;

  const contextResponse = await workerHttpRequest(
    `/api/context/inject?project=${encodeURIComponent(projectName)}`,
  );
  if (!contextResponse.ok) return false;

  const context = await contextResponse.text();
  if (context && context.trim()) {
    writeContextFile(workspaceRoot, context);
    console.log(`  Generated initial context from existing memory`);
    return true;
  }
  return false;
}

export function uninstallCursorHooks(target: CursorInstallTarget): number {
  console.log(`\nUninstalling Claude-Mem Cursor hooks (${target} level)...\n`);

  const targetDir = getTargetDir(target);
  if (!targetDir) {
    console.error(`Invalid target: ${target}`);
    return 1;
  }

  try {
    const workspaceRoot = process.cwd();
    // Built for removal: a plugin folder that is gone must not stop the uninstall (libraryRemovalEnvironment).
    const environment = libraryRemovalEnvironment(currentLibraryInstallEnvironment());
    const request = cursorLibraryRequest(targetDir, workspaceRoot, target === 'project' ? null : undefined, environment);
    const items = [...request.items, cursorMcpItem(environment.mcpServerPath!, path.join(targetDir, 'mcp.json')).item];
    removeLibraryForInstaller({ agentId: 'cursor', items, jsonStyles: request.jsonStyles, groups: [...request.ownedGroups, `mcp:${targetDir}`] });
    console.log(`  Removed claude-mem entries from hooks.json (other hooks preserved)`);

    // Scripts older installers copied next to hooks.json; hooks.json no longer runs them.
    for (const name of CURSOR_LEGACY_HOOK_SCRIPT_BASENAMES) {
      for (const script of [`${name}.sh`, `${name}.ps1`]) {
        const scriptPath = path.join(targetDir, 'hooks', script);
        if (existsSync(scriptPath)) {
          unlinkSync(scriptPath);
          console.log(`  Removed legacy script: ${script}`);
        }
      }
    }

    if (target === 'project') {
      unregisterCursorProject(getProjectContext(workspaceRoot).primary);
      console.log(`  Unregistered from auto-context updates`);
    }

    console.log(`\nUninstallation complete!\n`);
    console.log('Restart Cursor to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cursorHookCommand(hook: unknown): string | null {
  const command = (hook as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command.trim() : null;
}

/** Every hook entry in a parsed hooks.json, across all events. */
function allCursorHookEntries(config: Record<string, any>): unknown[] {
  if (!isPlainObject(config.hooks)) return [];
  return Object.values(config.hooks).flatMap((entries) => (Array.isArray(entries) ? entries : []));
}

export function checkCursorHooksStatus(): number {
  console.log('\nClaude-Mem Cursor Hooks Status\n');

  const locations: Array<{ name: string; dir: string }> = [
    { name: 'Project', dir: path.join(process.cwd(), '.cursor') },
    { name: 'User', dir: path.join(homedir(), '.cursor') },
  ];

  if (process.platform === 'darwin') {
    locations.push({ name: 'Enterprise', dir: '/Library/Application Support/Cursor' });
  } else if (process.platform === 'linux') {
    locations.push({ name: 'Enterprise', dir: '/etc/cursor' });
  }

  let anyInstalled = false;

  for (const loc of locations) {
    const hooksJson = path.join(loc.dir, 'hooks.json');

    if (!existsSync(hooksJson)) {
      console.log(`${loc.name}: Not installed`);
      console.log('');
      continue;
    }

    let hooksContent: Record<string, any>;
    try {
      const parsed = parseJsonWithBom<unknown>(readFileSync(hooksJson, 'utf-8'));
      if (!isPlainObject(parsed)) throw new Error('top-level value is not an object');
      hooksContent = parsed;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'Unable to parse hooks.json', { path: hooksJson }, cause);
      console.log(`${loc.name}: Unknown (unable to parse hooks.json)`);
      console.log(`   Config: ${hooksJson}`);
      console.log('');
      continue;
    }

    // hooks.json is shared with the user's own hooks, so its existence says
    // nothing: installed means at least one of our entries is in it.
    const entries = allCursorHookEntries(hooksContent);
    const unifiedEntries = entries.filter(isUnifiedClaudeMemCursorHook);
    const legacyCommands = entries.filter(isLegacyClaudeMemCursorHook).map((hook) => cursorHookCommand(hook) ?? '');
    const userHookCount = entries.length - unifiedEntries.length - legacyCommands.length;

    if (unifiedEntries.length === 0 && legacyCommands.length === 0) {
      console.log(`${loc.name}: Not installed (hooks.json has ${userHookCount} user hook${userHookCount === 1 ? '' : 's'})`);
      console.log('');
      continue;
    }

    anyInstalled = true;
    console.log(`${loc.name}: Installed`);
    console.log(`   Config: ${hooksJson}`);
    if (unifiedEntries.length > 0) {
      console.log(`   Mode: Unified CLI (bun worker-service.cjs)`);
    }
    if (legacyCommands.length > 0) {
      const hasBash = legacyCommands.some((command) => /\.sh["']?$/.test(command));
      const hasPs = legacyCommands.some((command) => /\.ps1["']?$/.test(command));
      console.log(`   Mode: Legacy shell scripts (consider reinstalling for unified CLI)`);
      if (hasBash && hasPs) {
        console.log(`   Platform: Both (bash + PowerShell)`);
      } else if (hasBash) {
        console.log(`   Platform: Unix (bash)`);
      } else {
        console.log(`   Platform: Windows (PowerShell)`);
      }
    }
    if (userHookCount > 0) {
      console.log(`   Other hooks: ${userHookCount} (preserved)`);
    }

    if (loc.name === 'Project') {
      const contextFile = path.join(loc.dir, 'rules', 'claude-mem-context.mdc');
      if (existsSync(contextFile)) {
        console.log(`   Context: Active`);
      } else {
        console.log(`   Context: Not yet generated (will be created on first prompt)`);
      }
    }
    console.log('');
  }

  if (!anyInstalled) {
    console.log('No hooks installed. Run: claude-mem cursor install\n');
  }

  return 0;
}

export async function handleCursorCommand(subcommand: string, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const target = (args[0] || 'project') as CursorInstallTarget;
      return installCursorHooks(target);
    }

    case 'uninstall': {
      const target = (args[0] || 'project') as CursorInstallTarget;
      return uninstallCursorHooks(target);
    }

    case 'status': {
      return checkCursorHooksStatus();
    }

    case 'setup': {
      console.log('Use the main entry point for setup');
      return 0;
    }

    default: {
      console.log(`
Claude-Mem Cursor Integration

Usage: claude-mem cursor <command> [options]

Commands:
  setup               Interactive guided setup (recommended for first-time users)

  install [target]    Install Cursor hooks
                      target: project (default), user, or enterprise

  uninstall [target]  Remove Cursor hooks
                      target: project (default), user, or enterprise

  status              Check installation status

Examples:
  npm run cursor:setup                   # Interactive wizard (recommended)
  npm run cursor:install                 # Install for current project
  claude-mem cursor install user         # Install globally for user
  claude-mem cursor uninstall            # Remove from current project
  claude-mem cursor status               # Check if hooks are installed

For more info: https://docs.claude-mem.ai/cursor
      `);
      return 0;
    }
  }
}

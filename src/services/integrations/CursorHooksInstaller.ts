
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { getProjectContext } from '../../utils/project-name.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import {
  readCursorRegistry as readCursorRegistryFromFile,
  registerCursorProject as registerCursorProjectInFile,
  unregisterCursorProject as unregisterCursorProjectInFile,
  configureCursorMcp as configureCursorMcpFile,
  writeContextFile,
  type CursorProjectRegistry
} from '../../utils/cursor-utils.js';
import type { CursorInstallTarget, CursorHooksJson } from './types.js';
import {
  getMcpServerAbsolutePath,
  getWorkerServiceAbsolutePath,
  getBunAbsolutePath,
} from './install-paths.js';

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

  const hooksJsonPath = path.join(targetDir, 'hooks.json');

  const bunPath = getBunAbsolutePath();
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');

  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  const callOperator = process.platform === 'win32' ? '& ' : '';
  const makeHookCommand = (command: string) => {
    return `${callOperator}"${escapedBunPath}" "${escapedWorkerPath}" hook cursor ${command}`;
  };

  console.log(`  Using Bun runtime: ${bunPath}`);

  const hooksJson: CursorHooksJson = {
    version: 1,
    hooks: {
      beforeSubmitPrompt: [
        { command: makeHookCommand('session-init') },
        { command: makeHookCommand('context') }
      ],
      afterMCPExecution: [
        { command: makeHookCommand('observation') }
      ],
      afterShellExecution: [
        { command: makeHookCommand('observation') }
      ],
      afterFileEdit: [
        { command: makeHookCommand('file-edit') }
      ],
      stop: [
        { command: makeHookCommand('summarize') }
      ]
    }
  };

  try {
    mkdirSync(targetDir, { recursive: true });
    await writeHooksJsonAndSetupProject(hooksJsonPath, hooksJson, workerServicePath, target, targetDir, workspaceRoot);
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

type CursorHookEntry = { command?: unknown };

// Older installers copied these scripts into <target>/hooks/ and pointed
// hooks.json at them (`./.cursor/hooks/session-init.sh`, an absolute
// `<dir>/hooks/session-init.sh`, or `powershell.exe ... -File "<dir>/hooks/session-init.ps1"`).
const LEGACY_HOOK_SCRIPT_BASENAMES = [
  'common', 'session-init', 'context-inject', 'save-observation', 'save-file-edit', 'session-summary',
];
const LEGACY_BASH_SCRIPTS = LEGACY_HOOK_SCRIPT_BASENAMES.map((name) => `${name}.sh`);
const LEGACY_POWERSHELL_SCRIPTS = LEGACY_HOOK_SCRIPT_BASENAMES.map((name) => `${name}.ps1`);

// Narrow on purpose: the script must sit directly in a `hooks` directory and
// have one of our exact basenames, so a user's `./my-session-init.sh` stays theirs.
const LEGACY_HOOK_COMMAND_PATTERN = new RegExp(
  `(?:^|[\\s"'\\\\/])hooks[\\\\/](?:${LEGACY_HOOK_SCRIPT_BASENAMES.join('|')})\\.(?:sh|ps1)["']?$`,
);

function cursorHookCommand(hook: unknown): string | null {
  const command = (hook as CursorHookEntry | null)?.command;
  return typeof command === 'string' ? command.trim() : null;
}

function isUnifiedClaudeMemCursorHook(hook: unknown): boolean {
  const command = cursorHookCommand(hook);
  return command !== null && command.includes('worker-service') && command.includes('hook cursor');
}

function isLegacyClaudeMemCursorHook(hook: unknown): boolean {
  const command = cursorHookCommand(hook);
  return command !== null && LEGACY_HOOK_COMMAND_PATTERN.test(command);
}

/**
 * A hook entry is ours when it runs `worker-service ... hook cursor <command>`
 * or one of the legacy hook scripts older installers wrote. Anything else in
 * hooks.json belongs to the user (or another tool).
 */
function isClaudeMemCursorHook(hook: unknown): boolean {
  return isUnifiedClaudeMemCursorHook(hook) || isLegacyClaudeMemCursorHook(hook);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every hook entry in a parsed hooks.json, across all events. */
function allCursorHookEntries(config: Record<string, any>): unknown[] {
  if (!isPlainObject(config.hooks)) return [];
  return Object.values(config.hooks).flatMap((entries) => (Array.isArray(entries) ? entries : []));
}

function readExistingCursorHooksJson(hooksJsonPath: string): Record<string, any> | null {
  if (!existsSync(hooksJsonPath)) return null;
  try {
    const parsed = parseJsonWithBom<unknown>(readFileSync(hooksJsonPath, 'utf-8'));
    if (!isPlainObject(parsed)) {
      throw new Error('top-level value is not an object');
    }
    // A shape we don't understand is the user's to fix: rewriting it would
    // silently drop whatever they meant to put there.
    if (parsed.hooks !== undefined) {
      if (!isPlainObject(parsed.hooks)) {
        throw new Error('"hooks" is not an object');
      }
      for (const [eventName, entries] of Object.entries(parsed.hooks)) {
        if (!Array.isArray(entries)) {
          throw new Error(`"hooks.${eventName}" is not an array`);
        }
      }
    }
    return parsed;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error('WORKER', 'Corrupt hooks.json, refusing to overwrite', { path: hooksJsonPath }, cause);
    throw new Error(`Corrupt hooks.json at ${hooksJsonPath}, refusing to overwrite (${cause.message})`);
  }
}

/** Merge our hooks into whatever the user already has, replacing only our own earlier entries. */
function mergeCursorHooksJson(existing: Record<string, any> | null, ours: CursorHooksJson): Record<string, any> {
  const merged: Record<string, any> = { ...(existing ?? {}) };
  if (typeof merged.version !== 'number') merged.version = ours.version;
  const existingHooks: Record<string, any> =
    merged.hooks && typeof merged.hooks === 'object' && !Array.isArray(merged.hooks) ? merged.hooks : {};
  const mergedHooks: Record<string, any> = { ...existingHooks };

  for (const [eventName, entries] of Object.entries(ours.hooks)) {
    const kept = Array.isArray(existingHooks[eventName])
      ? existingHooks[eventName].filter((hook: unknown) => !isClaudeMemCursorHook(hook))
      : [];
    mergedHooks[eventName] = [...kept, ...(entries ?? [])];
  }

  merged.hooks = mergedHooks;
  return merged;
}

/** Drop only our entries. Returns the file's remaining content, or null when no hooks remain. */
function removeClaudeMemCursorHooks(existing: Record<string, any>): Record<string, any> | null {
  const hooks: Record<string, any> =
    existing.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks) ? { ...existing.hooks } : {};

  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((hook) => !isClaudeMemCursorHook(hook));
    if (kept.length === 0) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = kept;
    }
  }

  if (Object.keys(hooks).length === 0) return null;
  return { ...existing, hooks };
}

async function writeHooksJsonAndSetupProject(
  hooksJsonPath: string,
  hooksJson: CursorHooksJson,
  workerServicePath: string,
  target: CursorInstallTarget,
  targetDir: string,
  workspaceRoot: string,
): Promise<void> {
  const merged = mergeCursorHooksJson(readExistingCursorHooksJson(hooksJsonPath), hooksJson);
  writeFileSync(hooksJsonPath, JSON.stringify(merged, null, 2));
  console.log(`  Wrote hooks.json (unified CLI mode, existing hooks preserved)`);
  console.log(`  Worker service: ${workerServicePath}`);

  if (target === 'project') {
    await setupProjectContext(targetDir, workspaceRoot);
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

async function setupProjectContext(targetDir: string, workspaceRoot: string): Promise<void> {
  const rulesDir = path.join(targetDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });

  const projectName = getProjectContext(workspaceRoot).primary;
  let contextGenerated = false;

  console.log(`  Generating initial context...`);

  try {
    contextGenerated = await fetchInitialContextFromWorker(projectName, workspaceRoot);
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not running during install', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not running during install', {}, new Error(String(error)));
    }
  }

  if (!contextGenerated) {
    const rulesFile = path.join(rulesDir, 'claude-mem-context.mdc');
    const placeholderContent = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
`;
    writeFileSync(rulesFile, placeholderContent);
    console.log(`  Created placeholder context file (will populate after first session)`);
  }

  registerCursorProject(projectName, workspaceRoot);
  console.log(`  Registered for auto-context updates`);
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

  const hooksDir = path.join(targetDir, 'hooks');
  const hooksJsonPath = path.join(targetDir, 'hooks.json');

  const allScripts = [...LEGACY_BASH_SCRIPTS, ...LEGACY_POWERSHELL_SCRIPTS];

  try {
    removeCursorHooksFiles(hooksDir, allScripts, hooksJsonPath, target, targetDir);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

function removeCursorHooksFiles(
  hooksDir: string,
  allScripts: string[],
  hooksJsonPath: string,
  target: CursorInstallTarget,
  targetDir: string,
): void {
  // hooks.json first: a file we can't parse may still point at the legacy
  // scripts, so those stay too rather than leaving Cursor running missing files.
  let hooksJsonUnderstood = true;
  if (existsSync(hooksJsonPath)) {
    let remaining: Record<string, any> | null = null;
    try {
      remaining = removeClaudeMemCursorHooks(readExistingCursorHooksJson(hooksJsonPath)!);
    } catch {
      hooksJsonUnderstood = false;
      console.log(`  Warning: could not parse hooks.json — leaving it and any legacy hook scripts intact to preserve other hooks`);
    }
    if (hooksJsonUnderstood) {
      if (remaining === null) {
        unlinkSync(hooksJsonPath);
        console.log(`  Removed hooks.json (no hooks remaining)`);
      } else {
        writeFileSync(hooksJsonPath, JSON.stringify(remaining, null, 2));
        console.log(`  Removed claude-mem entries from hooks.json (other hooks preserved)`);
      }
    }
  }

  if (hooksJsonUnderstood) {
    for (const script of allScripts) {
      const scriptPath = path.join(hooksDir, script);
      if (existsSync(scriptPath)) {
        unlinkSync(scriptPath);
        console.log(`  Removed legacy script: ${script}`);
      }
    }
  }

  if (target === 'project') {
    const contextFile = path.join(targetDir, 'rules', 'claude-mem-context.mdc');
    if (existsSync(contextFile)) {
      unlinkSync(contextFile);
      console.log(`  Removed context file`);
    }

    const projectName = getProjectContext(process.cwd()).primary;
    unregisterCursorProject(projectName);
    console.log(`  Unregistered from auto-context updates`);
  }

  console.log(`\nUninstallation complete!\n`);
  console.log('Restart Cursor to apply changes.');
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


import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { getWorkerPort, workerHttpRequest } from '../../shared/worker-utils.js';
import { DATA_DIR, MARKETPLACE_ROOT, CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
import {
  readCursorRegistry as readCursorRegistryFromFile,
  writeCursorRegistry as writeCursorRegistryToFile,
  writeContextFile,
  type CursorProjectRegistry
} from '../../utils/cursor-utils.js';
import type { CursorInstallTarget, CursorHooksJson, CursorMcpConfig, Platform } from './types.js';

const execAsync = promisify(exec);

const CURSOR_REGISTRY_FILE = path.join(DATA_DIR, 'cursor-projects.json');

export function detectPlatform(): Platform {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

export function getScriptExtension(): string {
  return detectPlatform() === 'windows' ? '.ps1' : '.sh';
}

export function readCursorRegistry(): CursorProjectRegistry {
  return readCursorRegistryFromFile(CURSOR_REGISTRY_FILE);
}

export function writeCursorRegistry(registry: CursorProjectRegistry): void {
  writeCursorRegistryToFile(CURSOR_REGISTRY_FILE, registry);
}

export function registerCursorProject(projectName: string, workspacePath: string): void {
  const registry = readCursorRegistry();
  registry[projectName] = {
    workspacePath,
    installedAt: new Date().toISOString()
  };
  writeCursorRegistry(registry);
  logger.info('CURSOR', 'Registered project for auto-context updates', { projectName, workspacePath });
}

export function unregisterCursorProject(projectName: string): void {
  const registry = readCursorRegistry();
  if (registry[projectName]) {
    delete registry[projectName];
    writeCursorRegistry(registry);
    logger.info('CURSOR', 'Unregistered project', { projectName });
  }
}

export async function updateCursorContextForProject(projectName: string, _port: number): Promise<void> {
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

export function findMcpServerPath(): string | null {
  const possiblePaths = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'mcp-server.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'mcp-server.cjs'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

export function findWorkerServicePath(): string | null {
  const possiblePaths = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

export function findBunPath(): string {
  const possiblePaths = [
    path.join(homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    ...(process.platform === 'win32' ? [
      path.join(homedir(), '.bun', 'bin', 'bun.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'bun', 'bun.exe'),
    ] : []),
  ];

  for (const p of possiblePaths) {
    if (p && existsSync(p)) {
      return p;
    }
  }

  return 'bun';
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
  const mcpServerPath = findMcpServerPath();

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
    mkdirSync(targetDir, { recursive: true });

    let config: CursorMcpConfig = { mcpServers: {} };
    if (existsSync(mcpJsonPath)) {
      try {
        config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
      } catch (error) {
        if (error instanceof Error) {
          logger.error('WORKER', 'Corrupt mcp.json, creating new config', { path: mcpJsonPath }, error);
        } else {
          logger.error('WORKER', 'Corrupt mcp.json, creating new config', { path: mcpJsonPath }, new Error(String(error)));
        }
        config = { mcpServers: {} };
      }
    }

    config.mcpServers['claude-mem'] = {
      command: 'node',
      args: [mcpServerPath]
    };

    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
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

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const workspaceRoot = process.cwd();

  const hooksJsonPath = path.join(targetDir, 'hooks.json');

  const bunPath = findBunPath();
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');

  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  const makeHookCommand = (command: string) => {
    return `"${escapedBunPath}" "${escapedWorkerPath}" hook cursor ${command}`;
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

async function writeHooksJsonAndSetupProject(
  hooksJsonPath: string,
  hooksJson: CursorHooksJson,
  workerServicePath: string,
  target: CursorInstallTarget,
  targetDir: string,
  workspaceRoot: string,
): Promise<void> {
  writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
  console.log(`  Created hooks.json (unified CLI mode)`);
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

  const projectName = path.basename(workspaceRoot);
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

  const bashScripts = ['common.sh', 'session-init.sh', 'context-inject.sh',
                      'save-observation.sh', 'save-file-edit.sh', 'session-summary.sh'];
  const psScripts = ['common.ps1', 'session-init.ps1', 'context-inject.ps1',
                     'save-observation.ps1', 'save-file-edit.ps1', 'session-summary.ps1'];

  const allScripts = [...bashScripts, ...psScripts];

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
  for (const script of allScripts) {
    const scriptPath = path.join(hooksDir, script);
    if (existsSync(scriptPath)) {
      unlinkSync(scriptPath);
      console.log(`  Removed legacy script: ${script}`);
    }
  }

  if (existsSync(hooksJsonPath)) {
    unlinkSync(hooksJsonPath);
    console.log(`  Removed hooks.json`);
  }

  if (target === 'project') {
    const contextFile = path.join(targetDir, 'rules', 'claude-mem-context.mdc');
    if (existsSync(contextFile)) {
      unlinkSync(contextFile);
      console.log(`  Removed context file`);
    }

    const projectName = path.basename(process.cwd());
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
    const hooksDir = path.join(loc.dir, 'hooks');

    if (existsSync(hooksJson)) {
      anyInstalled = true;
      console.log(`${loc.name}: Installed`);
      console.log(`   Config: ${hooksJson}`);

      let hooksContent: any = null;
      try {
        hooksContent = JSON.parse(readFileSync(hooksJson, 'utf-8'));
      } catch (error) {
        if (error instanceof Error) {
          logger.error('WORKER', 'Unable to parse hooks.json', { path: hooksJson }, error);
        } else {
          logger.error('WORKER', 'Unable to parse hooks.json', { path: hooksJson }, new Error(String(error)));
        }
        console.log(`   Mode: Unable to parse hooks.json`);
      }

      if (hooksContent) {
        const firstCommand = hooksContent?.hooks?.beforeSubmitPrompt?.[0]?.command || '';

        if (firstCommand.includes('worker-service.cjs') && firstCommand.includes('hook cursor')) {
          console.log(`   Mode: Unified CLI (bun worker-service.cjs)`);
        } else {
          const bashScripts = ['session-init.sh', 'context-inject.sh', 'save-observation.sh'];
          const psScripts = ['session-init.ps1', 'context-inject.ps1', 'save-observation.ps1'];

          const hasBash = bashScripts.some(s => existsSync(path.join(hooksDir, s)));
          const hasPs = psScripts.some(s => existsSync(path.join(hooksDir, s)));

          if (hasBash || hasPs) {
            console.log(`   Mode: Legacy shell scripts (consider reinstalling for unified CLI)`);
            if (hasBash && hasPs) {
              console.log(`   Platform: Both (bash + PowerShell)`);
            } else if (hasBash) {
              console.log(`   Platform: Unix (bash)`);
            } else if (hasPs) {
              console.log(`   Platform: Windows (PowerShell)`);
            }
          } else {
            console.log(`   Mode: Unknown configuration`);
          }
        }
      }

      if (loc.name === 'Project') {
        const contextFile = path.join(loc.dir, 'rules', 'claude-mem-context.mdc');
        if (existsSync(contextFile)) {
          console.log(`   Context: Active`);
        } else {
          console.log(`   Context: Not yet generated (will be created on first prompt)`);
        }
      }
    } else {
      console.log(`${loc.name}: Not installed`);
    }
    console.log('');
  }

  if (!anyInstalled) {
    console.log('No hooks installed. Run: claude-mem cursor install\n');
  }

  return 0;
}

export async function detectClaudeCode(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('which claude || where claude', { timeout: 5000 });
    if (stdout.trim()) {
      return true;
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('WORKER', 'Claude CLI not in PATH', {}, error);
    } else {
      logger.debug('WORKER', 'Claude CLI not in PATH', {}, new Error(String(error)));
    }
  }

  const pluginDir = path.join(CLAUDE_CONFIG_DIR, 'plugins');
  if (existsSync(pluginDir)) {
    return true;
  }

  return false;
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

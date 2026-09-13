/**
 * CopilotCliHooksInstaller.ts — GitHub Copilot CLI user-level hooks.json writer.
 *
 * Copilot CLI loads every `*.json` file under `~/.copilot/hooks/` (or
 * `$COPILOT_HOOKS_DIR`). Each file is version 1 with a `hooks` map of event
 * name → command entries. Entries use `exec` + `args` so the host does not
 * go through a shell (see Copilot CLI hook docs).
 *
 * Unlike Claude Code / Cursor, Copilot CLI does not expand
 * `${CLAUDE_PLUGIN_ROOT}` — absolute paths are baked at install time (Rule B).
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';
import { getBunAbsolutePath as findBunPath, getWorkerServiceAbsolutePath as findWorkerServicePath, getMcpServerAbsolutePath } from './install-paths.js';
import { writeMcpJsonConfig } from './McpIntegrations.js';

export const COPILOT_CLI_HOOKS_DIR = process.env.COPILOT_HOOKS_DIR
  || join(homedir(), '.copilot', 'hooks');
export const COPILOT_CLI_HOOKS_FILE = join(COPILOT_CLI_HOOKS_DIR, 'claude-mem.json');

/** Copilot CLI reads this file for MCP servers. */
export const COPILOT_CLI_MCP_CONFIG = join(homedir(), '.copilot', 'mcp-config.json');
/** Older GitHub Copilot docs path — dual-write so both hosts see the server. */
export const COPILOT_CLI_LEGACY_MCP_CONFIG = join(homedir(), '.github', 'copilot', 'mcp.json');

const MARKER_ENV = 'CLAUDE_MEM_COPILOT_HOOK';

interface CopilotHookCommand {
  type: 'command';
  exec: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}

interface CopilotHooksFile {
  version: 1;
  hooks: Record<string, CopilotHookCommand[]>;
}

function hookCommand(exec: string, args: string[], timeoutSec: number): CopilotHookCommand {
  return {
    type: 'command',
    exec,
    args,
    cwd: homedir(),
    env: { [MARKER_ENV]: '1' },
    timeoutSec,
  };
}

function buildHooksFile(exec: string, workerPath: string): CopilotHooksFile {
  const hook = (event: string, timeoutSec: number) =>
    hookCommand(exec, [workerPath, 'hook', 'copilot', event], timeoutSec);

  return {
    version: 1,
    hooks: {
      sessionStart: [hook('context', 20)],
      userPromptSubmitted: [hook('session-init', 15)],
      postToolUse: [hook('observation', 120)],
      postToolUseFailure: [hook('observation', 120)],
      sessionEnd: [hook('summarize', 60)],
    },
  };
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

export async function installCopilotCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Copilot CLI hooks + MCP...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();

  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    mkdirSync(COPILOT_CLI_HOOKS_DIR, { recursive: true });
    writeJsonAtomic(COPILOT_CLI_HOOKS_FILE, buildHooksFile(bunPath, workerServicePath));
    console.log(`  Wrote hooks to ${COPILOT_CLI_HOOKS_FILE}`);

    const mcpServerPath = getMcpServerAbsolutePath();
    if (!mcpServerPath) {
      console.error('Could not find MCP server script — hooks installed, MCP skipped');
    } else {
      writeMcpJsonConfig(COPILOT_CLI_MCP_CONFIG, mcpServerPath);
      writeMcpJsonConfig(COPILOT_CLI_LEGACY_MCP_CONFIG, mcpServerPath);
      console.log(`  MCP config: ${COPILOT_CLI_MCP_CONFIG}`);
      console.log(`  MCP config (legacy): ${COPILOT_CLI_LEGACY_MCP_CONFIG}`);
    }

    console.log(`
Installation complete!

Hooks installed to: ${COPILOT_CLI_HOOKS_FILE}
Using unified CLI: bun worker-service.cjs hook copilot <event>

Events registered:
  - sessionStart         (context injection)
  - userPromptSubmitted  (session init)
  - postToolUse          (observation)
  - sessionEnd           (summarize)

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Copilot CLI so it reloads ~/.copilot/hooks/
  3. Memory will be captured automatically during sessions
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    logger.warn('HOOK', `Copilot CLI install failed: ${message}`);
    return 1;
  }
}

/**
 * Remove claude-mem's Copilot CLI hook file. Does not touch other `*.json`
 * files in `~/.copilot/hooks/`.
 */
export function uninstallCopilotCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Copilot CLI hooks...\n');
  if (!existsSync(COPILOT_CLI_HOOKS_FILE)) {
    console.log(`  No hooks file at ${COPILOT_CLI_HOOKS_FILE}`);
    return 0;
  }
  try {
    unlinkSync(COPILOT_CLI_HOOKS_FILE);
    console.log(`  Removed ${COPILOT_CLI_HOOKS_FILE}`);
    logger.info('HOOK', `Removed Copilot CLI hooks at ${COPILOT_CLI_HOOKS_FILE}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to remove Copilot CLI hooks: ${message}`);
    logger.warn('HOOK', `Failed to remove Copilot CLI hooks: ${message}`);
    return 1;
  }
}

export function copilotCliHooksInstalled(): boolean {
  return existsSync(COPILOT_CLI_HOOKS_FILE);
}

/** @internal test helper */
export function _buildCopilotCliHooksFile(exec: string, workerPath: string): CopilotHooksFile {
  return buildHooksFile(exec, workerPath);
}

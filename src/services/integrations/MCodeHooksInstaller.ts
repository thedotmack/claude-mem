/**
 * MCodeHooksInstaller.ts — MiniMax Code (`mcode`) integration (hooks + MCP).
 *
 * MiniMax Code reads user hooks from hooks.json and MCP servers from the
 * `mcpServers` of mcp.json, both in its data directory ($MINIMAX_DATA_DIR,
 * default ~/.minimax). Its hooks send Claude Code field names, so the worker
 * runs the same handlers. Only the hook entries and the `claude-mem` server
 * this installer writes are touched. Absolute paths are baked per Rule B
 * (install-paths.ts).
 *
 * No PreToolUse rule: its output can deny or rewrite tool calls (#5085).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { getBunAbsolutePath, getMcpServerAbsolutePath, getWorkerServiceAbsolutePath } from './install-paths.js';
import { writeMcpJsonConfig } from './McpIntegrations.js';

interface MCodeHookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface MCodeHookRule {
  matcher?: string;
  hooks: MCodeHookCommand[];
  [key: string]: unknown;
}

type MCodeHooks = Record<string, MCodeHookRule[]>;

interface MCodeHooksFile {
  enabled?: unknown;
  hooks?: MCodeHooks;
  [key: string]: unknown;
}

const MCP_SERVER_NAME = 'claude-mem';
// MiniMax Code drops, without a warning, any hook whose timeout is over 10 seconds.
const MCODE_HOOK_TIMEOUT_SECONDS = 10;

export function mcodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINIMAX_DATA_DIR || path.join(homedir(), '.minimax');
}

/** The MiniMax Code events claude-mem has a handler for. */
export function buildMCodeHooks(bunPath: string, workerPath: string): MCodeHooks {
  const rule = (suffix: string): MCodeHookRule => ({
    hooks: [{ type: 'command', command: `"${bunPath}" "${workerPath}" ${suffix}`, timeout: MCODE_HOOK_TIMEOUT_SECONDS }],
  });
  return {
    SessionStart: [rule('start'), rule('hook mcode context')],
    UserPromptSubmit: [rule('hook mcode session-init')],
    PostToolUse: [rule('hook mcode observation')],
    Stop: [rule('hook mcode summarize')],
  };
}

// Ours only in the exact shape buildMCodeHooks writes: a quoted Bun runtime,
// the quoted plugin worker, then one of our subcommands.
const OWN_COMMAND = /^"(?:[^"]*[\\/])?bun(?:\.exe)?" "[^"]*[\\/]scripts[\\/]worker-service\.cjs" (start|hook mcode (?:context|session-init|observation|summarize))$/;

export function isClaudeMemMCodeHook(hook: MCodeHookCommand): boolean {
  return typeof hook?.command === 'string' && OWN_COMMAND.test(hook.command);
}

/** The hooks without claude-mem's entries; emptied rules and events are dropped. */
export function removeMCodeHooks(hooks: MCodeHooks): MCodeHooks {
  const next: MCodeHooks = {};
  for (const [event, rules] of Object.entries(hooks)) {
    if (!Array.isArray(rules)) {
      next[event] = rules;
      continue;
    }
    const kept = rules
      .map((rule) => Array.isArray(rule?.hooks)
        ? { ...rule, hooks: rule.hooks.filter((hook) => !isClaudeMemMCodeHook(hook)) }
        : rule)
      .filter((rule) => !Array.isArray(rule?.hooks) || rule.hooks.length > 0);
    if (kept.length > 0) next[event] = kept;
  }
  return next;
}

function readHooksFile(hooksPath: string): MCodeHooksFile {
  if (!existsSync(hooksPath)) return {};
  const parsed: unknown = parseJsonWithBom(readFileSync(hooksPath, 'utf-8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${hooksPath} is not a JSON object; refusing to overwrite it`);
  }
  const file = parsed as MCodeHooksFile;
  if (file.hooks !== undefined && (file.hooks === null || typeof file.hooks !== 'object' || Array.isArray(file.hooks))) {
    throw new Error(`"hooks" in ${hooksPath} is not an object; refusing to overwrite it`);
  }
  return file;
}

function backupOnce(filePath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${filePath}.bak-${stamp}`;
  if (existsSync(filePath) && !existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(filePath, 'utf-8'), { mode: 0o600 });
  }
}

export function installMCode(dataDir: string = mcodeDataDir()): number {
  const workerPath = getWorkerServiceAbsolutePath();
  if (!workerPath) {
    console.error('Could not find worker-service.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find mcp-server.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const bunPath = getBunAbsolutePath();
  const hooksPath = path.join(dataDir, 'hooks.json');
  const mcpPath = path.join(dataDir, 'mcp.json');
  try {
    const file = readHooksFile(hooksPath);
    mkdirSync(dataDir, { recursive: true });
    backupOnce(hooksPath);
    // One switch for every hook in this file, and a missing key means off.
    if (file.enabled === undefined) file.enabled = true;
    const hooks = removeMCodeHooks(file.hooks ?? {});
    for (const [event, rules] of Object.entries(buildMCodeHooks(bunPath, workerPath))) {
      hooks[event] = [...(hooks[event] ?? []), ...rules];
    }
    file.hooks = hooks;
    writeJsonFileAtomic(hooksPath, file);
    writeMcpJsonConfig(mcpPath, mcpServerPath);
    console.log(`  Installed MiniMax Code hooks into ${hooksPath}`);
    console.log(`  Configured MCP server in ${mcpPath}`);
    if (file.enabled !== true) {
      console.warn(`  "enabled" is not true in ${hooksPath}; MiniMax Code will not run the hooks until you set it to true.`);
    }
    console.log('  Start a new MiniMax Code session to load them.');
    return 0;
  } catch (error) {
    console.error(`Failed to install MiniMax Code hooks + MCP: ${(error as Error).message}`);
    return 1;
  }
}

export function uninstallMCode(dataDir: string = mcodeDataDir()): number {
  const hooksPath = path.join(dataDir, 'hooks.json');
  const mcpPath = path.join(dataDir, 'mcp.json');
  try {
    const mcp = readJsonSafe<Record<string, any>>(mcpPath, {});
    if (mcp.mcpServers?.[MCP_SERVER_NAME]) {
      delete mcp.mcpServers[MCP_SERVER_NAME];
      writeJsonFileAtomic(mcpPath, mcp);
      console.log(`  Removed claude-mem from ${mcpPath}`);
    }
    const file = readHooksFile(hooksPath);
    if (!file.hooks) return 0;
    const next = removeMCodeHooks(file.hooks);
    if (JSON.stringify(next) === JSON.stringify(file.hooks)) return 0;
    backupOnce(hooksPath);
    file.hooks = next;
    writeJsonFileAtomic(hooksPath, file);
    console.log(`  Removed claude-mem hooks from ${hooksPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to uninstall MiniMax Code hooks + MCP: ${(error as Error).message}`);
    return 1;
  }
}

export function checkMCodeStatus(dataDir: string = mcodeDataDir()): number {
  const hooksPath = path.join(dataDir, 'hooks.json');
  try {
    const file = readHooksFile(hooksPath);
    const installed = Object.values(file.hooks ?? {}).some((rules) => Array.isArray(rules)
      && rules.some((rule) => Array.isArray(rule?.hooks) && rule.hooks.some(isClaudeMemMCodeHook)));
    if (!installed) {
      console.log('  MiniMax Code hooks: not installed');
      return 1;
    }
    if (file.enabled !== true) {
      console.log(`  MiniMax Code hooks: disabled, "enabled" is not true in ${hooksPath}`);
      return 1;
    }
    console.log(`  MiniMax Code hooks: installed (${hooksPath})`);
    return 0;
  } catch (error) {
    console.error(`  MiniMax Code hooks: unreadable config (${(error as Error).message})`);
    return 1;
  }
}

export async function handleMCodeCommand(subcommand: string | undefined, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installMCode();
    case 'uninstall':
      return uninstallMCode();
    case 'status':
      return checkMCodeStatus();
    default:
      console.log('Usage: claude-mem mcode <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}

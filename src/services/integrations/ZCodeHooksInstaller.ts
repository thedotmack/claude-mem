/**
 * ZCodeHooksInstaller.ts — ZCode Desktop integration (hooks + MCP).
 *
 * ZCode reads user hooks from `hooks.events` and MCP servers from
 * `mcp.servers` in ~/.zcode/cli/config.json (zcode.z.ai/en/docs/hooks,
 * /mcp-services). Its hooks send Claude Code field and tool names, so the
 * worker runs the same handlers. The file holds the user's other ZCode
 * settings: one read, one backup, one atomic write, touching only the hook
 * entries and the `claude-mem` server this installer writes. Absolute paths
 * are baked per Rule B (install-paths.ts).
 *
 * No PreToolUse rule: its output can deny or rewrite tool calls (#5085).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { getBunAbsolutePath, getMcpServerAbsolutePath, getWorkerServiceAbsolutePath } from './install-paths.js';
import { buildMcpServerEntry } from './McpIntegrations.js';

export interface ZCodeHookCommand {
  type: string;
  command?: string;
  args?: unknown;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface ZCodeHookRule {
  matcher?: string;
  hooks: ZCodeHookCommand[];
  [key: string]: unknown;
}

export type ZCodeHookEvents = Record<string, ZCodeHookRule[]>;

interface ZCodeConfig {
  hooks?: { enabled?: unknown; events?: ZCodeHookEvents; [key: string]: unknown };
  mcp?: { servers?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

const MCP_SERVER_NAME = 'claude-mem';
const OWN_HOOK_SUBCOMMANDS = new Set(['context', 'session-init', 'observation', 'summarize']);

export function zcodeConfigPath(): string {
  return path.join(homedir(), '.zcode', 'cli', 'config.json');
}

/** The ZCode events claude-mem has a handler for. */
export function buildZCodeHooks(bunPath: string, workerPath: string): ZCodeHookEvents {
  // `process` runs command + args without a shell, so paths with spaces need no quoting.
  // Per-hook timeouts, so a low global hooks.timeoutMs cannot cut `start`.
  const rule = (args: string[], timeoutMs: number): ZCodeHookRule => ({
    matcher: '*',
    hooks: [{ type: 'process', command: bunPath, args: [workerPath, ...args], timeoutMs }],
  });
  const hook = (name: string) => ['hook', 'zcode', name];
  return {
    SessionStart: [rule(['start'], 60000), rule(hook('context'), 60000)],
    UserPromptSubmit: [rule(hook('session-init'), 15000)],
    PostToolUse: [rule(hook('observation'), 120000)],
    PostToolUseFailure: [rule(hook('observation'), 120000)],
    Stop: [rule(hook('summarize'), 120000)],
  };
}

// Ours only in the exact shape buildZCodeHooks writes: a Bun runtime, the
// plugin worker, then one of our subcommands.
export function isClaudeMemZCodeHook(hook: ZCodeHookCommand): boolean {
  if (hook?.type !== 'process' || typeof hook.command !== 'string') return false;
  const runtime = hook.command.split(/[\\/]/).pop();
  if (runtime !== 'bun' && runtime !== 'bun.exe') return false;
  const args = hook.args;
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !/[\\/]scripts[\\/]worker-service\.cjs$/.test(args[0])) return false;
  const rest = args.slice(1);
  if (rest.length === 1) return rest[0] === 'start';
  return rest.length === 3 && rest[0] === 'hook' && rest[1] === 'zcode' && OWN_HOOK_SUBCOMMANDS.has(rest[2]);
}

/** The events without claude-mem's hooks; emptied rules and events are dropped. */
export function removeZCodeHooks(events: ZCodeHookEvents): ZCodeHookEvents {
  const next: ZCodeHookEvents = {};
  for (const [event, rules] of Object.entries(events)) {
    if (!Array.isArray(rules)) {
      next[event] = rules;
      continue;
    }
    const kept = rules
      .map((rule) => Array.isArray(rule?.hooks)
        ? { ...rule, hooks: rule.hooks.filter((hook) => !isClaudeMemZCodeHook(hook)) }
        : rule)
      .filter((rule) => !Array.isArray(rule?.hooks) || rule.hooks.length > 0);
    if (kept.length > 0) next[event] = kept;
  }
  return next;
}

/** Replace claude-mem's hooks with `ours`, leaving every other hook in place. */
export function mergeZCodeHooks(events: ZCodeHookEvents, ours: ZCodeHookEvents): ZCodeHookEvents {
  const next = removeZCodeHooks(events);
  for (const [event, rules] of Object.entries(ours)) {
    next[event] = [...(next[event] ?? []), ...rules];
  }
  return next;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function refuse(configPath: string, key: string): never {
  throw new Error(`${key} in ${configPath} is not a JSON object; refusing to overwrite it`);
}

function readZCodeConfig(configPath: string): ZCodeConfig {
  if (!existsSync(configPath)) return {};
  const config: unknown = parseJsonWithBom(readFileSync(configPath, 'utf-8'));
  if (!isObject(config)) refuse(configPath, 'The root');
  if (config.hooks !== undefined) {
    if (!isObject(config.hooks)) refuse(configPath, '"hooks"');
    if (config.hooks.events !== undefined && !isObject(config.hooks.events)) refuse(configPath, '"hooks.events"');
  }
  if (config.mcp !== undefined) {
    if (!isObject(config.mcp)) refuse(configPath, '"mcp"');
    if (config.mcp.servers !== undefined && !isObject(config.mcp.servers)) refuse(configPath, '"mcp.servers"');
  }
  return config as ZCodeConfig;
}

function backupOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    // Owner-only: the backup holds every ZCode setting, and the default umask
    // would make it world-readable even when config.json is not.
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'), { mode: 0o600 });
  }
}

export function installZCode(configPath: string = zcodeConfigPath()): number {
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
  try {
    const config = readZCodeConfig(configPath);
    mkdirSync(path.dirname(configPath), { recursive: true });
    backupOnce(configPath);
    const hooks = config.hooks ?? {};
    if (hooks.enabled === undefined) hooks.enabled = true;
    hooks.events = mergeZCodeHooks(hooks.events ?? {}, buildZCodeHooks(bunPath, workerPath));
    config.hooks = hooks;
    const mcp = config.mcp ?? {};
    mcp.servers = { ...mcp.servers, [MCP_SERVER_NAME]: buildMcpServerEntry(mcpServerPath) };
    config.mcp = mcp;
    writeJsonFileAtomic(configPath, config);
    console.log(`  Installed ZCode hooks + MCP into ${configPath}`);
    console.log(`    Bun runtime: ${bunPath}`);
    console.log(`    Worker: ${workerPath}`);
    console.log(`    MCP server: ${mcpServerPath}`);
    if (hooks.enabled === false) {
      console.warn(`  hooks.enabled is false in ${configPath}; ZCode will not run the hooks until you set it to true.`);
    }
    console.log('  Start a new ZCode session or run /reload to load them.');
    return 0;
  } catch (error) {
    console.error(`Failed to install ZCode hooks + MCP: ${(error as Error).message}`);
    return 1;
  }
}

export function uninstallZCode(configPath: string = zcodeConfigPath()): number {
  if (!existsSync(configPath)) {
    console.log('  No ZCode config.json found; nothing to uninstall');
    return 0;
  }
  try {
    const config = readZCodeConfig(configPath);
    const events = config.hooks?.events;
    const nextEvents = events ? removeZCodeHooks(events) : undefined;
    const hooksChanged = JSON.stringify(nextEvents) !== JSON.stringify(events);
    const servers = config.mcp?.servers;
    const serverPresent = servers !== undefined && Object.hasOwn(servers, MCP_SERVER_NAME);
    if (!hooksChanged && !serverPresent) {
      console.log('  No claude-mem hooks or MCP server found in ZCode config.json');
      return 0;
    }
    backupOnce(configPath);
    if (config.hooks && hooksChanged) {
      if (nextEvents && Object.keys(nextEvents).length > 0) config.hooks.events = nextEvents;
      else delete config.hooks.events;
      // Only the `enabled: true` install writes; a user's own `false` stays.
      if (config.hooks.enabled === true && Object.keys(config.hooks).length === 1) delete config.hooks;
    }
    if (servers && serverPresent) {
      delete servers[MCP_SERVER_NAME];
      if (Object.keys(servers).length === 0 && config.mcp) {
        delete config.mcp.servers;
        if (Object.keys(config.mcp).length === 0) delete config.mcp;
      }
    }
    writeJsonFileAtomic(configPath, config);
    console.log(`  Removed claude-mem hooks + MCP from ${configPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to uninstall ZCode hooks + MCP: ${(error as Error).message}`);
    return 1;
  }
}

export function checkZCodeStatus(configPath: string = zcodeConfigPath()): number {
  try {
    const events = readZCodeConfig(configPath).hooks?.events ?? {};
    const installed = Object.values(events).some((rules) => Array.isArray(rules)
      && rules.some((rule) => Array.isArray(rule?.hooks) && rule.hooks.some(isClaudeMemZCodeHook)));
    if (installed) {
      console.log(`  ZCode hooks: installed (${configPath})`);
      return 0;
    }
  } catch (error) {
    console.error(`  ZCode hooks: unreadable config (${(error as Error).message})`);
    return 1;
  }
  console.log('  ZCode hooks: not installed');
  return 1;
}

export async function handleZCodeCommand(subcommand: string | undefined, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installZCode();
    case 'uninstall':
      return uninstallZCode();
    case 'status':
      return checkZCodeStatus();
    default:
      console.log('Usage: claude-mem zcode <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}

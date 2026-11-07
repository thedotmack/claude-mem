/**
 * DevinHooksInstaller.ts — first-class Devin CLI / Devin Desktop integration.
 *
 * Devin reads user-level hooks from the `"hooks"` key of
 * ~/.config/devin/config.json (%APPDATA%\devin\config.json on Windows), in the
 * Claude Code shape: `{ "<Event>": [{ "matcher", "hooks": [{ "type",
 * "command", "timeout" }] }] }` (docs.devin.ai cli/extensibility/hooks).
 * The file holds the user's other Devin settings, so the merge is
 * JSON-level and touches only the hook entries whose command runs
 * claude-mem's worker. Absolute paths are baked per Rule B (install-paths.ts).
 *
 * No PreToolUse rule: Devin's PreToolUse output can rewrite tool input
 * (`updatedInput`) and approve calls; see #5085 for what a stray PreToolUse
 * registration did on Antigravity.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { getBunAbsolutePath, getMcpServerAbsolutePath, getWorkerServiceAbsolutePath } from './install-paths.js';
import { buildMcpServerEntry } from './McpIntegrations.js';

interface DevinHookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface DevinHookRule {
  matcher?: string;
  hooks: DevinHookCommand[];
  [key: string]: unknown;
}

type DevinHooks = Record<string, DevinHookRule[]>;

interface DevinConfig {
  hooks?: DevinHooks;
  [key: string]: unknown;
}

export function devinConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.win32.join(appData, 'devin', 'config.json');
  }
  return path.join(homedir(), '.config', 'devin', 'config.json');
}

/**
 * Devin v3000.3+ keeps MCP servers in a dedicated mcp_config.json next to
 * config.json (older versions read `mcpServers` from config.json and migrate
 * them automatically — docs.devin.ai cli/extensibility/mcp/configuration).
 */
export function devinMcpConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.win32.join(appData, 'devin', 'mcp_config.json');
  }
  return path.join(homedir(), '.config', 'devin', 'mcp_config.json');
}

/** The Claude Code hook surface Devin has: the same handlers, minus PreToolUse. */
export function buildDevinHooks(bunPath: string, workerPath: string): DevinHooks {
  const run = (suffix: string) => `"${bunPath}" "${workerPath}" ${suffix}`;
  const rule = (suffix: string, timeout: number): DevinHookRule => ({
    matcher: '',
    hooks: [{ type: 'command', command: run(suffix), timeout }],
  });
  return {
    SessionStart: [rule('start', 60), rule('hook devin context', 60)],
    // Devin's SessionStart fires only on startup and resume. After compaction
    // it fires PostCompaction instead, so the timeline is re-injected there.
    PostCompaction: [rule('hook devin context', 60)],
    UserPromptSubmit: [rule('hook devin session-init', 15)],
    PostToolUse: [rule('hook devin observation', 120)],
    Stop: [rule('hook devin summarize', 120)],
    SessionEnd: [rule('hook devin session-end', 30)],
  };
}

// Ours only in the exact shape buildDevinHooks writes: a quoted Bun runtime,
// the quoted plugin worker, then one of our subcommands. A command that merely
// mentions the worker (`echo "/tmp/worker-service.cjs" start`) is the user's.
const OWN_COMMAND = /^"(?:[^"]*[\\/])?bun(?:\.exe)?" "[^"]*[\\/]scripts[\\/]worker-service\.cjs" (?:start|hook devin (?:context|session-init|observation|summarize|session-end))$/;

export function isClaudeMemDevinCommand(hook: DevinHookCommand): boolean {
  return typeof hook.command === 'string' && OWN_COMMAND.test(hook.command);
}

/** The hooks without claude-mem's entries; a rule left with no commands is dropped. */
export function removeDevinHooks(hooks: DevinHooks): DevinHooks {
  const next: DevinHooks = {};
  for (const [event, rules] of Object.entries(hooks)) {
    if (!Array.isArray(rules)) {
      next[event] = rules;
      continue;
    }
    const kept = rules
      .map((rule) => Array.isArray(rule?.hooks)
        ? { ...rule, hooks: rule.hooks.filter((hook) => !isClaudeMemDevinCommand(hook)) }
        : rule)
      .filter((rule) => !Array.isArray(rule?.hooks) || rule.hooks.length > 0);
    if (kept.length > 0) next[event] = kept;
  }
  return next;
}

/** Replace claude-mem's entries with `ours`, leaving every other hook in place. */
export function mergeDevinHooks(hooks: DevinHooks, ours: DevinHooks): DevinHooks {
  const next = removeDevinHooks(hooks);
  for (const [event, rules] of Object.entries(ours)) {
    next[event] = [...(next[event] ?? []), ...rules];
  }
  return next;
}

function readDevinConfig(configPath: string): DevinConfig {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = parseJsonWithBom(readFileSync(configPath, 'utf-8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} is not a JSON object; refusing to overwrite it`);
  }
  const config = parsed as DevinConfig;
  if (config.hooks !== undefined && (config.hooks === null || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) {
    throw new Error(`"hooks" in ${configPath} is not an object; refusing to overwrite it`);
  }
  return config;
}

// config.json holds the user's other Devin settings: write a temp file and
// rename it over the original, so an interrupted write never leaves it truncated.
function writeDevinConfig(configPath: string, config: DevinConfig): void {
  writeJsonFileAtomic(configPath, config);
}

function backupOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    // Owner-only: the backup holds every Devin setting, and the default umask
    // would make it world-readable even when config.json is not.
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'), { mode: 0o600 });
  }
}

export function installDevinHooks(configPath: string = devinConfigPath()): number {
  const workerPath = getWorkerServiceAbsolutePath();
  if (!workerPath) {
    console.error('Could not find worker-service.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const bunPath = getBunAbsolutePath();
  try {
    const config = readDevinConfig(configPath);
    mkdirSync(path.dirname(configPath), { recursive: true });
    backupOnce(configPath);
    config.hooks = mergeDevinHooks(config.hooks ?? {}, buildDevinHooks(bunPath, workerPath));
    writeDevinConfig(configPath, config);
    console.log(`  Installed Devin hooks into ${configPath}`);
    console.log(`    Bun runtime: ${bunPath}`);
    console.log(`    Worker: ${workerPath}`);
    console.log('  Run /hooks in Devin to confirm they loaded.');
    return 0;
  } catch (error) {
    console.error(`Failed to install Devin hooks: ${(error as Error).message}`);
    return 1;
  }
}

interface DevinMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * mcp_config.json is a small JSON object shared with the user's other MCP
 * servers: a corrupt file is refused rather than overwritten (same rule as
 * readDevinConfig), a missing one is created.
 */
function readDevinMcpConfig(mcpConfigPath: string): DevinMcpConfig {
  if (!existsSync(mcpConfigPath)) return {};
  const parsed: unknown = parseJsonWithBom(readFileSync(mcpConfigPath, 'utf-8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${mcpConfigPath} is not a JSON object; refusing to overwrite it`);
  }
  const config = parsed as DevinMcpConfig;
  if (config.mcpServers !== undefined && (config.mcpServers === null || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    throw new Error(`"mcpServers" in ${mcpConfigPath} is not an object; refusing to overwrite it`);
  }
  return config;
}

/** Register the claude-mem MCP search server (`mcp__claude-mem__*` tools) with Devin. */
export function configureDevinMcp(mcpConfigPath: string = devinMcpConfigPath()): number {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find mcp-server.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  try {
    const config = readDevinMcpConfig(mcpConfigPath);
    mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    config.mcpServers = { ...config.mcpServers, 'claude-mem': buildMcpServerEntry(mcpServerPath) };
    writeJsonFileAtomic(mcpConfigPath, config);
    console.log(`  Configured MCP server in ${mcpConfigPath}`);
    console.log(`    Server path: ${mcpServerPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to configure Devin MCP in ${mcpConfigPath}: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Remove only the `claude-mem` server entry — the name is ours, so anything
 * under it was written by configureDevinMcp. Other servers stay untouched.
 * Returns true when an entry was removed.
 */
export function removeDevinMcpServer(mcpConfigPath: string = devinMcpConfigPath()): boolean {
  if (!existsSync(mcpConfigPath)) return false;
  const config = readDevinMcpConfig(mcpConfigPath);
  if (!config.mcpServers || !('claude-mem' in config.mcpServers)) return false;
  delete config.mcpServers['claude-mem'];
  writeJsonFileAtomic(mcpConfigPath, config);
  console.log(`  Removed claude-mem entry from ${mcpConfigPath}`);
  return true;
}

export function uninstallDevinHooks(configPath: string = devinConfigPath()): number {
  // mcp_config.json sits next to config.json, so a caller-scoped configPath
  // scopes the MCP file the same way (tests never touch the real one).
  // A broken MCP file must not leave the hooks capturing after the user asked
  // to remove them, so carry on and report the failure in the exit code.
  let mcpRemovalFailed = false;
  try {
    removeDevinMcpServer(path.join(path.dirname(configPath), 'mcp_config.json'));
  } catch (error) {
    console.error(`Failed to remove the Devin MCP server: ${(error as Error).message}`);
    mcpRemovalFailed = true;
  }
  const exitCodeAfterHooks = mcpRemovalFailed ? 1 : 0;
  if (!existsSync(configPath)) {
    console.log('  No Devin config.json found; nothing to uninstall');
    return exitCodeAfterHooks;
  }
  try {
    const config = readDevinConfig(configPath);
    if (!config.hooks) {
      console.log('  No claude-mem hooks found in Devin config.json');
      return exitCodeAfterHooks;
    }
    const next = removeDevinHooks(config.hooks);
    if (JSON.stringify(next) === JSON.stringify(config.hooks)) {
      console.log('  No claude-mem hooks found in Devin config.json');
      return exitCodeAfterHooks;
    }
    backupOnce(configPath);
    if (Object.keys(next).length > 0) config.hooks = next;
    else delete config.hooks;
    writeDevinConfig(configPath, config);
    console.log(`  Removed claude-mem hooks from ${configPath}`);
    return exitCodeAfterHooks;
  } catch (error) {
    console.error(`Failed to uninstall Devin hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function checkDevinHooksStatus(configPath: string = devinConfigPath()): number {
  try {
    const hooks = readDevinConfig(configPath).hooks ?? {};
    const installed = Object.values(hooks).some((rules) => Array.isArray(rules)
      && rules.some((rule) => Array.isArray(rule?.hooks) && rule.hooks.some(isClaudeMemDevinCommand)));
    if (installed) {
      console.log(`  Devin hooks: installed (${configPath})`);
      return 0;
    }
  } catch (error) {
    console.error(`  Devin hooks: unreadable config (${(error as Error).message})`);
    return 1;
  }
  console.log('  Devin hooks: not installed');
  return 1;
}

export async function handleDevinCommand(subcommand: string | undefined, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const hooks = installDevinHooks();
      const mcp = configureDevinMcp();
      return hooks === 0 && mcp === 0 ? 0 : 1;
    }
    case 'uninstall':
      return uninstallDevinHooks();
    case 'status':
      return checkDevinHooksStatus();
    default:
      console.log('Usage: claude-mem devin <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}

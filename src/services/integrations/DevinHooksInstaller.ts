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
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { getBunAbsolutePath, getWorkerServiceAbsolutePath } from './install-paths.js';

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

/** The Claude Code hook surface Devin has: the same handlers, minus PreToolUse. */
export function buildDevinHooks(bunPath: string, workerPath: string): DevinHooks {
  const run = (suffix: string) => `"${bunPath}" "${workerPath}" ${suffix}`;
  const rule = (suffix: string, timeout: number): DevinHookRule => ({
    matcher: '',
    hooks: [{ type: 'command', command: run(suffix), timeout }],
  });
  return {
    SessionStart: [rule('start', 60), rule('hook devin context', 60)],
    UserPromptSubmit: [rule('hook devin session-init', 15)],
    PostToolUse: [rule('hook devin observation', 120)],
    Stop: [rule('hook devin summarize', 120)],
    SessionEnd: [rule('hook devin session-end', 30)],
  };
}

const OWN_COMMAND = /worker-service\.cjs" (?:start|hook devin [a-z-]+)$/;

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

function writeDevinConfig(configPath: string, config: DevinConfig): void {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function backupOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'));
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

export function uninstallDevinHooks(configPath: string = devinConfigPath()): number {
  if (!existsSync(configPath)) {
    console.log('  No Devin config.json found; nothing to uninstall');
    return 0;
  }
  try {
    const config = readDevinConfig(configPath);
    if (!config.hooks) {
      console.log('  No claude-mem hooks found in Devin config.json');
      return 0;
    }
    const next = removeDevinHooks(config.hooks);
    if (JSON.stringify(next) === JSON.stringify(config.hooks)) {
      console.log('  No claude-mem hooks found in Devin config.json');
      return 0;
    }
    if (Object.keys(next).length > 0) config.hooks = next;
    else delete config.hooks;
    writeDevinConfig(configPath, config);
    console.log(`  Removed claude-mem hooks from ${configPath}`);
    return 0;
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
    case 'install':
      return installDevinHooks();
    case 'uninstall':
      return uninstallDevinHooks();
    case 'status':
      return checkDevinHooksStatus();
    default:
      console.log('Usage: claude-mem devin <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}

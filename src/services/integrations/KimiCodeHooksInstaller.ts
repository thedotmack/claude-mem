// SPDX-License-Identifier: Apache-2.0

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as toml from '@iarna/toml';
import { logger } from '../../utils/logger.js';
import {
  getWorkerServiceAbsolutePath,
  getBunAbsolutePath,
} from './install-paths.js';

interface KimiHookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

interface KimiConfig {
  hooks?: KimiHookEntry[];
  [key: string]: unknown;
}

function getKimiConfigDir(): string {
  return process.env.KIMI_CODE_CONFIG_DIR
    ? path.resolve(process.env.KIMI_CODE_CONFIG_DIR)
    : path.join(homedir(), '.kimi-code');
}

function getKimiConfigPath(): string {
  return path.join(getKimiConfigDir(), 'config.toml');
}
const HOOK_NAME = 'claude-mem';
// Kimi timeout is in seconds. The docs show values like 5, 30, 60.
const HOOK_TIMEOUT_SECONDS = 120;

interface KimiHookSpec {
  event: string;
  matcher?: string;
  /** hook kimi-code <event>; omit for the bare `start` worker command */
  internalEvent?: string;
  timeout?: number;
}

// Mirrors the upstream Claude Code hook set (plugin/hooks/hooks.json), adapted
// to Kimi's lifecycle events. Verified against live Kimi Code hook payloads:
//  - SessionStart sources are 'startup' | 'resume' (no clear/compact).
//  - `start` is the bare worker-service command that ensures the daemon is
//    up; the other entries are `hook kimi-code <event>` dispatches.
//  - PreToolUse(Read) → file-context gives the same recall-on-read behavior
//    Claude Code gets.
//  - PostToolUseFailure is Kimi-specific; failures are observations too.
//  - Kimi matchers are regexes; omitting the matcher catches all targets
//    ('*' is not a valid catch-all regex).
const KIMI_HOOK_SPECS: KimiHookSpec[] = [
  { event: 'SessionStart', matcher: 'startup|resume', timeout: 60 },
  { event: 'SessionStart', matcher: 'startup|resume', internalEvent: 'context', timeout: 60 },
  { event: 'UserPromptSubmit', internalEvent: 'session-init', timeout: 60 },
  { event: 'PreToolUse', matcher: 'Read', internalEvent: 'file-context', timeout: 60 },
  { event: 'PostToolUse', internalEvent: 'observation', timeout: HOOK_TIMEOUT_SECONDS },
  { event: 'PostToolUseFailure', internalEvent: 'observation', timeout: HOOK_TIMEOUT_SECONDS },
  { event: 'Stop', internalEvent: 'summarize', timeout: HOOK_TIMEOUT_SECONDS },
];

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  spec: KimiHookSpec,
): string {
  // Kimi splits the command string by whitespace and passes the resulting
  // tokens as argv. Quoting paths is not supported, so we rely on the
  // resolved paths having no spaces. (The standard install locations don't.)
  if (!spec.internalEvent) {
    return `${bunPath} ${workerServicePath} start`;
  }
  return `${bunPath} ${workerServicePath} hook kimi-code ${spec.internalEvent}`;
}

function createHookEntry(
  bunPath: string,
  workerServicePath: string,
  spec: KimiHookSpec,
): KimiHookEntry {
  return {
    event: spec.event,
    ...(spec.matcher !== undefined && { matcher: spec.matcher }),
    command: buildHookCommand(bunPath, workerServicePath, spec),
    timeout: spec.timeout ?? HOOK_TIMEOUT_SECONDS,
  };
}

function describeSpec(spec: KimiHookSpec): string {
  const target = spec.internalEvent ?? 'start';
  return spec.matcher ? `${spec.event}[${spec.matcher}] → ${target}` : `${spec.event} → ${target}`;
}

function readKimiConfig(): KimiConfig {
  if (!existsSync(getKimiConfigPath())) {
    return {};
  }

  const content = readFileSync(getKimiConfigPath(), 'utf-8');
  try {
    return toml.parse(content) as KimiConfig;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Corrupt TOML in Kimi config', { path: getKimiConfigPath() }, error);
    } else {
      logger.error('WORKER', 'Corrupt TOML in Kimi config', { path: getKimiConfigPath() }, new Error(String(error)));
    }
    throw new Error(`Corrupt TOML in ${getKimiConfigPath()}, refusing to overwrite user settings`);
  }
}

function writeKimiConfig(config: KimiConfig): void {
  mkdirSync(getKimiConfigDir(), { recursive: true });
  // @iarna/toml inserts underscores in large integers (e.g. 120_000). Kimi's
  // config parser may not accept them, so strip numeric separators before writing.
  const raw = toml.stringify(config as unknown as toml.JsonMap);
  writeFileSync(getKimiConfigPath(), raw.replace(/(\d)_(?=\d)/g, '$1'));
}

function isClaudeMemHook(entry: KimiHookEntry): boolean {
  return typeof entry.command === 'string'
    && entry.command.includes('worker-service.cjs');
}

function mergeHooksIntoConfig(
  existingConfig: KimiConfig,
  newHooks: KimiHookEntry[],
): KimiConfig {
  const config: KimiConfig = { ...existingConfig };
  const existingHooks = Array.isArray(config.hooks) ? [...config.hooks] : [];

  // Remove any existing claude-mem hooks so the install is idempotent.
  const filteredHooks = existingHooks.filter(entry => !isClaudeMemHook(entry));

  // Append the new claude-mem hooks.
  config.hooks = [...filteredHooks, ...newHooks];

  return config;
}

export async function installKimiCodeHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Kimi Code CLI hooks...\n');

  const workerServicePath = getWorkerServiceAbsolutePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = getBunAbsolutePath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    const newHooks: KimiHookEntry[] = KIMI_HOOK_SPECS.map((spec) =>
      createHookEntry(bunPath, workerServicePath, spec),
    );

    const existingConfig = readKimiConfig();
    const mergedConfig = mergeHooksIntoConfig(existingConfig, newHooks);

    writeKimiConfig(mergedConfig);
    console.log(`  Merged hooks into ${getKimiConfigPath()}`);

    console.log(`  Registered ${KIMI_HOOK_SPECS.length} hook entries:`);
    for (const spec of KIMI_HOOK_SPECS) {
      console.log(`    ${describeSpec(spec)}`);
    }

    console.log(`
Installation complete!

Hooks installed to: ${getKimiConfigPath()}
Using unified CLI: bun worker-service.cjs hook kimi-code <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Kimi Code CLI to load the hooks
  3. Memory will be captured automatically during sessions
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallKimiCodeHooks(): number {
  console.log('\nUninstalling Claude-Mem Kimi Code CLI hooks...\n');

  if (!existsSync(getKimiConfigPath())) {
    console.log('  No Kimi Code CLI config found — nothing to uninstall.');
    return 0;
  }

  try {
    const config = readKimiConfig();
    if (!Array.isArray(config.hooks) || config.hooks.length === 0) {
      console.log('  No hooks found in Kimi Code CLI config — nothing to uninstall.');
      return 0;
    }

    const originalCount = config.hooks.length;
    config.hooks = config.hooks.filter(entry => !isClaudeMemHook(entry));
    const removedCount = originalCount - config.hooks.length;

    if (removedCount === 0) {
      console.log('  No claude-mem hooks found — nothing to uninstall.');
      return 0;
    }

    writeKimiConfig(config);
    console.log(`  Removed ${removedCount} claude-mem hook(s) from ${getKimiConfigPath()}`);
    console.log('\nUninstallation complete!\n');
    console.log('Restart Kimi Code CLI to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkKimiCodeHooksStatus(): number {
  console.log('\nClaude-Mem Kimi Code CLI Hooks Status\n');

  if (!existsSync(getKimiConfigPath())) {
    console.log('Kimi Code CLI config: Not found');
    console.log(`  Expected at: ${getKimiConfigPath()}\n`);
    console.log('No hooks installed. Run: claude-mem install --ide kimi-code\n');
    return 0;
  }

  let config: KimiConfig;
  try {
    config = readKimiConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to read Kimi Code CLI config', { path: getKimiConfigPath() }, error);
    } else {
      logger.error('WORKER', 'Failed to read Kimi Code CLI config', { path: getKimiConfigPath() }, new Error(String(error)));
    }
    console.log(`Kimi Code CLI config: ${message}\n`);
    return 0;
  }

  if (!Array.isArray(config.hooks) || config.hooks.length === 0) {
    console.log('Kimi Code CLI config: Found, but no hooks configured\n');
    console.log('No hooks installed. Run: claude-mem install --ide kimi-code\n');
    return 0;
  }

  const installedCommands: string[] = [];
  for (const entry of config.hooks) {
    if (isClaudeMemHook(entry) && entry.event) {
      installedCommands.push(`${entry.event}${entry.matcher ? `[${entry.matcher}]` : ''}`);
    }
  }

  if (installedCommands.length === 0) {
    console.log('Kimi Code CLI config: Found, but no claude-mem hooks\n');
    console.log('Run: claude-mem install --ide kimi-code\n');
    return 0;
  }

  console.log(`Config: ${getKimiConfigPath()}`);
  console.log(`Mode: Unified CLI (bun worker-service.cjs hook kimi-code)`);
  console.log(`Hook entries: ${installedCommands.length} of ${KIMI_HOOK_SPECS.length} installed`);
  for (const spec of KIMI_HOOK_SPECS) {
    const label = `${spec.event}${spec.matcher ? `[${spec.matcher}]` : ''}`;
    const mark = installedCommands.includes(label) ? 'installed' : 'missing';
    console.log(`  ${describeSpec(spec)} — ${mark}`);
  }

  console.log('');
  return 0;
}

export async function handleKimiCodeCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installKimiCodeHooks();

    case 'uninstall':
      return uninstallKimiCodeHooks();

    case 'status':
      return checkKimiCodeHooksStatus();

    default:
      console.log(`
Claude-Mem Kimi Code CLI Integration

Usage: claude-mem kimi-code <command>

Commands:
  install             Install hooks into ~/.kimi-code/config.toml
  uninstall           Remove claude-mem hooks (preserves other hooks)
  status              Check installation status

Examples:
  claude-mem kimi-code install     # Install hooks
  claude-mem kimi-code status      # Check if installed
  claude-mem kimi-code uninstall   # Remove hooks

For more info: https://github.com/thedotmack/claude-mem
      `);
      return 0;
  }
}

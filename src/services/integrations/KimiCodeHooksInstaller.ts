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
  name?: string;
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
const HOOK_TIMEOUT_MS = 120000;

const KIMI_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'SessionStart': 'context',
  'UserPromptSubmit': 'session-init',
  'PostToolUse': 'observation',
  'Stop': 'summarize',
};

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  kimiEventName: string,
): string {
  const internalEvent = KIMI_EVENT_TO_INTERNAL_EVENT[kimiEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Kimi event: ${kimiEventName}`);
  }

  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook kimi-code ${internalEvent}`;
}

function createHookEntry(
  bunPath: string,
  workerServicePath: string,
  kimiEventName: string,
): KimiHookEntry {
  // Kimi matchers are regexes against the target (tool name / prompt text / source).
  // '*' is not a valid regex and would match nothing, so omit the matcher to
  // catch all targets. SessionStart sources are 'startup' or 'resume' per Kimi docs.
  const matcher = kimiEventName === 'SessionStart'
    ? 'startup|resume|clear|compact'
    : undefined;

  return {
    event: kimiEventName,
    ...(matcher !== undefined && { matcher }),
    name: HOOK_NAME,
    command: buildHookCommand(bunPath, workerServicePath, kimiEventName),
    timeout: HOOK_TIMEOUT_MS,
  };
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
  return entry.name === HOOK_NAME
    || (typeof entry.command === 'string'
      && entry.command.includes('worker-service.cjs')
      && entry.command.includes('hook kimi-code'));
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
    const newHooks: KimiHookEntry[] = [];
    for (const kimiEvent of Object.keys(KIMI_EVENT_TO_INTERNAL_EVENT)) {
      newHooks.push(createHookEntry(bunPath, workerServicePath, kimiEvent));
    }

    const existingConfig = readKimiConfig();
    const mergedConfig = mergeHooksIntoConfig(existingConfig, newHooks);

    writeKimiConfig(mergedConfig);
    console.log(`  Merged hooks into ${getKimiConfigPath()}`);

    const eventNames = Object.keys(KIMI_EVENT_TO_INTERNAL_EVENT);
    console.log(`  Registered ${eventNames.length} hook events:`);
    for (const event of eventNames) {
      const internalEvent = KIMI_EVENT_TO_INTERNAL_EVENT[event];
      console.log(`    ${event} → ${internalEvent}`);
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

  const installedEvents: string[] = [];
  for (const entry of config.hooks) {
    if (isClaudeMemHook(entry) && entry.event) {
      installedEvents.push(entry.event);
    }
  }

  if (installedEvents.length === 0) {
    console.log('Kimi Code CLI config: Found, but no claude-mem hooks\n');
    console.log('Run: claude-mem install --ide kimi-code\n');
    return 0;
  }

  console.log(`Config: ${getKimiConfigPath()}`);
  console.log(`Mode: Unified CLI (bun worker-service.cjs hook kimi-code)`);
  console.log(`Events: ${installedEvents.length} of ${Object.keys(KIMI_EVENT_TO_INTERNAL_EVENT).length} mapped`);
  for (const event of installedEvents) {
    const internalEvent = KIMI_EVENT_TO_INTERNAL_EVENT[event] ?? 'unknown';
    console.log(`  ${event} → ${internalEvent}`);
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


import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import {
  getWorkerServiceAbsolutePath as findWorkerServicePath,
  getBunAbsolutePath as findBunPath,
  getMcpServerAbsolutePath,
} from './install-paths.js';
import { writeMcpJsonConfig, PLACEHOLDER_CONTEXT } from './McpIntegrations.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';

interface AntigravityHookEntry {
  name: string;
  type: 'command';
  command: string;
  timeout: number;
}

interface AntigravityHookGroup {
  matcher: string;
  hooks: AntigravityHookEntry[];
}

// Official hooks.json schema (antigravity.google/docs/hooks): PreToolUse /
// PostToolUse take matcher-wrapped groups; PreInvocation / PostInvocation /
// Stop take a bare handler list (matcher is ignored for them).
interface AntigravityHooksConfig {
  [eventName: string]: AntigravityHookGroup[] | AntigravityHookEntry[];
}

interface AntigravitySettingsJson {
  hooks?: AntigravityHooksConfig;
  [key: string]: unknown;
}

// Antigravity CLI (`agy`) shares Gemini CLI's exact `~/.gemini/` config tree —
// confirmed 2026-07-03 against a live install (see Phase B0 findings in
// plans/2026-07-03-antigravity-cli-migration.md). Same settings.json, same
// hook JSON schema, same GEMINI.md context file. Not a typo/leftover.
const GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini');
const GEMINI_SETTINGS_PATH = path.join(GEMINI_CONFIG_DIR, 'settings.json');
const GEMINI_HOOKS_CONFIG_PATH = path.join(GEMINI_CONFIG_DIR, 'config', 'hooks.json');
const GEMINI_MD_PATH = path.join(GEMINI_CONFIG_DIR, 'GEMINI.md');

// B0 found two real, genuinely ambiguous MCP config paths on a live machine —
// one already populated (old path), one present but empty (newer path per
// third-party docs). Dual-write to both until Phase C's hands-on gate
// resolves which one `agy` actually reads.
const ANTIGRAVITY_MCP_CONFIG_PATHS = [
  path.join(GEMINI_CONFIG_DIR, 'antigravity', 'mcp_config.json'),
  path.join(GEMINI_CONFIG_DIR, 'config', 'mcp_config.json'),
];

// Plural "agents", home-relative — confirmed real and populated in B0 at
// ~/.agents/rules/. The prior MCP-only ANTIGRAVITY_CONFIG used process.cwd()
// instead, which a live install test (Phase C) proved wrong: it writes into
// whatever directory the installer happens to run from rather than the
// user's actual global rules directory.
const RULES_CONTEXT_PATH = path.join(homedir(), '.agents', 'rules', 'claude-mem-context.md');

const HOOK_NAME = 'claude-mem';
const HOOK_TIMEOUT_MS = 10000;

// 7 confirmed-live hook events (B0). SessionEnd is deliberately excluded:
// 'session-complete' has no handler in src/cli/handlers/index.ts — it was
// removed on purpose (see CHANGELOG.md:777) since the worker self-completes.
const ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'PreInvocation': 'context',
  'PreToolUse': 'observation',
  'PostToolUse': 'observation',
  'PostInvocation': 'observation',
  'Stop': 'summarize',
};

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  antigravityEventName: string,
): string {
  const internalEvent = ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[antigravityEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Antigravity CLI event: ${antigravityEventName}`);
  }

  // agy splits the command on spaces and does NOT strip quotes, so wrapping a
  // path in "..." makes bun receive a literal quoted filename and fail with
  // "File not found" (verified on a live install: quoted paths broke every hook
  // with exit status 1). Emit bare, forward-slashed paths.
  const formattedBunPath = bunPath.replace(/\\/g, '/');
  const formattedWorkerPath = workerServicePath.replace(/\\/g, '/');

  return `${formattedBunPath} ${formattedWorkerPath} hook antigravity-cli ${internalEvent}`;
}

const TOOL_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function createHookEntry(hookCommand: string): AntigravityHookEntry {
  return {
    name: HOOK_NAME,
    type: 'command',
    command: hookCommand,
    timeout: HOOK_TIMEOUT_MS,
  };
}

function createHookGroup(hookCommand: string): AntigravityHookGroup {
  return {
    matcher: '*',
    hooks: [createHookEntry(hookCommand)],
  };
}

function readAntigravitySettings(): AntigravitySettingsJson {
  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    return {};
  }

  const content = readFileSync(GEMINI_SETTINGS_PATH, 'utf-8');
  try {
    return JSON.parse(content) as AntigravitySettingsJson;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Corrupt JSON in Antigravity CLI (shared Gemini) settings', { path: GEMINI_SETTINGS_PATH }, error);
    } else {
      logger.error('WORKER', 'Corrupt JSON in Antigravity CLI (shared Gemini) settings', { path: GEMINI_SETTINGS_PATH }, new Error(String(error)));
    }
    throw new Error(`Corrupt JSON in ${GEMINI_SETTINGS_PATH}, refusing to overwrite user settings`);
  }
}

function writeAntigravitySettings(settings: AntigravitySettingsJson): void {
  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function writeAntigravityHooksConfig(hooksConfig: AntigravityHooksConfig): void {
  const configDir = path.join(GEMINI_CONFIG_DIR, 'config');
  mkdirSync(configDir, { recursive: true });

  let existingData: Record<string, any> = {};
  if (existsSync(GEMINI_HOOKS_CONFIG_PATH)) {
    try {
      const content = readFileSync(GEMINI_HOOKS_CONFIG_PATH, 'utf-8');
      if (content.trim()) {
        existingData = JSON.parse(content);
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error('WORKER', 'Corrupt JSON in Antigravity CLI hooks config', { path: GEMINI_HOOKS_CONFIG_PATH }, error);
      }
    }
  }

  existingData[HOOK_NAME] = hooksConfig;
  writeFileSync(GEMINI_HOOKS_CONFIG_PATH, JSON.stringify(existingData, null, 2) + '\n');
}

function removeAntigravityHooksFromHooksConfig(): void {
  if (!existsSync(GEMINI_HOOKS_CONFIG_PATH)) return;
  try {
    const content = readFileSync(GEMINI_HOOKS_CONFIG_PATH, 'utf-8');
    if (!content.trim()) return;
    const data = JSON.parse(content);
    if (data[HOOK_NAME]) {
      delete data[HOOK_NAME];
      writeFileSync(GEMINI_HOOKS_CONFIG_PATH, JSON.stringify(data, null, 2) + '\n');
      console.log(`  Removed ${HOOK_NAME} entry from ${GEMINI_HOOKS_CONFIG_PATH}`);
    }
  } catch (e) {}
}

function setupGeminiMdContextSection(): void {
  const contextTag = '<claude-mem-context>';
  const contextEndTag = '</claude-mem-context>';
  const placeholder = `${contextTag}
# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*
${contextEndTag}`;

  let content = '';
  if (existsSync(GEMINI_MD_PATH)) {
    content = readFileSync(GEMINI_MD_PATH, 'utf-8');
  }

  if (content.includes(contextTag)) {
    return;
  }

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  const newContent = content + separator + placeholder + '\n';

  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_MD_PATH, newContent);
}

// B0 found `~/.gemini/config/mcp_config.json` existing but genuinely empty (0
// bytes) on a live machine — a fresh placeholder created alongside the CLI's
// app-data dir, not corrupt data. readJsonSafe (reused by writeMcpJsonConfig)
// intentionally throws on empty files to prevent data loss on real corruption
// elsewhere — that contract must stay intact for every other caller. Here we
// only pre-seed a *zero-byte* file with `{}` immediately before delegating to
// the shared writer, so an empty placeholder doesn't get misread as corrupt.
function seedEmptyMcpConfigFile(mcpConfigPath: string): void {
  if (existsSync(mcpConfigPath) && readFileSync(mcpConfigPath, 'utf-8').trim() === '') {
    writeFileSync(mcpConfigPath, '{}\n');
  }
}

function registerAntigravityMcp(): void {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    throw new Error('MCP server script not found');
  }

  for (const mcpConfigPath of ANTIGRAVITY_MCP_CONFIG_PATHS) {
    seedEmptyMcpConfigFile(mcpConfigPath);
    writeMcpJsonConfig(mcpConfigPath, mcpServerPath);
    console.log(`  MCP config written to: ${mcpConfigPath}`);
  }
}

function setupRulesContextFile(): void {
  injectContextIntoMarkdownFile(RULES_CONTEXT_PATH, PLACEHOLDER_CONTEXT);
  console.log(`  Context placeholder written to: ${RULES_CONTEXT_PATH}`);
}

export async function installAntigravityCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Antigravity CLI hooks + MCP...\n');

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
    // Hooks live ONLY in ~/.gemini/config/hooks.json — agy never reads hook
    // definitions from settings.json (verified on a live install; the old
    // settings.json dual-write was dead weight and has been removed).
    const hooksConfig: AntigravityHooksConfig = {};
    for (const antigravityEvent of Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, antigravityEvent);
      hooksConfig[antigravityEvent] = TOOL_MATCHER_EVENTS.has(antigravityEvent)
        ? [createHookGroup(command)]
        : [createHookEntry(command)];
    }

    writeAntigravityHooksAndSetupContext(hooksConfig);
    registerAntigravityMcp();
    setupRulesContextFile();

    console.log(`
Installation complete!

Hooks installed to:    ${GEMINI_HOOKS_CONFIG_PATH}
MCP config installed to:
  ${ANTIGRAVITY_MCP_CONFIG_PATHS.join('\n  ')}
Using unified CLI: bun worker-service.cjs hook antigravity-cli <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Antigravity CLI (agy) to load the hooks
  3. Memory will be captured automatically during sessions

Context Injection:
  Context from past sessions is injected via ${GEMINI_MD_PATH}
  and ${RULES_CONTEXT_PATH}, and automatically included in Antigravity CLI conversations.
`);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function writeAntigravityHooksAndSetupContext(hooksConfig: AntigravityHooksConfig): void {
  writeAntigravityHooksConfig(hooksConfig);
  console.log(`  Merged hooks into ${GEMINI_HOOKS_CONFIG_PATH}`);

  setupGeminiMdContextSection();
  console.log(`  Setup context injection in ${GEMINI_MD_PATH}`);

  const eventNames = Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT);
  console.log(`  Registered ${eventNames.length} hook events:`);
  for (const event of eventNames) {
    const internalEvent = ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[event];
    console.log(`    ${event} → ${internalEvent}`);
  }
}

// Same empty-file tolerance as seedEmptyMcpConfigFile above, for read paths
// (status check + uninstall) that don't go through writeMcpJsonConfig. A
// genuinely empty file has nothing to lose; readJsonSafe's "corrupt" guard
// stays fully intact for real (non-empty) malformed content.
function readMcpConfigTolerantly(mcpConfigPath: string): Record<string, any> {
  if (!existsSync(mcpConfigPath)) return {};
  if (readFileSync(mcpConfigPath, 'utf-8').trim() === '') return {};
  return readJsonSafe<Record<string, any>>(mcpConfigPath, {});
}

function removeClaudeMemFromMcpConfig(mcpConfigPath: string): boolean {
  if (!existsSync(mcpConfigPath)) return false;

  const config = readMcpConfigTolerantly(mcpConfigPath);
  if (!config.mcpServers || !('claude-mem' in config.mcpServers)) {
    return false;
  }

  delete config.mcpServers['claude-mem'];
  writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

function removeContextTagBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  let content = readFileSync(filePath, 'utf-8');
  const contextRegex = /\n?<claude-mem-context>[\s\S]*?<\/claude-mem-context>\n?/;
  if (!contextRegex.test(content)) return false;

  content = content.replace(contextRegex, '');
  writeFileSync(filePath, content);
  return true;
}

export function uninstallAntigravityCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Antigravity CLI hooks + MCP...\n');

  try {
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      removeAntigravityHooksFromSettings();
    } else {
      console.log('  No Antigravity CLI (Gemini-shared) settings found — nothing to uninstall.');
    }

    removeAntigravityHooksFromHooksConfig();

    for (const mcpConfigPath of ANTIGRAVITY_MCP_CONFIG_PATHS) {
      const removed = removeClaudeMemFromMcpConfig(mcpConfigPath);
      if (removed) {
        console.log(`  Removed claude-mem entry from ${mcpConfigPath}`);
      }
    }

    if (removeContextTagBlock(RULES_CONTEXT_PATH)) {
      console.log(`  Removed context section from ${RULES_CONTEXT_PATH}`);
    }

    console.log('\nUninstallation complete!\n');
    console.log('Restart Antigravity CLI (agy) to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

function removeAntigravityHooksFromSettings(): void {
  const settings = readAntigravitySettings();
  if (!settings.hooks) {
    console.log('  No hooks found in Antigravity CLI settings — nothing to uninstall.');
    return;
  }

  let removedCount = 0;

  // Legacy cleanup: older installers dual-wrote matcher-wrapped groups into
  // settings.json (agy never read them). Bare entries never existed here.
  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    const filteredGroups = (groups as AntigravityHookGroup[])
      .map(group => {
        if (!Array.isArray(group.hooks)) return group;
        const remainingHooks = group.hooks.filter(hook => hook.name !== HOOK_NAME);
        removedCount += group.hooks.length - remainingHooks.length;
        return { ...group, hooks: remainingHooks };
      })
      .filter(group => !Array.isArray(group.hooks) || group.hooks.length > 0);

    if (filteredGroups.length > 0) {
      settings.hooks[eventName] = filteredGroups;
    } else {
      delete settings.hooks[eventName];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeAntigravitySettings(settings);
  console.log(`  Removed ${removedCount} claude-mem hook(s) from ${GEMINI_SETTINGS_PATH}`);

  if (removeContextTagBlock(GEMINI_MD_PATH)) {
    console.log(`  Removed context section from ${GEMINI_MD_PATH}`);
  }
}

export function checkAntigravityCliHooksStatus(): number {
  console.log('\nClaude-Mem Antigravity CLI Status\n');

  let installedEvents: string[] = [];
  if (existsSync(GEMINI_HOOKS_CONFIG_PATH)) {
    try {
      const content = readFileSync(GEMINI_HOOKS_CONFIG_PATH, 'utf-8');
      const data = content.trim() ? JSON.parse(content) : {};
      const hooksConfig = data[HOOK_NAME];
      if (hooksConfig && typeof hooksConfig === 'object') {
        installedEvents = Object.keys(hooksConfig).filter(k => k in ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Antigravity CLI hooks config: ${message}\n`);
      return 0;
    }
  }

  if (installedEvents.length === 0) {
    console.log('Hooks: Not installed');
    console.log(`  Expected at: ${GEMINI_HOOKS_CONFIG_PATH}`);
    console.log('Run: claude-mem install --ide antigravity\n');
  } else {
    console.log(`Hooks config: ${GEMINI_HOOKS_CONFIG_PATH}`);
    console.log(`Mode: Unified CLI (bun worker-service.cjs hook antigravity-cli)`);
    console.log(`Events: ${installedEvents.length} of ${Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT).length} mapped`);
    for (const event of installedEvents) {
      const internalEvent = ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[event] ?? 'unknown';
      console.log(`  ${event} → ${internalEvent}`);
    }
  }

  if (existsSync(GEMINI_MD_PATH)) {
    const mdContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
    if (mdContent.includes('<claude-mem-context>')) {
      console.log(`Context (GEMINI.md): Active (${GEMINI_MD_PATH})`);
    } else {
      console.log('Context (GEMINI.md): exists but missing claude-mem section');
    }
  } else {
    console.log('Context (GEMINI.md): No GEMINI.md found');
  }

  console.log('');
  for (const mcpConfigPath of ANTIGRAVITY_MCP_CONFIG_PATHS) {
    if (!existsSync(mcpConfigPath)) {
      console.log(`MCP config (${mcpConfigPath}): Not found`);
      continue;
    }
    const config = readMcpConfigTolerantly(mcpConfigPath);
    const hasEntry = Boolean(config.mcpServers?.['claude-mem']);
    console.log(`MCP config (${mcpConfigPath}): ${hasEntry ? 'claude-mem registered' : 'found, but no claude-mem entry'}`);
  }

  console.log('');
  return 0;
}

export async function handleAntigravityCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installAntigravityCliHooks();

    case 'uninstall':
      return uninstallAntigravityCliHooks();

    case 'status':
      return checkAntigravityCliHooksStatus();

    default:
      console.log(`
Claude-Mem Antigravity CLI Integration

Usage: claude-mem antigravity-cli <command>

Commands:
  install             Install hooks into ~/.gemini/config/hooks.json + MCP config
  uninstall           Remove claude-mem hooks/MCP entries (preserves other config)
  status              Check installation status

Examples:
  claude-mem antigravity-cli install     # Install hooks + MCP
  claude-mem antigravity-cli status      # Check if installed
  claude-mem antigravity-cli uninstall   # Remove hooks + MCP

For more info: https://docs.claude-mem.ai/antigravity-cli/setup
      `);
      return 0;
  }
}

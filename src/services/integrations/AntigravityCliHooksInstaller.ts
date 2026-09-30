
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
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

interface AntigravityHooksConfig {
  [eventName: string]: AntigravityHookGroup[];
}

interface AntigravitySettingsJson {
  hooks?: AntigravityHooksConfig;
  [key: string]: unknown;
}

// Antigravity CLI (`agy`) shares Gemini CLI's `~/.gemini/` config tree for
// context (GEMINI.md) and MCP, but — contrary to an earlier assumption — it
// does NOT read lifecycle hooks from `settings.json`. Confirmed against
// `agy` 1.2.1 (issue #4057): the CLI loads hook definitions from a dedicated
// `hooks.json` and fires the `PreToolUse` / `PostToolUse` / `PreInvocation` /
// `PostInvocation` / `Stop` events (the Gemini-CLI `BeforeTool` / `AfterTool`
// / `BeforeAgent` / `SessionStart` names do not exist in the binary, so hooks
// written under those keys never execute).
const GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini');
// Legacy path — retained ONLY so uninstall can strip hooks written by prior
// (pre-#4057) versions that mistakenly registered them here. New installs
// never write hooks to settings.json.
const GEMINI_SETTINGS_PATH = path.join(GEMINI_CONFIG_DIR, 'settings.json');
// The hooks file `agy` actually loads (issue #4057). Lives alongside the
// already-used `~/.gemini/config/mcp_config.json`.
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

// The 5 hook events `agy` 1.2.1 actually fires (issue #4057), mapped to
// claude-mem's internal handlers:
//   - PreInvocation  → context     (inject memory before the agent runs; the
//                                    adapter emits `injectSteps` on this path)
//   - PreToolUse     → observation (records tool intent; adapter emits
//                                    `{"decision":"allow"}` so the call proceeds)
//   - PostToolUse    → observation (records the tool result)
//   - PostInvocation → observation (records the assistant response, pulled from
//                                    the transcript's PLANNER_RESPONSE node)
//   - Stop           → summarize   (session/turn end → summary)
// The old Gemini-CLI names (SessionStart/BeforeAgent/AfterAgent/BeforeTool/
// AfterTool/Notification/PreCompress) are NOT present in the agy binary and
// were never executed.
const ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'PreInvocation': 'context',
  'PreToolUse': 'observation',
  'PostToolUse': 'observation',
  'PostInvocation': 'observation',
  'Stop': 'summarize',
};

// `agy` splits a hook command string on spaces and does NOT strip quotes, so a
// quoted path makes bun receive a literal `"C:/path/bun"` argument and fail
// with "File not found" (verified on a live install — quoted paths broke every
// hook with exit status 1). On Windows, a space inside the path can't be
// quoted away either, so resolve the 8.3 short path to remove the space; if 8.3
// generation is disabled we fall back to the raw path with a warning rather
// than blocking the install.
function toSpaceFreePath(filePath: string): string {
  if (!filePath.includes(' ')) return filePath;
  if (process.platform !== 'win32') {
    console.warn(
      `  WARNING: Antigravity CLI hook path contains spaces: ${filePath}\n` +
      `  agy splits commands on spaces, so hooks may fail to launch.\n` +
      `  Move bun or the plugin to a path without spaces.`,
    );
    return filePath;
  }
  try {
    const shortPath = execSync(
      `for %~I in ("${filePath}") do @echo %~sI`,
      { shell: 'cmd.exe', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
    ).trim();
    if (shortPath && !shortPath.includes(' ')) return shortPath;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to resolve Windows 8.3 short path', { path: filePath }, error);
    }
  }
  console.warn(
    `  WARNING: Antigravity CLI hook path contains spaces and 8.3 short-path\n` +
    `  resolution failed: ${filePath}\n` +
    `  agy splits commands on spaces, so hooks may fail to launch.`,
  );
  return filePath;
}

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  antigravityEventName: string,
): string {
  const internalEvent = ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[antigravityEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Antigravity CLI event: ${antigravityEventName}`);
  }

  // Emit bare, forward-slashed paths (see toSpaceFreePath): agy does not run the
  // command through a shell, so quotes are taken literally and backslashes are
  // fragile.
  const formattedBunPath = toSpaceFreePath(bunPath).replace(/\\/g, '/');
  const formattedWorkerPath = toSpaceFreePath(workerServicePath).replace(/\\/g, '/');

  return `${formattedBunPath} ${formattedWorkerPath} hook antigravity-cli ${internalEvent}`;
}

function createHookGroup(hookCommand: string): AntigravityHookGroup {
  return {
    matcher: '*',
    hooks: [{
      name: HOOK_NAME,
      type: 'command',
      command: hookCommand,
      timeout: HOOK_TIMEOUT_MS,
    }],
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

// Read the standalone `hooks.json` agy loads. Returns the event→groups map
// (the whole file). Empty/missing file → {}. Genuinely corrupt (non-empty,
// unparseable) content throws so we never clobber a user's hand-edited hooks.
function readAntigravityHooksConfig(): AntigravityHooksConfig {
  if (!existsSync(GEMINI_HOOKS_CONFIG_PATH)) {
    return {};
  }
  const content = readFileSync(GEMINI_HOOKS_CONFIG_PATH, 'utf-8');
  if (!content.trim()) {
    return {};
  }
  try {
    return JSON.parse(content) as AntigravityHooksConfig;
  } catch (error) {
    logger.error(
      'WORKER',
      'Corrupt JSON in Antigravity CLI hooks config',
      { path: GEMINI_HOOKS_CONFIG_PATH },
      error instanceof Error ? error : new Error(String(error)),
    );
    throw new Error(`Corrupt JSON in ${GEMINI_HOOKS_CONFIG_PATH}, refusing to overwrite user hooks`);
  }
}

function writeAntigravityHooksConfig(hooksConfig: AntigravityHooksConfig): void {
  mkdirSync(path.dirname(GEMINI_HOOKS_CONFIG_PATH), { recursive: true });
  writeFileSync(GEMINI_HOOKS_CONFIG_PATH, JSON.stringify(hooksConfig, null, 2) + '\n');
}

// Generic JSON-group merge — merges claude-mem's hook groups into an existing
// event→groups map (keyed on the `claude-mem` hook name), preserving any hooks
// the user or other tools registered. Event-name agnostic.
function mergeHooksIntoConfig(
  existingConfig: AntigravityHooksConfig,
  newHooks: AntigravityHooksConfig,
): AntigravityHooksConfig {
  const config: AntigravityHooksConfig = { ...existingConfig };

  for (const [eventName, newGroups] of Object.entries(newHooks)) {
    const existingGroups: AntigravityHookGroup[] = config[eventName] ?? [];

    for (const newGroup of newGroups) {
      const existingGroupIndex = existingGroups.findIndex((group: AntigravityHookGroup) =>
        group.hooks.some((hook: AntigravityHookEntry) => hook.name === HOOK_NAME)
      );

      if (existingGroupIndex >= 0) {
        const existingGroup: AntigravityHookGroup = existingGroups[existingGroupIndex];
        const hookIndex = existingGroup.hooks.findIndex((hook: AntigravityHookEntry) => hook.name === HOOK_NAME);
        if (hookIndex >= 0) {
          existingGroup.hooks[hookIndex] = newGroup.hooks[0];
        } else {
          existingGroup.hooks.push(newGroup.hooks[0]);
        }
      } else {
        existingGroups.push(newGroup);
      }
    }

    config[eventName] = existingGroups;
  }

  return config;
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
    const hooksConfig: AntigravityHooksConfig = {};
    for (const antigravityEvent of Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, antigravityEvent);
      hooksConfig[antigravityEvent] = [createHookGroup(command)];
    }

    const existingHooks = readAntigravityHooksConfig();
    const mergedHooks = mergeHooksIntoConfig(existingHooks, hooksConfig);

    writeAntigravityHooksAndSetupContext(mergedHooks);
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

function writeAntigravityHooksAndSetupContext(mergedHooks: AntigravityHooksConfig): void {
  writeAntigravityHooksConfig(mergedHooks);
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
    removeAntigravityHooksFromHooksConfig();

    // Legacy cleanup: strip hooks that pre-#4057 versions wrote into
    // settings.json (agy never read them, but leave the user's file tidy).
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      removeAntigravityHooksFromSettings();
    }

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

function removeAntigravityHooksFromHooksConfig(): void {
  if (!existsSync(GEMINI_HOOKS_CONFIG_PATH)) {
    console.log('  No Antigravity CLI hooks.json found — nothing to uninstall.');
    return;
  }

  let config: AntigravityHooksConfig;
  try {
    config = readAntigravityHooksConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  Skipping hooks.json cleanup: ${message}`);
    return;
  }

  let removedCount = 0;

  for (const [eventName, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) continue;
    const filteredGroups = groups
      .map(group => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const remainingHooks = group.hooks.filter(hook => hook.name !== HOOK_NAME);
        removedCount += group.hooks.length - remainingHooks.length;
        return { ...group, hooks: remainingHooks };
      })
      .filter(group => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);

    if (filteredGroups.length > 0) {
      config[eventName] = filteredGroups;
    } else {
      delete config[eventName];
    }
  }

  writeAntigravityHooksConfig(config);
  console.log(`  Removed ${removedCount} claude-mem hook(s) from ${GEMINI_HOOKS_CONFIG_PATH}`);

  if (removeContextTagBlock(GEMINI_MD_PATH)) {
    console.log(`  Removed context section from ${GEMINI_MD_PATH}`);
  }
}

function removeAntigravityHooksFromSettings(): void {
  const settings = readAntigravitySettings();
  if (!settings.hooks) {
    return;
  }

  let removedCount = 0;

  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    const filteredGroups = groups
      .map(group => {
        const remainingHooks = group.hooks.filter(hook => hook.name !== HOOK_NAME);
        removedCount += group.hooks.length - remainingHooks.length;
        return { ...group, hooks: remainingHooks };
      })
      .filter(group => group.hooks.length > 0);

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

  if (!existsSync(GEMINI_HOOKS_CONFIG_PATH)) {
    console.log('Antigravity CLI hooks.json: Not found');
    console.log(`  Expected at: ${GEMINI_HOOKS_CONFIG_PATH}\n`);
    console.log('No hooks installed. Run: claude-mem install --ide antigravity\n');
    return 0;
  }

  let hooksConfig: AntigravityHooksConfig;
  try {
    hooksConfig = readAntigravityHooksConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('WORKER', 'Failed to read Antigravity CLI hooks config', { path: GEMINI_HOOKS_CONFIG_PATH }, error instanceof Error ? error : new Error(String(error)));
    console.log(`Antigravity CLI hooks.json: ${message}\n`);
    return 0;
  }

  const installedEvents: string[] = [];
  for (const [eventName, groups] of Object.entries(hooksConfig)) {
    if (!Array.isArray(groups)) continue;
    const hasClaudeMem = groups.some(group =>
      Array.isArray(group?.hooks) && group.hooks.some(hook => hook.name === HOOK_NAME)
    );
    if (hasClaudeMem) {
      installedEvents.push(eventName);
    }
  }

  if (installedEvents.length === 0) {
    console.log('Hooks: Not installed');
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

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { toBmpSafe } from '../../utils/bmp-safe.js';
import { ANTIGRAVITY_HOOK_TIMEOUT_MS } from '../../shared/host-hook-limits.js';
import {
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_HOOK_TABLE,
  GEMINI_MD_PLACEHOLDER_BODY,
  LIBRARY_GROUPS,
  PLACEHOLDER_CONTEXT,
  antigravityHookItems,
  antigravityHooksMigration,
  antigravityLegacySettingsMigration,
  contextBlockItem,
  countAntigravityLegacyHandlers,
  libraryRemovalEnvironment,
  mcpMemberItem,
  nodeMcpServerEntry,
  type LibraryInstallEnvironment,
} from '../wire-gateway/library/agent-library-targets.js';
import {
  applyLibraryForInstaller,
  currentLibraryInstallEnvironment,
  removeLibraryForInstaller,
  withoutInstructionsWhenWireInjects,
} from '../wire-gateway/library/library-runtime.js';
import type { LibraryItem } from '../wire-gateway/library/types.js';

// agy hook schema (builtin `agy-customizations/docs/hooks.md`): each top-level
// key of hooks.json is a hook NAME, mapping to an object of event keys. Only
// PreToolUse/PostToolUse use the grouped { matcher, hooks } shape; the remaining
// events are flat arrays of handlers. Handlers carry type/command/timeout only
// (no per-handler `name`; `timeout` is seconds). The event table and the
// writes live in the Library (wire-gateway/library/agent-library-targets.ts).
type AntigravityHooksConfig = Record<string, unknown>;

// Antigravity CLI (`agy`) shares Gemini CLI's `~/.gemini/` config tree for
// context (GEMINI.md) and MCP, but it does NOT read lifecycle hooks from
// `settings.json` (agy 1.2.1, issue #4057, #4911): it loads them from a
// dedicated `hooks.json`. settings.json is touched only to remove hooks
// pre-#4057 installers wrote there.
const GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini');
const GEMINI_SETTINGS_PATH = path.join(GEMINI_CONFIG_DIR, 'settings.json');
const GEMINI_HOOKS_CONFIG_PATH = path.join(GEMINI_CONFIG_DIR, 'config', 'hooks.json');
const GEMINI_MD_PATH = path.join(GEMINI_CONFIG_DIR, 'GEMINI.md');

// B0 found two real, genuinely ambiguous MCP config paths on a live machine —
// one already populated (old path), one present but empty (newer path per
// third-party docs). Dual-write to both until Phase C's hands-on gate
// resolves which one `agy` actually reads. A zero-byte one is a fresh
// placeholder, read as `{}`.
const ANTIGRAVITY_MCP_CONFIG_PATHS = [
  path.join(GEMINI_CONFIG_DIR, 'antigravity', 'mcp_config.json'),
  path.join(GEMINI_CONFIG_DIR, 'config', 'mcp_config.json'),
];

// Plural "agents", home-relative — confirmed real and populated in B0 at
// ~/.agents/rules/ (the user's global rules directory, never process.cwd()).
const RULES_CONTEXT_PATH = path.join(homedir(), '.agents', 'rules', 'claude-mem-context.md');

// agy hook timeouts are in SECONDS ("Execution timeout in seconds. Defaults to
// 30"). The limit itself lives in host-hook-limits.ts, where the server-runtime
// SessionStart budget reads it.
export const ANTIGRAVITY_HOOK_TIMEOUT_SECONDS = ANTIGRAVITY_HOOK_TIMEOUT_MS / 1000;

const ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT: Record<string, string> = Object.fromEntries(
  ANTIGRAVITY_HOOK_TABLE.map((row) => [row.event, row.args.split(' ').pop()!]),
);

/** Everything claude-mem writes for agy: hooks, MCP in both candidate files, GEMINI.md and the rules context. */
function antigravityLibraryItems(environment: LibraryInstallEnvironment): LibraryItem[] {
  const items: LibraryItem[] = [];
  if (environment.workerServicePath) items.push(...antigravityHookItems(environment, GEMINI_HOOKS_CONFIG_PATH, ANTIGRAVITY_HOOK_TIMEOUT_SECONDS));
  if (environment.mcpServerPath) {
    for (const mcpConfigPath of ANTIGRAVITY_MCP_CONFIG_PATHS) items.push(mcpMemberItem(mcpConfigPath, ['mcpServers', 'claude-mem'], nodeMcpServerEntry(environment)));
  }
  items.push(
    contextBlockItem(GEMINI_MD_PATH, GEMINI_MD_PLACEHOLDER_BODY, 'once-after-blank-line'),
    // #2787: astral (surrogate-pair) code points are stripped so a context truncation can't split one.
    contextBlockItem(RULES_CONTEXT_PATH, toBmpSafe(PLACEHOLDER_CONTEXT), 'after-trimmed-text'),
  );
  return withoutInstructionsWhenWireInjects('antigravity', items);
}

export async function installAntigravityCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Antigravity CLI hooks + MCP...\n');

  const environment = currentLibraryInstallEnvironment();
  if (!environment.workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }
  console.log(`  Using Bun runtime: ${environment.bunPath}`);
  console.log(`  Worker service: ${environment.workerServicePath}`);
  if (!environment.mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    console.error('\nInstallation failed: MCP server script not found');
    return 1;
  }

  try {
    applyLibraryForInstaller({
      agentId: 'antigravity',
      items: antigravityLibraryItems(environment),
      ownedGroups: [LIBRARY_GROUPS.hooks, LIBRARY_GROUPS.mcp, LIBRARY_GROUPS.instructions],
      migrations: [antigravityHooksMigration(GEMINI_HOOKS_CONFIG_PATH)],
    });
    console.log(`  Merged hooks into ${GEMINI_HOOKS_CONFIG_PATH}`);
    console.log(`  Setup context injection in ${GEMINI_MD_PATH}`);
    console.log(`  Registered ${ANTIGRAVITY_HOOK_TABLE.length} hook events:`);
    for (const [event, internalEvent] of Object.entries(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT)) console.log(`    ${event} → ${internalEvent}`);
    for (const mcpConfigPath of ANTIGRAVITY_MCP_CONFIG_PATHS) console.log(`  MCP config written to: ${mcpConfigPath}`);
    console.log(`  Context placeholder written to: ${RULES_CONTEXT_PATH}`);

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

/**
 * Remove what claude-mem wrote for agy, and claude-mem's entries from before
 * the Library (the event-keyed hooks.json layout, hooks in settings.json):
 * every other hook, server and line stays.
 */
export function uninstallAntigravityCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Antigravity CLI hooks + MCP...\n');
  try {
    const result = removeLibraryForInstaller({
      agentId: 'antigravity',
      items: antigravityLibraryItems(libraryRemovalEnvironment(currentLibraryInstallEnvironment())),
      migrations: [antigravityHooksMigration(GEMINI_HOOKS_CONFIG_PATH), antigravityLegacySettingsMigration(GEMINI_SETTINGS_PATH)],
    });
    for (const path of result.filesWritten) console.log(`  Removed claude-mem entries from ${path}`);
    console.log('\nUninstallation complete!\n');
    console.log('Restart Antigravity CLI (agy) to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

/** The hooks.json agy loads, read only (status). Empty or absent is `{}`; corrupt throws. */
function readAntigravityHooksConfig(): AntigravityHooksConfig {
  if (!existsSync(GEMINI_HOOKS_CONFIG_PATH)) return {};
  if (!readFileSync(GEMINI_HOOKS_CONFIG_PATH, 'utf-8').trim()) return {};
  return readJsonSafe<AntigravityHooksConfig>(GEMINI_HOOKS_CONFIG_PATH, {});
}

// Same empty-file tolerance for the MCP configs (status).
function readMcpConfigTolerantly(mcpConfigPath: string): Record<string, any> {
  if (!existsSync(mcpConfigPath)) return {};
  if (readFileSync(mcpConfigPath, 'utf-8').trim() === '') return {};
  return readJsonSafe<Record<string, any>>(mcpConfigPath, {});
}

// What `status` reports for a hooks.json: the events the named `claude-mem`
// hook covers, how many claude-mem handlers a pre-#4196 install left under
// top-level event keys, and whether a stale pre-#4911 PreInvocation handler
// remains registered. Other tools' entries there are not counted, because
// re-running install only migrates claude-mem's. Exported for tests (#4196, #4911).
export function describeAntigravityHooks(
  config: AntigravityHooksConfig,
): { installedEvents: string[]; legacyHandlerCount: number; hasStalePreInvocation: boolean } {
  const installedEvents: string[] = [];
  let hasStalePreInvocation = false;
  const namedHook = config[ANTIGRAVITY_HOOK_NAME];
  if (namedHook && typeof namedHook === 'object' && !Array.isArray(namedHook)) {
    for (const event of Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT)) {
      const value = (namedHook as Record<string, unknown>)[event];
      if (Array.isArray(value) && value.length > 0) {
        installedEvents.push(event);
      }
    }

    const preInvocation = (namedHook as Record<string, unknown>)['PreInvocation'];
    if (Array.isArray(preInvocation) && preInvocation.length > 0) {
      hasStalePreInvocation = true;
    }
  }

  const legacyHandlerCount = countAntigravityLegacyHandlers(config);
  return { installedEvents, legacyHandlerCount, hasStalePreInvocation };
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

  const { installedEvents, legacyHandlerCount, hasStalePreInvocation } = describeAntigravityHooks(hooksConfig);

  if (installedEvents.length === 0 && !hasStalePreInvocation) {
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

  // A pre-#4911 install leaves a named PreInvocation handler that injects context
  // on every invocation, busting prefix cache. Warn the user to migrate.
  if (hasStalePreInvocation) {
    console.log(`\nStale hooks: PreInvocation context handler found (pre-#4911). This invalidates LLM prefix caching on every invocation.`);
    console.log('Re-run install to migrate: claude-mem install --ide antigravity\n');
  }

  // A pre-#4196 install leaves claude-mem under top-level event keys, which agy
  // ignores. Point at the migration whenever any are left, including next to a
  // current install.
  if (legacyHandlerCount > 0) {
    console.log(`Legacy hooks: ${legacyHandlerCount} pre-#4196 event-keyed claude-mem hook(s) found. Re-run install to migrate them.\n`);
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

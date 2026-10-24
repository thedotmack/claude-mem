// SPDX-License-Identifier: Apache-2.0
//
// Each agent's Library targets as data (plan Phase 14 task 2, Appendix B):
// the files claude-mem writes, their formats, hook event tables, MCP root
// keys and reference syntax, instruction files and bundles. The ported
// installers (src/services/integrations/*) turn these into LibraryItems and
// hand them to the engine; `claude-mem library status|sync|remove` reads the
// same table. Every value here is what that agent's pre-Library installer
// wrote, so the goldens it produced still hold.

import { dirname, join } from 'path';
import type { AgentEnvironment } from '../agents/types.js';
import { buildWorkerHookCommand, isWorkerHookCommandFor, type HookCommandStyle } from './hook-commands.js';
import { encodeMcpServerEntry, type McpEntryFormat } from './mcp-servers.js';
import type {
  ConfigMemberItem,
  JsonArrayEntryItem,
  JsonFileStyle,
  LibraryItem,
  LibraryMigration,
  LibraryValue,
  OwnedFileItem,
  TextBlockItem,
} from './types.js';
import { SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL } from './types.js';

/** What every target builder needs: resolved runtime paths and where the agent lives. */
export interface LibraryInstallEnvironment extends AgentEnvironment {
  cwd: string;
  bunPath: string;
  /** null when the plugin's worker-service.cjs cannot be found (hooks cannot be installed). */
  workerServicePath: string | null;
  /** null when the plugin's mcp-server.cjs cannot be found (MCP cannot be installed). */
  mcpServerPath: string | null;
  /** The Node that launches MCP servers (process.execPath, install-paths.ts). */
  nodePath: string;
}

/**
 * The environment a remove builds its items from: a script path the plugin
 * folder no longer provides is stood in for (SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL),
 * so every item, with its signature, is still there to find claude-mem's
 * entries by. A remove never needs the real path; the engine refuses to
 * write the stand-in.
 */
export function libraryRemovalEnvironment(environment: LibraryInstallEnvironment): LibraryInstallEnvironment {
  return {
    ...environment,
    workerServicePath: environment.workerServicePath ?? SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL,
    mcpServerPath: environment.mcpServerPath ?? SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL,
  };
}

/** The `<claude-mem-context>` markers claude-mem's runtime refreshers look for (utils/context-injection.ts). */
export { CONTEXT_TAG_OPEN as CONTEXT_BLOCK_OPEN, CONTEXT_TAG_CLOSE as CONTEXT_BLOCK_CLOSE } from '../../../utils/context-injection.js';
import { CONTEXT_TAG_CLOSE as CONTEXT_BLOCK_CLOSE, CONTEXT_TAG_OPEN as CONTEXT_BLOCK_OPEN } from '../../../utils/context-injection.js';

/** The context placeholder MCP-only integrations write before any session has run. */
export const PLACEHOLDER_CONTEXT = `# claude-mem: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.`;

/** The groups an agent's items fall in; an install owns its own groups (see LibraryItemBase.group). */
export const LIBRARY_GROUPS = {
  hooks: 'hooks',
  mcp: 'mcp',
  settings: 'settings',
  bundle: 'bundle',
  instructions: 'instructions',
} as const;

/** One hook the agent runs: its own event name, what claude-mem does then, optional matcher and timeout. */
export interface HookTableRow {
  event: string;
  args: string;
  matcher?: string;
  timeout?: number;
}

/** An agent the Library installs into: the id `claude-mem install --ide` and `library` take, and the wire agents it matches (task 5). */
export interface LibraryAgentTarget {
  id: string;
  name: string;
  /** Wire descriptors (agents/builtin-agents.ts) whose routes stand for this agent: their memory injection replaces its instruction blocks. */
  wireAgentIds: readonly string[];
  /** Appendix B: how the agent spells `${NAME}` in its MCP config. */
  mcpEntryFormat?: McpEntryFormat;
}

// --- Windsurf ---------------------------------------------------------------------------------

export const WINDSURF_HOOK_TABLE: readonly HookTableRow[] = [
  { event: 'pre_user_prompt', args: 'hook windsurf session-init' },
  { event: 'post_write_code', args: 'hook windsurf file-edit' },
  { event: 'post_run_command', args: 'hook windsurf observation' },
  { event: 'post_mcp_tool_use', args: 'hook windsurf observation' },
  { event: 'post_cascade_response', args: 'hook windsurf observation' },
];

export function windsurfHooksPath(environment: AgentEnvironment): string {
  return join(environment.home, '.codeium', 'windsurf', 'hooks.json');
}

export function windsurfRulesPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.windsurf', 'rules', 'claude-mem-context.md');
}

/** Windsurf and Cursor write their hooks.json with no final newline. */
const NO_FINAL_NEWLINE: JsonFileStyle = { finalNewline: false };

export function windsurfHookItems(environment: LibraryInstallEnvironment): { items: LibraryItem[]; jsonStyles: Record<string, JsonFileStyle> } {
  const file = windsurfHooksPath(environment);
  const items = WINDSURF_HOOK_TABLE.map((row): JsonArrayEntryItem => ({
    kind: 'hook',
    id: `hook:${row.event}`,
    group: LIBRARY_GROUPS.hooks,
    place: 'json-array-entry',
    file,
    arrayKeyPath: ['hooks', row.event],
    // Windsurf defaults to the active workspace; hook payloads other than
    // post_run_command omit cwd, so the adapter inherits that directory.
    entry: { command: buildWorkerHookCommand({ bunPath: environment.bunPath, workerServicePath: environment.workerServicePath!, args: row.args, style: 'shell-quoted', platform: environment.platform }), show_output: false },
    isPreLibraryEntry: (entry) => isWorkerHookCommandFor((entry as { command?: unknown } | null)?.command, 'windsurf'),
  }));
  return { items, jsonStyles: { [file]: NO_FINAL_NEWLINE } };
}

export const WINDSURF_PLACEHOLDER_RULES = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
`;

/** A workspace's rules file. `contents: null` records a file claude-mem's runtime just generated. */
export function rulesFileItem(path: string, contents: string | null, workspaceRoot: string): OwnedFileItem {
  return {
    kind: 'instructions',
    id: `instructions:${path}`,
    group: `${LIBRARY_GROUPS.instructions}:${workspaceRoot}`,
    place: 'file',
    path,
    contents: contents === null ? null : new TextEncoder().encode(contents),
    contentsManagedAtRuntime: true,
  };
}

// --- Cursor -----------------------------------------------------------------------------------

export const CURSOR_HOOK_TABLE: readonly HookTableRow[] = [
  { event: 'beforeSubmitPrompt', args: 'hook cursor session-init' },
  { event: 'beforeSubmitPrompt', args: 'hook cursor context' },
  { event: 'afterMCPExecution', args: 'hook cursor observation' },
  { event: 'afterShellExecution', args: 'hook cursor observation' },
  { event: 'afterFileEdit', args: 'hook cursor file-edit' },
  { event: 'stop', args: 'hook cursor summarize' },
];

// Older installers copied these scripts into <target>/hooks/ and pointed
// hooks.json at them (`./.cursor/hooks/session-init.sh`, an absolute
// `<dir>/hooks/session-init.sh`, or `powershell.exe ... -File "<dir>/hooks/session-init.ps1"`).
export const CURSOR_LEGACY_HOOK_SCRIPT_BASENAMES = ['common', 'session-init', 'context-inject', 'save-observation', 'save-file-edit', 'session-summary'] as const;

// Narrow on purpose: the script must sit directly in a `hooks` directory and
// have one of our exact basenames, so a user's `./my-session-init.sh` stays theirs.
const CURSOR_LEGACY_HOOK_COMMAND_PATTERN = new RegExp(
  `(?:^|[\\s"'\\\\/])hooks[\\\\/](?:${CURSOR_LEGACY_HOOK_SCRIPT_BASENAMES.join('|')})\\.(?:sh|ps1)["']?$`,
);

function cursorHookCommand(hook: unknown): string | null {
  const command = (hook as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command.trim() : null;
}

export function isUnifiedClaudeMemCursorHook(hook: unknown): boolean {
  const command = cursorHookCommand(hook);
  return command !== null && command.includes('worker-service') && command.includes('hook cursor');
}

export function isLegacyClaudeMemCursorHook(hook: unknown): boolean {
  const command = cursorHookCommand(hook);
  return command !== null && CURSOR_LEGACY_HOOK_COMMAND_PATTERN.test(command);
}

export function cursorHookItems(environment: LibraryInstallEnvironment, targetDirectory: string): { items: LibraryItem[]; jsonStyles: Record<string, JsonFileStyle> } {
  const file = join(targetDirectory, 'hooks.json');
  const version: ConfigMemberItem = {
    kind: 'setting', id: `setting:${file}:version`, group: `${LIBRARY_GROUPS.hooks}:${targetDirectory}`,
    place: 'member', file, format: 'json', keyPath: ['version'], value: 1, whenUnrecorded: 'leave', onlyWhenAbsent: true,
  };
  const hooks = CURSOR_HOOK_TABLE.map((row, index): JsonArrayEntryItem => ({
    kind: 'hook',
    id: `hook:${file}:${row.event}:${index}`,
    group: `${LIBRARY_GROUPS.hooks}:${targetDirectory}`,
    place: 'json-array-entry',
    file,
    arrayKeyPath: ['hooks', row.event],
    entry: { command: buildWorkerHookCommand({ bunPath: environment.bunPath, workerServicePath: environment.workerServicePath!, args: row.args, style: 'shell-quoted-json-escaped', platform: environment.platform }) },
    isPreLibraryEntry: (entry) => isUnifiedClaudeMemCursorHook(entry) || isLegacyClaudeMemCursorHook(entry),
  }));
  return { items: [version, ...hooks], jsonStyles: { [file]: NO_FINAL_NEWLINE } };
}

/** `mcpJsonPath` is `<target>/mcp.json`; the item's group names the target folder. */
export function cursorMcpItem(mcpServerPath: string, mcpJsonPath: string): { item: ConfigMemberItem; jsonStyles: Record<string, JsonFileStyle> } {
  const file = mcpJsonPath;
  const targetDirectory = dirname(mcpJsonPath);
  return {
    // Cursor's own MCP entry launches `node` from PATH, as it always has.
    item: mcpMemberItem(file, ['mcpServers', 'claude-mem'], encodeMcpServerEntry({ transport: 'stdio', command: 'node', args: [mcpServerPath] }, 'claude', { cursorSyntax: true }), `${LIBRARY_GROUPS.mcp}:${targetDirectory}`),
    jsonStyles: { [file]: NO_FINAL_NEWLINE },
  };
}

export const CURSOR_PLACEHOLDER_RULES = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
`;

// --- MCP members shared by every JSON MCP config ----------------------------------------------

/** claude-mem's server under its own name: an earlier install wrote it, so it is claude-mem's by name. */
export function mcpMemberItem(file: string, keyPath: string[], entry: Record<string, LibraryValue>, group: string = LIBRARY_GROUPS.mcp, format: ConfigMemberItem['format'] = 'json'): ConfigMemberItem {
  return { kind: 'mcp', id: `mcp:${file}:${keyPath.join('.')}`, group, place: 'member', file, format, keyPath, value: entry, whenUnrecorded: 'adopt' };
}

/** `node <mcp-server.cjs>` as the claude-family JSON configs spell it (what the MCP-only installers always wrote). */
export function nodeMcpServerEntry(environment: LibraryInstallEnvironment): Record<string, LibraryValue> {
  return encodeMcpServerEntry({ transport: 'stdio', command: environment.nodePath, args: [environment.mcpServerPath!] }, 'claude');
}

/** A `<claude-mem-context>` block claude-mem's runtime keeps refreshing (WARP.md, copilot-instructions.md, rules files). */
export function contextBlockItem(file: string, body: string, placement: TextBlockItem['placement'], group: string = LIBRARY_GROUPS.instructions): TextBlockItem {
  return {
    kind: 'instructions', id: `instructions:${file}`, group, place: 'text-block', file,
    open: CONTEXT_BLOCK_OPEN, close: CONTEXT_BLOCK_CLOSE, body, placement, bodyManagedAtRuntime: true,
  };
}

// --- Kimi -------------------------------------------------------------------------------------

export const KIMI_MARKER_BEGIN = '# >>> claude-mem kimi hooks (managed by claude-mem; do not edit) >>>';
export const KIMI_MARKER_END = '# <<< claude-mem kimi hooks <<<';

/** Seven rules: the Claude Code hook surface, plus PostToolUseFailure (a failed tool call is still an observation). */
export const KIMI_HOOK_TABLE: readonly HookTableRow[] = [
  { event: 'SessionStart', matcher: 'startup|resume', args: 'start', timeout: 120 },
  { event: 'UserPromptSubmit', args: 'hook kimi session-init-context', timeout: 120 },
  { event: 'PostToolUse', args: 'hook kimi observation', timeout: 120 },
  { event: 'PostToolUseFailure', args: 'hook kimi observation', timeout: 120 },
  { event: 'PreToolUse', matcher: 'Read', args: 'hook kimi file-context', timeout: 60 },
  { event: 'Stop', args: 'hook kimi summarize', timeout: 120 },
  { event: 'PreCompact', matcher: 'manual|auto', args: 'hook kimi summarize', timeout: 120 },
];

/** The `[[hooks]]` tables inside Kimi's managed block (no markers). */
export function kimiHooksBlockBody(bunPath: string, workerServicePath: string): string {
  return KIMI_HOOK_TABLE.map((row) => {
    const lines = ['[[hooks]]', `event = "${row.event}"`];
    if (row.matcher) lines.push(`matcher = "${row.matcher}"`);
    lines.push(`command = ${buildWorkerHookCommand({ bunPath, workerServicePath, args: row.args, style: 'toml-literal' })}`, `timeout = ${row.timeout}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function kimiHooksItem(configPath: string, bunPath: string, workerServicePath: string): TextBlockItem {
  return {
    kind: 'hook', id: 'hook:kimi-block', group: LIBRARY_GROUPS.hooks, place: 'text-block', file: configPath,
    open: KIMI_MARKER_BEGIN, close: KIMI_MARKER_END, body: kimiHooksBlockBody(bunPath, workerServicePath),
    placement: 'after-blank-line', validateAs: 'toml',
  };
}

/** Kimi's MCP entry keeps its generic name `mcp-search`: a pre-existing one is the user's unless it runs claude-mem's server. */
export function kimiMcpItem(mcpJsonPath: string, nodePath: string, mcpServerPath: string): ConfigMemberItem {
  return {
    kind: 'mcp', id: 'mcp:mcp-search', group: LIBRARY_GROUPS.mcp, place: 'member', file: mcpJsonPath, format: 'json',
    keyPath: ['mcpServers', 'mcp-search'],
    value: encodeMcpServerEntry({ transport: 'stdio', command: nodePath, args: [mcpServerPath] }, 'kimi'),
    whenUnrecorded: 'leave',
    isPreLibraryValue: (value) => {
      const args = (value as { args?: unknown } | null)?.args;
      return Array.isArray(args) && args.some((arg) => typeof arg === 'string' && arg.endsWith('mcp-server.cjs'));
    },
  };
}

// --- Antigravity CLI --------------------------------------------------------------------------

export const ANTIGRAVITY_HOOK_NAME = 'claude-mem';

// The 5 hook events `agy` fires, mapped to claude-mem's internal handlers:
//   - SessionStart   → context     (inject startup memory once per session;
//                                    PreInvocation busted the prefix cache, #4911)
//   - PreToolUse     → observation (adapter emits `{"decision":"allow"}`)
//   - PostToolUse    → observation
//   - PostInvocation → observation (the assistant response)
//   - Stop           → summarize
export const ANTIGRAVITY_HOOK_TABLE: readonly HookTableRow[] = [
  { event: 'SessionStart', args: 'hook antigravity-cli context' },
  { event: 'PreToolUse', args: 'hook antigravity-cli observation' },
  { event: 'PostToolUse', args: 'hook antigravity-cli observation' },
  { event: 'PostInvocation', args: 'hook antigravity-cli observation' },
  { event: 'Stop', args: 'hook antigravity-cli summarize' },
];

// PreToolUse/PostToolUse are the only events that use the grouped
// { matcher, hooks } shape; the rest are flat handler arrays (agy 1.2.13
// builtin docs/hooks.md, "Supported Event Types").
const ANTIGRAVITY_GROUPED_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export function antigravityHookItems(environment: LibraryInstallEnvironment, hooksPath: string, timeoutSeconds: number): LibraryItem[] {
  return ANTIGRAVITY_HOOK_TABLE.map((row): ConfigMemberItem => {
    const handler = {
      type: 'command',
      command: buildWorkerHookCommand({ bunPath: environment.bunPath, workerServicePath: environment.workerServicePath!, args: row.args, style: 'split-on-spaces', platform: environment.platform }),
      timeout: timeoutSeconds,
    };
    return {
      kind: 'hook', id: `hook:${row.event}`, group: LIBRARY_GROUPS.hooks, place: 'member', file: hooksPath, format: 'json',
      keyPath: [ANTIGRAVITY_HOOK_NAME, row.event],
      value: ANTIGRAVITY_GROUPED_EVENTS.has(row.event) ? [{ matcher: '*', hooks: [handler] }] : [handler],
      whenUnrecorded: 'adopt',
      // The named `claude-mem` hook exists only for these events: emptied by a remove, it goes too.
      dropEmptiedParentOnRemove: true,
    };
  });
}

interface LegacyAntigravityHookGroup {
  matcher?: string;
  hooks: Array<{ name?: string }>;
}

/**
 * Entries the pre-#4196 installers wrote: top-level keys are event names and
 * handlers carry `name: 'claude-mem'`. The current layout never has an array
 * at the top level, so an array there is unambiguously that shape.
 */
export function antigravityLegacyEventHookEdits(document: unknown): Array<{ op: 'set'; keyPath: string[]; value: LibraryValue } | { op: 'delete'; keyPath: string[] }> {
  const edits: Array<{ op: 'set'; keyPath: string[]; value: LibraryValue } | { op: 'delete'; keyPath: string[] }> = [];
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return edits;
  for (const [eventName, value] of Object.entries(document as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    let removed = 0;
    const groups = (value as LegacyAntigravityHookGroup[])
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const remaining = group.hooks.filter((hook) => hook?.name !== ANTIGRAVITY_HOOK_NAME);
        removed += group.hooks.length - remaining.length;
        return { ...group, hooks: remaining };
      })
      .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (removed === 0) continue;
    edits.push(groups.length > 0 ? { op: 'set', keyPath: [eventName], value: groups as unknown as LibraryValue } : { op: 'delete', keyPath: [eventName] });
  }
  return edits;
}

/** Migrations for agy's hooks.json: the pre-#4196 event-keyed entries, and the pre-#4911 PreInvocation context hook. */
export function antigravityHooksMigration(hooksPath: string): LibraryMigration {
  return {
    file: hooksPath,
    format: 'json',
    compute: (document) => {
      const edits = antigravityLegacyEventHookEdits(document);
      const named = (document as Record<string, unknown> | null)?.[ANTIGRAVITY_HOOK_NAME];
      if (named && typeof named === 'object' && !Array.isArray(named) && Object.hasOwn(named, 'PreInvocation')) {
        edits.push({ op: 'delete', keyPath: [ANTIGRAVITY_HOOK_NAME, 'PreInvocation'] });
      }
      return edits;
    },
  };
}

export const GEMINI_MD_PLACEHOLDER_BODY = `# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*`;

// --- OpenCode ---------------------------------------------------------------------------------

export const OPENCODE_PLUGIN_CONFIG_PATH = './plugins/claude-mem.js';
export const OPENCODE_MCP_SERVER_KEY = 'claude-mem';

// --- the agents ---------------------------------------------------------------------------------

/**
 * Every agent claude-mem installs into through the Library (the plan's port
 * order, task 4), with the wire agents whose routes stand for it. Claude Code
 * is not here: it installs as a marketplace plugin, not by file edits.
 */
export const LIBRARY_AGENT_TARGETS: readonly LibraryAgentTarget[] = [
  { id: 'windsurf', name: 'Windsurf', wireAgentIds: [] },
  { id: 'kimi', name: 'Kimi Code', wireAgentIds: ['kimi'], mcpEntryFormat: 'kimi' },
  { id: 'antigravity', name: 'Antigravity CLI', wireAgentIds: ['antigravity-cli'], mcpEntryFormat: 'antigravity' },
  { id: 'cursor', name: 'Cursor', wireAgentIds: ['cursor-private-inference'], mcpEntryFormat: 'claude' },
  { id: 'opencode', name: 'OpenCode', wireAgentIds: ['opencode'], mcpEntryFormat: 'opencode' },
  { id: 'openclaw', name: 'OpenClaw', wireAgentIds: ['openclaw'] },
  { id: 'pi', name: 'Pi', wireAgentIds: ['pi'] },
  { id: 'omp', name: 'OMP', wireAgentIds: ['omp'] },
  { id: 't3code', name: 'T3 Code', wireAgentIds: [] },
  { id: 'grok-bot', name: 'Grok Bot', wireAgentIds: [] },
  { id: 'dsh', name: 'DeepSeek Harness', wireAgentIds: [] },
  { id: 'codex-cli', name: 'Codex CLI', wireAgentIds: ['codex'], mcpEntryFormat: 'codex' },
  { id: 'copilot-cli', name: 'Copilot CLI', wireAgentIds: [], mcpEntryFormat: 'claude' },
  { id: 'roo-code', name: 'Roo Code', wireAgentIds: ['roo-code'], mcpEntryFormat: 'claude' },
  { id: 'warp', name: 'Warp', wireAgentIds: [], mcpEntryFormat: 'claude' },
  { id: 'goose', name: 'Goose', wireAgentIds: ['goose'], mcpEntryFormat: 'goose' },
];

export function findLibraryAgentTarget(agentId: string): LibraryAgentTarget | undefined {
  return LIBRARY_AGENT_TARGETS.find((target) => target.id === agentId);
}

export type { HookCommandStyle };

/** How many handlers the pre-#4196 event-keyed layout still holds for claude-mem (status). */
export function countAntigravityLegacyHandlers(document: unknown): number {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return 0;
  let count = 0;
  for (const value of Object.values(document as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const group of value as LegacyAntigravityHookGroup[]) {
      if (group && Array.isArray(group.hooks)) count += group.hooks.filter((hook) => hook?.name === ANTIGRAVITY_HOOK_NAME).length;
    }
  }
  return count;
}

/**
 * Hooks the pre-#4057 installers put in ~/.gemini/settings.json, which agy
 * never read: `hooks.<Event>[].hooks[]` handlers named claude-mem.
 */
export function antigravityLegacySettingsMigration(settingsPath: string): LibraryMigration {
  return {
    file: settingsPath,
    format: 'json',
    compute: (document) => {
      const hooks = (document as { hooks?: unknown } | null)?.hooks;
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
      const edits = antigravityLegacyEventHookEdits(hooks).map((edit) => ({ ...edit, keyPath: ['hooks', ...edit.keyPath] }));
      if (edits.length === 0) return [];
      const remaining = Object.keys(hooks).filter((event) => !edits.some((edit) => edit.op === 'delete' && edit.keyPath[1] === event));
      return remaining.length === 0 ? [{ op: 'delete', keyPath: ['hooks'] }] : edits;
    },
  };
}

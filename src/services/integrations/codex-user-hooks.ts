/**
 * claude-mem's Codex hooks, registered in the user's own `<codex home>/hooks.json`.
 *
 * Why not bundle them in the plugin: Codex approves a plugin-bundled hook
 * against a fingerprint of the WHOLE plugin folder (codex-rs/hooks
 * plugin_fingerprint.rs), so every claude-mem update turned every hook off
 * ("plugin contents changed; hook approval required") until the owner
 * approved them again. Codex approves a user-level hook against its
 * declaration only (event, matcher, command, timeout) and its position in the
 * file, so the approval survives an update as long as neither changes.
 *
 * To keep both stable:
 * - the command is the on-PATH `claude-mem` launcher, which finds the newest
 *   installed plugin at run time, so its text does not change between releases;
 * - claude-mem's groups are appended after everyone else's and then left where
 *   they are, so no other tool's hook moves and ours keep their position.
 *
 * This file never writes an approval. Trust stays the owner's step in Codex.
 */
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';

export const CODEX_USER_HOOKS_FILE_NAME = 'hooks.json';

type JsonRecord = Record<string, unknown>;
export type CodexHookGroups = Record<string, JsonRecord>;

const HOOK_EVENT_ARGUMENT = /\bhook codex ([a-z][a-z-]*)/;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A command claude-mem wrote: the launcher form, or the older plugin-script form. */
function isClaudeMemCodexHook(handler: unknown): boolean {
  if (!isRecord(handler) || typeof handler.command !== 'string') return false;
  return HOOK_EVENT_ARGUMENT.test(handler.command)
    && /claude-mem|worker-service\.cjs/.test(handler.command);
}

/** Quote one path for the shell Codex starts the hook in. */
function quoteForHookShell(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${value}"`;
  // Single quotes are literal in sh, bash, zsh and fish alike.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function codexLauncherHookCommand(
  launcherPath: string,
  hookEvent: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${quoteForHookShell(launcherPath, platform)} hook codex ${hookEvent}`;
}

/**
 * Turn the generated hook definitions (plugin/hooks/codex-hooks.json: events,
 * matchers, timeouts) into the groups written at user level. Only the command
 * is replaced, so matchers and timeouts keep their single source.
 */
export function buildCodexUserHookGroups(
  bundledHooks: unknown,
  launcherPath: string,
  platform: NodeJS.Platform = process.platform,
): CodexHookGroups {
  if (!isRecord(bundledHooks) || !isRecord(bundledHooks.hooks)) {
    throw new Error('claude-mem Codex hook definitions are missing their "hooks" object.');
  }
  const groups: CodexHookGroups = {};
  for (const [eventName, eventGroups] of Object.entries(bundledHooks.hooks)) {
    if (!Array.isArray(eventGroups) || eventGroups.length !== 1 || !isRecord(eventGroups[0])
      || !Array.isArray(eventGroups[0].hooks) || eventGroups[0].hooks.length !== 1) {
      throw new Error(`claude-mem Codex hook definitions for ${eventName} must be one group with one hook.`);
    }
    const group = eventGroups[0];
    const handler = (group.hooks as unknown[])[0];
    const hookEvent = isRecord(handler) && typeof handler.command === 'string'
      ? HOOK_EVENT_ARGUMENT.exec(handler.command)?.[1]
      : undefined;
    if (!isRecord(handler) || !hookEvent) {
      throw new Error(`claude-mem Codex hook definition for ${eventName} does not name a "hook codex <event>" command.`);
    }
    const { type, command: _command, commandWindows: _commandWindows, ...handlerOptions } = handler;
    groups[eventName] = {
      ...group,
      hooks: [{ type, command: codexLauncherHookCommand(launcherPath, hookEvent, platform), ...handlerOptions }],
    };
  }
  return groups;
}

function refuse(hooksPath: string, problem: string): never {
  throw new Error(
    `${hooksPath} ${problem}. claude-mem left the file untouched. `
    + 'Fix or remove it, then run: npx claude-mem@latest install',
  );
}

/**
 * Merge claude-mem's groups into a hooks.json document other tools also write.
 *
 * Other tools' groups are never dropped, edited or reordered. A claude-mem
 * group that already matches is left exactly where it is; one that differs is
 * replaced in place; a missing one is appended. Passing no groups removes
 * claude-mem's entries and nothing else. Returns the same document object when
 * nothing needs to change.
 */
export function mergeCodexUserHooks(
  document: unknown,
  claudeMemGroups: CodexHookGroups,
  hooksPath = CODEX_USER_HOOKS_FILE_NAME,
): { document: JsonRecord; changed: boolean } {
  if (!isRecord(document)) refuse(hooksPath, 'is not a JSON object');
  const existingEvents = document.hooks === undefined ? {} : document.hooks;
  if (!isRecord(existingEvents)) refuse(hooksPath, 'has a "hooks" entry that is not an object');

  const nextEvents: JsonRecord = {};
  const eventNames = [
    ...Object.keys(existingEvents),
    ...Object.keys(claudeMemGroups).filter((eventName) => !(eventName in existingEvents)),
  ];

  for (const eventName of eventNames) {
    const existingGroups = eventName in existingEvents ? existingEvents[eventName] : [];
    if (!Array.isArray(existingGroups)) refuse(hooksPath, `lists hooks.${eventName} as something other than a list`);
    const wanted = claudeMemGroups[eventName];
    let placed = false;
    let removedOwn = false;
    const nextGroups: unknown[] = [];

    for (const group of existingGroups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        refuse(hooksPath, `has an entry under hooks.${eventName} without a "hooks" list`);
      }
      if (!group.hooks.some(isClaudeMemCodexHook)) {
        nextGroups.push(group);
        continue;
      }
      // A group holding only claude-mem's hook is the one this installer wrote.
      if (wanted && !placed && group.hooks.length === 1) {
        placed = true;
        nextGroups.push(JSON.stringify(group) === JSON.stringify(wanted) ? group : wanted);
        continue;
      }
      // A duplicate, an event claude-mem no longer uses, or a group shared
      // with another tool's hook: take only claude-mem's hook out.
      removedOwn = true;
      const othersHooks = group.hooks.filter((handler) => !isClaudeMemCodexHook(handler));
      if (othersHooks.length > 0) nextGroups.push({ ...group, hooks: othersHooks });
    }

    if (wanted && !placed) nextGroups.push(wanted);
    // Drop an event key only when removing claude-mem's hook emptied it.
    if (nextGroups.length === 0 && removedOwn) continue;
    if (nextGroups.length === 0 && !(eventName in existingEvents)) continue;
    nextEvents[eventName] = nextGroups;
  }

  const next = { ...document, hooks: nextEvents };
  if (JSON.stringify(next) === JSON.stringify({ ...document, hooks: existingEvents })) {
    return { document, changed: false };
  }
  return { document: next, changed: true };
}

function readHooksDocument(hooksPath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(hooksPath, 'utf-8');
  } catch (error) {
    refuse(hooksPath, `could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  if (raw.trim() === '') return {};
  try {
    return parseJsonWithBom(raw);
  } catch (error) {
    refuse(hooksPath, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

export interface CodexUserHooksResult {
  hooksPath: string;
  changed: boolean;
  hookCount: number;
}

/** Register claude-mem's hooks in `<codexHome>/hooks.json`. Throws, writing nothing, on a file it cannot safely merge. */
export function registerCodexUserHooks(options: {
  codexHome: string;
  /** The generated definitions, normally `<marketplace>/plugin/hooks/codex-hooks.json`. */
  hookDefinitionsPath: string;
  launcherPath: string;
  platform?: NodeJS.Platform;
  /** Check that the existing file can be merged, and write nothing. */
  dryRun?: boolean;
}): CodexUserHooksResult {
  const hooksPath = path.join(options.codexHome, CODEX_USER_HOOKS_FILE_NAME);
  const groups = buildCodexUserHookGroups(
    parseJsonWithBom(readFileSync(options.hookDefinitionsPath, 'utf-8')),
    options.launcherPath,
    options.platform,
  );
  const current = existsSync(hooksPath) ? readHooksDocument(hooksPath) : {};
  const merged = mergeCodexUserHooks(current, groups, hooksPath);
  if (merged.changed && !options.dryRun) writeJsonFileAtomic(hooksPath, merged.document);
  return { hooksPath, changed: merged.changed, hookCount: Object.keys(groups).length };
}

/** Remove only claude-mem's hooks from `<codexHome>/hooks.json`. A missing file is already clean. */
export function removeCodexUserHooks(codexHome: string): CodexUserHooksResult {
  const hooksPath = path.join(codexHome, CODEX_USER_HOOKS_FILE_NAME);
  if (!existsSync(hooksPath)) return { hooksPath, changed: false, hookCount: 0 };
  const merged = mergeCodexUserHooks(readHooksDocument(hooksPath), {}, hooksPath);
  if (merged.changed) writeJsonFileAtomic(hooksPath, merged.document);
  return { hooksPath, changed: merged.changed, hookCount: 0 };
}

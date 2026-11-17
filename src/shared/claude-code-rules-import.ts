import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import { resolveDataDir } from './data-dir.js';
import { CLAUDE_CONFIG_DIR } from './paths.js';

/**
 * Claude Code loads claude-mem's guidance through one chain of imports:
 * <Claude config dir>/CLAUDE.md imports MY-RULES.md (added from My Rules), and
 * MY-RULES.md imports RULES-AND-TOOLS.md (how to read the timeline and use the
 * tools). When that chain is in place, the other channels that carry the same
 * text (the SessionStart pointer line, the MCP server instructions) stay quiet,
 * so an agent reads each instruction once, where CLAUDE.md puts it.
 *
 * fs and path only: the MCP server bundle and the SessionStart hook import this.
 */
export const MY_RULES_FILENAME = 'MY-RULES.md';
export const RULES_AND_TOOLS_FILENAME = 'RULES-AND-TOOLS.md';

export function myRulesFilePath(): string {
  return join(resolveDataDir(), MY_RULES_FILENAME);
}

export function rulesAndToolsFilePath(): string {
  return join(resolveDataDir(), RULES_AND_TOOLS_FILENAME);
}

export function userClaudeInstructionsPath(): string {
  return join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
}

/**
 * A path with `/` separators. Claude Code does not resolve an `@` import whose
 * separators are `\` (Windows `path.join` output): it skips the file without a
 * word. `C:/Users/…` and `~/…` both load on Windows.
 */
export function forwardSlashPath(filePath: string, separator: string = sep): string {
  return separator === '\\' ? filePath.replaceAll('\\', '/') : filePath;
}

/** A path as a person types it: `~/…` under the home folder, else absolute, with `/` separators. */
export function homeRelativePath(filePath: string, home: string = homedir(), separator: string = sep): string {
  const path = forwardSlashPath(filePath, separator);
  const root = forwardSlashPath(home, separator);
  return path === root || path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/** The `@path` line that makes Claude Code load a file. Claude Code ends @path at an unescaped space; quoting it is not an import. */
export function claudeCodeImportLine(filePath: string, home: string = homedir(), separator: string = sep): string {
  return `@${homeRelativePath(filePath, home, separator).replaceAll(' ', '\\ ')}`;
}

export function rulesAndToolsPointerLine(filePath: string = rulesAndToolsFilePath()): string {
  return `Access Claude-Mem Rules + Tools: ${homeRelativePath(filePath)}`;
}

function readIfPresent(filePath: string): string | null {
  try { return readFileSync(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Claude Code loads `@~/…` and `@/absolute/…` alike, so either spelling counts as the import. */
function hasImportLine(text: string | null, importedPath: string): boolean {
  const accepted = new Set([claudeCodeImportLine(importedPath), `@${importedPath.replaceAll(' ', '\\ ')}`]);
  if (text === null) return false;
  // Claude Code does not evaluate imports in fenced code examples. Only a
  // matching marker at least as long, with no trailing text, closes a fence.
  let fence: string | null = null;
  for (const candidate of text.split(/\r\n?|\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(candidate);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) { fence = marker[1]; continue; }
    if (accepted.has(candidate.trim())) return true;
  }
  return false;
}

export interface RulesImportPaths {
  claudeInstructionsPath?: string;
  myRulesPath?: string;
  rulesAndToolsPath?: string;
}

/** True when Claude Code's user CLAUDE.md -> MY-RULES.md -> RULES-AND-TOOLS.md chain is complete and the last file exists. */
export function rulesAndToolsLoadedByClaudeCode(paths: RulesImportPaths = {}): boolean {
  const claudeInstructionsPath = paths.claudeInstructionsPath ?? userClaudeInstructionsPath();
  const myRulesPath = paths.myRulesPath ?? myRulesFilePath();
  const rulesAndToolsPath = paths.rulesAndToolsPath ?? rulesAndToolsFilePath();
  return hasImportLine(readIfPresent(claudeInstructionsPath), myRulesPath)
    && hasImportLine(readIfPresent(myRulesPath), rulesAndToolsPath)
    && existsSync(rulesAndToolsPath);
}

/**
 * Whether the MCP server may skip its instructions: the host is Claude Code
 * (it spawns MCP servers with CLAUDECODE=1; Codex, Cursor and the desktop app
 * do not), the import chain is complete, and the imported file already holds
 * exactly the text the server would send. Any mismatch (other runtime, a
 * setting changed since the file was written) keeps the instructions on.
 */
export function claudeCodeAlreadyLoadsInstructions(
  instructions: string,
  environment: NodeJS.ProcessEnv = process.env,
  paths: RulesImportPaths = {},
): boolean {
  if (!instructions || environment.CLAUDECODE !== '1') return false;
  const rulesAndToolsPath = paths.rulesAndToolsPath ?? rulesAndToolsFilePath();
  if (!rulesAndToolsLoadedByClaudeCode({ ...paths, rulesAndToolsPath })) return false;
  return readIfPresent(rulesAndToolsPath)?.includes(instructions) === true;
}

/**
 * The SessionStart text for Claude Code without its first line when that line
 * points at a file CLAUDE.md already loads. Exact match only; anything else is
 * returned unchanged.
 */
export function withoutLoadedRulesPointer(contextText: string, paths: RulesImportPaths = {}): string {
  const pointer = rulesAndToolsPointerLine(paths.rulesAndToolsPath);
  if (contextText !== pointer && !contextText.startsWith(`${pointer}\n`)) return contextText;
  if (!rulesAndToolsLoadedByClaudeCode(paths)) return contextText;
  return contextText.slice(pointer.length).replace(/^\n+/, '');
}

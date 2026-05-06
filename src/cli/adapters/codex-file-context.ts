import { existsSync, statSync } from 'fs';
import path from 'path';
import { parse, type ParsedToken } from 'shell-quote';

const MAX_FILE_PATHS = 10;
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'view', 'nl', 'tac']);
const FLAGS_WITH_VALUES_BY_COMMAND: Record<string, Set<string>> = {
  head: new Set(['-n', '-c', '--lines', '--bytes']),
  tail: new Set(['-n', '-c', '--lines', '--bytes']),
};
const NO_FLAGS_WITH_VALUES = new Set<string>();

function isOperatorToken(token: ParsedToken): boolean {
  return typeof token === 'object' && token !== null && 'op' in token;
}

function splitSegments(tokens: ParsedToken[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (isOperatorToken(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    if (typeof token === 'string') {
      current.push(token);
    }
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function normalizeCommand(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

function isFlagLike(value: string): boolean {
  return value.startsWith('-') || value.startsWith('+');
}

function flagsWithValues(command: string): Set<string> {
  return FLAGS_WITH_VALUES_BY_COMMAND[command] ?? NO_FLAGS_WITH_VALUES;
}

function dropFlagValue(flag: string, command: string): boolean {
  const valueFlags = flagsWithValues(command);
  if (valueFlags.has(flag)) return true;
  const eqIndex = flag.indexOf('=');
  return eqIndex > 0 && valueFlags.has(flag.slice(0, eqIndex));
}

function isExistingFile(candidate: string, cwd: string): boolean {
  const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  try {
    if (!existsSync(absolutePath)) return false;
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function dedupeAndCap(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const filePath of paths) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    deduped.push(filePath);
    if (deduped.length >= MAX_FILE_PATHS) break;
  }

  return deduped;
}

function extractFromBash(toolInput: unknown, cwd: string): string[] {
  const command = normalizeCommand((toolInput as { command?: unknown } | undefined)?.command);
  if (!command) return [];

  const tokens = parse(command);
  const paths: string[] = [];

  for (const segment of splitSegments(tokens)) {
    const argv0Index = segment.findIndex(token => token && !isFlagLike(token));
    if (argv0Index === -1) continue;

    const argv0 = path.basename(segment[argv0Index]);
    if (!READ_COMMANDS.has(argv0)) continue;

    let skipNext = false;
    for (const token of segment.slice(argv0Index + 1)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (isFlagLike(token)) {
        skipNext = dropFlagValue(token, argv0) && !token.includes('=');
        continue;
      }
      if (isExistingFile(token, cwd)) {
        paths.push(token);
      }
    }
  }

  return dedupeAndCap(paths);
}

function extractFromMcp(toolName: string, toolInput: unknown, cwd: string): string[] {
  if (!/^mcp__.+__(read|view|cat)(?:_file|_files)?$/.test(toolName)) return [];

  const input = (toolInput ?? {}) as { path?: unknown; paths?: unknown };
  const candidates: string[] = [];

  if (typeof input.path === 'string') candidates.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const item of input.paths) {
      if (typeof item === 'string') candidates.push(item);
    }
  }

  return dedupeAndCap(candidates.filter(candidate => isExistingFile(candidate, cwd)));
}

export function extractFilePaths(toolName: string, toolInput: unknown, cwd: string): string[] {
  if (toolName === 'Bash') return extractFromBash(toolInput, cwd);
  if (toolName.startsWith('mcp__')) return extractFromMcp(toolName, toolInput, cwd);
  return [];
}

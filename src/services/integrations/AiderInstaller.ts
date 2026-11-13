/**
 * AiderInstaller.ts — file-based Aider integration.
 *
 * Aider (0.86.x) has no MCP client, no hooks, and no plugin API, so there is
 * no adapter to build: the supported surface is the conventions file Aider
 * loads read-only into every session (aider.chat/docs/usage/conventions).
 * This installer merges one entry — the per-project memory file
 * `.claude-mem/aider-memory.md` — into the project's `.aider.conf.yml`
 * `read:` list, and refreshes that file from the worker
 * (`GET /api/context/inject`, the same endpoint Cursor's context refresh
 * uses) on `aider sync`.
 *
 * The YAML merge is text-level, following the Goose precedent in
 * McpIntegrations.ts: no YAML library is a dependency of this repo, and a
 * round-trip rewrite would drop comments, reorder keys, and risk the user's
 * API keys. Every other line stays byte-for-byte as written. A config whose
 * `read:` region is ambiguous or malformed is refused, never replaced with
 * an empty object; the file is left untouched and the installer reports the
 * failure honestly.
 *
 * The installer never logs file contents: `.aider.conf.yml` can hold API
 * keys (`openai-api-key`, `anthropic-api-key`, `api-key`, `set-env`), so
 * console output names paths only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stripUtf8Bom, writeTextFileAtomic } from '../../shared/atomic-json.js';
import {
  AIDER_MEMORY_RELATIVE_PATH,
  aiderMemoryFilePath,
  aiderProjectDirForConfig,
  resolveAiderConfigPath,
} from '../../shared/aider-paths.js';
import { cliFlagValue } from '../../shared/cli-flag-value.js';
import { projectsQueryString } from '../../shared/project-list.js';
import { getProjectContext } from '../../utils/project-name.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';

export const AIDER_MARKER_BEGIN = '# >>> claude-mem aider (managed by claude-mem; do not edit) >>>';
export const AIDER_MARKER_END = '# <<< claude-mem aider <<<';
/** Trailing comment marking the entry this installer owns in a user `read:` list. */
export const AIDER_MANAGED_ENTRY_COMMENT = '# claude-mem (managed)';

const AIDER_MEMORY_HEADER = '# claude-mem memory for Aider';
const AIDER_PLACEHOLDER_CONTEXT = [
  '# Memory Context from Past Sessions',
  '',
  '*No context yet. Complete your first session, then run `npx claude-mem aider sync` — context will appear here.*',
  '',
  'Use `npx claude-mem search <query>` for manual memory queries.',
].join('\n');

const USAGE = 'Usage: claude-mem aider <install|uninstall|status|sync> [--cwd <dir>]';

export interface AiderInstallOptions {
  cwd?: string;
  configPath?: string;
  /** `--no-auto-start`: refresh from a worker that is already running, never start one. */
  noAutoStart?: boolean;
}

interface AiderPaths {
  configPath: string;
  projectDir: string;
  memoryFilePath: string;
}

function resolveAiderPaths(options: AiderInstallOptions = {}): AiderPaths {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolveAiderConfigPath(cwd);
  return {
    configPath,
    projectDir: aiderProjectDirForConfig(configPath, cwd),
    memoryFilePath: aiderMemoryFilePath(configPath, cwd),
  };
}

function backupOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    // Owner-only: the backup holds every Aider setting, including API keys,
    // and the default umask would make it world-readable even when the
    // config itself is not.
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'), { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// Line-level YAML helpers (text-level merge; no YAML library in this repo)
// ---------------------------------------------------------------------------

function isYamlContentLine(line: string): boolean {
  return line.trim() !== '' && !line.trimStart().startsWith('#');
}

function leadingSpaceCount(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Rest after a top-level `read:` key on `line` (column 0, plain or quoted),
 * or null when the line is not that key. A commented-out or nested `read:`
 * never matches.
 */
function readKeyRest(line: string): string | null {
  const match = /^(['"]?)read\1\s*:(.*)$/.exec(line);
  if (!match) return null;
  const rest = match[2];
  return rest === '' || /^\s/.test(rest) ? rest : null;
}

/** `rest` with a trailing `# comment` removed (a `#` inside quotes is kept). */
function stripYamlComment(rest: string): string {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(rest[i - 1]))) return rest.slice(0, i);
  }
  return rest;
}

/** Unquote a YAML single- or double-quoted scalar; null when not quoted. */
function unquoteYamlScalar(value: string): string | null {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  return null;
}

/** Plain scalar as written, or its unquoted form; null for flow/mapping values. */
function yamlScalarValue(rest: string): string | null {
  const trimmed = stripYamlComment(rest).trim();
  if (trimmed === '') return null;
  const quoted = unquoteYamlScalar(trimmed);
  if (quoted !== null) return quoted;
  if (/^[[{&*!|>]/.test(trimmed)) return null;
  return trimmed;
}

/** Quote `value` for YAML when it is not plain-safe; plain otherwise. */
function yamlPlainOrQuoted(value: string): string {
  return /^[A-Za-z0-9._\/\-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Items of a single-line flow list (`[a, b]`), unquoted; null when the list
 * is unclosed, spans lines, or has unbalanced quotes.
 */
function parseFlowList(rest: string): string[] | null {
  const trimmed = stripYamlComment(rest).trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1);
  if (inner.includes('[') || inner.includes(']')) return null;
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (quote) return null;
  if (current.trim() !== '') items.push(current.trim());
  return items
    .map((item) => (item === '' ? null : (unquoteYamlScalar(item) ?? item)))
    .filter((item): item is string => item !== null);
}

type AiderReadForm =
  | { kind: 'block'; header: number; end: number; itemIndent: string; items: { line: number; value: string }[] }
  | { kind: 'flow'; header: number; items: string[] }
  | { kind: 'scalar'; header: number; value: string };

/**
 * Index of the `]` closing the flow list on `line`, before any trailing
 * comment: searching the whole line would find a `]` inside `# [shared
 * docs]` and put the new entry in the comment instead of the list.
 */
function flowListCloseIndex(line: string): number {
  return stripYamlComment(line).lastIndexOf(']');
}

/**
 * Where the top-level `read:` key and its entries sit in `lines`; null when
 * there is no such key. Throws when the `read:` region is ambiguous or
 * malformed — the caller must refuse to write, never guess.
 */
function findAiderReadSpan(lines: string[]): AiderReadForm | null {
  const headers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => readKeyRest(line) !== null)
    .map(({ index }) => index);
  if (headers.length === 0) return null;
  if (headers.length > 1) {
    throw new Error('Duplicate top-level `read:` key in .aider.conf.yml; remove one and try again');
  }
  const header = headers[0];
  const rest = readKeyRest(lines[header])!;
  const valueText = stripYamlComment(rest).trim();

  if (valueText !== '') {
    if (valueText.startsWith('[')) {
      const items = parseFlowList(rest);
      if (items === null) {
        throw new Error('`read:` flow list is unclosed or spans lines; write it as a block list and try again');
      }
      return { kind: 'flow', header, items };
    }
    const scalar = yamlScalarValue(rest);
    if (scalar === null) {
      throw new Error('`read:` has a mapping or block value claude-mem cannot merge; write it as a list and try again');
    }
    return { kind: 'scalar', header, value: scalar };
  }

  // Block sequence: runs to the next top-level content line or document end.
  // A column-zero `- ` line is a list item of this same `read:` list, not a
  // new top-level key: `read:\n- CONVENTIONS.md` is valid YAML.
  let end = header + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\.\.\.(?:\s|$)/.test(line) || /^---(?:\s|$)/.test(line)) break;
    if (isYamlContentLine(line) && leadingSpaceCount(line) === 0 && !/^-(?:\s|$)/.test(line)) break;
    end++;
  }
  const items: { line: number; value: string }[] = [];
  let itemIndent: string | null = null;
  for (let i = header + 1; i < end; i++) {
    const line = lines[i];
    if (!isYamlContentLine(line)) continue;
    if (line.includes('\t')) {
      throw new Error('Tab indentation in the `read:` list; YAML forbids tabs — fix the indentation and try again');
    }
    const itemMatch = /^(\s*)-\s+(.*)$/.exec(line);
    if (!itemMatch) {
      throw new Error('`read:` has a non-list entry; write it as a list of files and try again');
    }
    if (itemIndent === null) itemIndent = itemMatch[1];
    if (itemMatch[1] !== itemIndent) {
      throw new Error('`read:` list items use inconsistent indentation; fix the indentation and try again');
    }
    const value = yamlScalarValue(itemMatch[2]);
    if (value === null) {
      throw new Error('`read:` list has an entry claude-mem cannot read; use plain file paths and try again');
    }
    items.push({ line: i, value });
  }
  return { kind: 'block', header, end, itemIndent: itemIndent ?? '  ', items };
}

function managedBlockLines(memoryPath: string): string[] {
  return [
    AIDER_MARKER_BEGIN,
    'read:',
    `  - ${yamlPlainOrQuoted(memoryPath)}`,
    AIDER_MARKER_END,
  ];
}

function findManagedBlock(lines: string[]): [number, number] | null {
  const begin = lines.indexOf(AIDER_MARKER_BEGIN);
  const end = lines.indexOf(AIDER_MARKER_END);
  if (begin === -1 || end === -1 || end <= begin) return null;
  return [begin, end];
}

function splitLines(content: string): { lines: string[]; eol: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return { lines: content.split('\n').map((line) => line.replace(/\r$/, '')), eol };
}

function joinLines(lines: string[], eol: string): string {
  const joined = lines.join(eol);
  return joined === '' ? '' : joined.endsWith(eol) ? joined : joined + eol;
}

/**
 * `content` with `memoryPath` in `read:` — via a managed block when there is
 * no `read:` key yet, or inserted into the existing list. Every other line
 * stays as written. Throws on an ambiguous or malformed `read:` region.
 */
export function upsertAiderReadEntry(content: string, memoryPath: string): string {
  const { lines, eol } = splitLines(stripUtf8Bom(content));
  const managed = findManagedBlock(lines);
  if (managed) {
    const [begin, end] = managed;
    const outside = [...lines.slice(0, begin), ...lines.slice(end + 1)];
    if (outside.some((line) => readKeyRest(line) !== null)) {
      throw new Error('A managed claude-mem block and a separate `read:` key both exist; remove one and try again');
    }
    return joinLines(
      [...lines.slice(0, begin), ...managedBlockLines(memoryPath), ...lines.slice(end + 1)],
      eol,
    );
  }

  const span = findAiderReadSpan(lines);
  if (!span) {
    // No `read:` key: append the managed block (before a `...` document end,
    // which would put entries outside the YAML document).
    const docEnd = lines.findIndex((line) => /^\.\.\.(?:\s|$)/.test(line));
    const at = docEnd === -1 ? lines.length : docEnd;
    const before = lines.slice(0, at);
    while (before.length > 0 && before[before.length - 1].trim() === '') before.pop();
    const block = managedBlockLines(memoryPath);
    const merged = [...before, ...(before.length > 0 ? [''] : []), ...block, ...lines.slice(at)];
    return joinLines(merged, eol);
  }

  if (span.kind === 'flow') {
    if (span.items.includes(memoryPath)) return content;
    const line = lines[span.header];
    const closeAt = flowListCloseIndex(line);
    const inner = line.slice(0, closeAt).trimEnd();
    // Reuse an existing trailing comma instead of adding a second one:
    // `read: [CONVENTIONS.md,]` must not become `[CONVENTIONS.md,, ...]`.
    const separator = inner.endsWith('[') ? '' : inner.endsWith(',') ? ' ' : ', ';
    const tail = line.slice(closeAt + 1).trimEnd();
    // Mark the line as ours: uninstall must not remove a flow entry the user
    // wrote themselves, and a flow list carries no per-entry marker.
    const marker = tail.includes(AIDER_MANAGED_ENTRY_COMMENT)
      ? ''
      : `${tail === '' ? '  ' : ' '}${AIDER_MANAGED_ENTRY_COMMENT}`;
    lines[span.header] = `${inner}${separator}${yamlPlainOrQuoted(memoryPath)}]${tail}${marker}`;
    return joinLines(lines, eol);
  }

  if (span.kind === 'scalar') {
    if (span.value === memoryPath) return content;
    // Keep the user's scalar exactly as written — quoting and trailing
    // comment included — so the comment survives on the original entry; only
    // the new entry is rendered by us.
    const rawScalar = readKeyRest(lines[span.header])!.trim();
    lines.splice(
      span.header,
      1,
      'read:',
      `  - ${rawScalar}`,
      `  - ${yamlPlainOrQuoted(memoryPath)}  ${AIDER_MANAGED_ENTRY_COMMENT}`,
    );
    return joinLines(lines, eol);
  }

  // Block sequence.
  if (span.items.some((item) => item.value === memoryPath)) return content;
  const entryLine = `${span.itemIndent}- ${yamlPlainOrQuoted(memoryPath)}  ${AIDER_MANAGED_ENTRY_COMMENT}`;
  const at = span.items.length > 0 ? span.items[span.items.length - 1].line + 1 : span.header + 1;
  lines.splice(at, 0, entryLine);
  return joinLines(lines, eol);
}

/**
 * `content` without the claude-mem `read:` entry; null when there is nothing
 * of ours to remove. Only entries this installer owns are removed: the
 * managed block, a block entry carrying the managed-entry comment, or a flow
 * entry on a line the installer marked when it added it. A `read:` entry the
 * user wrote themselves is left alone.
 */
export function removeAiderReadEntry(content: string, memoryPath: string): string | null {
  const { lines, eol } = splitLines(stripUtf8Bom(content));
  const managed = findManagedBlock(lines);
  if (managed) {
    const [begin, end] = managed;
    const prefix = lines.slice(0, begin);
    while (prefix.length > 0 && prefix[prefix.length - 1].trim() === '') prefix.pop();
    const suffix = lines.slice(end + 1);
    while (suffix.length > 0 && suffix[0].trim() === '') suffix.shift();
    const merged = [...prefix, ...(prefix.length > 0 && suffix.length > 0 ? [''] : []), ...suffix];
    return joinLines(merged, eol);
  }

  const span = findAiderReadSpan(lines);
  if (!span || span.kind === 'scalar') return null;
  if (span.kind === 'flow') {
    if (!span.items.includes(memoryPath)) return null;
    const line = lines[span.header];
    // A flow list carries no per-entry marker: only a line this installer
    // marked when it added the entry is ours to remove. A user who wrote
    // the memory path themselves keeps their manual setup.
    if (!line.includes(AIDER_MANAGED_ENTRY_COMMENT)) return null;
    const closeAt = flowListCloseIndex(line);
    const inner = line.slice(line.indexOf('[') + 1, closeAt);
    const remaining = parseFlowList(`[${inner}]`)!.filter((item) => item !== memoryPath);
    const tail = line.slice(closeAt + 1).replace(AIDER_MANAGED_ENTRY_COMMENT, '').trimEnd();
    lines[span.header] =
      remaining.length === 0
        ? `read:${tail}`
        : `read: [${remaining.map(yamlPlainOrQuoted).join(', ')}]${tail}`;
    return joinLines(lines, eol);
  }

  const owned = span.items.filter(
    (item) => item.value === memoryPath && lines[item.line].includes(AIDER_MANAGED_ENTRY_COMMENT),
  );
  if (owned.length === 0) return null;
  const ownedLines = new Set(owned.map((item) => item.line));
  return joinLines(lines.filter((_, index) => !ownedLines.has(index)), eol);
}

/** Whether `content` already loads `memoryPath` via `read:`. */
export function hasAiderReadEntry(content: string, memoryPath: string): boolean {
  const { lines } = splitLines(stripUtf8Bom(content));
  if (findManagedBlock(lines)) return true;
  const span = findAiderReadSpan(lines);
  if (!span) return false;
  if (span.kind === 'scalar') return span.value === memoryPath;
  if (span.kind === 'flow') return span.items.includes(memoryPath);
  return span.items.some((item) => item.value === memoryPath);
}

// ---------------------------------------------------------------------------
// Installer commands
// ---------------------------------------------------------------------------

/**
 * Merge the memory file into `read:` in `configPath`, backing up first.
 * Throws on an ambiguous or malformed `read:` region; the file is untouched.
 */
export function installAiderConfigFile(configPath: string, memoryPath: string): boolean {
  const current = existsSync(configPath) ? stripUtf8Bom(readFileSync(configPath, 'utf-8')) : '';
  const next = upsertAiderReadEntry(current, memoryPath);
  if (next === current) return false;
  backupOnce(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeTextFileAtomic(configPath, next);
  return true;
}

/** The worker fetch behind a refresh: every project key the checkout reads, plus its directory. */
type AiderFetchContext = (projects: string[], cwd: string) => Promise<string | null>;

async function fetchContextFromWorker(
  projects: string[],
  cwd: string,
  skipWorkerStart = false,
): Promise<string | null> {
  if (!skipWorkerStart) {
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      throw new Error('Worker is not running and could not be started. Start it with `npx claude-mem start`.');
    }
  }
  // With skipWorkerStart the request still goes out: a worker that is
  // already running answers, one that is not fails fast and the refresh
  // reports it instead of starting a worker behind the caller's back.
  const response = await workerHttpRequest(
    `/api/context/inject?${projectsQueryString(projects)}&cwd=${encodeURIComponent(cwd)}`,
  );
  if (!response.ok) {
    throw new Error(`Worker context request failed: HTTP ${response.status}`);
  }
  const context = await response.text();
  return context && context.trim() ? context : null;
}

/**
 * Refresh the memory file from the worker. `fetchContext` is injectable so
 * tests never touch a real worker; production fetches
 * `GET /api/context/inject`. Returns 1 (and leaves the file untouched) when
 * the worker is unreachable or returns nothing usable — an explicit refresh
 * reports failures honestly, never a success it did not achieve.
 */
export async function refreshAiderMemoryFile(
  options: AiderInstallOptions = {},
  fetchContext: AiderFetchContext = (projects, cwd) =>
    fetchContextFromWorker(projects, cwd, options.noAutoStart ?? false),
): Promise<number> {
  const { projectDir, memoryFilePath } = resolveAiderPaths(options);
  const { primary, allProjects } = getProjectContext(projectDir);
  let context: string | null;
  try {
    // Every key this checkout reads — a distinctly named worktree's parent
    // project and any configured inherited keys included — so Aider receives
    // the same shared memory as the other agents.
    context = await fetchContext(allProjects, projectDir);
  } catch (error) {
    console.error(`Failed to refresh Aider memory: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!context || !context.trim()) {
    console.log('  No context yet — run `npx claude-mem aider sync` again after your first session.');
    return 0;
  }
  mkdirSync(dirname(memoryFilePath), { recursive: true });
  injectContextIntoMarkdownFile(memoryFilePath, context, AIDER_MEMORY_HEADER);
  console.log(`  Refreshed Aider memory from project ${primary} (${memoryFilePath})`);
  return 0;
}

export async function installAiderIntegration(
  options: AiderInstallOptions = {},
  fetchContext: AiderFetchContext = (projects, cwd) =>
    fetchContextFromWorker(projects, cwd, options.noAutoStart ?? false),
): Promise<number> {
  const { configPath, memoryFilePath } = resolveAiderPaths(options);
  try {
    const changed = installAiderConfigFile(configPath, AIDER_MEMORY_RELATIVE_PATH);
    console.log(
      changed
        ? `  Added ${AIDER_MEMORY_RELATIVE_PATH} to read: in ${configPath}`
        : `  ${AIDER_MEMORY_RELATIVE_PATH} is already in read: in ${configPath}`,
    );
  } catch (error) {
    console.error(`Failed to install Aider context: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    if (!existsSync(memoryFilePath)) {
      mkdirSync(dirname(memoryFilePath), { recursive: true });
      injectContextIntoMarkdownFile(memoryFilePath, AIDER_PLACEHOLDER_CONTEXT, AIDER_MEMORY_HEADER);
      console.log(`  Created placeholder memory file (will populate on sync)`);
    }
    // Best-effort refresh, like Cursor's setup: install succeeds with the
    // placeholder when the worker is not running; the user syncs later.
    const refreshed = await refreshAiderMemoryFile(options, fetchContext);
    if (refreshed !== 0) {
      console.log(`  Worker not reachable — run \`npx claude-mem aider sync\` once it is running.`);
    }
  } catch (error) {
    console.error(`Failed to set up Aider memory file: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`
Aider integration installed!

Config:  ${configPath}
Memory:  ${memoryFilePath}

Note: This is a file-based integration. Aider loads the memory file
read-only into every session via .aider.conf.yml read:. There is no
automatic capture — Aider exposes no hooks or MCP client — so refresh the
file with \`npx claude-mem aider sync\` before a session, and save notes
with POST /api/memory/save (see docs).

Next steps:
  1. Add .claude-mem/ to .gitignore so the memory file stays local
  2. Start claude-mem worker: npx claude-mem start
  3. Run Aider from the project root: aider
`);
  return 0;
}

export function uninstallAiderIntegration(options: AiderInstallOptions = {}): number {
  const { configPath } = resolveAiderPaths(options);
  if (!existsSync(configPath)) {
    console.log('  No .aider.conf.yml found; nothing to uninstall');
    return 0;
  }
  let updated: string | null;
  try {
    updated = removeAiderReadEntry(stripUtf8Bom(readFileSync(configPath, 'utf-8')), AIDER_MEMORY_RELATIVE_PATH);
  } catch (error) {
    console.error(`Failed to uninstall Aider context: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (updated === null) {
    console.log('  No claude-mem entry found in .aider.conf.yml');
    return 0;
  }
  backupOnce(configPath);
  writeTextFileAtomic(configPath, updated);
  console.log(`  Removed claude-mem entry from ${configPath}`);
  console.log('  Memory file left untouched — delete .claude-mem/aider-memory.md yourself if you no longer want it.');
  return 0;
}

export function checkAiderStatus(options: AiderInstallOptions = {}): number {
  const { configPath, memoryFilePath } = resolveAiderPaths(options);
  const installed =
    existsSync(configPath) &&
    hasAiderReadEntry(readFileSync(configPath, 'utf-8'), AIDER_MEMORY_RELATIVE_PATH);
  if (installed) {
    console.log(`  Aider context: installed (${configPath})`);
    console.log(`  Memory file: ${memoryFilePath}${existsSync(memoryFilePath) ? '' : ' (not yet created — run `npx claude-mem aider sync`)'}`);
    return 0;
  }
  console.log('  Aider context: not installed');
  return 1;
}

export async function handleAiderCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const cwd = cliFlagValue(args, '--cwd') ?? undefined;
  const noAutoStart = args.includes('--no-auto-start');
  const options: AiderInstallOptions = { ...(cwd ? { cwd } : {}), ...(noAutoStart ? { noAutoStart: true } : {}) };
  switch (subcommand) {
    case 'install':
      return installAiderIntegration(options);
    case 'uninstall':
      return uninstallAiderIntegration(options);
    case 'status':
      return checkAiderStatus(options);
    case 'sync':
      return refreshAiderMemoryFile(options);
    default:
      console.log(USAGE);
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}

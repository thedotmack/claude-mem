// SPDX-License-Identifier: Apache-2.0
//
// What a request's prompt is made of (plan Phase 10 task 7): the agent's own
// prompt, its tool definitions, the instruction files and reminders it put
// in (memory), the files its tools read, its tools' other output, and the
// conversation, each as the tokens it takes. Ported from magpie's prompt
// builder (internal/gateway/prompt.go:30-737, MIT, Copyright (c) 2026
// yetone) and its agent tag (internal/gui/context.go:366-430,
// `memory-heavy` at a memory share of 0.10 or more).
//
// Read from the decoded body as the agent sent it, through the byte-offset
// scanner, off the request path (the usage ledger reads it once the reply is
// over). Only names and sizes are kept, never the prompt's text.
//
// Where this differs from magpie, on purpose:
// - No calibration to the vendor's count and no item cap: the usage ledger
//   keeps each part's estimated total, and the counted prompt beside it.
// - magpie's line regexes for instruction files (`contentsOf`,
//   `instructionsFrom`, `agentsFor`) use lazy repeats that backtrack over a
//   long line; the same lines are found here by linear string scans.
// - Gemini's snake_case field names are read too, as the request parser does.

import { decodeString, rawText, scanDocument, type JsonSpan } from '../json/scanner.js';
import { ScannedObject, objectElements } from '../ir/scanned-object.js';
import { userWordsInText } from '../identity/user-words.js';
import type { WireProtocol } from '../relay/protocols.js';

export type WireContextPartKind = 'system' | 'tools' | 'memory' | 'files' | 'results' | 'chat';

/** The parts in the order they are shown (magpie `partOrder`). */
export const WIRE_CONTEXT_PART_KINDS: readonly WireContextPartKind[] = ['system', 'tools', 'memory', 'files', 'results', 'chat'];

/** What an image is taken to cost: about what Anthropic counts for a 1092×1092 one (magpie `imageTokens`). */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** An agent whose prompts are this much memory or more is tagged memory-heavy (magpie gui/context.go:411-413). */
export const MEMORY_HEAVY_SHARE = 0.10;

export interface WireContextItem {
  /** A tool, an MCP server's tools, an instruction file's path, a file read, a turn's number. */
  name: string;
  /** What it is: mcp, namespace, user, project, local, memory, skills, reminder, image, read, shell, result, turn, compacted, or ''. */
  tag: string;
  /** How many it gathers (an MCP server's tools, a tool's results). */
  count: number;
  tokens: number;
}

export interface WireContextPart {
  kind: WireContextPartKind;
  tokens: number;
  /** Largest first. */
  items: WireContextItem[];
}

export interface WireContextBreakdown {
  /** The estimated tokens of the whole prompt: the parts' sum. */
  tokens: number;
  /** The user's turns in it. */
  turns: number;
  /** A Responses request that names a previous response: its earlier turns are held at the vendor's. */
  held: boolean;
  /** Only parts that hold something, in WIRE_CONTEXT_PART_KINDS order. */
  parts: WireContextPart[];
}

/** Each part's estimated tokens, every kind present (0 when empty): what a usage-ledger line keeps. */
export type WireContextBuckets = Record<WireContextPartKind, number>;

/**
 * The tokens of a text: about four ASCII characters a token, a token a
 * character for the rest (CJK, mostly) (magpie `tokensOf`).
 */
export function estimateTextTokens(text: string): number {
  let asciiCount = 0;
  let otherCount = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 0x80) asciiCount++;
    else otherCount++;
  }
  return Math.floor((asciiCount + 3) / 4) + otherCount;
}

/** The tokens of raw JSON bytes (magpie `rawTokens`). */
function estimateRawTokens(byteLength: number): number {
  return Math.floor((byteLength + 3) / 4);
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

// ---------------------------------------------------------------------------
// Instruction files, reminders, harness messages (magpie prompt.go:297-413)

interface MemorySection {
  /** Where the section's heading line starts in the text. */
  startOffset: number;
  path: string;
  description: string;
}

/**
 * `text` with any run of `characters` at its end taken off. A loop, not a
 * regex: `/[x]+$/` retries the run from every start, so a long run that is
 * not at the end costs its length squared.
 */
function trimTrailingCharacters(text: string, characters: string): string {
  let end = text.length;
  while (end > 0 && characters.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/** A line with its spaces and tabs at the end taken off (what a regex's `[ \t]*$` leaves out). */
function trimTrailingSpacesAndTabs(line: string): string {
  return trimTrailingCharacters(line, ' \t');
}

function isWhitespaceCharacter(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

const CONTENTS_OF_PREFIX = 'Contents of ';

/**
 * Claude Code's "Contents of /path/CLAUDE.md (project instructions, …):"
 * heading (magpie `contentsOf`: `^Contents of (\S.*?) \(<desc>\):[ \t]*$`,
 * where <desc> may hold one level of balanced parentheses). The lazy path
 * means the leftmost " (" whose rest is a valid description; found in one
 * backward pass over the line, so it costs the line's length.
 */
function parseContentsOfHeading(line: string): { path: string; description: string } | null {
  if (!line.startsWith(CONTENTS_OF_PREFIX)) return null;
  const pathStart = CONTENTS_OF_PREFIX.length;
  if (pathStart >= line.length || isWhitespaceCharacter(line[pathStart])) return null;
  const heading = trimTrailingSpacesAndTabs(line);
  if (!heading.endsWith('):')) return null;
  const descriptionEnd = heading.length - 2; // the ')' before ':'
  // Walking back from the description's end, a start s is valid while the
  // parentheses between s and the end never nest past one level and balance.
  const validDescriptionStarts = new Set<number>();
  let depth = 0;
  validDescriptionStarts.add(descriptionEnd);
  for (let index = descriptionEnd - 1; index >= pathStart; index--) {
    const character = heading[index];
    if (character === ')') depth++;
    else if (character === '(') depth--;
    if (depth < 0 || depth > 1) break;
    if (depth === 0) validDescriptionStarts.add(index);
  }
  // The path is at least one character, so " (" may begin at pathStart + 1 at the earliest.
  for (let openAt = pathStart + 2; openAt + 1 <= descriptionEnd; openAt++) {
    if (heading[openAt - 1] === ' ' && heading[openAt] === '(' && validDescriptionStarts.has(openAt + 1)) {
      return { path: heading.slice(pathStart, openAt - 1), description: heading.slice(openAt + 1, descriptionEnd) };
    }
  }
  return null;
}

const INSTRUCTIONS_FROM_PREFIX = 'Instructions from: ';

/** OpenCode's "Instructions from: /path/AGENTS.md" (magpie `instructionsFrom`). */
function parseInstructionsFromHeading(line: string): string | null {
  if (!line.startsWith(INSTRUCTIONS_FROM_PREFIX)) return null;
  const path = trimTrailingSpacesAndTabs(line.slice(INSTRUCTIONS_FROM_PREFIX.length));
  return path === '' || isWhitespaceCharacter(path[0]) ? null : path;
}

/**
 * Codex's "# AGENTS.md instructions for /path" first line, with its line feed
 * (magpie `agentsFor`). codex-cli 0.162.1 sends a bare "# AGENTS.md
 * instructions" line (seen live): directory is then null.
 */
function parseAgentsFileHeading(text: string): { fileName: string; directory: string | null } | null {
  if (!text.startsWith('# ')) return null;
  const lineEnd = text.indexOf('\n');
  if (lineEnd < 0) return null;
  const line = trimTrailingSpacesAndTabs(text.slice(0, lineEnd));
  const fileNameEnd = line.indexOf(' ', 2);
  if (fileNameEnd < 0) return null;
  const fileName = line.slice(2, fileNameEnd);
  if (!fileName.endsWith('.md') || fileName.length < 4 || /\s/.test(fileName)) return null;
  if (line.slice(fileNameEnd) === ' instructions') return { fileName, directory: null };
  const marker = ' instructions for ';
  if (!line.startsWith(marker, fileNameEnd)) return null;
  const directory = line.slice(fileNameEnd + marker.length);
  return directory === '' || isWhitespaceCharacter(directory[0]) ? null : { fileName, directory };
}

/** Each line of `text` with where it starts. */
function linesWithOffsets(text: string): Array<{ line: string; offset: number }> {
  const lines: Array<{ line: string; offset: number }> = [];
  let offset = 0;
  for (;;) {
    const lineEnd = text.indexOf('\n', offset);
    if (lineEnd < 0) {
      lines.push({ line: text.slice(offset), offset });
      return lines;
    }
    lines.push({ line: text.slice(offset, lineEnd), offset });
    offset = lineEnd + 1;
  }
}

/** Whose an instruction file is, from how the agent describes it or its path (magpie `memoryTag`). */
function memoryTagOf(path: string, description: string): string {
  const lowered = description.toLowerCase();
  if (lowered.includes("user's") || lowered.includes('global')) return 'user';
  if (lowered.includes('local')) return 'local';
  if (lowered.includes('auto-memory') || lowered.includes('memory')) return 'memory';
  if (lowered !== '') return 'project';
  if (path.includes('/.claude/') || path.includes('/.codex/') || path.includes('/.config/')) return 'user';
  return 'project';
}

const LEAD_TAG_PATTERN = /^\s*<([a-zA-Z_][\w -]{0,40})>/;

/** A system or developer text named by its leading tag, or what it is (magpie `harnessName`). */
function harnessNameOf(text: string, fallback: string): string {
  const leadTag = LEAD_TAG_PATTERN.exec(text);
  if (leadTag) return leadTag[1].trim();
  if (text.startsWith('# Environment')) return 'environment';
  return fallback;
}

const HARNESS_CONTEXT_PREFIXES = ['<environment_context>', '<user_instructions>', '<turn_aborted>', '<user_shell_command>'];

// ---------------------------------------------------------------------------
// Tool calls and the files they read (magpie prompt.go:415-546)

/** The tools that read a file, and where they take its path. */
const READ_TOOL_NAMES = new Set(['Read', 'read', 'read_file', 'ReadFile', 'view', 'View', 'NotebookRead', 'readFile', 'open_file', 'cat']);
const PATH_ARGUMENT_KEYS = ['file_path', 'path', 'filePath', 'target_file', 'notebook_path', 'file', 'filename', 'uri'];
const READ_ONLY_COMMANDS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']);
const SHELL_WRAPPER_PREFIXES = ['bash -lc ', 'bash -c ', 'sh -c ', 'zsh -lc '];
const SHELL_OPERATOR_CHARACTERS = /[|;&><`$]/;
/** Codex's exec takes JavaScript: text(await tools.exec_command({cmd:"cat x"})). */
const EXEC_CMD_PATTERN = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/;
const EXEC_TOOL_PATTERN = /\btools\.(\w+)\s*\(/;

function trimQuotes(text: string): string {
  return trimTrailingCharacters(text.replace(/^["']+/, ''), `"'`);
}

/**
 * The files a shell command reads, when all it does is read files: cat,
 * head, tail, nl, bat, less, more, sed -n (magpie `filesOfCommand`).
 */
export function filesReadByCommand(command: string): string[] {
  let cmd = command.trim();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (cmd.startsWith(prefix)) cmd = trimQuotes(cmd.slice(prefix.length).trim());
  }
  if (SHELL_OPERATOR_CHARACTERS.test(cmd)) {
    // A pipeline or more than one command is not a plain read; "cd dir && cat x" still is.
    const andAt = cmd.indexOf('&&');
    if (andAt >= 0 && cmd.startsWith('cd ') && !SHELL_OPERATOR_CHARACTERS.test(cmd.slice(andAt + 2))) {
      cmd = cmd.slice(andAt + 2).trim();
    } else {
      return [];
    }
  }
  const fields = cmd.split(/\s+/).filter(field => field !== '');
  if (fields.length < 2) return [];
  const isSedPrint = fields[0] === 'sed' && fields.includes('-n');
  if (!READ_ONLY_COMMANDS.has(fields[0]) && !isSedPrint) return [];
  const files: string[] = [];
  for (let index = 1; index < fields.length; index++) {
    const argument = trimQuotes(fields[index]);
    if (argument.startsWith('-')) {
      if ((argument === '-n' || argument === '-c') && !isSedPrint && index + 1 < fields.length) index++; // head -n 40
      continue;
    }
    if (isSedPrint && argument.endsWith('p') && /[0-9,]/.test(argument) && !argument.includes('/') && !argument.includes('.')) continue; // sed -n 1,80p
    if (/^[+-]?\d+$/.test(argument)) continue;
    files.push(argument);
  }
  return files;
}

interface CalledTool {
  name: string;
  /** The files it reads, when it reads files. */
  files: string[];
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** What a tool call does, from its name and input: the files it reads, and the name its results go by (magpie `callOf`). */
function calledToolOf(name: string, inputJson: string): CalledTool {
  const called: CalledTool = { name, files: [] };
  const args = parseJsonObject(inputJson);
  const stringArgument = (key: string): string => (typeof args?.[key] === 'string' ? args[key] as string : '');
  if (READ_TOOL_NAMES.has(name)) {
    for (const key of PATH_ARGUMENT_KEYS) {
      const path = stringArgument(key);
      if (path !== '') {
        called.files = [path];
        return called;
      }
    }
  }
  let command = stringArgument('command') || stringArgument('cmd');
  if (command === '' && Array.isArray(args?.command) && (args.command as unknown[]).every(part => typeof part === 'string')) {
    command = (args.command as string[]).join(' ');
  }
  if (command === '' && args === null) {
    const toolMatch = EXEC_TOOL_PATTERN.exec(inputJson);
    if (toolMatch) called.name = toolMatch[1];
    const commandMatch = EXEC_CMD_PATTERN.exec(inputJson);
    if (commandMatch) {
      try {
        command = JSON.parse(`"${commandMatch[1]}"`) as string;
      } catch {
        command = '';
      }
    }
  }
  if (command !== '') called.files = filesReadByCommand(command);
  return called;
}

// ---------------------------------------------------------------------------
// The builder (magpie promptBuilder)

class ContextBreakdownBuilder {
  private readonly itemsByPart = new Map<WireContextPartKind, Map<string, WireContextItem>>();
  private turn = 0;
  held = false;
  private readonly calledToolsById = new Map<string, CalledTool>();

  constructor(readonly bytes: Uint8Array) {}

  add(kind: WireContextPartKind, name: string, tag: string, tokens: number): void {
    if (tokens <= 0) return;
    let items = this.itemsByPart.get(kind);
    if (!items) {
      items = new Map();
      this.itemsByPart.set(kind, items);
    }
    const key = `${tag}\u0000${name}`;
    let item = items.get(key);
    if (!item) {
      item = { name, tag, count: 0, tokens: 0 };
      items.set(key, item);
    }
    item.count++;
    item.tokens += tokens;
  }

  /** Raise a gathered item's count (a namespace of tools counted as one). */
  addToCount(kind: WireContextPartKind, name: string, tag: string, extra: number): void {
    const item = this.itemsByPart.get(kind)?.get(`${tag}\u0000${name}`);
    if (item) item.count += extra;
  }

  /** Adds to the conversation's current turn. */
  chat(tokens: number): void {
    if (this.turn === 0) this.turn = 1;
    this.add('chat', String(this.turn), 'turn', tokens);
  }

  newTurn(): void {
    this.turn++;
  }

  breakdown(): WireContextBreakdown {
    const parts: WireContextPart[] = [];
    let total = 0;
    for (const kind of WIRE_CONTEXT_PART_KINDS) {
      const items = this.itemsByPart.get(kind);
      if (!items || items.size === 0) continue;
      const sortedItems = [...items.values()].sort((first, second) => second.tokens - first.tokens || first.name.localeCompare(second.name));
      const tokens = sortedItems.reduce((sum, item) => sum + item.tokens, 0);
      parts.push({ kind, tokens, items: sortedItems });
      total += tokens;
    }
    return { tokens: total, turns: this.turn, held: this.held, parts };
  }

  /** Takes the instruction files out of a text as memory; returns what is left (magpie `splitMemory`). */
  splitMemory(text: string): string {
    const sections: MemorySection[] = [];
    for (const { line, offset } of linesWithOffsets(text)) {
      const contentsOf = parseContentsOfHeading(line);
      if (contentsOf) {
        sections.push({ startOffset: offset, path: contentsOf.path, description: contentsOf.description });
        continue;
      }
      const instructionsFrom = parseInstructionsFromHeading(line);
      if (instructionsFrom) sections.push({ startOffset: offset, path: instructionsFrom, description: '' });
    }
    if (sections.length === 0) return text;
    let rest = text.slice(0, sections[0].startOffset);
    sections.forEach((section, index) => {
      const end = index + 1 < sections.length ? sections[index + 1].startOffset : text.length;
      let chunk = text.slice(section.startOffset, end);
      // A reminder's closing tag and what follows it are not the file's.
      const closeAt = chunk.indexOf('</system-reminder>');
      if (closeAt >= 0) {
        rest += chunk.slice(closeAt);
        chunk = chunk.slice(0, closeAt);
      }
      this.add('memory', section.path, memoryTagOf(section.path, section.description), estimateTextTokens(chunk));
    });
    return rest;
  }

  /** The agent's own prompt, with the instruction files in it taken out as memory (magpie `systemText`). */
  systemText(text: string, name: string): void {
    const rest = this.splitMemory(text);
    if (rest.trim().startsWith('<skills_instructions>')) {
      this.add('memory', 'skills', 'skills', estimateTextTokens(rest));
      return;
    }
    this.add('system', harnessNameOf(rest, name), '', estimateTextTokens(rest));
  }

  /** A user's text: an instruction file or reminder the agent put in, or what the user said (magpie `userText`). */
  userText(text: string): void {
    const trimmed = text.trim();
    if (trimmed.startsWith('<system-reminder>')) {
      let rest = this.splitMemory(trimmed).trim();
      if (rest.startsWith('<system-reminder>')) rest = rest.slice('<system-reminder>'.length);
      if (rest.endsWith('</system-reminder>')) rest = rest.slice(0, -'</system-reminder>'.length);
      rest = rest.trim();
      if (rest !== '') this.add('memory', 'reminders', 'reminder', estimateTextTokens(rest));
      return;
    }
    const agentsFile = parseAgentsFileHeading(trimmed);
    if (agentsFile) {
      const label = agentsFile.directory === null ? agentsFile.fileName : `${trimTrailingCharacters(agentsFile.directory, '/')}/${agentsFile.fileName}`;
      this.add('memory', label, 'project', estimateTextTokens(trimmed));
      return;
    }
    if (HARNESS_CONTEXT_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
      this.add('system', harnessNameOf(trimmed, 'context'), '', estimateTextTokens(trimmed));
      return;
    }
    this.chat(estimateTextTokens(text));
  }

  call(callId: string | undefined, name: string, inputJson: string): void {
    this.calledToolsById.set(callId ?? '', calledToolOf(name, inputJson));
  }

  knowsCall(callId: string): boolean {
    return this.calledToolsById.has(callId);
  }

  /** What a tool answered: the files it read, or its output (magpie `result`). */
  result(callId: string | undefined, tokens: number): void {
    const called = this.calledToolsById.get(callId ?? '') ?? { name: 'tool', files: [] };
    if (called.files.length > 0) {
      const each = Math.floor(tokens / called.files.length);
      called.files.forEach((file, index) => {
        const share = index === 0 ? each + tokens - each * called.files.length : each;
        this.add('files', file, READ_TOOL_NAMES.has(called.name) ? 'read' : 'shell', share);
      });
      return;
    }
    this.add('results', called.name, 'result', tokens);
  }

  /** A tool definition: an MCP server's tools as one (magpie `tool`). */
  tool(name: string, tokens: number): void {
    if (name.startsWith('mcp__')) {
      const rest = name.slice('mcp__'.length);
      const separatorAt = rest.indexOf('__');
      this.add('tools', separatorAt > 0 ? rest.slice(0, separatorAt) : rest, 'mcp', tokens);
      return;
    }
    this.add('tools', name, '', tokens);
  }

  spanTokens(span: JsonSpan): number {
    return estimateRawTokens(span.end - span.start);
  }

  raw(span: JsonSpan): string {
    return rawText(this.bytes, span);
  }
}

function userSays(text: string): boolean {
  return userWordsInText(text) !== '';
}

// ---------------------------------------------------------------------------
// Anthropic Messages (magpie prompt.go:563-737)

interface AnthropicBlock {
  type: string;
  text: string;
  object: ScannedObject | null;
}

/** Content that is a string or a list of blocks (magpie `blocksOf`). */
function anthropicBlocksOf(bytes: Uint8Array, span: JsonSpan | undefined): AnthropicBlock[] {
  if (span?.type === 'string') return [{ type: 'text', text: decodeString(bytes, span), object: null }];
  return objectElements(bytes, span).map(block => ({ type: block.string('type') ?? '', text: block.string('text') ?? '', object: block }));
}

function readAnthropicBlock(builder: ContextBreakdownBuilder, role: string, block: AnthropicBlock): void {
  const object = block.object;
  switch (block.type) {
    case 'text':
      if (role === 'user') builder.userText(block.text);
      else builder.chat(estimateTextTokens(block.text));
      return;
    case 'thinking':
      builder.chat(estimateTextTokens(object?.string('thinking') ?? ''));
      return;
    case 'redacted_thinking':
      builder.chat(Math.floor(estimateTextTokens(object?.string('data') ?? '') / 4));
      return;
    case 'tool_use':
    case 'server_tool_use': {
      const name = object?.string('name') ?? '';
      const inputSpan = object?.spanOf('input');
      builder.call(object?.string('id'), name, inputSpan ? builder.raw(inputSpan) : '');
      builder.chat(estimateTextTokens(name) + (inputSpan ? builder.spanTokens(inputSpan) : 0));
      return;
    }
    case 'tool_result':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result': {
      const contentSpan = object?.spanOf('content');
      let tokens = 0;
      for (const inner of anthropicBlocksOf(builder.bytes, contentSpan)) {
        if (inner.type === 'image' || inner.type === 'document') builder.add('files', inner.type, 'image', IMAGE_TOKEN_ESTIMATE);
        else tokens += estimateTextTokens(inner.text);
      }
      if (contentSpan && contentSpan.type !== 'string' && contentSpan.type !== 'array') tokens = builder.spanTokens(contentSpan);
      builder.result(object?.string('tool_use_id'), tokens);
      return;
    }
    case 'image':
    case 'document': {
      const sourceSpan = object?.spanOf('source');
      if (block.type === 'document' && sourceSpan && !builder.raw(sourceSpan).includes('"base64"')) {
        builder.add('files', 'document', 'image', builder.spanTokens(sourceSpan));
        return;
      }
      builder.add('files', block.type, 'image', IMAGE_TOKEN_ESTIMATE);
      return;
    }
    default:
      builder.chat(estimateTextTokens(block.text));
  }
}

function readAnthropicRequest(builder: ContextBreakdownBuilder, root: ScannedObject): void {
  const bytes = builder.bytes;
  for (const block of anthropicBlocksOf(bytes, root.spanOf('system'))) {
    if (block.text.startsWith('x-anthropic-billing-header')) {
      builder.add('system', 'billing', '', estimateTextTokens(block.text));
      continue;
    }
    builder.systemText(block.text, 'prompt');
  }
  for (const tool of objectElements(bytes, root.spanOf('tools'))) builder.tool(tool.string('name') ?? '', builder.spanTokens(tool.span));
  for (const message of objectElements(bytes, root.spanOf('messages'))) {
    const role = message.string('role') ?? '';
    const blocks = anthropicBlocksOf(bytes, message.spanOf('content'));
    if (role === 'system' || role === 'developer') {
      for (const block of blocks) builder.systemText(block.text, 'harness');
      continue;
    }
    if (role === 'user') {
      // A message that answers tool calls goes on with the turn; one where the user says something begins one.
      const answersCalls = blocks.some(block => block.type === 'tool_result');
      if (!answersCalls && blocks.some(block => block.type === 'text' && userSays(block.text))) builder.newTurn();
    }
    for (const block of blocks) readAnthropicBlock(builder, role, block);
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses and Chat Completions (magpie prompt.go:742-1017)

interface ResponsesContentPart {
  text: string;
  image: boolean;
}

function responsesContentOf(bytes: Uint8Array, span: JsonSpan | undefined): ResponsesContentPart[] {
  if (span?.type === 'string') return [{ text: decodeString(bytes, span), image: false }];
  return objectElements(bytes, span).map(part => {
    const partType = part.string('type');
    return { text: part.string('text') ?? '', image: partType === 'input_image' || partType === 'input_file' || partType === 'image_url' };
  });
}

function readResponsesTool(builder: ContextBreakdownBuilder, tool: ScannedObject): void {
  const toolType = tool.string('type') ?? '';
  let name = tool.string('name') || tool.object('function')?.string('name') || toolType;
  const innerTools = objectElements(builder.bytes, tool.spanOf('tools'));
  if (toolType === 'namespace' || innerTools.length > 0) {
    // A namespace of tools: Codex's own functions one by one, any other as one, as an MCP server's.
    if (name === 'functions') {
      for (const inner of innerTools) readResponsesTool(builder, inner);
      return;
    }
    let tag = 'namespace';
    if (name.startsWith('mcp__')) {
      tag = 'mcp';
      name = trimTrailingCharacters(name.slice('mcp__'.length).split('__')[0], '_');
    }
    builder.add('tools', name, tag, builder.spanTokens(tool.span));
    builder.addToCount('tools', name, tag, innerTools.length - 1);
    return;
  }
  builder.tool(name, builder.spanTokens(tool.span));
}

function readUserContentParts(builder: ContextBreakdownBuilder, parts: ResponsesContentPart[]): void {
  if (parts.some(part => part.image || userSays(part.text))) builder.newTurn();
  for (const part of parts) {
    if (part.image) builder.add('files', 'image', 'image', IMAGE_TOKEN_ESTIMATE);
    else builder.userText(part.text);
  }
}

/** A tool's output: its text tokens, images counted as files. */
function toolOutputTokens(builder: ContextBreakdownBuilder, parts: ResponsesContentPart[]): number {
  let tokens = 0;
  for (const part of parts) {
    if (part.image) builder.add('files', 'image', 'image', IMAGE_TOKEN_ESTIMATE);
    else tokens += estimateTextTokens(part.text);
  }
  return tokens;
}

function readResponsesItem(builder: ContextBreakdownBuilder, item: ScannedObject): void {
  const bytes = builder.bytes;
  let itemType = item.string('type') ?? '';
  const role = item.string('role') ?? '';
  if (itemType === '' && role !== '') itemType = 'message';
  switch (itemType) {
    case 'additional_tools':
      for (const tool of objectElements(bytes, item.spanOf('tools'))) readResponsesTool(builder, tool);
      return;
    case 'message': {
      const parts = responsesContentOf(bytes, item.spanOf('content'));
      if (role === 'system' || role === 'developer') {
        for (const part of parts) builder.systemText(part.text, 'prompt');
      } else if (role === 'user') {
        readUserContentParts(builder, parts);
      } else {
        for (const part of parts) builder.chat(estimateTextTokens(part.text));
      }
      return;
    }
    case 'reasoning': {
      let tokens = 0;
      for (const summary of objectElements(bytes, item.spanOf('summary'))) tokens += estimateTextTokens(summary.string('text') ?? '');
      // The reasoning itself, sealed: about three quarters of its base64 is what was sealed.
      const encryptedLength = (item.string('encrypted_content') ?? '').length;
      tokens += Math.floor(Math.floor(Math.floor(encryptedLength * 3) / 4) / 4);
      builder.chat(tokens);
      return;
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'tool_search_call': {
      let input = item.string('arguments') ?? '';
      if (itemType === 'custom_tool_call') input = item.string('input') ?? '';
      if (itemType === 'local_shell_call') input = item.raw('action') ?? '';
      const name = item.string('name') ?? '';
      builder.call(item.string('call_id'), name, input);
      builder.chat(estimateTextTokens(name) + Math.floor((utf8ByteLength(input) + 3) / 4));
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
    case 'tool_search_output': {
      const outputSpan = item.spanOf('output');
      const tokens = outputSpan?.type === 'string'
        ? estimateTextTokens(decodeString(bytes, outputSpan))
        : toolOutputTokens(builder, responsesContentOf(bytes, outputSpan));
      if (itemType === 'tool_search_output') {
        for (const tool of objectElements(bytes, item.spanOf('tools'))) readResponsesTool(builder, tool);
      }
      builder.result(item.string('call_id'), tokens);
      return;
    }
    case 'compaction':
    case 'compaction_summary':
      builder.add('chat', 'compacted', 'compacted', builder.spanTokens(item.span));
      return;
    default:
      builder.chat(builder.spanTokens(item.span));
  }
}

function readResponsesRequest(builder: ContextBreakdownBuilder, root: ScannedObject): void {
  const bytes = builder.bytes;
  builder.held = (root.string('previous_response_id') ?? '') !== '';
  const instructions = root.string('instructions');
  if (instructions) builder.systemText(instructions, 'prompt');
  for (const tool of objectElements(bytes, root.spanOf('tools'))) readResponsesTool(builder, tool);
  const inputSpan = root.spanOf('input');
  if (inputSpan?.type === 'string') {
    builder.newTurn();
    builder.userText(decodeString(bytes, inputSpan));
    return;
  }
  for (const item of objectElements(bytes, inputSpan)) readResponsesItem(builder, item);
}

function readChatRequest(builder: ContextBreakdownBuilder, root: ScannedObject): void {
  const bytes = builder.bytes;
  for (const tool of objectElements(bytes, root.spanOf('tools'))) readResponsesTool(builder, tool);
  for (const message of objectElements(bytes, root.spanOf('messages'))) {
    const parts = responsesContentOf(bytes, message.spanOf('content'));
    switch (message.string('role') ?? '') {
      case 'system':
      case 'developer':
        for (const part of parts) builder.systemText(part.text, 'prompt');
        break;
      case 'user':
        readUserContentParts(builder, parts);
        break;
      case 'tool':
      case 'function':
        builder.result(message.string('tool_call_id'), toolOutputTokens(builder, parts));
        break;
      default: {
        // Its reasoning, what it said and its calls, a piece each.
        builder.chat(estimateTextTokens(message.string('reasoning_content') ?? ''));
        builder.chat(parts.reduce((sum, part) => sum + estimateTextTokens(part.text), 0));
        for (const call of objectElements(bytes, message.spanOf('tool_calls'))) {
          const fn = call.object('function');
          const name = fn?.string('name') ?? '';
          const args = fn?.string('arguments') ?? '';
          builder.call(call.string('id'), name, args);
          builder.chat(estimateTextTokens(name) + estimateTextTokens(args));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gemini (magpie prompt.go:1019-1105)

function readGeminiRequest(builder: ContextBreakdownBuilder, root: ScannedObject): void {
  const bytes = builder.bytes;
  const systemInstruction = root.object('systemInstruction', 'system_instruction');
  for (const part of objectElements(bytes, systemInstruction?.spanOf('parts'))) builder.systemText(part.string('text') ?? '', 'prompt');
  for (const tool of objectElements(bytes, root.spanOf('tools'))) {
    for (const declaration of objectElements(bytes, tool.spanOf('functionDeclarations', 'function_declarations'))) {
      builder.tool(declaration.string('name') ?? '', builder.spanTokens(declaration.span));
    }
  }
  for (const content of objectElements(bytes, root.spanOf('contents'))) {
    const role = content.string('role') ?? '';
    const parts = objectElements(bytes, content.spanOf('parts'));
    const functionResponseOf = (part: ScannedObject) => part.object('functionResponse', 'function_response');
    if (role !== 'model' && parts.some(part => userSays(part.string('text') ?? '') && !functionResponseOf(part))) builder.newTurn();
    for (const part of parts) {
      const functionCall = part.object('functionCall', 'function_call');
      const functionResponse = functionResponseOf(part);
      if (functionCall) {
        // Gemini matches a response to its call by name, or id.
        const name = functionCall.string('name') ?? '';
        const argsSpan = functionCall.spanOf('args');
        builder.call(functionCall.string('id') || `name:${name}`, name, argsSpan ? builder.raw(argsSpan) : '');
        builder.chat(estimateTextTokens(name) + (argsSpan ? builder.spanTokens(argsSpan) : 0));
      } else if (functionResponse) {
        const name = functionResponse.string('name') ?? '';
        const callId = functionResponse.string('id') || `name:${name}`;
        if (!builder.knowsCall(callId)) builder.call(callId, name, '');
        const responseSpan = functionResponse.spanOf('response');
        builder.result(callId, responseSpan ? builder.spanTokens(responseSpan) : 0);
      } else if (part.spanOf('inlineData', 'inline_data') || part.spanOf('fileData', 'file_data')) {
        builder.add('files', 'image', 'image', IMAGE_TOKEN_ESTIMATE);
      } else if (role === 'model') {
        builder.chat(estimateTextTokens(part.string('text') ?? ''));
      } else {
        builder.userText(part.string('text') ?? '');
      }
    }
  }
}

/**
 * What a request's prompt holds, part by part (magpie `promptOf`); null when
 * the body is not a JSON object.
 */
export function contextBreakdownOfRequest(protocol: WireProtocol, body: Uint8Array): WireContextBreakdown | null {
  let root: ScannedObject | undefined;
  try {
    root = ScannedObject.of(body, scanDocument(body));
  } catch {
    return null;
  }
  if (!root) return null;
  const builder = new ContextBreakdownBuilder(body);
  switch (protocol) {
    case 'anthropic':
      readAnthropicRequest(builder, root);
      break;
    case 'openai-responses':
      readResponsesRequest(builder, root);
      break;
    case 'openai-chat':
      readChatRequest(builder, root);
      break;
    case 'gemini':
      readGeminiRequest(builder, root);
      break;
  }
  return builder.breakdown();
}

/** Each part's tokens, every kind present. */
export function contextBucketsOf(breakdown: WireContextBreakdown): WireContextBuckets {
  const buckets = { system: 0, tools: 0, memory: 0, files: 0, results: 0, chat: 0 };
  for (const part of breakdown.parts) buckets[part.kind] = part.tokens;
  return buckets;
}

// ---------------------------------------------------------------------------
// Per-agent shares and tags (magpie gui/context.go:169-430)

export interface WireContextShareSample {
  agent: string;
  /** Only the conversation's own requests count (magpie skips a route with a kind). */
  kind: string;
  status: number;
  buckets?: WireContextBuckets;
}

export interface WireAgentContextSummary {
  agent: string;
  /** Requests whose prompt was read. */
  requests: number;
  /** Each part's share of every token of those prompts. */
  shares: WireContextBuckets;
  /** `memory-heavy` when memory is MEMORY_HEAVY_SHARE of the prompts or more. */
  tags: string[];
}

/** Each agent's prompt shares over `samples`, and its tags. */
export function summarizeAgentContext(samples: Iterable<WireContextShareSample>): WireAgentContextSummary[] {
  const totalsByAgent = new Map<string, { requests: number; buckets: WireContextBuckets }>();
  for (const sample of samples) {
    if (!sample.buckets || sample.status >= 400 || (sample.kind !== 'turn' && sample.kind !== 'subagent')) continue;
    let totals = totalsByAgent.get(sample.agent);
    if (!totals) {
      totals = { requests: 0, buckets: { system: 0, tools: 0, memory: 0, files: 0, results: 0, chat: 0 } };
      totalsByAgent.set(sample.agent, totals);
    }
    totals.requests++;
    for (const kind of WIRE_CONTEXT_PART_KINDS) totals.buckets[kind] += sample.buckets[kind] ?? 0;
  }
  const summaries: WireAgentContextSummary[] = [];
  for (const [agent, totals] of totalsByAgent) {
    const allTokens = Math.max(1, WIRE_CONTEXT_PART_KINDS.reduce((sum, kind) => sum + totals.buckets[kind], 0));
    const shares = { system: 0, tools: 0, memory: 0, files: 0, results: 0, chat: 0 };
    for (const kind of WIRE_CONTEXT_PART_KINDS) shares[kind] = totals.buckets[kind] / allTokens;
    const tags = shares.memory >= MEMORY_HEAVY_SHARE ? ['memory-heavy'] : [];
    summaries.push({ agent, requests: totals.requests, shares, tags });
  }
  return summaries.sort((first, second) => second.requests - first.requests || first.agent.localeCompare(second.agent));
}

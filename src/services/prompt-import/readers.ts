/**
 * One reader per agent: where its transcripts live, which lines are prompts the
 * user typed, and which text the agent wrote (for the agent-written check).
 * Readers only read. The Claude Code and Codex rules are a line-by-line port of
 * `plugin/skills/owner-goals/scripts/export_owner_prompts.py` (`read_owner_typed_prompts`,
 * `read_agent_authored_text`); the Gemini CLI, Antigravity CLI and OpenCode rules
 * follow those agents' files as found on a real machine (see each reader).
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { homedir } from 'os';
import { pipeline, type Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { logger } from '../../utils/logger.js';
import { scanZstdFramesInFile } from '../transcripts/zstd-frames.js';

export type PromptAgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'antigravity-cli' | 'opencode';

export interface TypedPrompt {
  agent: PromptAgentId;
  sessionId: string;
  /** The agent's own id for this message; stable across re-scans. */
  nativePromptId: string;
  /** Milliseconds since the epoch, from the transcript. */
  at: number;
  cwd: string | null;
  text: string;
  /** Other spellings claude-mem's hook may have stored for the same prompt (slash commands). */
  hookTextVariants?: string[];
}

export interface TranscriptSource {
  path: string;
  bytes: number;
  mtimeMs: number;
  /** False for files read only for agent-written text (Claude Code subagents). */
  holdsPrompts: boolean;
}

export interface ReaderSink {
  prompt(prompt: TypedPrompt): void;
  /** A session this agent's transcripts hold, typed prompts or not. */
  session(sessionId: string): void;
}

export interface AgentPromptReader {
  id: PromptAgentId;
  label: string;
  /** claude-mem's `platform_source` for this agent's sessions. */
  platformSource: string;
  locate(homeDirectory: string): { detected: boolean; sources: TranscriptSource[] };
  readPrompts(source: TranscriptSource, sink: ReaderSink, sinceEpochMs: number): Promise<void>;
  readAgentText(source: TranscriptSource, add: (epochSeconds: number, text: string) => void): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers

/** Streams plain or Codex-compressed JSONL without holding the file in memory. */
export async function* readLines(path: string): AsyncGenerator<string> {
  let decompressor: Transform | undefined;
  if (path.endsWith('.jsonl.zst')) {
    // Older supported runtimes must still load this module and read plain files.
    const createZstdDecompress = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
    if (typeof createZstdDecompress !== 'function') {
      throw new Error('this runtime cannot decode compressed Codex history (zlib.createZstdDecompress is missing)');
    }
    // Bun's streaming decoder can finish without rejecting a truncated frame.
    // Reuse the bounded header scan so a partial history is reported as unreadable.
    const frames = scanZstdFramesInFile(path, 0, statSync(path).size);
    if (frames.tornStart !== null || !frames.frames.length) {
      throw new Error('incomplete Zstandard frame in compressed Codex history');
    }
    decompressor = createZstdDecompress();
  }
  const input = createReadStream(path, { highWaterMark: 1 << 20 });
  // pipeline forwards input errors to the decoder and closes both streams on
  // failure or early cancellation. The async iterator below reports the error.
  const stream = decompressor ? pipeline(input, decompressor, () => {}) : input;
  stream.setEncoding('utf8');
  try {
    let pending: string[] = [];
    for await (const chunk of stream as AsyncIterable<string>) {
      // Search each decoded chunk once. A large tool payload may span many
      // chunks; repeatedly joining and searching that growing line is quadratic.
      let start = 0;
      let newline = chunk.indexOf('\n');
      while (newline !== -1) {
        const tail = chunk.slice(start, newline);
        if (pending.length) {
          pending.push(tail);
          const line = pending.join('');
          pending = [];
          yield line;
        } else {
          yield tail;
        }
        start = newline + 1;
        newline = chunk.indexOf('\n', start);
      }
      if (start < chunk.length) pending.push(chunk.slice(start));
    }
    if (pending.length) yield pending.join('');
  } finally {
    stream.destroy();
    input.destroy();
  }
}

/** A line that is not JSON (a torn last line, a partial write) is not a record; the Python reader skips it the same way. */
export function parseLine(line: string): any {
  try { return JSON.parse(line); } catch { return undefined; }
}

export function isoToEpochMs(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string' || !timestamp) return null;
  const epoch = Date.parse(timestamp);
  return Number.isFinite(epoch) ? epoch : null;
}

/** `text_of`: a string, or the text of the content items whose type is listed. */
function textOf(content: unknown, textTypes: string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && typeof item === 'object' && textTypes.includes(item.type))
    .map(item => (typeof item.text === 'string' ? item.text : ''))
    .join('\n');
}

/** Decode complete JSON string tokens, not their container or the contents of decoded strings. */
function addJsonStringText(text: string, add: (text: string) => void): void {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '"') continue;
    let end = start + 1;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '"') break;
    }
    if (end >= text.length) break; // An incomplete value stays raw evidence only.
    const decoded = parseLine(text.slice(start, end + 1));
    if (typeof decoded === 'string') add(decoded);
    start = end;
  }
}

function fallbackId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') logger.warn('IMPORT', 'Skipped an unreadable transcript folder', { path, code });
    return [];
  }
}

/** Native environment overrides belong to the current profile, not an explicitly different home. */
function nativeProfileDirectory(homeDirectory: string, variable: string, ...fallback: string[]): string {
  const configured = resolve(homeDirectory) === resolve(homedir()) ? process.env[variable] : undefined;
  return configured ? resolve(configured) : join(homeDirectory, ...fallback);
}

/** Claude Code's config directory: CLAUDE_CONFIG_DIR for the current profile, else ~/.claude. */
export function claudeConfigDirectory(homeDirectory: string): string {
  return nativeProfileDirectory(homeDirectory, 'CLAUDE_CONFIG_DIR', '.claude');
}

function source(path: string, holdsPrompts = true): TranscriptSource | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? { path, bytes: stats.size, mtimeMs: stats.mtimeMs, holdsPrompts } : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn('IMPORT', 'Skipped an unreadable transcript file', { path, code });
    return null;
  }
}

function presentSources(sources: Array<TranscriptSource | null>): TranscriptSource[] {
  return sources.filter((entry): entry is TranscriptSource => entry !== null);
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/projects/*/*.jsonl, subagents in */*/subagents/*.jsonl

const COMMAND_PROMPT = /^<command-message>[\s\S]*?<\/command-message>\s*<command-name>([^<]+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?\s*$/;

/** A slash command, as the user typed it and as claude-mem's hook stores it (plugin prefix dropped). */
function claudeCommandSpellings(text: string): { typed: string; hookVariants: string[] } | null {
  const match = COMMAND_PROMPT.exec(text);
  if (!match) return null;
  const name = match[1].trim();
  const args = (match[2] ?? '').trim();
  const typed = `${name} ${args}`.trim();
  const shortName = `/${name.replace(/^\//, '').split(':').pop()}`;
  return { typed, hookVariants: [...new Set([typed, `${shortName} ${args}`.trim()])] };
}

export function createClaudeCodeReader(): AgentPromptReader {
  const seenKeys = new Set<string>();
  return {
    id: 'claude-code',
    label: 'Claude Code',
    platformSource: 'claude',
    locate(homeDirectory) {
      const projects = join(claudeConfigDirectory(homeDirectory), 'projects');
      const sources: Array<TranscriptSource | null> = [];
      for (const project of listDirectory(projects)) {
        const projectPath = join(projects, project);
        for (const entry of listDirectory(projectPath)) {
          if (entry.endsWith('.jsonl')) { sources.push(source(join(projectPath, entry))); continue; }
          const subagents = join(projectPath, entry, 'subagents');
          for (const subagent of listDirectory(subagents)) {
            if (subagent.endsWith('.jsonl')) sources.push(source(join(subagents, subagent), false));
          }
        }
      }
      return { detected: existsSync(projects), sources: presentSources(sources) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      sink.session(basename(transcript.path, '.jsonl'));
      for await (const line of readLines(transcript.path)) {
        if (!/"type"\s*:\s*"user"/.test(line)) continue;
        const record = parseLine(line);
        if (!record || typeof record !== 'object') continue;
        if (typeof record.sessionId === 'string') sink.session(record.sessionId);
        const text = textOf(record.message?.content, ['text']).trim();
        const isOwnerTyped = record.origin?.kind === 'human'
          && (record.entrypoint === 'cli' || record.entrypoint === 'claude-desktop')
          && !record.isSidechain && !record.isMeta;
        const at = isoToEpochMs(record.timestamp);
        if (!text || !isOwnerTyped || at === null || at < sinceEpochMs) continue;
        const dedupeKey = record.uuid || `${record.timestamp}\u0000${text.slice(0, 200)}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        const command = claudeCommandSpellings(text);
        sink.prompt({
          agent: 'claude-code',
          sessionId: typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : basename(transcript.path, '.jsonl'),
          nativePromptId: typeof record.uuid === 'string' && record.uuid ? record.uuid : fallbackId(record.timestamp, text),
          at,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
          text: command?.typed ?? text,
          ...(command ? { hookTextVariants: command.hookVariants } : {}),
        });
      }
    },
    async readAgentText(transcript, add) {
      for await (const line of readLines(transcript.path)) {
        if (!/"type"\s*:\s*"assistant"/.test(line)) continue;
        const record = parseLine(line);
        const content = record?.message?.content;
        const at = isoToEpochMs(record?.timestamp);
        if (at === null) continue;
        const pieces: string[] = [];
        for (const block of Array.isArray(content) ? content : []) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text') pieces.push(typeof block.text === 'string' ? block.text : '');
          else if (block.type === 'tool_use') {
            const raw = JSON.stringify(block.input ?? {});
            pieces.push(raw);
            addJsonStringText(raw, text => add(Math.floor(at / 1000), text));
          }
        }
        if (pieces.length) add(Math.floor(at / 1000), pieces.join(' '));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions/*.jsonl
// (either may be .jsonl.zst for cold sessions)

const CODEX_INJECTED_PREFIXES = ['# AGENTS.md', '<environment_context', '<user_instructions', '<permissions', '<INSTRUCTIONS', '<turn_aborted'];

/** Verified creator protocol: a fork persists its own settings before any child turn.
 * Resume retains the creation header; older/unknown creators keep their existing interpretation. */
export function codexForkThreadId(meta: any): string | null {
  return typeof meta?.id === 'string' && meta.id
    && typeof meta.forked_from_id === 'string' && meta.forked_from_id
    && typeof meta.cli_version === 'string' && Bun.semver.satisfies(meta.cli_version, '>=0.154.0')
    ? meta.id : null;
}

/** Rollouts in one Codex directory, plain or compressed. */
function codexRollouts(directory: string): Array<TranscriptSource | null> {
  const rollouts: Array<TranscriptSource | null> = [];
  for (const file of listDirectory(directory)) {
    if (!file.endsWith('.jsonl') && !file.endsWith('.jsonl.zst')) continue;
    // Codex reads the plain sibling while both exist during compression.
    if (file.endsWith('.zst') && existsSync(join(directory, file.slice(0, -4)))) continue;
    rollouts.push(source(join(directory, file)));
  }
  return rollouts;
}

export function createCodexReader(): AgentPromptReader {
  const seenKeys = new Set<string>();
  return {
    id: 'codex',
    label: 'Codex',
    platformSource: 'codex',
    locate(homeDirectory) {
      const profile = nativeProfileDirectory(homeDirectory, 'CODEX_HOME', '.codex');
      const sessions = join(profile, 'sessions');
      const archived = join(profile, 'archived_sessions');
      const sources: Array<TranscriptSource | null> = [];
      for (const year of listDirectory(sessions)) {
        for (const month of listDirectory(join(sessions, year))) {
          for (const day of listDirectory(join(sessions, year, month))) {
            sources.push(...codexRollouts(join(sessions, year, month, day)));
          }
        }
      }
      // Archival moves the same rollout into this flat directory, and Codex
      // compresses it there too. It remains part of the owner's history; the
      // existing timestamp/window rules apply.
      sources.push(...codexRollouts(archived));
      return { detected: existsSync(sessions) || existsSync(archived), sources: presentSources(sources) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      let meta: any = null;
      let awaitingThreadId: string | null = null;
      for await (const line of readLines(transcript.path)) {
        if (meta === null) {
          const first = parseLine(line);
          if (!first || typeof first !== 'object') return;
          meta = first.payload ?? {};
          awaitingThreadId = codexForkThreadId(meta);
          if (meta.id) sink.session(String(meta.id));
          const isInteractiveSession = typeof meta.source === 'string' && meta.originator !== 'codex_exec' && meta.source !== 'exec';
          if (!isInteractiveSession) return;
          continue;
        }
        if (awaitingThreadId !== null) {
          if (line.includes('"thread_settings_applied"')) {
            const record = parseLine(line);
            if (record?.type === 'event_msg' && record.payload?.type === 'thread_settings_applied'
              && record.payload.thread_id === awaitingThreadId) awaitingThreadId = null;
          }
          continue;
        }
        if (!/"role"\s*:\s*"user"/.test(line)) continue;
        const record = parseLine(line);
        const payload = record?.payload ?? {};
        if (record?.type !== 'response_item' || payload.role !== 'user') continue;
        const text = textOf(payload.content, ['input_text']).trim();
        const at = isoToEpochMs(record.timestamp);
        if (!text || CODEX_INJECTED_PREFIXES.some(prefix => text.startsWith(prefix)) || at === null || at < sinceEpochMs) continue;
        const sessionId = String(meta.id ?? basename(transcript.path).replace(/\.jsonl(?:\.zst)?$/, ''));
        const nativePromptId = typeof payload.id === 'string' && payload.id ? payload.id : fallbackId(String(meta.id), record.timestamp, text);
        const dedupeKey = fallbackId(sessionId, nativePromptId, String(at), text);
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        sink.prompt({
          agent: 'codex',
          sessionId,
          nativePromptId,
          at,
          cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
          text,
        });
      }
    },
    async readAgentText(transcript, add) {
      for await (const line of readLines(transcript.path)) {
        if (!line.includes('response_item')) continue;
        const record = parseLine(line);
        const payload = record?.payload ?? {};
        const at = isoToEpochMs(record?.timestamp);
        if (record?.type !== 'response_item' || at === null) continue;
        let text: string;
        if (payload.type === 'message' && payload.role === 'assistant') {
          text = (Array.isArray(payload.content) ? payload.content : [])
            .filter((item: any) => item && typeof item === 'object')
            .map((item: any) => (typeof item.text === 'string' ? item.text : ''))
            .join(' ');
        } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
          const value = payload.arguments || payload.input || '';
          text = typeof value === 'string' ? value : JSON.stringify(value);
          if (payload.type === 'function_call') addJsonStringText(text, value => add(Math.floor(at / 1000), value));
        } else continue;
        add(Math.floor(at / 1000), text);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.json (one JSON document)
// and session-*.jsonl (a header line, message lines, and `$set` lines that
// carry `messages`). User text is `displayContent` when present (what was
// typed, before @file expansion), else `content`. A `displayContent` with no
// text is a tool continuation ("System: Please continue."), not a prompt.

const GEMINI_INJECTED_PREFIXES = ['<hook_context>', '<session_context>', 'System: Please continue.'];
const GEMINI_REFERENCED_FILES = '\n--- Content from referenced files ---';

function geminiProjectDirectories(homeDirectory: string): Map<string, string> {
  const directories = new Map<string, string>();
  try {
    const projects = JSON.parse(readFileSync(join(homeDirectory, '.gemini', 'projects.json'), 'utf8')).projects ?? {};
    for (const [directory, name] of Object.entries(projects)) if (typeof name === 'string') directories.set(name, directory);
  } catch (error) {
    // No projects.json: chats still import, without a working directory.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('IMPORT', 'Could not read ~/.gemini/projects.json', { error: String(error) });
  }
  return directories;
}

export async function readGeminiChat(path: string): Promise<{ header: any; messages: any[] }> {
  if (!path.endsWith('.jsonl')) {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    return { header: document, messages: Array.isArray(document.messages) ? document.messages : [] };
  }
  let header: any = null;
  const byId = new Map<string, any>();
  const keep = (message: any) => {
    if (message && typeof message === 'object' && message.type) byId.set(String(message.id ?? byId.size), message);
  };
  for await (const line of readLines(path)) {
    const record = parseLine(line);
    if (!record || typeof record !== 'object') continue;
    if (header === null) { header = record; continue; }
    if (record.$set) for (const message of record.$set.messages ?? []) keep(message);
    else keep(record);
  }
  return { header: header ?? {}, messages: [...byId.values()] };
}

function geminiTypedText(message: any): string | null {
  const display = message.displayContent;
  let text: string;
  if (typeof display === 'string') {
    text = display;
  } else if (Array.isArray(display)) {
    if (!display.some((part: any) => typeof part?.text === 'string')) return null;
    text = textOf(display.map((part: any) => ({ type: 'text', ...part })), ['text']);
  } else {
    const content = Array.isArray(message.content) ? message.content.map((part: any) => ({ type: 'text', ...part })) : message.content;
    text = textOf(content, ['text']);
  }
  const referenced = text.indexOf(GEMINI_REFERENCED_FILES);
  text = (referenced === -1 ? text : text.slice(0, referenced)).trim();
  if (!text || GEMINI_INJECTED_PREFIXES.some(prefix => text.startsWith(prefix))) return null;
  return text;
}

export function createGeminiCliReader(): AgentPromptReader {
  let projectDirectories = new Map<string, string>();
  const seenPrompts = new Set<string>();
  return {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    platformSource: 'gemini-cli',
    locate(homeDirectory) {
      // Gemini's override names the parent of .gemini, not the config folder.
      const profileHome = nativeProfileDirectory(homeDirectory, 'GEMINI_CLI_HOME');
      projectDirectories = geminiProjectDirectories(profileHome);
      const tmp = join(profileHome, '.gemini', 'tmp');
      const sources: Array<TranscriptSource | null> = [];
      for (const project of listDirectory(tmp)) {
        const chats = join(tmp, project, 'chats');
        for (const file of listDirectory(chats)) {
          if (file.endsWith('.json') || file.endsWith('.jsonl')) sources.push(source(join(chats, file)));
        }
      }
      return { detected: existsSync(tmp), sources: presentSources(sources) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      const { header, messages } = await readGeminiChat(transcript.path);
      if (header.kind && header.kind !== 'main') return;
      const sessionId = typeof header.sessionId === 'string' && header.sessionId ? header.sessionId : basename(transcript.path).replace(/\.jsonl?$/, '');
      sink.session(sessionId);
      const projectName = basename(join(transcript.path, '..', '..'));
      for (const message of messages) {
        if (message.type !== 'user') continue;
        const text = geminiTypedText(message);
        const at = isoToEpochMs(message.timestamp);
        if (text === null || at === null || at < sinceEpochMs) continue;
        const nativePromptId = typeof message.id === 'string' && message.id ? message.id : fallbackId(sessionId, message.timestamp, text);
        const identity = fallbackId(sessionId, nativePromptId, String(at), text);
        if (seenPrompts.has(identity)) continue;
        seenPrompts.add(identity);
        sink.prompt({
          agent: 'gemini-cli',
          sessionId,
          nativePromptId,
          at,
          cwd: projectDirectories.get(projectName) ?? null,
          text,
        });
      }
    },
    async readAgentText(transcript, add) {
      const { messages } = await readGeminiChat(transcript.path);
      for (const message of messages) {
        const at = isoToEpochMs(message.timestamp);
        if (message.type !== 'gemini' || at === null) continue;
        const pieces = [typeof message.content === 'string' ? message.content : textOf(message.content, ['text'])];
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
          const raw = JSON.stringify(call?.args ?? {});
          pieces.push(raw);
          addJsonStringText(raw, text => add(Math.floor(at / 1000), text));
        }
        add(Math.floor(at / 1000), pieces.join(' '));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Antigravity CLI: ~/.gemini/antigravity-cli/history.jsonl, one line per typed
// entry: {display, timestamp (ms), workspace, conversationId?, type?}.
// `type: "slash_command"` lines are built-in commands (/model, /resume).

export function createAntigravityCliReader(): AgentPromptReader {
  return {
    id: 'antigravity-cli',
    label: 'Antigravity CLI',
    platformSource: 'antigravity-cli',
    locate(homeDirectory) {
      const history = source(join(homeDirectory, '.gemini', 'antigravity-cli', 'history.jsonl'));
      return { detected: existsSync(join(homeDirectory, '.gemini', 'antigravity-cli')), sources: presentSources([history]) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      for await (const line of readLines(transcript.path)) {
        const record = parseLine(line);
        if (!record || typeof record !== 'object' || record.type === 'slash_command') continue;
        const text = typeof record.display === 'string' ? record.display.trim() : '';
        const at = typeof record.timestamp === 'number' ? record.timestamp : isoToEpochMs(record.timestamp);
        if (!text || at === null || at < sinceEpochMs) continue;
        const sessionId = typeof record.conversationId === 'string' && record.conversationId ? record.conversationId : 'antigravity-history';
        sink.session(sessionId);
        sink.prompt({
          agent: 'antigravity-cli',
          sessionId,
          nativePromptId: `history-${at}`,
          at,
          cwd: typeof record.workspace === 'string' ? record.workspace : null,
          text,
        });
      }
    },
    // The history file holds only what was typed; there is no agent text in it.
    async readAgentText() {},
  };
}

// ---------------------------------------------------------------------------
// OpenCode: ~/.local/share/opencode/opencode.db (SQLite, opened read-only).
// V1 stores message roles and text in `message`/`part`; V2 stores typed user
// text in `session_message`, with assistant content inline or in `session_part`.
// Native migration retains V1 rows, preserving their IDs in the V2 tables.

export function openCodeHistoryLayout(database: Database): { legacy: boolean; current: boolean; splitParts: boolean } {
  const tables = new Set((database.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('message', 'session_message', 'session_part')`).all() as Array<{ name: string }>).map(row => row.name));
  const legacy = tables.has('message');
  const current = tables.has('session_message');
  if (!legacy && !current) throw new Error('No supported OpenCode message table');
  return { legacy, current, splitParts: tables.has('session_part') };
}

interface OpenCodePart { messageId: string; sessionId: string; role: string; createdAt: number; directory: string; parentId: string | null; data: string }

function readOpenCodeParts(path: string, role: 'user' | 'assistant'): OpenCodePart[] {
  const database = new Database(path, { readonly: true });
  try {
    const layout = openCodeHistoryLayout(database);
    const queries: string[] = [];
    const parameters: string[] = [];
    if (layout.legacy) {
      queries.push(`SELECT p.message_id AS messageId, m.session_id AS sessionId, json_extract(m.data, '$.role') AS role,
        m.time_created AS createdAt, s.directory, s.parent_id AS parentId, p.data,
        json_extract(p.data, '$.type') AS partType, json_extract(p.data, '$.state.time.start') AS startedAt,
        0 AS storageOrder, p.id AS ordinal
        FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = m.session_id
        WHERE json_extract(m.data, '$.role') = ? AND (json_extract(p.data, '$.type') = 'text'
          OR (? = 'assistant' AND json_extract(p.data, '$.type') = 'tool'))
          ${layout.current ? 'AND NOT EXISTS (SELECT 1 FROM session_message current WHERE current.id = m.id)' : ''}`);
      parameters.push(role, role);
    }
    if (layout.current && role === 'user') {
      queries.push(`SELECT m.id AS messageId, m.session_id AS sessionId, m.type AS role,
        m.time_created AS createdAt, s.directory, s.parent_id AS parentId,
        json_object('type', 'text', 'text', json_extract(m.data, '$.text')) AS data,
        'text' AS partType, NULL AS startedAt, 0 AS storageOrder, 0 AS ordinal
        FROM session_message m JOIN session_v2 s ON s.id = m.session_id WHERE m.type = 'user'`);
    }
    if (layout.current && role === 'assistant') {
      if (layout.splitParts) {
        queries.push(`SELECT m.id AS messageId, m.session_id AS sessionId, m.type AS role,
          m.time_created AS createdAt, s.directory, s.parent_id AS parentId, p.data,
          p.type AS partType, json_extract(p.data, '$.time.ran') AS startedAt, 0 AS storageOrder, p.ordinal
          FROM session_message m JOIN session_v2 s ON s.id = m.session_id
          JOIN session_part p ON p.message_id = m.id
          WHERE m.type = 'assistant' AND p.type IN ('text', 'tool')`);
      }
      // Native history reads ordered split parts before any remaining inline
      // content. Both can exist when an older build resumes a split message.
      queries.push(`SELECT m.id AS messageId, m.session_id AS sessionId, m.type AS role,
        m.time_created AS createdAt, s.directory, s.parent_id AS parentId, p.value AS data,
        json_extract(p.value, '$.type') AS partType, json_extract(p.value, '$.time.ran') AS startedAt,
        1 AS storageOrder, CAST(p.key AS INTEGER) AS ordinal
        FROM session_message m JOIN session_v2 s ON s.id = m.session_id, json_each(m.data, '$.content') p
        WHERE m.type = 'assistant' AND json_extract(p.value, '$.type') IN ('text', 'tool')`);
    }
    // Tool outputs may be user-authored files; project only model input and its call time.
    return database.prepare(`SELECT messageId, sessionId, role, createdAt, directory, parentId,
        CASE WHEN partType = 'tool' THEN json_object(
          'type', 'tool', 'status', json_extract(data, '$.state.status'),
          'input', json_extract(data, '$.state.input'), 'startedAt', startedAt)
          ELSE data END AS data
      FROM (${queries.join('\nUNION ALL\n')}) ORDER BY createdAt, messageId, storageOrder, ordinal`).all(...parameters) as OpenCodePart[];
  } finally {
    database.close();
  }
}

function groupOpenCodeMessages(parts: OpenCodePart[], typedOnly: boolean): Array<{ first: OpenCodePart; text: string }> {
  const messages = new Map<string, { first: OpenCodePart; pieces: string[] }>();
  for (const part of parts) {
    const data = parseLine(part.data);
    if (!data || typeof data.text !== 'string' || (typedOnly && (data.synthetic || data.ignored))) continue;
    const message = messages.get(part.messageId) ?? { first: part, pieces: [] };
    message.pieces.push(data.text);
    messages.set(part.messageId, message);
  }
  return [...messages.values()].map(message => ({ first: message.first, text: message.pieces.join('\n').trim() }));
}

export function createOpenCodeReader(): AgentPromptReader {
  return {
    id: 'opencode',
    label: 'OpenCode',
    platformSource: 'opencode',
    locate(homeDirectory) {
      const data = nativeProfileDirectory(homeDirectory, 'XDG_DATA_HOME', '.local', 'share');
      const database = source(join(data, 'opencode', 'opencode.db'));
      // SQLite commits can update only the WAL until the next checkpoint.
      const wal = database ? source(`${database.path}-wal`) : null;
      if (database && wal) database.mtimeMs = Math.max(database.mtimeMs, wal.mtimeMs);
      return { detected: database !== null, sources: presentSources([database]) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      for (const { first, text } of groupOpenCodeMessages(readOpenCodeParts(transcript.path, 'user'), true)) {
        sink.session(first.sessionId);
        if (first.parentId || !text || first.createdAt < sinceEpochMs) continue;
        sink.prompt({ agent: 'opencode', sessionId: first.sessionId, nativePromptId: first.messageId, at: first.createdAt, cwd: first.directory || null, text });
      }
    },
    async readAgentText(transcript, add) {
      const parts = readOpenCodeParts(transcript.path, 'assistant');
      for (const { first, text } of groupOpenCodeMessages(parts, false)) {
        add(Math.floor(first.createdAt / 1000), text);
      }
      for (const part of parts) {
        const data = parseLine(part.data);
        if (data?.type !== 'tool' || !['running', 'completed', 'error'].includes(data.status)
          || typeof data.startedAt !== 'number' || !Number.isFinite(data.startedAt) || data.startedAt < 0
          || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) continue;
        const raw = JSON.stringify(data.input);
        add(Math.floor(data.startedAt / 1000), raw);
        addJsonStringText(raw, text => add(Math.floor(data.startedAt / 1000), text));
      }
    },
  };
}

export function createPromptReaders(): AgentPromptReader[] {
  return [createClaudeCodeReader(), createCodexReader(), createGeminiCliReader(), createAntigravityCliReader(), createOpenCodeReader()];
}

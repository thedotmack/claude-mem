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
import { basename, join } from 'path';
import { logger } from '../../utils/logger.js';

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

/** Streams a file's lines without holding the file in memory. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let pending = '';
  for await (const chunk of stream as AsyncIterable<string>) {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  if (pending) yield pending;
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

function unescapeJsonText(text: string): string {
  return text.replaceAll('\\n', '\n').replaceAll('\\"', '"');
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
      const projects = join(homeDirectory, '.claude', 'projects');
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
        if (!line.includes('"type":"user"')) continue;
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
        if (!line.includes('"type":"assistant"')) continue;
        const record = parseLine(line);
        const content = record?.message?.content;
        const pieces: string[] = [];
        for (const block of Array.isArray(content) ? content : []) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text') pieces.push(typeof block.text === 'string' ? block.text : '');
          else if (block.type === 'tool_use') pieces.push(unescapeJsonText(JSON.stringify(block.input ?? {})));
        }
        const at = isoToEpochMs(record?.timestamp);
        if (pieces.length && at !== null) add(Math.floor(at / 1000), pieces.join(' '));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

const CODEX_INJECTED_PREFIXES = ['# AGENTS.md', '<environment_context', '<user_instructions', '<permissions', '<INSTRUCTIONS', '<turn_aborted'];

export function createCodexReader(): AgentPromptReader {
  const seenKeys = new Set<string>();
  return {
    id: 'codex',
    label: 'Codex',
    platformSource: 'codex',
    locate(homeDirectory) {
      const sessions = join(homeDirectory, '.codex', 'sessions');
      const sources: Array<TranscriptSource | null> = [];
      for (const year of listDirectory(sessions)) {
        for (const month of listDirectory(join(sessions, year))) {
          for (const day of listDirectory(join(sessions, year, month))) {
            for (const file of listDirectory(join(sessions, year, month, day))) {
              if (file.endsWith('.jsonl')) sources.push(source(join(sessions, year, month, day, file)));
            }
          }
        }
      }
      return { detected: existsSync(sessions), sources: presentSources(sources) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      let meta: any = null;
      for await (const line of readLines(transcript.path)) {
        if (meta === null) {
          const first = parseLine(line);
          if (!first || typeof first !== 'object') return;
          meta = first.payload ?? {};
          if (meta.id) sink.session(String(meta.id));
          const isInteractiveSession = typeof meta.source === 'string' && meta.originator !== 'codex_exec' && meta.source !== 'exec';
          if (!isInteractiveSession) return;
          continue;
        }
        if (!line.replaceAll(' ', '').includes('"role":"user"')) continue;
        const record = parseLine(line);
        const payload = record?.payload ?? {};
        if (record?.type !== 'response_item' || payload.role !== 'user') continue;
        const text = textOf(payload.content, ['input_text']).trim();
        const at = isoToEpochMs(record.timestamp);
        if (!text || CODEX_INJECTED_PREFIXES.some(prefix => text.startsWith(prefix)) || at === null || at < sinceEpochMs) continue;
        const dedupeKey = `${meta.id}\u0000${record.timestamp}\u0000${text.slice(0, 200)}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        sink.prompt({
          agent: 'codex',
          sessionId: String(meta.id ?? basename(transcript.path, '.jsonl')),
          nativePromptId: typeof payload.id === 'string' && payload.id ? payload.id : fallbackId(String(meta.id), record.timestamp, text),
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
          text = unescapeJsonText(typeof value === 'string' ? value : JSON.stringify(value));
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
  if (Array.isArray(display)) {
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
  return {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    platformSource: 'gemini-cli',
    locate(homeDirectory) {
      projectDirectories = geminiProjectDirectories(homeDirectory);
      const tmp = join(homeDirectory, '.gemini', 'tmp');
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
        sink.prompt({
          agent: 'gemini-cli',
          sessionId,
          nativePromptId: typeof message.id === 'string' && message.id ? message.id : fallbackId(sessionId, message.timestamp, text),
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
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) pieces.push(unescapeJsonText(JSON.stringify(call?.args ?? {})));
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
// `session` (parent_id set for subagent sessions), `message` (data.role),
// `part` (data.type "text"; synthetic/ignored parts were not typed).

interface OpenCodeTextPart { messageId: string; sessionId: string; role: string; createdAt: number; directory: string; parentId: string | null; data: string }

function readOpenCodeTextParts(path: string, role: 'user' | 'assistant'): OpenCodeTextPart[] {
  const database = new Database(path, { readonly: true });
  try {
    return database.prepare(`SELECT p.message_id AS messageId, m.session_id AS sessionId, json_extract(m.data, '$.role') AS role,
        m.time_created AS createdAt, s.directory, s.parent_id AS parentId, p.data
      FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = m.session_id
      WHERE json_extract(m.data, '$.role') = ? AND json_extract(p.data, '$.type') = 'text'
      ORDER BY m.time_created, p.message_id, p.id`).all(role) as OpenCodeTextPart[];
  } finally {
    database.close();
  }
}

function groupOpenCodeMessages(parts: OpenCodeTextPart[], typedOnly: boolean): Array<{ first: OpenCodeTextPart; text: string }> {
  const messages = new Map<string, { first: OpenCodeTextPart; pieces: string[] }>();
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
      const database = source(join(homeDirectory, '.local', 'share', 'opencode', 'opencode.db'));
      return { detected: database !== null, sources: presentSources([database]) };
    },
    async readPrompts(transcript, sink, sinceEpochMs) {
      for (const { first, text } of groupOpenCodeMessages(readOpenCodeTextParts(transcript.path, 'user'), true)) {
        sink.session(first.sessionId);
        if (first.parentId || !text || first.createdAt < sinceEpochMs) continue;
        sink.prompt({ agent: 'opencode', sessionId: first.sessionId, nativePromptId: first.messageId, at: first.createdAt, cwd: first.directory || null, text });
      }
    },
    async readAgentText(transcript, add) {
      for (const { first, text } of groupOpenCodeMessages(readOpenCodeTextParts(transcript.path, 'assistant'), false)) {
        add(Math.floor(first.createdAt / 1000), text);
      }
    },
  };
}

export function createPromptReaders(): AgentPromptReader[] {
  return [createClaudeCodeReader(), createCodexReader(), createGeminiCliReader(), createAntigravityCliReader(), createOpenCodeReader()];
}

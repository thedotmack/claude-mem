/**
 * Claude Code transcript normalizer (upstream #2690).
 *
 * The generic schema DSL (`field-utils.ts`) cannot fan out arrays: it can read
 * a fixed index (`content[0]`) but cannot iterate. Claude Code packs multiple
 * content blocks per JSONL line (one assistant message = text + N `tool_use`;
 * one user message = N `tool_result`). A plain schema would silently drop every
 * block past the first.
 *
 * Rather than extend the DSL, we flatten each JSONL line's `message.content`
 * into one *synthetic flat event per block*, tagged with a `__cc` type field,
 * then feed each flat event through the existing `TranscriptEventProcessor`
 * keyed on a small schema (`CLAUDE_CODE_SCHEMA`). This reuses ALL existing
 * session-state / pendingTools / ingestObservation / summary logic unchanged.
 */
import type { TranscriptSchema } from './types.js';

/** Synthetic per-block event type, carried on the `__cc` field. */
export type ClaudeCodeEventType =
  | 'user_prompt'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result';

/** A flattened, schema-ready event derived from one Claude Code content block. */
export interface ClaudeCodeFlatEvent {
  __cc: ClaudeCodeEventType;
  sessionId?: string;
  cwd?: string;
  /** Original ISO timestamp of the source line (informational; not backdated — see ingest.ts). */
  ts?: string;
  prompt?: string;
  message?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
}

interface RawLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Line `type` values that carry conversational content we ingest. */
const CONTENT_LINE_TYPES = new Set(['user', 'assistant']);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Flatten one Claude Code JSONL line into zero or more schema-ready flat events.
 * Non-conversational lines (`permission-mode`, `file-history-snapshot`,
 * `attachment`, `system`, `last-prompt`, …) produce no events.
 */
export function normalizeClaudeCodeLine(raw: unknown): ClaudeCodeFlatEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const line = raw as RawLine;
  if (!line.type || !CONTENT_LINE_TYPES.has(line.type)) return [];

  const base = {
    sessionId: asString(line.sessionId),
    cwd: asString(line.cwd),
    ts: asString(line.timestamp),
  };

  const content = line.message?.content;

  // String content: a plain user prompt or assistant text reply.
  if (typeof content === 'string') {
    if (!content.trim()) return [];
    return line.type === 'user'
      ? [{ ...base, __cc: 'user_prompt', prompt: content }]
      : [{ ...base, __cc: 'assistant_text', message: content }];
  }

  if (!Array.isArray(content)) return [];

  const events: ClaudeCodeFlatEvent[] = [];
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    const block = rawBlock as RawContentBlock;
    switch (block.type) {
      case 'text': {
        const text = asString(block.text);
        if (!text) break;
        events.push(
          line.type === 'user'
            ? { ...base, __cc: 'user_prompt', prompt: text }
            : { ...base, __cc: 'assistant_text', message: text }
        );
        break;
      }
      case 'tool_use': {
        events.push({
          ...base,
          __cc: 'tool_use',
          toolId: asString(block.id),
          toolName: asString(block.name),
          toolInput: block.input,
        });
        break;
      }
      case 'tool_result': {
        events.push({
          ...base,
          __cc: 'tool_result',
          toolId: asString(block.tool_use_id),
          toolResponse: block.content,
        });
        break;
      }
      // thinking / image / redacted_thinking / etc. — intentionally ignored.
      default:
        break;
    }
  }
  return events;
}

/**
 * Schema mapping the synthetic flat events onto existing processor actions.
 * Keyed on `__cc`; every field reads a top-level key set by the normalizer.
 *
 * Mirrors the Codex pattern of treating each user message as a `session_init`
 * (bumps the prompt number) — see CODEX_SAMPLE_SCHEMA.
 */
export const CLAUDE_CODE_SCHEMA: TranscriptSchema = {
  name: 'claude',
  version: '1.0',
  description: 'Claude Code JSONL transcripts, normalized one synthetic event per content block (#2690).',
  eventTypePath: '__cc',
  sessionIdPath: 'sessionId',
  cwdPath: 'cwd',
  events: [
    {
      name: 'user-prompt',
      match: { path: '__cc', equals: 'user_prompt' },
      action: 'session_init',
      fields: { sessionId: 'sessionId', cwd: 'cwd', prompt: 'prompt' },
    },
    {
      name: 'assistant-text',
      match: { path: '__cc', equals: 'assistant_text' },
      action: 'assistant_message',
      fields: { sessionId: 'sessionId', cwd: 'cwd', message: 'message' },
    },
    {
      name: 'tool-use',
      match: { path: '__cc', equals: 'tool_use' },
      action: 'tool_use',
      fields: {
        sessionId: 'sessionId',
        cwd: 'cwd',
        toolId: 'toolId',
        toolName: 'toolName',
        toolInput: 'toolInput',
      },
    },
    {
      name: 'tool-result',
      match: { path: '__cc', equals: 'tool_result' },
      action: 'tool_result',
      fields: {
        sessionId: 'sessionId',
        cwd: 'cwd',
        toolId: 'toolId',
        toolResponse: 'toolResponse',
      },
    },
  ],
};

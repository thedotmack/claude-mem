import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * First backward chunk. The last 64 KB of a 2 GB Claude Code transcript already
 * holds ~5 assistant entries; 256 KB covers a long tool-only run-up to the
 * final text turn in one read.
 */
export const TRANSCRIPT_TAIL_INITIAL_BYTES = 256 * 1024;

/**
 * Largest single chunk the backward scan reads. Chunks grow 4x per step up to
 * this size so a far-back answer costs few syscalls, while peak memory stays
 * at one chunk plus one carried line - never the whole file. The old
 * `readFileSync(path, 'utf-8')` needed the entire transcript in one string,
 * which hits JavaScriptCore's 2^31-1 cap (Bun reports ENOMEM) and V8's
 * 0x1fffffe8 cap (ERR_STRING_TOO_LONG); a 2.16 GB session lost every
 * Stop-hook summary that way.
 */
export const TRANSCRIPT_TAIL_MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export interface TranscriptTailOptions {
  /** Bytes read by the first chunk (default TRANSCRIPT_TAIL_INITIAL_BYTES). */
  initialBytes?: number;
  /** Largest chunk the scan grows to (default TRANSCRIPT_TAIL_MAX_CHUNK_BYTES). */
  maxChunkBytes?: number;
}

/**
 * Fill `buffer` from `position`, looping on short reads. Returns the number of
 * bytes actually read, which is less than `buffer.length` only at EOF (the
 * file shrank between `fstat` and `read`).
 */
function readFully(fd: number, buffer: Buffer, position: number): number {
  let filled = 0;
  while (filled < buffer.length) {
    const n = readSync(fd, buffer, filled, buffer.length - filled, position + filled);
    if (n === 0) break;
    filled += n;
  }
  return filled;
}

/**
 * Yield the transcript's complete lines in backward chunks: the last chunk
 * first, each chunk's text holding only whole lines (a line torn at the chunk
 * boundary is carried into the next, earlier chunk, so entries are never
 * parsed from a fragment). `isFirstChunkOfFile` is true on the chunk that
 * reaches byte 0 - the caller's last chance to fall back.
 */
function* readTranscriptChunksBackward(
  transcriptPath: string,
  options: TranscriptTailOptions
): Generator<{ text: string; isFirstChunkOfFile: boolean }> {
  const maxChunk = Math.max(1, options.maxChunkBytes ?? TRANSCRIPT_TAIL_MAX_CHUNK_BYTES);
  let chunkBytes = Math.min(maxChunk, Math.max(1, options.initialBytes ?? TRANSCRIPT_TAIL_INITIAL_BYTES));

  const fd = openSync(transcriptPath, 'r');
  try {
    let end = fstatSync(fd).size;
    let carry = Buffer.alloc(0); // the torn head of the line that begins before `end`

    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      const got = readFully(fd, chunk, start);
      const data = got === chunk.length ? chunk : chunk.subarray(0, got);
      const joined = carry.length ? Buffer.concat([data, carry]) : data;

      if (start === 0) {
        yield { text: joined.toString('utf-8'), isFirstChunkOfFile: true };
        return;
      }

      const firstNewline = joined.indexOf(0x0a);
      if (firstNewline === -1) {
        // The whole chunk is the middle of one line - keep carrying it.
        carry = joined;
      } else {
        carry = joined.subarray(0, firstNewline);
        yield { text: joined.subarray(firstNewline + 1).toString('utf-8'), isFirstChunkOfFile: false };
      }

      end = start;
      chunkBytes = Math.min(chunkBytes * 4, maxChunk);
    }

    if (carry.length) {
      yield { text: carry.toString('utf-8'), isFirstChunkOfFile: true };
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk the transcript backwards chunk by chunk until `probe` returns a value.
 * `probe` sees each chunk's complete lines (newest chunk first) and
 * `isFirstChunkOfFile` on the last one, where it must return whatever a
 * whole-file read would have returned (fallbacks included). On earlier chunks
 * it returns `undefined` for anything an earlier chunk might improve on, and
 * is responsible for remembering its own fallback across calls.
 *
 * Returns `undefined` (after a warn) when the path is missing, the file does
 * not exist, the file is empty, or the probe never produced a value.
 */
function scanTranscriptBackward<T>(
  transcriptPath: string,
  probe: (chunkText: string, isFirstChunkOfFile: boolean) => T | undefined,
  options: TranscriptTailOptions = {}
): T | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    logger.warn('PARSER', `Transcript path missing or file does not exist: ${transcriptPath}`);
    return undefined;
  }

  let sawContent = false;
  for (const chunk of readTranscriptChunksBackward(transcriptPath, options)) {
    if (!sawContent && chunk.text.trim()) sawContent = true;
    const hit = probe(chunk.text, chunk.isFirstChunkOfFile);
    if (hit !== undefined) return hit;
  }

  if (!sawContent) {
    logger.warn('PARSER', `Transcript file exists but is empty: ${transcriptPath}`);
  }
  return undefined;
}

/**
 * Yield parsed JSONL entries from the last line to the first. Blank lines and
 * lines that fail to parse are skipped so callers only ever see objects.
 */
function* parseJsonlLinesBackward(content: string): Generator<any> {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    // Tolerate truncated/malformed JSONL lines (crash mid-write, partial flush).
    // A bad line shouldn't crash the summarization pipeline — skip and move on.
    let line: any;
    try {
      line = JSON.parse(rawLine);
    } catch {
      // [ANTI-PATTERN IGNORED]: malformed/truncated JSONL lines are expected (crash mid-write,
      // partial flush) and this fires per bad line while scanning backwards over the whole
      // transcript; recovery is to skip the line and keep scanning, so logging each one would
      // flood the log with noise for a documented, tolerated condition.
      continue;
    }
    yield line;
  }
}

export function extractLastMessage(
  transcriptPath: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean = false,
  tailOptions?: TranscriptTailOptions
): string {
  return extractLastTurnBackward(transcriptPath, role, stripSystemReminders, false, tailOptions).text;
}

/**
 * Shared backward walk for the text readers. Real text in the newest chunk
 * wins immediately; a tool-only synthesis is remembered as the fallback (the
 * NEWEST one, matching whole-file semantics) and only returned once the walk
 * has reached the start of the file without finding text. The model, when
 * requested, is the newest assistant model seen - independent of where the
 * text turn sits.
 */
function extractLastTurnBackward(
  transcriptPath: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean,
  wantModel: boolean,
  tailOptions?: TranscriptTailOptions
): { text: string; model?: string } {
  let text: string | undefined;
  let fallbackText: string | null = null;
  let model: string | undefined;

  const result = scanTranscriptBackward(
    transcriptPath,
    (chunkText, isFirstChunkOfFile) => {
      // The model is the NEWEST assistant entry that carries one. Entries with
      // no model (other adapters, some tool-only turns) must not end the search,
      // so this keeps looking past the text hit until a model is found.
      if (wantModel && model === undefined) {
        model = extractLastAssistantModelFromJsonl(chunkText);
      }
      if (text === undefined) {
        const hit = findLastMessageInJsonl(chunkText, role, stripSystemReminders);
        if (hit.kind === 'text') {
          text = hit.text;
        } else if (hit.kind !== 'none' && fallbackText === null) {
          // Whole-file semantics: the NEWEST matching turn with no text decides
          // the fallback - a blank turn yields '' even if an older turn was
          // tool-only. Latch it from the first chunk that holds a matching turn.
          fallbackText = hit.text;
        }
      }
      const done = text !== undefined && (!wantModel || model !== undefined);
      if (done || isFirstChunkOfFile) {
        return { text: text ?? fallbackText ?? '', model };
      }
      return undefined;
    },
    tailOptions
  );

  if (!result) return { text: '' };
  return wantModel ? result : { text: result.text };
}

/**
 * Read the transcript tail ONCE and extract both the last assistant text and
 * the model that assistant turn was running. The Stop hook needs both, and a
 * long transcript should not be read from disk twice for it.
 */
export function extractLastAssistantTurn(
  transcriptPath: string,
  stripSystemReminders: boolean = false,
  tailOptions?: TranscriptTailOptions
): { text: string; model?: string } {
  const turn = extractLastTurnBackward(transcriptPath, 'assistant', stripSystemReminders, true, tailOptions);
  return turn.model === undefined ? { text: turn.text } : turn;
}

/**
 * Antigravity CLI (`agy`) transcript node types → chat roles. Its
 * `brain/<session>/.system_generated/logs/transcript.jsonl` lines are shaped
 * `{step_index, source, type, content}` with the text at the TOP LEVEL
 * (`content`), not under `message.content` (issue #4057). Only PLANNER_RESPONSE
 * carries the assistant's final text — RUN_COMMAND / VIEW_FILE / etc. also
 * carry `source: 'MODEL'`, so we discriminate on `type`, never on `source`.
 */
const ANTIGRAVITY_TYPE_TO_ROLE: Record<string, 'user' | 'assistant'> = {
  USER_INPUT: 'user',
  PLANNER_RESPONSE: 'assistant',
};

/**
 * Reduce a message content value to plain text. Returns `null` for an unknown
 * shape so callers can skip the line (rather than treating it as empty text).
 * Handles a top-level string, a Claude-style content array (`{type:'text',text}`),
 * and a generic `{text}` array (Antigravity, when content isn't a bare string).
 */
function contentToText(msgContent: unknown): string | null {
  if (typeof msgContent === 'string') return msgContent;
  if (Array.isArray(msgContent)) {
    return msgContent
      .filter(
        (c: any): c is { text: string } =>
          !!c && typeof c === 'object' && typeof c.text === 'string' &&
          (c.type === undefined || c.type === 'text')
      )
      .map((c) => c.text)
      .join('\n');
  }
  return null;
}

/**
 * Kimi Code wire.jsonl is event-sourced; role is carried by envelope type:
 * - user:      {"type":"context.append_message","message":{"role":"user",...}}
 * - assistant: {"type":"context.append_loop_event","event":{"type":"content.part",
 *              ...,"part":{"type":"text","text":"..."}}}  (part.type "think" is reasoning — skipped)
 */
function kimiWireRole(line: any): 'user' | 'assistant' | undefined {
  if (line?.type === 'context.append_message') {
    const role = line.message?.role;
    return role === 'user' || role === 'assistant' ? role : undefined;
  }
  if (
    line?.type === 'context.append_loop_event' &&
    line.event?.type === 'content.part' &&
    line.event?.part?.type === 'text'
  ) {
    return 'assistant';
  }
  return undefined;
}

function kimiWireText(line: any, role: 'user' | 'assistant'): string {
  if (role === 'user' && line?.type === 'context.append_message') {
    return contentToText(line.message?.content) ?? '';
  }
  if (role === 'assistant' && line?.type === 'context.append_loop_event') {
    const text = line.event?.part?.text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/**
 * Last-resort stand-in for a tool-only assistant turn: names the tools it
 * called, so a session that ended mid-tool-call (every assistant turn is
 * tool_use only) still has something to summarize. A Bash command is clipped
 * to 60 characters; the observer already saw the full tool inputs.
 */
function synthesizeToolDescription(msgContent: any[]): string {
  const toolUses = msgContent.filter((c: any) => c?.type === 'tool_use');
  if (toolUses.length === 0) return '';
  const labels = toolUses.map((t: any) => {
    const name: string = t.name ?? 'unknown';
    const input = t.input ?? {};
    if (input.file_path) return `${name}(${input.file_path})`;
    if (input.command) return `${name}(${String(input.command).slice(0, 60)})`;
    return name;
  });
  return `[Session ended mid-task. Last tools used: ${labels.join(', ')}]`;
}

/**
 * Extract last message from a JSONL transcript.
 *
 * Supports four field conventions for the per-line role marker:
 * - Claude Code:      `{"type":"assistant","message":{"content":...}}`
 * - Cursor:           `{"role":"assistant","message":{"content":...}}`
 * - Antigravity CLI:  `{"type":"PLANNER_RESPONSE","content":"..."}` (top-level)
 * - Kimi Code:        wire.jsonl `context.append_message` / `context.append_loop_event`
 *
 * The most recent assistant turn is often a pure tool_use block with no text
 * content (especially in Cursor, where the agent's last action before the
 * user replies is a tool call). We therefore keep scanning backwards until
 * we find a turn with non-empty text content, instead of returning early on
 * the first matching role.
 */
export function extractLastMessageFromJsonl(
  content: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean
): string {
  return findLastMessageInJsonl(content, role, stripSystemReminders).text;
}

/**
 * How `findLastMessageInJsonl` arrived at its text:
 * - `text`:        a matching turn with real (non-blank) text content
 * - `synthesized`: the newest matching turn was tool-only; `text` names the tools
 * - `blank`:       the newest matching turn had blank text and no tool calls;
 *                  `text` is that blank string (whole-file semantics return it)
 * - `none`:        no matching turn at all; `text` is ''
 *
 * The backward chunk walk needs the distinction: `synthesized`/`blank` from the
 * NEWEST chunk that holds a matching turn is the fallback a whole-file read
 * would return, so it is latched there and never replaced by an older chunk's
 * tool description; `none` says nothing about the file and is skipped.
 */
export interface LastMessageHit {
  kind: 'text' | 'synthesized' | 'blank' | 'none';
  text: string;
}

export function findLastMessageInJsonl(
  content: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean
): LastMessageHit {
  let foundMatchingRole = false;
  let lastEmptyText: string | null = null;
  let lastEmptyKind: 'synthesized' | 'blank' = 'blank';

  for (const line of parseJsonlLinesBackward(content)) {
    const kimiRole = kimiWireRole(line);
    const antigravityRole = typeof line.type === 'string'
      ? ANTIGRAVITY_TYPE_TO_ROLE[line.type]
      : undefined;
    const lineRole = kimiRole ?? antigravityRole ?? line.type ?? line.role;
    if (lineRole !== role) continue;
    foundMatchingRole = true;

    let text: string;
    let msgContent: unknown;
    if (kimiRole !== undefined) {
      text = kimiWireText(line, role);
    } else {
      // Antigravity nodes carry text at the top level; Claude/Cursor nest it under
      // `message.content`.
      msgContent = antigravityRole !== undefined ? line.content : line.message?.content;
      if (msgContent === undefined || msgContent === null) continue;

      // Unknown content shape (number, plain object, etc.) — skip rather than
      // throw. A single weird line should not crash the entire summary pipeline;
      // we already tolerate malformed JSONL in parseJsonlLinesBackward, and this
      // is the same class of defensive forward compat (CodeRabbit / Greptile
      // review on PR #2282).
      const extracted = contentToText(msgContent);
      if (extracted === null) continue;
      text = extracted;
    }

    if (stripSystemReminders) {
      text = text.replace(SYSTEM_REMINDER_REGEX, '');
      text = text.replace(/\n{3,}/g, '\n\n').trim();
    }

    if (text && text.trim()) {
      return { kind: 'text', text };
    }
    // Remember the first (most recent) empty-text turn as a fallback so the
    // caller can still distinguish "no matching role" from "matching role but
    // tool-only turns" if every later turn is empty.
    if (lastEmptyText === null) {
      lastEmptyText = text;
      // If this turn was tool-only, synthesize a description as a last resort
      // so the summarizer has something rather than silently skipping the session.
      if (!lastEmptyText.trim() && Array.isArray(msgContent)) {
        const toolSummary = synthesizeToolDescription(msgContent);
        if (toolSummary) {
          lastEmptyText = toolSummary;
          lastEmptyKind = 'synthesized';
        }
      }
    }
  }

  if (!foundMatchingRole) {
    return { kind: 'none', text: '' };
  }
  return { kind: lastEmptyKind, text: lastEmptyText ?? '' };
}

/**
 * Extract the model id the OBSERVED session is running from its transcript.
 *
 * Every assistant entry in a Claude Code / Cursor transcript carries
 * `message.model` (e.g. `"claude-fable-5-1"`). We scan backwards so the value
 * reflects the most recent turn — this covers mid-session `/model` switches.
 *
 * This is the observed-session model (what the user's IDE is running), NOT the
 * observer model claude-mem uses to write observations.
 */
export function extractLastAssistantModel(
  transcriptPath: string,
  tailOptions?: TranscriptTailOptions
): string | undefined {
  // Silent on a missing path: the model is telemetry, and the Stop handler
  // already decided whether the transcript matters for the summary itself.
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  return scanTranscriptBackward(
    transcriptPath,
    (chunkText) => extractLastAssistantModelFromJsonl(chunkText),
    tailOptions
  );
}

export function extractLastAssistantModelFromJsonl(content: string): string | undefined {
  for (const line of parseJsonlLinesBackward(content)) {
    if ((line.type ?? line.role) !== 'assistant') continue;
    const model = line.message?.model;
    if (typeof model === 'string' && model) return model;
  }
  return undefined;
}

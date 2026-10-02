import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * First tail window. The last 64 KB of a 2 GB Claude Code transcript already
 * holds ~5 assistant entries; 256 KB covers a long tool-only run-up to the
 * final text turn in one read.
 */
export const TRANSCRIPT_TAIL_INITIAL_BYTES = 256 * 1024;

/**
 * Hard ceiling for the backward scan. Kept far below JavaScriptCore's
 * 2^31-1 and V8's 0x1fffffe8 maximum string lengths: `readFileSync(path,
 * 'utf-8')` on a transcript past those caps throws ENOMEM (Bun) /
 * ERR_STRING_TOO_LONG (Node), which is how a 2.16 GB session lost every
 * Stop-hook summary.
 */
export const TRANSCRIPT_TAIL_MAX_BYTES = 256 * 1024 * 1024;

export interface TranscriptTailOptions {
  /** Bytes read on the first attempt (default TRANSCRIPT_TAIL_INITIAL_BYTES). */
  initialBytes?: number;
  /** Largest window the scan will grow to (default TRANSCRIPT_TAIL_MAX_BYTES). */
  maxBytes?: number;
}

interface TailWindow {
  /** Window contents, starting at a line boundary (or at byte 0). */
  text: string;
  /** File offset where `text` begins; 0 means the window is the whole file. */
  startOffset: number;
  fileSize: number;
}

/**
 * Read the last `maxBytes` of the file, aligned to the first complete line.
 * When the cut lands inside a line, that partial line is dropped — it is read
 * whole by the next, larger window (every window re-reads from the end of the
 * file). A window that starts at offset 0 is the whole file, unaligned.
 */
function readTranscriptTail(transcriptPath: string, maxBytes: number): TailWindow {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    if (start === 0) {
      return { text: buffer.toString('utf-8'), startOffset: 0, fileSize: size };
    }
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) {
      return { text: '', startOffset: size, fileSize: size };
    }
    return {
      text: buffer.subarray(firstNewline + 1).toString('utf-8'),
      startOffset: start + firstNewline + 1,
      fileSize: size,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk backwards through the transcript in growing windows until `probe`
 * returns a value, the window covers the whole file, or the window reaches
 * the cap. `probe` receives `isFinalWindow = true` on the last attempt and
 * must then return whatever a whole-file read would have returned (fallbacks
 * included) — on earlier windows it should return `undefined` for any result
 * that a larger window might improve on.
 *
 * Returns `undefined` (after a warn) when the path is missing, the file does
 * not exist, the file is empty, or the probe never produced a value.
 */
function scanTranscriptTail<T>(
  transcriptPath: string,
  probe: (windowText: string, isFinalWindow: boolean) => T | undefined,
  options: TranscriptTailOptions = {}
): T | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    logger.warn('PARSER', `Transcript path missing or file does not exist: ${transcriptPath}`);
    return undefined;
  }

  const cap = Math.max(1, options.maxBytes ?? TRANSCRIPT_TAIL_MAX_BYTES);
  let windowBytes = Math.min(cap, Math.max(1, options.initialBytes ?? TRANSCRIPT_TAIL_INITIAL_BYTES));

  for (;;) {
    const tail = readTranscriptTail(transcriptPath, windowBytes);
    const isWholeFile = tail.startOffset === 0;
    const isFinalWindow = isWholeFile || windowBytes >= cap;

    if (isWholeFile && !tail.text.trim()) {
      logger.warn('PARSER', `Transcript file exists but is empty: ${transcriptPath}`);
      return undefined;
    }

    const hit = probe(tail.text, isFinalWindow);
    if (hit !== undefined) return hit;

    if (isFinalWindow) {
      if (!isWholeFile) {
        logger.warn('PARSER', 'Transcript tail scan reached its byte cap without a usable entry', {
          transcriptPath,
          fileSize: tail.fileSize,
          maxBytes: cap,
        });
      }
      return undefined;
    }

    windowBytes = Math.min(windowBytes * 4, cap);
  }
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
  const text = scanTranscriptTail(
    transcriptPath,
    (windowText, isFinalWindow) => {
      const hit = findLastMessageInJsonl(windowText, role, stripSystemReminders);
      // A synthesized tool description (or nothing at all) from a partial
      // window is not an answer yet: a larger window may still hold real text.
      if (hit.kind === 'text' || isFinalWindow) return hit.text;
      return undefined;
    },
    tailOptions
  );
  return text ?? '';
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
  const turn = scanTranscriptTail(
    transcriptPath,
    (windowText, isFinalWindow) => {
      const hit = findLastMessageInJsonl(windowText, 'assistant', stripSystemReminders);
      if (hit.kind !== 'text' && !isFinalWindow) return undefined;
      return { text: hit.text, model: extractLastAssistantModelFromJsonl(windowText) };
    },
    tailOptions
  );
  return turn ?? { text: '' };
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
 * - `synthesized`: every matching turn was tool-only; `text` names the tools
 * - `none`:        no matching turn, or only blank-text turns; `text` is ''/blank
 *
 * The tail scanner needs the distinction: a `synthesized`/`none` result from a
 * partial window must not be returned while a larger window could still hold
 * real text.
 */
export interface LastMessageHit {
  kind: 'text' | 'synthesized' | 'none';
  text: string;
}

export function findLastMessageInJsonl(
  content: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean
): LastMessageHit {
  let foundMatchingRole = false;
  let lastEmptyText: string | null = null;
  let lastEmptyKind: 'synthesized' | 'none' = 'none';

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
  return scanTranscriptTail(
    transcriptPath,
    (windowText) => extractLastAssistantModelFromJsonl(windowText),
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

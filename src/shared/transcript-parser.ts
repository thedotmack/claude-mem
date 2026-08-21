import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

export function extractLastMessage(
  transcriptPath: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean = false
): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    logger.warn('PARSER', `Transcript path missing or file does not exist: ${transcriptPath}`);
    return '';
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    logger.warn('PARSER', `Transcript file exists but is empty: ${transcriptPath}`);
    return '';
  }

  return extractLastMessageFromJsonl(content, role, stripSystemReminders);
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
    const content = line.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n');
    }
    return '';
  }
  if (role === 'assistant' && line?.type === 'context.append_loop_event') {
    const text = line.event?.part?.text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/**
 * Extract last message from a JSONL transcript.
 *
 * Supports two field conventions for the per-line role marker:
 * - Claude Code:  `{"type":"assistant",...}`
 * - Cursor:       `{"role":"assistant",...}`
 * - Kimi Code:    wire.jsonl `context.append_message` / `context.append_loop_event`
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
  const lines = content.split('\n');
  let foundMatchingRole = false;
  let lastEmptyText: string | null = null;

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
    const kimiRole = kimiWireRole(line);
    const lineRole = kimiRole ?? line.type ?? line.role;
    if (lineRole !== role) continue;
    foundMatchingRole = true;

    let text = '';
    if (kimiRole) {
      text = kimiWireText(line, role);
    } else {
      if (!line.message?.content) continue;
      const msgContent = line.message.content;
      if (typeof msgContent === 'string') {
        text = msgContent;
      } else if (Array.isArray(msgContent)) {
        text = msgContent
          .filter(
            (c: any): c is { type: 'text'; text: string } =>
              !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string'
          )
          .map((c) => c.text)
          .join('\n');
      } else {
        // Unknown content shape (null, number, plain object, etc.) — skip rather
        // than throw. A single weird line should not crash the entire summary
        // pipeline; we already tolerate malformed JSONL via the parse-catch
        // above, and this is the same class of defensive forward compat
        // (CodeRabbit / Greptile review on PR #2282).
        continue;
      }
    }

    if (stripSystemReminders) {
      text = text.replace(SYSTEM_REMINDER_REGEX, '');
      text = text.replace(/\n{3,}/g, '\n\n').trim();
    }

    if (text && text.trim()) {
      return text;
    }
    // Remember the first (most recent) empty-text turn as a fallback so the
    // caller can still distinguish "no matching role" from "matching role but
    // tool-only turns" if every later turn is empty.
    if (lastEmptyText === null) {
      lastEmptyText = text;
    }
  }

  if (!foundMatchingRole) {
    return '';
  }
  return lastEmptyText ?? '';
}

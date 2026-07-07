import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * Count non-empty JSONL lines in a transcript file. Used as a cheap pointer
 * back into "how much conversation existed at this moment" — e.g. to record
 * how far a tool call (like `advisor`, which forwards the whole transcript)
 * had read into the session, without copying the transcript itself.
 */
export function countTranscriptLines(transcriptPath: string): number {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return 0;
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    return 0;
  }

  return content.split('\n').filter(line => line.trim().length > 0).length;
}

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
 * Extract last message from a JSONL transcript.
 *
 * Supports two field conventions for the per-line role marker:
 * - Claude Code:  `{"type":"assistant",...}`
 * - Cursor:       `{"role":"assistant",...}`
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
    const lineRole = line.type ?? line.role;
    if (lineRole !== role) continue;
    foundMatchingRole = true;

    if (!line.message?.content) continue;

    let text = '';
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

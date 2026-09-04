import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * Read a transcript file once, trimmed. Returns '' (after a warn) when the
 * path is missing, the file does not exist, or the file is empty.
 */
function readTranscriptOrWarn(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    logger.warn('PARSER', `Transcript path missing or file does not exist: ${transcriptPath}`);
    return '';
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    logger.warn('PARSER', `Transcript file exists but is empty: ${transcriptPath}`);
    return '';
  }

  return content;
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
  stripSystemReminders: boolean = false
): string {
  const content = readTranscriptOrWarn(transcriptPath);
  if (!content) return '';
  return extractLastMessageFromJsonl(content, role, stripSystemReminders);
}

/**
 * Read the transcript ONCE and extract both the last assistant text and the
 * model that assistant turn was running. The Stop hook needs both, and a
 * long transcript should not be read from disk twice for it.
 */
export function extractLastAssistantTurn(
  transcriptPath: string,
  stripSystemReminders: boolean = false
): { text: string; model?: string } {
  const content = readTranscriptOrWarn(transcriptPath);
  if (!content) return { text: '' };
  return {
    text: extractLastMessageFromJsonl(content, 'assistant', stripSystemReminders),
    model: extractLastAssistantModelFromJsonl(content),
  };
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
  let foundMatchingRole = false;
  let lastEmptyText: string | null = null;

  for (const line of parseJsonlLinesBackward(content)) {
    let isMatchingRole = false;
    let text = '';

    if (role === 'assistant') {
      if (line.type === 'assistant' || line.role === 'assistant') {
        isMatchingRole = true;
        const msgContent = line.message?.content;
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
          continue;
        }
      } else if (line.type === 'PLANNER_RESPONSE') {
        isMatchingRole = true;
        if (typeof line.content === 'string') {
          text = line.content;
        }
      }
    } else if (role === 'user') {
      if (line.type === 'user' || line.role === 'user') {
        isMatchingRole = true;
        const msgContent = line.message?.content;
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
          continue;
        }
      } else if (line.source === 'USER_EXPLICIT' || line.type === 'USER_INPUT') {
        isMatchingRole = true;
        if (typeof line.content === 'string') {
          text = line.content;
        }
      }
    }

    if (!isMatchingRole) continue;
    foundMatchingRole = true;

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
export function extractLastAssistantModel(transcriptPath: string): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) return undefined;
  return extractLastAssistantModelFromJsonl(content);
}

export function extractLastAssistantModelFromJsonl(content: string): string | undefined {
  for (const line of parseJsonlLinesBackward(content)) {
    if ((line.type ?? line.role) !== 'assistant') continue;
    const model = line.message?.model;
    if (typeof model === 'string' && model) return model;
  }
  return undefined;
}

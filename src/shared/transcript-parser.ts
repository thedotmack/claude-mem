import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * Detect whether a transcript file is in Gemini CLI JSON document format.
 *
 * Gemini CLI 0.37.0 writes a single JSON document with a top-level `messages`
 * array instead of JSONL. Assistant entries use `type: "gemini"` rather than
 * `type: "assistant"`.
 *
 * Example Gemini format:
 *   { "messages": [{ "type": "user", "content": "..." }, { "type": "gemini", "content": "..." }] }
 *
 * Claude Code format (JSONL):
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 */
function isGeminiTranscriptFormat(content: string): { isGemini: true; messages: any[] } | { isGemini: false } {
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.messages)) {
      return { isGemini: true, messages: parsed.messages };
    }
  } catch {
    // Not a valid single JSON object — assume JSONL
  }
  return { isGemini: false };
}

/**
 * Extract last message of specified role from transcript file.
 *
 * Supports two transcript formats:
 * - JSONL (Claude Code): one JSON object per line, `type: "assistant"` or `type: "user"`
 * - JSON document (Gemini CLI 0.37.0+): `{ messages: [{ type: "gemini"|"user", content: string }] }`
 *
 * @param transcriptPath Path to transcript file
 * @param role 'user' or 'assistant'
 * @param stripSystemReminders Whether to remove <system-reminder> tags (for assistant)
 */
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

  // Gemini CLI 0.37.0 writes a JSON document rather than JSONL.
  // Detect and handle it before falling through to the JSONL parser.
  const geminiCheck = isGeminiTranscriptFormat(content);
  if (geminiCheck.isGemini) {
    return extractLastMessageFromGeminiTranscript(geminiCheck.messages, role, stripSystemReminders);
  }

  return extractLastMessageFromJsonl(content, role, stripSystemReminders);
}

/**
 * Extract last message from Gemini CLI JSON document transcript.
 * Maps `type: "gemini"` → assistant role; `type: "user"` → user role.
 */
function extractLastMessageFromGeminiTranscript(
  messages: any[],
  role: 'user' | 'assistant',
  stripSystemReminders: boolean
): string {
  // "gemini" entries are assistant turns; "user" entries are user turns
  const geminiRole = role === 'assistant' ? 'gemini' : 'user';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === geminiRole && typeof msg.content === 'string') {
      let text = msg.content;
      if (stripSystemReminders) {
        text = text.replace(SYSTEM_REMINDER_REGEX, '');
        text = text.replace(/\n{3,}/g, '\n\n').trim();
      }
      return text;
    }
  }

  return '';
}

/**
 * Map a JSONL entry's `type` field to the internal role.
 * Handles Claude Code ("assistant"/"user") and Gemini CLI ("gemini"/"model"/"user")
 * transcript formats. Returns null for unrecognized types. (#1909)
 */
function mapJsonlTypeToRole(type: string): 'user' | 'assistant' | null {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
    case 'gemini':
    case 'model':
      return 'assistant';
    default:
      return null;
  }
}

/**
 * Extract last message from JSONL transcript.
 * Each line is an independent JSON object.
 *
 * Supports two JSONL conventions:
 * - Claude Code: `type: "assistant"` or `type: "user"`, content in `message.content`
 * - Gemini CLI JSONL: `type: "gemini"|"model"` or `type: "user"`, content in `content` (string) or `message.content`
 */
function extractLastMessageFromJsonl(
  content: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean
): string {
  const lines = content.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmedLine = lines[i].trim();
    if (!trimmedLine) continue;

    let line: any;
    try {
      line = JSON.parse(trimmedLine);
    } catch {
      // Skip unparseable lines - log for debugging
      logger.debug('PARSER', `Skipping unparseable JSONL line ${i}`, { lineLength: trimmedLine.length });
      continue;
    }

    const mappedRole = mapJsonlTypeToRole(line.type);
    if (mappedRole === role) {
      // Gemini JSONL: content is a top-level string field
      if (typeof line.content === 'string') {
        let text = line.content;
        if (stripSystemReminders) {
          text = text.replace(SYSTEM_REMINDER_REGEX, '');
          text = text.replace(/\n{3,}/g, '\n\n').trim();
        }
        return text;
      }

      // Claude Code JSONL: content is nested in message.content
      if (line.message?.content) {
        let text = '';
        const msgContent = line.message.content;

        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        } else {
          // Unknown content format - throw error
          throw new Error(`Unknown message content format in transcript. Type: ${typeof msgContent}`);
        }

        if (stripSystemReminders) {
          text = text.replace(SYSTEM_REMINDER_REGEX, '');
          text = text.replace(/\n{3,}/g, '\n\n').trim();
        }

        // Return text even if empty - caller decides if that's an error
        return text;
      }
    }
  }

  return '';
}

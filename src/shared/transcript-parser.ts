import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * Extract last message of specified role from transcript JSON or JSONL file
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

  const rawContent = readFileSync(transcriptPath, 'utf-8').trim();
  if (!rawContent) {
    logger.warn('PARSER', `Transcript file exists but is empty: ${transcriptPath}`);
    return '';
  }

  let messages: any[] = [];
  let isJSONL = false;

  // Try parsing as standard JSON (Gemini CLI format)
  try {
    const data = JSON.parse(rawContent);
    if (Array.isArray(data.messages)) {
      messages = data.messages;
    } else if (Array.isArray(data)) {
      messages = data;
    } else {
      isJSONL = true;
    }
  } catch {
    isJSONL = true;
  }

  // Fallback to JSONL (Claude Code format)
  if (isJSONL) {
    try {
      messages = rawContent
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch (err) {
      logger.error(
        'PARSER',
        `Failed to parse transcript as JSONL: ${err instanceof Error ? err.message : err}`
      );
      return '';
    }
  }

  // Define role mapping for different platforms
  const targetTypes = role === 'assistant'
    ? ['assistant', 'gemini', 'agent']
    : ['user', 'human'];

  let foundMatchingRole = false;

  // Search backwards for the last message from the requested role
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (targetTypes.includes(msg.type)) {
      foundMatchingRole = true;

      // Extract text content based on format (line.message.content or msg.content)
      let text = '';
      const msgContent = msg.message?.content ?? msg.content;

      if (!msgContent) continue;

      if (typeof msgContent === 'string') {
        text = msgContent;
      } else if (Array.isArray(msgContent)) {
        text = msgContent
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text ?? c.content)
          .join('\n');
      }

      if (!text) continue;

      if (stripSystemReminders) {
        text = text.replace(SYSTEM_REMINDER_REGEX, '');
        text = text.replace(/\n{3,}/g, '\n\n').trim();
      }

      return text;
    }
  }

  if (!foundMatchingRole) {
    logger.debug('PARSER', `No messages found with role types: ${targetTypes.join(', ')}`);
  }

  return '';
}

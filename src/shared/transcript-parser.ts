import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';

/**
 * Extract last message of specified role from transcript JSONL file
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
    logger.happyPathError(
      'PARSER',
      'Transcript path missing or file does not exist',
      undefined,
      { transcriptPath, role },
      ''
    );
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      logger.happyPathError(
        'PARSER',
        'Transcript file exists but is empty',
        undefined,
        { transcriptPath, role },
        ''
      );
      return '';
    }

    const lines = content.split('\n');
    let foundMatchingRole = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);
        if (line.type === role) {
          foundMatchingRole = true;

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
            }

            if (stripSystemReminders) {
              text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
              text = text.replace(/\n{3,}/g, '\n\n').trim();
            }

            // Log if we found the role but the text is empty after processing
            if (!text || text.trim() === '') {
              logger.happyPathError(
                'PARSER',
                'Found message but content is empty after processing',
                undefined,
                { role, transcriptPath, msgContentType: typeof msgContent, stripSystemReminders },
                ''
              );
            }

            return text;
          }
        }
      } catch {
        continue;
      }
    }

    // If we searched the whole transcript and didn't find any message of this role
    if (!foundMatchingRole) {
      logger.happyPathError(
        'PARSER',
        'No message found for role in transcript',
        undefined,
        { role, transcriptPath, totalLines: lines.length },
        ''
      );
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

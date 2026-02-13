import { readFileSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import type { ThinkingContent } from '../../types/transcript.js';

export interface ThinkingBlock {
  thinking: string;
  timestamp: number;
  messageIndex: number;
}

/**
 * Extract thinking blocks from a Claude Code JSONL transcript file.
 * Reads line-by-line, parses each as JSON, and collects thinking content
 * from assistant messages.
 */
export function extractThinkingBlocks(transcriptPath: string): ThinkingBlock[] {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    return [];
  }

  const lines = content.split('\n');
  const thinkingBlocks: ThinkingBlock[] = [];

  lines.forEach((line, lineIndex) => {
    try {
      const entry = JSON.parse(line);

      if (entry.type !== 'assistant') return;
      if (!Array.isArray(entry.message?.content)) return;

      for (const block of entry.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          thinkingBlocks.push({
            thinking: (block as ThinkingContent).thinking,
            timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
            messageIndex: lineIndex,
          });
        }
      }
    } catch {
      logger.debug('THINKING', 'Skipping malformed transcript line', { lineIndex, transcriptPath });
    }
  });

  return thinkingBlocks;
}

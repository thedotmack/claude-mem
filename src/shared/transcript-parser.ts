import { readFileSync, existsSync } from 'fs';

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
    throw new Error(`Transcript path missing or file does not exist: ${transcriptPath}`);
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    throw new Error(`Transcript file exists but is empty: ${transcriptPath}`);
  }

  const lines = content.split('\n');
  let foundMatchingRole = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = JSON.parse(lines[i]) as {
      type?: string;
      message?: { content?: string | Array<{ type: string; text?: string }> };
    };
    if (line.type === role) {
      foundMatchingRole = true;

      if (line.message?.content) {
        let text = '';
        const msgContent: string | Array<{ type: string; text?: string }> = line.message.content;

        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .filter((c: unknown) => typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
            .map((c: unknown) => (c as { text: string }).text)
            .join('\n');
        } else {
          // Unknown content format - throw error
          throw new Error(`Unknown message content format in transcript. Type: ${typeof msgContent}`);
        }

        if (stripSystemReminders) {
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
          text = text.replace(/\n{3,}/g, '\n\n').trim();
        }

        // Return text even if empty - caller decides if that's an error
        return text;
      }
    }
  }

  // If we searched the whole transcript and didn't find any message of this role
  if (!foundMatchingRole) {
    throw new Error(`No message found for role '${role}' in transcript: ${transcriptPath}`);
  }

  return '';
}

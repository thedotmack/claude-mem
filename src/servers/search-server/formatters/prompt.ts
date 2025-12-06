import { UserPromptSearchResult } from '../../../services/sqlite/types.js';

/**
 * Format user prompt as index entry (full text - don't truncate context!)
 */
export function formatUserPromptIndex(prompt: UserPromptSearchResult, index: number): string {
  const date = new Date(prompt.created_at_epoch).toLocaleString();

  return `${index + 1}. "${prompt.prompt_text}"
   Date: ${date} | Prompt #${prompt.prompt_number}
   Source: claude-mem://user-prompt/${prompt.id}`;
}

/**
 * Format user prompt as text content with metadata
 */
export function formatUserPromptResult(prompt: UserPromptSearchResult): string {
  const contentParts: string[] = [];
  contentParts.push(`## User Prompt #${prompt.prompt_number}`);
  contentParts.push(`*Source: claude-mem://user-prompt/${prompt.id}*`);
  contentParts.push('');
  contentParts.push(prompt.prompt_text);
  contentParts.push('');
  contentParts.push('---');

  const date = new Date(prompt.created_at_epoch).toLocaleString();
  contentParts.push(`Date: ${date}`);

  return contentParts.join('\n');
}

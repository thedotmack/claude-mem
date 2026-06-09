import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
import { logger } from '../../utils/logger.js';

export const MAX_STORED_PROMPT_CHARS = 4000;

export function normalizeStoredPromptText(promptText: string): string {
  const trimmedRawPrompt = promptText.trim();
  const strippedPrompt = stripMemoryTagsFromPrompt(promptText).trim();
  const preferredPrompt = strippedPrompt || trimmedRawPrompt;

  if (preferredPrompt.length <= MAX_STORED_PROMPT_CHARS) {
    return preferredPrompt;
  }

  // Keep stored prompt history bounded; search/timeline views need the user ask, not the full wrapper blob.
  logger.debug('DB', 'Truncated stored prompt text to the configured cap', {
    originalLength: preferredPrompt.length,
    storedLength: MAX_STORED_PROMPT_CHARS,
  });
  return `${preferredPrompt.slice(0, MAX_STORED_PROMPT_CHARS - 1)}…`;
}

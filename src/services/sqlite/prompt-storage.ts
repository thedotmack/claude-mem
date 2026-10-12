import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { logger } from '../../utils/logger.js';

export const MAX_STORED_PROMPT_CHARS = 4000;

// Stand-in written when a session is initialized with no usable prompt text; later real prompts may replace this durable value.
export const MEDIA_PROMPT_PLACEHOLDER = '[media prompt]';

export function normalizeStoredPromptText(promptText: string): string {
  const trimmedRawPrompt = promptText.trim();
  const strippedPrompt = stripMemoryTags(promptText).trim();
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

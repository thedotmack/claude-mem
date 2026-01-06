/**
 * Text truncation utilities for handling large payloads
 *
 * Prevents ECONNRESET errors when transcript/message content is too large
 * by truncating to a reasonable size while preserving context from both
 * the beginning (original request context) and end (final results).
 */

/** Maximum size for assistant messages sent to worker/AI (50KB) */
export const MAX_ASSISTANT_MESSAGE_LENGTH = 50000;

/** How much to keep from the start (context) */
export const HEAD_KEEP_LENGTH = 10000;

/** How much to keep from the end (results - more important) */
export const TAIL_KEEP_LENGTH = 40000;

/**
 * Truncate large text by keeping head + tail portions
 * This preserves both the initial context and the final results
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum allowed length (default: 50KB)
 * @param headLength - Length to keep from start (default: 10KB)
 * @param tailLength - Length to keep from end (default: 40KB)
 * @returns Truncated text with marker if truncation occurred
 */
export function truncateLargeText(
  text: string | undefined,
  maxLength: number = MAX_ASSISTANT_MESSAGE_LENGTH,
  headLength: number = HEAD_KEEP_LENGTH,
  tailLength: number = TAIL_KEEP_LENGTH
): string {
  if (!text) return '';

  if (text.length <= maxLength) {
    return text;
  }

  const head = text.slice(0, headLength);
  const tail = text.slice(-tailLength);
  const truncatedBytes = text.length - headLength - tailLength;

  return `${head}\n\n[... ${truncatedBytes.toLocaleString()} characters truncated ...]\n\n${tail}`;
}

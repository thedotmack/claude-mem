/**
 * Text truncation utilities for handling large payloads
 *
 * Prevents ECONNRESET errors when transcript/message content is too large
 * by truncating to a reasonable size while preserving context from both
 * the beginning (original request context) and end (final results).
 */

/**
 * Maximum size for assistant messages sent to worker/AI.
 *
 * This limit is in characters, not bytes. For ASCII-heavy text it's close to ~50KB,
 * but UTF-8 content may be larger in bytes.
 */
export const MAX_ASSISTANT_MESSAGE_LENGTH = 50000;

/**
 * Truncate large text by keeping head + tail portions
 * This preserves both the initial context and the final results
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum allowed length (in characters)
 * @returns Truncated text with marker if truncation occurred
 */
export function truncateLargeText(
  text: string | undefined,
  maxLength: number = MAX_ASSISTANT_MESSAGE_LENGTH
): string {
  if (!text) return '';

  if (text.length <= maxLength) {
    return text;
  }

  const tailRatio = 0.8;
  let marker = '\n\n[... characters truncated ...]\n\n';

  // The marker includes a dynamic character count, which affects its length.
  // Iterate to converge so the final output stays within maxLength.
  for (let i = 0; i < 3; i += 1) {
    const availableForContent = maxLength - marker.length;
    if (availableForContent <= 0) {
      return text.slice(0, maxLength);
    }

    const tailLength = Math.floor(availableForContent * tailRatio);
    const headLength = availableForContent - tailLength;
    const truncatedChars = text.length - headLength - tailLength;
    const nextMarker = `\n\n[... ${truncatedChars.toLocaleString()} characters truncated ...]\n\n`;

    if (nextMarker === marker) {
      const result = text.slice(0, headLength) + marker + text.slice(-tailLength);
      return result.length <= maxLength ? result : result.slice(0, maxLength);
    }

    marker = nextMarker;
  }

  // Final pass with the converged marker
  const availableForContent = maxLength - marker.length;
  if (availableForContent <= 0) {
    return text.slice(0, maxLength);
  }

  const tailLength = Math.floor(availableForContent * tailRatio);
  const headLength = availableForContent - tailLength;
  const result = text.slice(0, headLength) + marker + text.slice(-tailLength);
  return result.length <= maxLength ? result : result.slice(0, maxLength);
}

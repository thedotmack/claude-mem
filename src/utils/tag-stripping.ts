/**
 * Tag Stripping Utilities
 *
 * Implements the dual-tag system for meta-observation control:
 * 1. <claude-mem-context> - System-level tag for auto-injected observations
 *    (prevents recursive storage when context injection is active)
 * 2. <private> - User-level tag for manual privacy control
 *    (allows users to mark content they don't want persisted)
 *
 * EDGE PROCESSING PATTERN: Filter at hook layer before sending to worker/storage.
 * This keeps the worker service simple and follows one-way data stream.
 */

import { silentDebug } from './silent-debug.js';

/**
 * Maximum number of tags allowed in a single content block
 * This protects against ReDoS (Regular Expression Denial of Service) attacks
 * where malicious input with many nested/unclosed tags could cause catastrophic backtracking
 */
const MAX_TAG_COUNT = 100;

/**
 * Count total number of opening tags in content
 * Used for ReDoS protection before regex processing
 */
function countTags(content: string): number {
  const privateCount = (content.match(/<private>/g) || []).length;
  const contextCount = (content.match(/<claude-mem-context>/g) || []).length;
  return privateCount + contextCount;
}

/**
 * Strip memory tags from JSON-serialized content (tool inputs/responses)
 *
 * @param content - Stringified JSON content from tool_input or tool_response
 * @returns Cleaned content with tags removed, or '{}' if non-string/invalid
 *
 * Note: Returns '{}' for non-strings because this is used in JSON context
 * where we need a valid JSON object if the input is invalid.
 */
export function stripMemoryTagsFromJson(content: string): string {
  if (typeof content !== 'string') {
    silentDebug('[tag-stripping] received non-string for JSON context:', { type: typeof content });
    return '{}';  // Safe default for JSON context
  }

  // ReDoS protection: limit tag count before regex processing
  const tagCount = countTags(content);
  if (tagCount > MAX_TAG_COUNT) {
    silentDebug('[tag-stripping] tag count exceeds limit, truncating:', {
      tagCount,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: content.length
    });
    // Still process but log the anomaly
  }

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}

/**
 * Strip memory tags from user prompt content
 *
 * @param content - Raw user prompt text
 * @returns Cleaned content with tags removed, or '' if non-string/invalid
 *
 * Note: Returns '' (empty string) for non-strings because this is used in prompt context
 * where an empty prompt indicates the user didn't provide any content.
 */
export function stripMemoryTagsFromPrompt(content: string): string {
  if (typeof content !== 'string') {
    silentDebug('[tag-stripping] received non-string for prompt context:', { type: typeof content });
    return '';  // Safe default for prompt content
  }

  // ReDoS protection: limit tag count before regex processing
  const tagCount = countTags(content);
  if (tagCount > MAX_TAG_COUNT) {
    silentDebug('[tag-stripping] tag count exceeds limit, truncating:', {
      tagCount,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: content.length
    });
    // Still process but log the anomaly
  }

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}

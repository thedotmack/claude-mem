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

import { logger } from './logger.js';

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
 * Internal function to strip memory tags from content
 * Shared logic extracted from both JSON and prompt stripping functions
 */
function stripTagsInternal(content: string): string {
  // ReDoS protection: limit tag count before regex processing
  const tagCount = countTags(content);
  if (tagCount > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
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
 * Strip memory tags from JSON-serialized content (tool inputs/responses)
 *
 * @param content - Stringified JSON content from tool_input or tool_response
 * @returns Cleaned content with tags removed, or '{}' if invalid
 */
export function stripMemoryTagsFromJson(content: string): string {
  return stripTagsInternal(content);
}

/**
 * Strip memory tags from user prompt content
 *
 * @param content - Raw user prompt text
 * @returns Cleaned content with tags removed
 */
export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTagsInternal(content);
}

/**
 * Internal agent output markers that should never appear in user-facing output.
 * These are headers and prompts used by the memory agent's internal processing.
 * If they leak into context injection or hook output, they confuse users (#784).
 */
const INTERNAL_AGENT_MARKERS = [
  /MEMORY PROCESSING START\n?=+/g,
  /MEMORY PROCESSING CONTINUED\n?=+/g,
  /PROGRESS SUMMARY CHECKPOINT\n?=+/g,
  /Hello memory agent, you are continuing to observe the primary Claude session\./g,
  /IMPORTANT: Continue generating observations from tool use messages using the XML structure below\./g,
  /You are a Claude-Mem, a specialized observer tool[\s\S]*?(?=\n\n|\n[A-Z]|$)/g,
  /No observation to record at this time\.?/g,
  /<observation>[\s\S]*?<\/observation>/g,
  /<summary>[\s\S]*?<\/summary>/g,
];

/**
 * Strip internal memory agent markers from output text.
 * Prevents agent system prompts, processing headers, and raw XML responses
 * from leaking into user-visible hook output (fixes #784).
 *
 * @param content - Text that may contain internal agent output
 * @returns Cleaned text with internal markers removed
 */
export function stripInternalAgentMarkers(content: string): string {
  let cleaned = content;
  for (const pattern of INTERNAL_AGENT_MARKERS) {
    cleaned = cleaned.replace(pattern, '');
  }
  // Collapse multiple blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

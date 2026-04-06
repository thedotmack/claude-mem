/**
 * Shared context injection utilities for claude-mem.
 *
 * Provides tag constants and a function to inject or update a
 * <claude-mem-context> section in any markdown file. Used by
 * MCP integrations and OpenCode installer.
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

// ============================================================================
// Tag Constants
// ============================================================================

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

// ============================================================================
// Context Injection
// ============================================================================

/**
 * Inject or update a <claude-mem-context> section in a markdown file.
 * Creates the file if it doesn't exist. Preserves content outside the tags.
 *
 * @param filePath - Absolute path to the target markdown file.
 * @param contextContent - The content to place between the context tags.
 * @param headerLine - Optional first line written when creating a new file
 *                     (e.g. `"# Claude-Mem Memory Context"` for AGENTS.md).
 */
export function injectContextIntoMarkdownFile(
  filePath: string,
  contextContent: string,
  headerLine?: string,
): void {
  const parentDirectory = path.dirname(filePath);
  mkdirSync(parentDirectory, { recursive: true });

  const wrappedContent = `${CONTEXT_TAG_OPEN}\n${contextContent}\n${CONTEXT_TAG_CLOSE}`;

  if (existsSync(filePath)) {
    let existingContent = readFileSync(filePath, 'utf-8');

    const tagStartIndex = existingContent.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = existingContent.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      // Replace existing section
      existingContent =
        existingContent.slice(0, tagStartIndex) +
        wrappedContent +
        existingContent.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length);
    } else {
      // Append section
      existingContent = existingContent.trimEnd() + '\n\n' + wrappedContent + '\n';
    }

    writeFileSync(filePath, existingContent, 'utf-8');
  } else {
    // Create new file
    if (headerLine) {
      writeFileSync(filePath, `${headerLine}\n\n${wrappedContent}\n`, 'utf-8');
    } else {
      writeFileSync(filePath, wrappedContent + '\n', 'utf-8');
    }
  }
}

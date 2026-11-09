import { findTextBlock } from '../services/wire-gateway/library/text-block.js';

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

/**
 * Where the managed context block sits in `content`, from its opening tag
 * through its closing tag, or null when there is no complete block. One
 * finder for every marker block (wire-gateway/library/text-block.ts): each
 * tag sits on its own line, inline examples and fenced code belong to the
 * user, and a real closing tag pairs with its nearest real opening tag, so a
 * stray close or dangling open can't swallow the user's text. Writing the
 * block into an agent's instruction file is the Library's (contextBlockItem).
 */
export function findContextBlockRange(content: string): { start: number; end: number } | null {
  return findTextBlock(content, CONTEXT_TAG_OPEN, CONTEXT_TAG_CLOSE);
}

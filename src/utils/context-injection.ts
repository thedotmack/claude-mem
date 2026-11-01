
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { toBmpSafe } from './bmp-safe.js';

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

/**
 * Where the managed context block sits in `content`, from its opening tag
 * through its closing tag, or null when there is no complete block.
 *
 * The closing tag is the first one after an opening tag, so a stray closing
 * tag earlier in the file (a tag mentioned in prose) is never taken for the end
 * of the block. Taking it duplicated the text between it and the block and left
 * the old block in place, on every refresh. The opening tag is the nearest one
 * before that closing tag, so a dangling opening tag earlier in the file can't
 * swallow the user's text between it and the block.
 */
export function findContextBlockRange(content: string): { start: number; end: number } | null {
  const firstOpen = content.indexOf(CONTEXT_TAG_OPEN);
  if (firstOpen === -1) return null;
  const close = content.indexOf(CONTEXT_TAG_CLOSE, firstOpen + CONTEXT_TAG_OPEN.length);
  if (close === -1) return null;
  return { start: content.lastIndexOf(CONTEXT_TAG_OPEN, close), end: close + CONTEXT_TAG_CLOSE.length };
}

export function injectContextIntoMarkdownFile(
  filePath: string,
  contextContent: string,
  headerLine?: string,
): void {
  const parentDirectory = path.dirname(filePath);
  mkdirSync(parentDirectory, { recursive: true });

  // #2787: strip astral (surrogate-pair) code points so a Claude Code context
  // truncation can't split a pair into a lone surrogate and brick the session.
  const wrappedContent = `${CONTEXT_TAG_OPEN}\n${toBmpSafe(contextContent)}\n${CONTEXT_TAG_CLOSE}`;

  if (existsSync(filePath)) {
    let existingContent = readFileSync(filePath, 'utf-8');

    const block = findContextBlockRange(existingContent);

    if (block) {
      existingContent =
        existingContent.slice(0, block.start) +
        wrappedContent +
        existingContent.slice(block.end);
    } else {
      existingContent = existingContent.trimEnd() + '\n\n' + wrappedContent + '\n';
    }

    writeFileSync(filePath, existingContent, 'utf-8');
  } else {
    if (headerLine) {
      writeFileSync(filePath, `${headerLine}\n\n${wrappedContent}\n`, 'utf-8');
    } else {
      writeFileSync(filePath, wrappedContent + '\n', 'utf-8');
    }
  }
}

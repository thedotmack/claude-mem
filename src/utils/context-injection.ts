
import path from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { toBmpSafe } from './bmp-safe.js';

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

/**
 * Replace (or append) the <claude-mem-context> block in a markdown file.
 *
 * Single shared implementation for CLAUDE.md folder indexes, AGENTS.md
 * mirrors, and integration context files:
 *   - never writes inside a .git directory (issue #1165)
 *   - creates the parent directory when missing
 *   - strips astral (surrogate-pair) code points (#2787: a Claude Code
 *     truncation can split a pair and brick the session)
 *   - writes via tmp file + atomic rename
 *   - for a brand-new file, prefixes the optional `header` line
 */
export function writeTaggedBlock(filePath: string, body: string, header?: string): void {
  const resolvedPath = path.resolve(filePath);
  if (
    resolvedPath.includes('/.git/') || resolvedPath.includes('\\.git\\') ||
    resolvedPath.endsWith('/.git') || resolvedPath.endsWith('\\.git')
  ) return;

  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const block = `${CONTEXT_TAG_OPEN}\n${toBmpSafe(body)}\n${CONTEXT_TAG_CLOSE}`;

  let finalContent: string;
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf-8');
    const tagStartIndex = existingContent.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = existingContent.indexOf(CONTEXT_TAG_CLOSE);
    finalContent = tagStartIndex !== -1 && tagEndIndex !== -1
      ? existingContent.slice(0, tagStartIndex) + block + existingContent.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length)
      : existingContent.trimEnd() + '\n\n' + block + '\n';
  } else {
    finalContent = header ? `${header}\n\n${block}\n` : block + '\n';
  }

  const tempFile = `${filePath}.tmp`;
  writeFileSync(tempFile, finalContent, 'utf-8');
  renameSync(tempFile, filePath);
}

// Legacy name kept for existing callers (integration installers).
export const injectContextIntoMarkdownFile = writeTaggedBlock;

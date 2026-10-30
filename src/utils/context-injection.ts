
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { toBmpSafe } from './bmp-safe.js';

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

/**
 * Where the managed context block sits in `content`, from its opening tag
 * through its closing tag, or null when there is no complete block.
 *
 * Writers put each delimiter on its own line. Inline examples and fenced code
 * belong to the user, even when they contain a balanced pair of marker names.
 * Pair a real closing delimiter with its nearest real opening delimiter, so an
 * earlier stray close or dangling open cannot swallow the user's instructions.
 */
export function findContextBlockRange(content: string): { start: number; end: number } | null {
  let offset = 0;
  let opening = -1;
  let fence: { character: string; length: number; indent: number } | null = null;
  const listIndents: number[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    let tabPadding = 0;
    const expanded = line.replace(/\t/g, (_tab, index: number) => {
      const width = 4 - (index + tabPadding) % 4;
      tabPadding += width - 1;
      return ' '.repeat(width);
    });
    const leading = /^ */.exec(expanded)![0].length;
    const nonblank = /[^ ]/.test(expanded);
    if (fence && nonblank && leading < fence.indent) fence = null;
    if (!fence && nonblank) {
      while (listIndents.length && leading < listIndents[listIndents.length - 1]) listIndents.pop();
    }
    let indent: number = fence?.indent ?? listIndents[listIndents.length - 1] ?? 0;
    let containerLine = expanded.slice(indent);
    if (!fence && opening === -1) {
      let item: RegExpExecArray | null;
      while ((item = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])( +)(?=\S)/.exec(containerLine))) {
        const padding = item[1].length > 4 ? 1 : item[1].length;
        indent += item[0].length - item[1].length + padding;
        listIndents.push(indent);
        containerLine = expanded.slice(indent);
      }
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(containerLine);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length && /^[ \t]*$/.test(delimiter[2])) {
        fence = null;
      }
    // Fences inside managed memory are payload, even when a recalled snippet
    // ends before its closing fence. They cannot hide the managed closing tag.
    } else if (opening === -1 && delimiter &&
               !(delimiter[1][0] === '`' && delimiter[2].includes('`'))) {
      fence = { character: delimiter[1][0], length: delimiter[1].length, indent };
    } else if (line === CONTEXT_TAG_OPEN) {
      opening = offset;
    } else if (line === CONTEXT_TAG_CLOSE && opening !== -1) {
      return { start: opening, end: offset + CONTEXT_TAG_CLOSE.length };
    }
    offset += rawLine.length + 1;
  }
  return null;
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

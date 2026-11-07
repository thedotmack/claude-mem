
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
 *
 * A delimiter line may carry a leading BOM (first line only), up to three spaces
 * of indent and trailing spaces or tabs, because hand edits and other tools leave
 * those behind. The range starts at the tag itself, so a replacement keeps them.
 * Both tags on one line are out of scope: no writer produces that form, and it
 * reads the same as an authored example.
 *
 * A fence that never closes must not hide the block: a hidden block makes every
 * refresh append another one. When a scan ends inside a fence without finding a
 * block, that opening line is treated as plain text and the scan runs again.
 */
export function findContextBlockRange(content: string): { start: number; end: number } | null {
  const unterminatedFenceLines = new Set<number>();
  while (true) {
    const { block, openFenceLine } = scanForContextBlock(content, unterminatedFenceLines);
    if (block || openFenceLine === null) return block;
    unterminatedFenceLines.add(openFenceLine);
  }
}

function scanForContextBlock(
  content: string,
  unterminatedFenceLines: ReadonlySet<number>,
): { block: { start: number; end: number } | null; openFenceLine: number | null } {
  let offset = 0;
  let opening = -1;
  let fence: { character: string; length: number; indent: number; lineNumber: number } | null = null;
  const listIndents: number[] = [];
  const thematicBreak = /^ {0,3}([-*_])(?: *\1){2,} *$/;

  for (const [lineNumber, rawLine] of content.split('\n').entries()) {
    const bomLength = lineNumber === 0 && rawLine.startsWith('﻿') ? 1 : 0;
    const line = rawLine.slice(bomLength).replace(/\r$/, '');
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
      while (!thematicBreak.test(containerLine) &&
             (item = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])( +)(?=\S)/.exec(containerLine))) {
        const padding = item[1].length > 4 ? 1 : item[1].length;
        indent += item[0].length - item[1].length + padding;
        listIndents.push(indent);
        containerLine = expanded.slice(indent);
      }
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(containerLine);
    const tagLine = /^( {0,3})(\S+)[ \t]*$/.exec(line);
    const tagOffset = offset + bomLength + (tagLine?.[1].length ?? 0);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length && /^[ \t]*$/.test(delimiter[2])) {
        fence = null;
      }
    // Fences inside managed memory are payload, even when a recalled snippet
    // ends before its closing fence. They cannot hide the managed closing tag.
    } else if (opening === -1 && delimiter && !unterminatedFenceLines.has(lineNumber) &&
               !(delimiter[1][0] === '`' && delimiter[2].includes('`'))) {
      fence = { character: delimiter[1][0], length: delimiter[1].length, indent, lineNumber };
    } else if (tagLine?.[2] === CONTEXT_TAG_OPEN) {
      opening = tagOffset;
    } else if (tagLine?.[2] === CONTEXT_TAG_CLOSE && opening !== -1) {
      return { block: { start: opening, end: tagOffset + CONTEXT_TAG_CLOSE.length }, openFenceLine: null };
    }
    offset += rawLine.length + 1;
  }
  return { block: null, openFenceLine: fence?.lineNumber ?? null };
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

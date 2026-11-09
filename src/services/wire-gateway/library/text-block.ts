// SPDX-License-Identifier: Apache-2.0
//
// Marker-delimited blocks in text files (plan Phase 14 task 1,
// `instructions`): claude-mem's `<claude-mem-context>` blocks in Markdown
// instruction files and Kimi's managed `[[hooks]]` block in its TOML config.
// One place finds, writes and removes them; before the Library every
// installer had its own (utils/context-injection.ts, KimiHooksInstaller,
// AntigravityCliHooksInstaller, CodexCliInstaller, OpenCodeInstaller).
// magpie's own block is the same idea (internal/library/instructions.go:
// 169-222, `withBlock`), MIT, Copyright (c) 2026 yetone.

import type { TextBlockPlacement } from './types.js';

export interface TextBlockRange {
  start: number;
  end: number;
}

/**
 * Where the block sits, from its opening marker through its closing marker,
 * or null when there is no complete block.
 *
 * Writers put each marker on its own line. Inline examples and fenced code
 * belong to the user, even when they contain a balanced pair of markers
 * (#5203). A real closing marker pairs with its nearest real opening marker,
 * so an earlier stray close or dangling open cannot swallow the user's text.
 *
 * A marker line may carry a leading BOM (first line only), up to three spaces
 * of indent and trailing spaces or tabs, because hand edits and other tools
 * leave those behind. The range starts at the marker itself, so a replacement
 * keeps them. Both markers on one line are out of scope: no writer produces
 * that form, and it reads the same as an authored example.
 *
 * A fence that never closes must not hide the block: a hidden block makes
 * every refresh append another one. When a scan ends inside a fence without
 * finding a block, that opening line is treated as plain text and the scan
 * runs again.
 */
export function findTextBlock(text: string, open: string, close: string): TextBlockRange | null {
  const unterminatedFenceLines = new Set<number>();
  while (true) {
    const { block, openFenceLine } = scanForTextBlock(text, open, close, unterminatedFenceLines);
    if (block || openFenceLine === null) return block;
    unterminatedFenceLines.add(openFenceLine);
  }
}

function scanForTextBlock(
  text: string,
  open: string,
  close: string,
  unterminatedFenceLines: ReadonlySet<number>,
): { block: TextBlockRange | null; openFenceLine: number | null } {
  let offset = 0;
  let opening = -1;
  let fence: { character: string; length: number; indent: number; lineNumber: number } | null = null;
  const listIndents: number[] = [];
  const thematicBreak = /^ {0,3}([-*_])(?: *\1){2,} *$/;

  for (const [lineNumber, rawLine] of text.split('\n').entries()) {
    const bomLength = lineNumber === 0 && rawLine.startsWith('\uFEFF') ? 1 : 0;
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
    const markerLine = /^( {0,3})(\S(?:.*\S)?)[ \t]*$/.exec(line);
    const markerOffset = offset + bomLength + (markerLine?.[1].length ?? 0);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length && /^[ \t]*$/.test(delimiter[2])) {
        fence = null;
      }
    // Fences inside the managed block are payload, even when a recalled
    // snippet ends before its closing fence. They cannot hide the closing marker.
    } else if (opening === -1 && delimiter && !unterminatedFenceLines.has(lineNumber) &&
               !(delimiter[1][0] === '`' && delimiter[2].includes('`'))) {
      fence = { character: delimiter[1][0], length: delimiter[1].length, indent, lineNumber };
    } else if (markerLine?.[2] === open) {
      opening = markerOffset;
    } else if (markerLine?.[2] === close && opening !== -1) {
      return { block: { start: opening, end: markerOffset + close.length }, openFenceLine: null };
    }
    offset += rawLine.length + 1;
  }
  return { block: null, openFenceLine: fence?.lineNumber ?? null };
}

export function renderTextBlock(open: string, body: string, close: string): string {
  return `${open}\n${body}\n${close}`;
}

/** The body between the markers of a block found by findTextBlock. */
export function textBlockBody(text: string, range: TextBlockRange, open: string, close: string): string {
  const inner = text.slice(range.start + open.length, range.end - close.length);
  return inner.replace(/^\n/, '').replace(/\n$/, '');
}

/**
 * `text` with the block in it: a block already there is replaced in place;
 * otherwise the block is added by `placement`. An empty `text` with
 * `headerLineForNewFile` starts with that header and a blank line.
 */
export function upsertTextBlock(
  text: string | null,
  open: string,
  close: string,
  body: string,
  placement: TextBlockPlacement,
  headerLineForNewFile?: string,
): string {
  const block = renderTextBlock(open, body, close);
  if (text === null) {
    if (placement === 'after-trimmed-text' && headerLineForNewFile) return `${headerLineForNewFile}\n\n${block}\n`;
    return `${block}\n`;
  }
  if (placement === 'once-after-blank-line' && text.includes(open)) return text;
  const range = findTextBlock(text, open, close);
  if (range) return text.slice(0, range.start) + block + text.slice(range.end);
  if (placement === 'after-trimmed-text') return `${text.trimEnd()}\n\n${block}\n`;
  const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  if (placement === 'once-after-blank-line') {
    // GEMINI.md's own rule: one newline after text that ends in one, a blank line after text that does not.
    const geminiSeparator = text.length > 0 && !text.endsWith('\n') ? '\n\n' : text.length > 0 ? '\n' : '';
    return `${text}${geminiSeparator}${block}\n`;
  }
  return `${text}${separator}${block}\n`;
}

/**
 * `text` without the block: the line breaks around it are taken in, and the
 * text before and after is joined by one blank line (or `join`). A file
 * left with nothing returns ''.
 */
export function removeTextBlock(text: string, range: TextBlockRange, join: '\n' | '\n\n' = '\n\n'): string {
  const prefix = text.slice(0, range.start).replace(/\n+$/, '');
  const suffix = text.slice(range.end).replace(/^\n+/, '');
  if (prefix.length === 0) return suffix;
  if (suffix.length === 0) return `${prefix}\n`;
  return `${prefix}${join}${suffix}`;
}

/**
 * Strip a context block claude-mem wrote into an agent's AGENTS.md before its
 * native integration injected memory itself (Codex, OpenCode). The text
 * around it is trimmed and joined by `join`; returns the remaining text,
 * trimmed, or null when there is no block.
 */
export function stripLegacyContextBlock(text: string, open: string, close: string, join: '\n' | '\n\n'): string | null {
  const range = findTextBlock(text, open, close);
  if (!range) return null;
  const before = join === '\n' ? text.slice(0, range.start).trimEnd() : text.slice(0, range.start).replace(/\n+$/, '');
  const after = join === '\n' ? text.slice(range.end).trimStart() : text.slice(range.end).replace(/^\n+/, '');
  if (join === '\n') return `${before}\n${after}`.trim();
  return (before + (after ? `\n\n${after}` : '')).trim();
}

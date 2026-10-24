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
 * or null when there is no complete block. The closing marker is the first
 * one after an opening marker, so a stray closing marker earlier in the file
 * (one mentioned in prose) is never taken for the end; the opening marker is
 * the nearest one before that closing marker, so a dangling opening marker
 * earlier in the file cannot swallow the user's text between it and the block.
 */
export function findTextBlock(text: string, open: string, close: string): TextBlockRange | null {
  const firstOpen = text.indexOf(open);
  if (firstOpen === -1) return null;
  const closeAt = text.indexOf(close, firstOpen + open.length);
  if (closeAt === -1) return null;
  return { start: text.lastIndexOf(open, closeAt), end: closeAt + close.length };
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

// SPDX-License-Identifier: Apache-2.0
//
// A dotenv editor (plan Phase 7 task 6), ported from magpie
// internal/edit/env.go and text.go (MIT, Copyright (c) 2026 yetone): a set
// rewrites only its own line (the last one for a key set twice, which is the
// one dotenv readers use) or adds one after the last assignment; a delete
// drops every line for the key. Every other line is kept byte for byte. A
// quoted value may run over several lines (dotenv reads `NOTE="a\nb"` as one
// value); its lines are one assignment, never assignments of their own.

import { decodeConfigText, editConfigTextPreservingShape } from './text-shape.js';

/**
 * magpie's `^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$`
 * without its `(.*?)\s*$` tail: a lazy group followed by `\s*$` backtracks
 * quadratically over a long run of spaces inside a value (a 1 MB line took
 * minutes). The value is everything after `=`, trimmed in code instead.
 */
const ENV_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/;

interface EnvAssignment {
  key: string;
  rawValue: string;
}

function parseEnvAssignment(line: string): EnvAssignment | null {
  const match = ENV_ASSIGNMENT_PATTERN.exec(line);
  if (!match) return null;
  return { key: match[1], rawValue: line.slice(match[0].length).trim() };
}

/** One assignment: its key and the lines it spans (several for a quoted value that runs over lines). */
interface EnvAssignmentSpan {
  key: string;
  rawValue: string;
  firstLineIndex: number;
  lastLineIndex: number;
}

const ENV_QUOTES = ['"', "'", '`'];

/** Index past the quote closing a value opened by `quote`, searching `line` from `from`, or -1. Only `"` has escapes. */
function closingQuoteEnd(line: string, from: number, quote: string): number {
  for (let index = from; index < line.length; index++) {
    if (quote === '"' && line[index] === '\\') {
      index++;
      continue;
    }
    if (line[index] === quote) return index + 1;
  }
  return -1;
}

/**
 * Every assignment, in order, in one linear pass. A value whose opening
 * quote is not closed on its line takes the following lines up to the one
 * that closes it; an unclosed quote is a one-line value (as dotenv reads it).
 * Once a quote kind finds no closer to the end of the text, later unclosed
 * values of that kind are one-line values without searching again, so many
 * unclosed quotes stay linear.
 */
function scanEnvAssignments(lines: string[]): EnvAssignmentSpan[] {
  const assignments: EnvAssignmentSpan[] = [];
  const quotesWithNoCloserAhead = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const assignment = parseEnvAssignment(lines[index]);
    if (!assignment) continue;
    const span: EnvAssignmentSpan = { key: assignment.key, rawValue: assignment.rawValue, firstLineIndex: index, lastLineIndex: index };
    const quote = assignment.rawValue[0];
    if (ENV_QUOTES.includes(quote) && !quotesWithNoCloserAhead.has(quote) && closingQuoteEnd(assignment.rawValue, 1, quote) === -1) {
      let closingLineIndex = -1;
      for (let later = index + 1; later < lines.length; later++) {
        if (closingQuoteEnd(lines[later], 0, quote) !== -1) {
          closingLineIndex = later;
          break;
        }
      }
      if (closingLineIndex === -1) {
        quotesWithNoCloserAhead.add(quote);
      } else {
        const valueLines = [assignment.rawValue, ...lines.slice(index + 1, closingLineIndex + 1)];
        span.rawValue = valueLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).join('\n').trim();
        span.lastLineIndex = closingLineIndex;
        index = closingLineIndex;
      }
    }
    assignments.push(span);
  }
  return assignments;
}

/** A leading quoted value, unquoted (anything after it, such as a comment, dropped); null when it is not quoted. */
function unquoteEnvValue(rawValue: string): string | null {
  const quote = rawValue[0];
  if (quote !== '"' && quote !== "'") return null;
  for (let index = 1; index < rawValue.length; index++) {
    if (quote === '"' && rawValue[index] === '\\') {
      index++;
      continue;
    }
    if (rawValue[index] === quote) {
      const inner = rawValue.slice(1, index);
      if (quote === "'") return inner;
      try {
        return JSON.parse(`"${inner}"`) as string;
      } catch {
        return inner;
      }
    }
  }
  return rawValue.slice(1);
}

/** The value a dotenv reader sees for `key` (the last assignment wins), or undefined. */
export function readEnvValue(configBytes: Uint8Array, key: string): string | undefined {
  const assignments = scanEnvAssignments(decodeConfigText(configBytes).split('\n'));
  for (let index = assignments.length - 1; index >= 0; index--) {
    const assignment = assignments[index];
    if (assignment.key !== key) continue;
    const unquoted = unquoteEnvValue(assignment.rawValue);
    if (unquoted !== null) return unquoted;
    const commentStart = assignment.rawValue.indexOf('#');
    return commentStart === -1 ? assignment.rawValue : assignment.rawValue.slice(0, commentStart).trim();
  }
  return undefined;
}

/** A value as dotenv text: bare when safe, else single- or double-quoted (Gemini CLI keeps backslashes literal in single quotes). */
function renderEnvValue(key: string, value: string): string {
  if (value.includes('\n') || value.includes('\r')) throw new Error(`${key}: a .env value cannot hold a line break here`);
  if (![' ', '#', '"', "'", '$', '\t'].some((special) => value.includes(special))) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function assertEnvKey(key: string): void {
  if (!/^[A-Za-z_]\w*$/.test(key)) throw new Error(`"${key}" is not a .env key`);
}

export interface EnvPatch {
  set?: Array<{ key: string; value: string }>;
  delete?: string[];
}

/**
 * Apply sets, then deletes, to a .env file and return its new bytes. A file
 * that does not end in a line break gets none added, so a set followed by a
 * delete of the same new key gives back the original bytes.
 */
export function patchEnvDocument(originalBytes: Uint8Array, patch: EnvPatch): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    let lines = text.split('\n');
    for (const { key, value } of patch.set ?? []) {
      assertEnvKey(key);
      const newLine = `${key}=${renderEnvValue(key, value)}`;
      const assignments = scanEnvAssignments(lines);
      const sameKey = assignments.filter((assignment) => assignment.key === key).pop();
      if (sameKey) {
        lines = [...lines.slice(0, sameKey.firstLineIndex), newLine, ...lines.slice(sameKey.lastLineIndex + 1)];
        continue;
      }
      // After a last line with no line break, the new line becomes the last one.
      const insertAt = assignments.length > 0 ? assignments[assignments.length - 1].lastLineIndex + 1 : 0;
      lines = [...lines.slice(0, insertAt), newLine, ...lines.slice(insertAt)];
    }
    for (const key of patch.delete ?? []) {
      assertEnvKey(key);
      const deletedLineIndexes = new Set<number>();
      for (const assignment of scanEnvAssignments(lines)) {
        if (assignment.key !== key) continue;
        for (let index = assignment.firstLineIndex; index <= assignment.lastLineIndex; index++) deletedLineIndexes.add(index);
      }
      lines = lines.filter((_, index) => !deletedLineIndexes.has(index));
    }
    return lines.join('\n');
  });
}

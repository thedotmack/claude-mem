// SPDX-License-Identifier: Apache-2.0
//
// The line diff `claude-mem wire preview` prints (plan Phase 8 task 4).
// Ported from magpie internal/agent/preview.go:301-450 `diffLines`,
// `sameLines`, `lineKey`, `mask` (MIT, Copyright (c) 2026 yetone):
//
//   - common leading and trailing lines are dropped first;
//   - the middle is diffed with Myers, capped at 4,000 edits, then a greedy
//     in-order match while the product of the sides is ≤ 50e6;
//   - an added line pairs with a removed line of the same key and indent as
//     `~ new (was old)`; the rest are `+` and `-`;
//   - a value whose key names a secret (key, token, secret, password, auth;
//     not *TOKENS) is shown as ••••.

import { trimCharacters } from '../edit/text-shape.js';

export interface ConfigDiffLine {
  op: '~' | '+' | '-';
  text: string;
  /** For `~`: the line it replaced. */
  was?: string;
}

const MAX_MYERS_EDITS = 4000;
const MAX_GREEDY_PRODUCT = 50_000_000;

function splitDiffLines(text: string): string[] {
  if (text === '') return [];
  const normalized = trimCharacters(text.replace(/\r\n/g, '\n'), '\n', 'end');
  return normalized === '' ? [] : normalized.split('\n');
}

/**
 * Myers' shortest edit script; marks the lines both sides keep. Returns null
 * past `maxEdits`. Each round's frontier is saved (only the 2d+3 diagonals it
 * can reach) for the walk back.
 */
function myersKeptLines(left: string[], right: string[], maxEdits: number): { keptLeft: boolean[]; keptRight: boolean[] } | null {
  const leftLength = left.length;
  const rightLength = right.length;
  const most = Math.min(leftLength + rightLength, maxEdits);
  const offset = most + 1;
  const frontier = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let edits = 0; edits <= most; edits++) {
    trace.push(frontier.slice(offset - edits - 1, offset + edits + 2));
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      let x = diagonal === -edits || (diagonal !== edits && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
        ? frontier[offset + diagonal + 1]
        : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < leftLength && y < rightLength && left[x] === right[y]) {
        x++;
        y++;
      }
      frontier[offset + diagonal] = x;
      if (x >= leftLength && y >= rightLength) return walkBack(trace, leftLength, rightLength);
    }
  }
  return null;
}

function walkBack(trace: Int32Array[], leftLength: number, rightLength: number): { keptLeft: boolean[]; keptRight: boolean[] } {
  const keptLeft = new Array<boolean>(leftLength).fill(false);
  const keptRight = new Array<boolean>(rightLength).fill(false);
  let x = leftLength;
  let y = rightLength;
  for (let edits = trace.length - 1; edits >= 0; edits--) {
    const saved = trace[edits];
    const at = (diagonal: number) => saved[diagonal + edits + 1];
    const diagonal = x - y;
    const previousDiagonal = diagonal === -edits || (diagonal !== edits && at(diagonal - 1) < at(diagonal + 1)) ? diagonal + 1 : diagonal - 1;
    const previousX = edits === 0 ? 0 : at(previousDiagonal);
    const previousY = edits === 0 ? 0 : previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      keptLeft[x - 1] = true;
      keptRight[y - 1] = true;
      x--;
      y--;
    }
    x = previousX;
    y = previousY;
  }
  return { keptLeft, keptRight };
}

/** Each right line takes the next equal left line after the last match. */
function greedyKeptLines(left: string[], right: string[]): { keptLeft: boolean[]; keptRight: boolean[] } {
  const keptLeft = new Array<boolean>(left.length).fill(false);
  const keptRight = new Array<boolean>(right.length).fill(false);
  let nextLeft = 0;
  right.forEach((line, rightIndex) => {
    for (let leftIndex = nextLeft; leftIndex < left.length; leftIndex++) {
      if (left[leftIndex] !== line) continue;
      keptLeft[leftIndex] = true;
      keptRight[rightIndex] = true;
      nextLeft = leftIndex + 1;
      return;
    }
  });
  return { keptLeft, keptRight };
}

// `  "name": …`, `export NAME=…`, `name = …`, `name: …`. Linear: each
// quantified part is followed by a character it cannot match.
const LINE_KEY_PATTERN = /^\s*(?:export\s+)?"?([A-Za-z0-9_.-]+)"?\s*[:=]/;
const SECRET_NAME_PATTERN = /key|token|secret|password|auth/i;
const LEADING_WHITESPACE_PATTERN = /^[ \t]*/;

function lineKey(line: string): string {
  const match = LINE_KEY_PATTERN.exec(line);
  if (match) return match[1];
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed : '';
}

function indentOf(line: string): string {
  return LEADING_WHITESPACE_PATTERN.exec(line)![0];
}

/** A secret-named key's value as ••••; anything else unchanged. */
export function maskSecretLine(line: string): string {
  const key = lineKey(line);
  if (!key || !SECRET_NAME_PATTERN.test(key) || key.toUpperCase().endsWith('TOKENS')) return line;
  const match = LINE_KEY_PATTERN.exec(line);
  if (!match) return line;
  const bareValue = trimCharacters(line.slice(match[0].length).trim(), '"\', ');
  if (bareValue === '' || bareValue.startsWith('{') || bareValue.startsWith('$')) return line;
  return `${line.slice(0, match[0].length)} ••••`;
}

function isStructuralOnly(line: string): boolean {
  return trimCharacters(line.trim(), '{}[](),') === '';
}

/** The changed lines between two texts, `~`/`+` in new-file order, then `-`. Secrets are masked. */
export function diffConfigLines(beforeText: string, afterText: string): ConfigDiffLine[] {
  const before = splitDiffLines(beforeText);
  const after = splitDiffLines(afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);

  const kept = myersKeptLines(middleBefore, middleAfter, MAX_MYERS_EDITS)
    ?? (middleBefore.length * middleAfter.length <= MAX_GREEDY_PRODUCT
      ? greedyKeptLines(middleBefore, middleAfter)
      : { keptLeft: new Array<boolean>(middleBefore.length).fill(false), keptRight: new Array<boolean>(middleAfter.length).fill(false) });

  const output: ConfigDiffLine[] = [];
  let gone: string[] = [];
  let came: string[] = [];
  const flush = () => {
    for (const line of came) {
      const key = lineKey(line);
      const pairIndex = key ? gone.findIndex((removed) => lineKey(removed) === key && indentOf(removed) === indentOf(line)) : -1;
      if (pairIndex === -1) {
        output.push({ op: '+', text: maskSecretLine(line) });
      } else {
        output.push({ op: '~', text: maskSecretLine(line), was: maskSecretLine(gone[pairIndex]) });
        gone.splice(pairIndex, 1);
      }
    }
    for (const line of gone) output.push({ op: '-', text: maskSecretLine(line) });
    gone = [];
    came = [];
  };
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < middleBefore.length || rightIndex < middleAfter.length) {
    if (leftIndex < middleBefore.length && !kept.keptLeft[leftIndex]) {
      if (middleBefore[leftIndex].trim() !== '') gone.push(middleBefore[leftIndex]);
      leftIndex++;
    } else if (rightIndex < middleAfter.length && !kept.keptRight[rightIndex]) {
      if (middleAfter[rightIndex].trim() !== '') came.push(middleAfter[rightIndex]);
      rightIndex++;
    } else {
      flush();
      leftIndex++;
      rightIndex++;
    }
  }
  flush();
  return output.filter((line) => !isStructuralOnly(line.text));
}

export function formatConfigDiffLine(line: ConfigDiffLine): string {
  return line.op === '~' ? `~ ${line.text}   (was ${line.was!.trim()})` : `${line.op} ${line.text}`;
}

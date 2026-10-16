// SPDX-License-Identifier: Apache-2.0
//
// Where one SSE event of a relayed reply ends, and which of its lines holds
// the JSON, so a reply can be rewritten event by event with every other byte
// kept (magpie `eventEnd` and `splitEvent`, internal/middleware/run.go:353-404,
// MIT, Copyright (c) 2026 yetone). Shared by the placeholder restorer
// (Phase 6) and the response rewrite stages (Phase 10).

/** Where the first complete event in `bytes` ends, and the length of the blank line that ends it (magpie `eventEnd`). */
export function findSseEventEnd(bytes: Uint8Array, scanFrom: number): { index: number; separatorLength: number } | null {
  let lfIndex = -1;
  let crlfIndex = -1;
  for (let index = scanFrom; index + 1 < bytes.length; index++) {
    if (lfIndex < 0 && bytes[index] === 0x0a && bytes[index + 1] === 0x0a) lfIndex = index;
    if (crlfIndex < 0 && index + 3 < bytes.length && bytes[index] === 0x0d && bytes[index + 1] === 0x0a && bytes[index + 2] === 0x0d && bytes[index + 3] === 0x0a) {
      crlfIndex = index;
    }
    if (lfIndex >= 0 || crlfIndex >= 0) break;
  }
  if (lfIndex < 0 && crlfIndex < 0) return null;
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) return { index: crlfIndex, separatorLength: 4 };
  return { index: lfIndex, separatorLength: 2 };
}

/** A line without its line ending; a loop, since `/[\r\n]+$/` costs a long run of `\r` its length squared. */
function withoutLineEnding(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === '\n' || line[end - 1] === '\r')) end--;
  return line.slice(0, end);
}

export interface SplitSseEvent {
  /** The `event:` name, '' when the event has none (Chat and Gemini events never do). */
  name: string;
  /** The JSON on the event's one data line. */
  data: string;
  /** Everything before the JSON, and everything after it, byte for byte. */
  before: string;
  after: string;
}

/**
 * The one data line of an event that has JSON in it: what comes before the
 * JSON, the JSON, and what comes after it (magpie `splitEvent`). Null for an
 * event with no such line (`data: [DONE]`, a comment, a ping without data),
 * or with data over more than one line.
 */
export function splitSseEvent(event: string): SplitSseEvent | null {
  const lines = event.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let name = '';
  let dataLineIndex = -1;
  let offset = 0;
  lines.forEach((line, index) => {
    const trimmed = withoutLineEnding(line);
    if (trimmed.startsWith('event:')) {
      name = trimmed.slice('event:'.length).trim();
    } else if (trimmed.startsWith('data:')) {
      if (dataLineIndex >= 0) dataLineIndex = -2;
      else if (dataLineIndex === -1) dataLineIndex = index;
    }
    if (dataLineIndex === -1) offset += line.length;
  });
  if (dataLineIndex < 0) return null;
  const line = withoutLineEnding(lines[dataLineIndex]);
  const dataStart = line.length > 5 && line[5] === ' ' ? 6 : 5;
  const data = line.slice(dataStart);
  if (data === '' || (data[0] !== '{' && data[0] !== '[')) return null;
  return { name, data, before: event.slice(0, offset + dataStart), after: event.slice(offset + line.length) };
}

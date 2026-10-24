// SPDX-License-Identifier: Apache-2.0
//
// A push-fed SSE reader for relayed reply copies (plan Phase 3 task 4). The
// relay hands the capture side one chunk at a time (RelayObserver
// onResponseChunk), so this is the incremental form of
// src/shared/sse-reader.ts with magpie's relay allowances
// (sse.go:13-58, sniff.go:42-98; MIT, Copyright (c) 2026 yetone):
// - CR, LF and CRLF end a line; a CRLF split across chunks is one break.
// - Comment lines (":") are skipped.
// - A data line that completes a JSON value dispatches at once: some relays
//   send one JSON event per data line with no blank line between.
// - Lines are decoded only once whole, so a UTF-8 sequence split across
//   chunks decodes the same as an unsplit one.

export interface WireSseEvent {
  /** The `event:` name, '' when the frame had none. */
  event: string;
  data: string;
}

/** One event's data bytes may not pass this; a larger event is dropped and counted. */
export const WIRE_SSE_MAX_EVENT_BYTES = 16 * 1024 * 1024;

const CR = 13;
const LF = 10;

function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export class IncrementalSseReader {
  private readonly decoder = new TextDecoder('utf-8');
  private pendingLineParts: Uint8Array[] = [];
  private pendingLineBytes = 0;
  /** The line being read had bytes, even if they were dropped with an oversized event (so it is not a blank line). */
  private pendingLineHadBytes = false;
  private skipLeadingLineFeed = false;
  private eventName = '';
  private dataLines: string[] = [];
  private eventBytes = 0;
  private droppedOversizedEvent = false;
  /** Events dropped for passing WIRE_SSE_MAX_EVENT_BYTES. */
  oversizedEventCount = 0;

  constructor(private readonly onEvent: (event: WireSseEvent) => void) {}

  push(chunk: Uint8Array): void {
    let lineStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (this.skipLeadingLineFeed) {
        this.skipLeadingLineFeed = false;
        if (byte === LF) {
          lineStart = index + 1;
          continue;
        }
      }
      if (byte !== CR && byte !== LF) continue;
      this.appendPending(chunk.subarray(lineStart, index));
      const droppedLine = this.pendingLineHadBytes && this.pendingLineBytes === 0;
      const line = this.takePendingLine();
      if (!droppedLine) this.handleLine(line);
      this.skipLeadingLineFeed = byte === CR;
      lineStart = index + 1;
    }
    if (lineStart < chunk.length) this.appendPending(chunk.slice(lineStart));
  }

  /** The body ended: a last line or event with no blank line after it is still read (magpie readSSE). */
  finish(): void {
    if (this.pendingLineBytes > 0) this.handleLine(this.takePendingLine());
    this.dispatch();
  }

  private appendPending(part: Uint8Array): void {
    if (part.length === 0) return;
    this.pendingLineHadBytes = true;
    // The rest of a dropped event's line is not kept: handleLine would ignore it.
    if (this.droppedOversizedEvent) return;
    if (this.eventBytes + this.pendingLineBytes + part.length > WIRE_SSE_MAX_EVENT_BYTES) {
      this.dropOversizedEvent();
      return;
    }
    this.pendingLineParts.push(part.slice());
    this.pendingLineBytes += part.length;
  }

  private takePendingLine(): string {
    const line = Buffer.concat(this.pendingLineParts, this.pendingLineBytes);
    this.pendingLineParts = [];
    this.pendingLineBytes = 0;
    this.pendingLineHadBytes = false;
    return this.decoder.decode(line);
  }

  private dropOversizedEvent(): void {
    if (!this.droppedOversizedEvent) this.oversizedEventCount++;
    this.droppedOversizedEvent = true;
    this.pendingLineParts = [];
    this.pendingLineBytes = 0;
    this.dataLines = [];
    this.eventBytes = 0;
  }

  private handleLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (this.droppedOversizedEvent) return;
    if (line.startsWith(':')) return;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      this.eventName = value.trim();
    } else if (field === 'data') {
      this.dataLines.push(value);
      this.eventBytes += value.length;
      if (isCompleteJson(this.dataLines.join('\n'))) this.dispatch();
    }
  }

  private dispatch(): void {
    const dropped = this.droppedOversizedEvent;
    this.droppedOversizedEvent = false;
    const hasData = this.dataLines.length > 0;
    const event: WireSseEvent = { event: this.eventName, data: this.dataLines.join('\n') };
    this.eventName = '';
    this.dataLines = [];
    this.eventBytes = 0;
    if (!dropped && hasData) this.onEvent(event);
  }
}

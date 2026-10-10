/**
 * Minimal Server-Sent Events reader over WHATWG byte streams (Bun + Node 18+,
 * no Node `stream` imports). Rules follow the xAI SDK parser:
 *   - CR, LF and CRLF all end a line (a CRLF split across chunks is one break).
 *   - Lines starting with ':' are comments: never yielded, but reported through
 *     `onActivity` so callers can treat server pings as liveness.
 *   - Fields: event / data / id. Multi-line data is joined with '\n'.
 *   - A blank line dispatches the event. A trailing event with no blank line
 *     before end-of-stream is incomplete and discarded.
 *   - One event may not exceed `maxEventBytes` (default 1 MiB) ⇒ SseEventTooLargeError.
 *   - With `terminalEventNames`, a stream that ends before one of those events
 *     arrived throws StreamEndedEarlyError instead of ending quietly.
 */

const DEFAULT_SSE_MAX_EVENT_BYTES = 1024 * 1024;

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface ReadSseEventsOptions {
  /** Called for every ':' comment line (server keep-alive pings). */
  onActivity?: () => void;
  /** Event names that mark a complete stream. Unset ⇒ any clean end is fine. */
  terminalEventNames?: readonly string[];
  maxEventBytes?: number;
}

export class SseEventTooLargeError extends Error {
  constructor(public readonly maxEventBytes: number) {
    super(`SSE event exceeded ${maxEventBytes} bytes`);
    this.name = 'SseEventTooLargeError';
  }
}

export class StreamEndedEarlyError extends Error {
  constructor(public readonly terminalEventNames: readonly string[]) {
    super(`SSE stream ended before a terminal event (${terminalEventNames.join(', ')})`);
    this.name = 'StreamEndedEarlyError';
  }
}

const CR = 13;
const LF = 10;
const COLON = 58;

/**
 * Yields a byte stream's chunks. On an early stop or a read error it cancels the
 * stream, and it always releases the reader lock, even when that cancel rejects.
 */
export async function* iterateByteStream(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): AsyncGenerator<Uint8Array> {
  if (!(source instanceof ReadableStream)) {
    yield* source;
    return;
  }
  const reader = source.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; return; }
      yield value;
    }
  } finally {
    // Consumer stopped early (break/throw): release the underlying request.
    try {
      if (!finished) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function concatBytes(parts: Uint8Array[], totalBytes: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return joined;
}

export async function* readSseEvents(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: ReadSseEventsOptions = {}
): AsyncGenerator<SseEvent> {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_SSE_MAX_EVENT_BYTES;
  const decoder = new TextDecoder();
  let pendingLineParts: Uint8Array[] = [];
  let pendingLineBytes = 0;
  let skipLeadingLF = false;
  let eventBytes = 0;
  let eventName: string | null = null;
  let eventId: string | undefined;
  let dataLines: string[] | null = null;
  let sawTerminalEvent = false;

  const assertWithinCap = (extraBytes: number) => {
    if (eventBytes + extraBytes > maxEventBytes) throw new SseEventTooLargeError(maxEventBytes);
  };

  /** Returns a dispatched event on a blank line, otherwise null. */
  const handleLine = (lineBytes: Uint8Array): SseEvent | null => {
    if (lineBytes.length === 0) {
      const hasEvent = eventName !== null || dataLines !== null;
      const dispatched: SseEvent | null = hasEvent
        ? { event: eventName ?? 'message', data: (dataLines ?? []).join('\n'), ...(eventId !== undefined ? { id: eventId } : {}) }
        : null;
      eventName = null; eventId = undefined; dataLines = null; eventBytes = 0;
      return dispatched;
    }
    if (lineBytes[0] === COLON) {
      options.onActivity?.();
      return null;
    }
    assertWithinCap(lineBytes.length);
    eventBytes += lineBytes.length;
    const line = decoder.decode(lineBytes);
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') (dataLines ??= []).push(value);
    else if (field === 'id') eventId = value;
    return null;
  };

  for await (const chunk of iterateByteStream(source)) {
    let lineStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (skipLeadingLF) {
        skipLeadingLF = false;
        if (byte === LF) { lineStart = index + 1; continue; }
      }
      if (byte !== CR && byte !== LF) continue;
      pendingLineParts.push(chunk.subarray(lineStart, index));
      const lineBytes = concatBytes(pendingLineParts, pendingLineBytes + (index - lineStart));
      pendingLineParts = [];
      pendingLineBytes = 0;
      const dispatched = handleLine(lineBytes);
      if (dispatched) {
        if (options.terminalEventNames?.includes(dispatched.event)) sawTerminalEvent = true;
        yield dispatched;
      }
      skipLeadingLF = byte === CR;
      lineStart = index + 1;
    }
    if (lineStart < chunk.length) {
      const tail = chunk.slice(lineStart);
      pendingLineParts.push(tail);
      pendingLineBytes += tail.length;
      assertWithinCap(pendingLineBytes);
    }
  }

  if (options.terminalEventNames && options.terminalEventNames.length > 0 && !sawTerminalEvent) {
    throw new StreamEndedEarlyError(options.terminalEventNames);
  }
}

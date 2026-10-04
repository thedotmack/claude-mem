import { describe, expect, it } from 'bun:test';
import {
  readSseEvents,
  SseEventTooLargeError,
  StreamEndedEarlyError,
  type ReadSseEventsOptions,
  type SseEvent,
} from '../../src/shared/sse-reader.js';

const encoder = new TextEncoder();

function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, options?: ReadSseEventsOptions): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSseEvents(stream, options)) events.push(event);
  return events;
}

describe('readSseEvents', () => {
  it('accepts LF, CR and CRLF line endings, including a CRLF split across chunks', async () => {
    const events = await collect(streamOf(
      'event: a\ndata: lf\n\n',
      'event: b\rdata: cr\r\r',
      'event: c\r\ndata: crlf\r',
      '\n\r\n',
    ));
    expect(events).toEqual([
      { event: 'a', data: 'lf' },
      { event: 'b', data: 'cr' },
      { event: 'c', data: 'crlf' },
    ]);
  });

  it('reassembles fields and multi-byte UTF-8 split across chunks', async () => {
    const bytes = encoder.encode('data: héllo ✓\n\n');
    const events = await collect(streamOf(bytes.slice(0, 9), bytes.slice(9, 14), bytes.slice(14)));
    expect(events).toEqual([{ event: 'message', data: 'héllo ✓' }]);
  });

  it('joins multi-line data with \\n and keeps id', async () => {
    const events = await collect(streamOf('id: 7\ndata: one\ndata:two\ndata\n\n'));
    expect(events).toEqual([{ event: 'message', data: 'one\ntwo\n', id: '7' }]);
  });

  it('reports comment lines as activity and never yields them', async () => {
    let activity = 0;
    const events = await collect(
      streamOf(': ping\n\n', ':\n', 'data: x\n', ': mid-event ping\n', '\n'),
      { onActivity: () => { activity++; } }
    );
    expect(activity).toBe(3);
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('discards an incomplete trailing event', async () => {
    const events = await collect(streamOf('data: done\n\ndata: partial\n'));
    expect(events).toEqual([{ event: 'message', data: 'done' }]);
  });

  it('throws SseEventTooLargeError when one event exceeds the cap', async () => {
    const big = 'x'.repeat(600);
    await expect(collect(streamOf(`data: ${big}\n`, `data: ${big}\n\n`), { maxEventBytes: 1000 }))
      .rejects.toBeInstanceOf(SseEventTooLargeError);
    // An unterminated huge line trips the cap without waiting for a newline.
    await expect(collect(streamOf('data: ', 'y'.repeat(2000)), { maxEventBytes: 1000 }))
      .rejects.toBeInstanceOf(SseEventTooLargeError);
    // The cap is per event, not per stream.
    const events = await collect(streamOf(`data: ${big}\n\n`, `data: ${big}\n\n`), { maxEventBytes: 1000 });
    expect(events.length).toBe(2);
  });

  it('defaults the cap to 1 MiB', async () => {
    await expect(collect(streamOf(`data: ${'z'.repeat(1024 * 1024)}\n\n`)))
      .rejects.toBeInstanceOf(SseEventTooLargeError);
  });

  it('throws StreamEndedEarlyError when no terminal event arrived', async () => {
    await expect(collect(streamOf('event: delta\ndata: a\n\n'), { terminalEventNames: ['done'] }))
      .rejects.toBeInstanceOf(StreamEndedEarlyError);
    const events = await collect(
      streamOf('event: delta\ndata: a\n\nevent: done\n\n'),
      { terminalEventNames: ['done'] }
    );
    expect(events.map((event) => event.event)).toEqual(['delta', 'done']);
  });

  it('cancels the source when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: 1\n\ndata: 2\n\n')); },
      cancel() { cancelled = true; },
    });
    for await (const event of readSseEvents(stream)) {
      expect(event.data).toBe('1');
      break;
    }
    expect(cancelled).toBe(true);
  });
});

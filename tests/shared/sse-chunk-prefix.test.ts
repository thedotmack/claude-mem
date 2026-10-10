import { expect, it } from 'bun:test';
import { readSseEvents, SseEventTooLargeError } from '../../src/shared/sse-reader.js';

it('delivers a complete event before validating later bytes in the same chunk', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: answer\n\n' + 'x'.repeat(100))); },
    cancel() { cancelled = true; },
  });
  const events = [];
  for await (const event of readSseEvents(source, { maxEventBytes: 20 })) {
    events.push(event);
    break;
  }
  expect(events).toEqual([{ event: 'message', data: 'answer' }]);
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
});

it('still rejects the oversized next event when the consumer continues', async () => {
  const events = [];
  let failure: unknown;
  try {
    for await (const event of readSseEvents(new Response('data: answer\n\n' + 'x'.repeat(100)).body!, { maxEventBytes: 20 })) events.push(event);
  } catch (error) { failure = error; }
  expect(events).toEqual([{ event: 'message', data: 'answer' }]);
  expect(failure).toBeInstanceOf(SseEventTooLargeError);
});

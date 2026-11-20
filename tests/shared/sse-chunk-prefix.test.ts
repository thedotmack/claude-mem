import { expect, it } from 'bun:test';
import { readSseEvents } from '../../src/shared/sse-reader.js';

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

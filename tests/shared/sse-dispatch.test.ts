import { describe, expect, it } from 'bun:test';
import { readSseEvents } from '../../src/shared/sse-reader.js';

async function collect(text: string) {
  const events = [];
  for await (const event of readSseEvents(new Response(text).body!)) events.push(event);
  return events;
}

describe('SSE default event name', () => {
  it('uses message for an explicitly empty event name', async () => {
    expect(await collect('event:\ndata: answer\n\n')).toEqual([{ event: 'message', data: 'answer' }]);
  });
  it('preserves nonempty event names', async () => {
    expect(await collect('event: update\ndata: answer\n\n')).toEqual([{ event: 'update', data: 'answer' }]);
  });
});
